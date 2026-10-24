import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { getIntent, type IntentId } from "./config.ts";
import { checkAccess } from "./access.ts";
import { Matchmaker, type Match } from "./matchmaker.ts";
import type { MediaRouter } from "./media.ts";
import { liveUser, loadUserByToken, pinUser, recordReport, touch, unpinUser, type User } from "./users.ts";

const REPORTS_BEFORE_BAN = 3;

type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "join"; intent: string; languages?: string[]; tags?: string[] }
  | { type: "leave" }
  | { type: "skip" }
  | { type: "report"; reason?: string }
  | { type: "signal"; data: unknown }
  | { type: "chat"; text: string };

interface Session {
  user: User;
  socket: WebSocket;
  intent: IntentId | null;
  partnerId: string | null;
  // Shared by both sides of a call; with a media router it's also the room name.
  callId: string | null;
}

export class SignalingHub {
  private sessions = new Map<string, Session>();
  readonly matchmaker = new Matchmaker((userId, intent) => {
    const user = liveUser(userId);
    const i = getIntent(intent);
    return !!user && !!i && this.sessions.has(userId) && checkAccess(user, i) === null;
  });

  // Without a media router, calls run peer-to-peer (dev only).
  constructor(private media: MediaRouter | null = null) {
    setInterval(() => this.tick(), 1000).unref();
  }

  handleConnection(socket: WebSocket): void {
    let session: Session | null = null;
    // Messages that arrive while auth is still loading the user wait for it.
    let authed: Promise<Session | null> = Promise.resolve(null);

    socket.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === "auth") {
        authed = this.authenticate(socket, msg.token).then((s) => (session = s));
        return;
      }

      const s = session ?? (await authed);
      if (!s) return send(socket, { type: "error", error: "unauthorized" });
      try {
        await this.handle(s, msg);
      } catch (err) {
        console.error("Signaling error:", err);
      }
    });

    socket.on("close", () => {
      if (!session || this.sessions.get(session.user.id) !== session) return;
      this.endCall(session, "partner_left");
      this.matchmaker.remove(session.user.id);
      this.sessions.delete(session.user.id);
      unpinUser(session.user.id);
    });
  }

  private async authenticate(socket: WebSocket, token: string): Promise<Session | null> {
    const user = await loadUserByToken(String(token)).catch(() => undefined);
    if (!user || user.banned) {
      send(socket, { type: "error", error: user ? "banned" : "unauthorized" });
      socket.close();
      return null;
    }
    await touch(user);
    // One live connection per account.
    this.sessions.get(user.id)?.socket.close();
    pinUser(user);
    const session: Session = { user, socket, intent: null, partnerId: null, callId: null };
    this.sessions.set(user.id, session);
    send(socket, { type: "ready" });
    return session;
  }

  private async handle(s: Session, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "join": {
        const intent = getIntent(msg.intent);
        if (!intent) return send(s.socket, { type: "error", error: "unknown_intent" });
        const denial = checkAccess(s.user, intent);
        if (denial) return send(s.socket, { type: "denied", intent: intent.id, reason: denial });
        this.endCall(s, "partner_left");
        s.intent = intent.id;
        const match = this.matchmaker.enqueue({
          userId: s.user.id,
          intent: intent.id,
          languages: Array.isArray(msg.languages) ? msg.languages.map(String) : [],
          tags: Array.isArray(msg.tags) ? msg.tags.map(String) : [],
        });
        if (match) await this.startCall(match);
        else send(s.socket, { type: "queued", intent: intent.id });
        return;
      }
      case "leave":
        this.endCall(s, "partner_left");
        this.matchmaker.remove(s.user.id);
        s.intent = null;
        return;
      case "skip":
        this.endCall(s, "partner_left");
        return;
      case "report": {
        const partner = s.partnerId ? this.sessions.get(s.partnerId) : undefined;
        if (partner) {
          const reason = String(msg.reason ?? "").slice(0, 500);
          const { banned } = await recordReport(s.user.id, partner.user.id, reason, REPORTS_BEFORE_BAN);
          if (banned) {
            this.endCall(s, "partner_left");
            send(partner.socket, { type: "error", error: "banned" });
            partner.socket.close();
            return;
          }
        }
        this.endCall(s, "partner_left");
        return;
      }
      case "signal":
      case "chat": {
        const partner = s.partnerId ? this.sessions.get(s.partnerId) : undefined;
        if (!partner) return;
        if (msg.type === "chat") {
          const text = String(msg.text ?? "").slice(0, 500);
          if (text) send(partner.socket, { type: "chat", text });
        } else {
          send(partner.socket, { type: "signal", data: msg.data });
        }
        return;
      }
    }
  }

  private async startCall({ a, b }: Match): Promise<void> {
    const sa = this.sessions.get(a.userId);
    const sb = this.sessions.get(b.userId);
    if (!sa || !sb) return;
    const callId = randomUUID();
    sa.partnerId = sb.user.id;
    sb.partnerId = sa.user.id;
    sa.callId = sb.callId = callId;
    const sharedTags = a.tags.filter((t) => b.tags.includes(t));

    let join: Map<string, { url: string; token: string }> | null = null;
    if (this.media) {
      try {
        join = await this.media.openCall(callId, [
          { userId: sa.user.id, displayName: sa.user.displayName },
          { userId: sb.user.id, displayName: sb.user.displayName },
        ]);
      } catch (err) {
        console.error("Couldn't open media room:", err);
        // Both go back to looking; their clients rejoin the queue on partner_left.
        this.endCall(sa, "partner_left");
        send(sa.socket, { type: "partner_left" });
        return;
      }
      // One of them may have skipped or left while the room was being created.
      if (sa.callId !== callId || sb.callId !== callId) {
        await this.media.closeCall(callId);
        return;
      }
    }

    for (const [self, other, initiator] of [[sa, sb, true], [sb, sa, false]] as const) {
      const media = join ? { kind: "livekit", ...join.get(self.user.id)! } : { kind: "p2p" };
      send(self.socket, { type: "matched", initiator, partner: { displayName: other.user.displayName }, sharedTags, media });
    }
  }

  // Ends `s`'s current call, if any, and tells the partner.
  private endCall(s: Session, reason: "partner_left" | "ended_by_moderator"): void {
    if (!s.partnerId) return;
    const partner = this.sessions.get(s.partnerId);
    if (s.callId) this.media?.closeCall(s.callId).catch(() => {});
    s.partnerId = null;
    s.callId = null;
    if (partner && partner.partnerId === s.user.id) {
      partner.partnerId = null;
      partner.callId = null;
      send(partner.socket, { type: reason });
    }
  }

  // Moderation kill switch: ends whatever call this user is in, for both sides,
  // and optionally disconnects them. Returns false if they weren't in a call.
  endCallFor(userId: string, opts: { disconnect?: boolean } = {}): boolean {
    const s = this.sessions.get(userId);
    if (!s) return false;
    const wasInCall = !!s.partnerId;
    this.endCall(s, "ended_by_moderator");
    if (wasInCall) send(s.socket, { type: "ended_by_moderator" });
    if (opts.disconnect) {
      send(s.socket, { type: "error", error: "banned" });
      s.socket.close();
    }
    return wasInCall;
  }

  private tick(): void {
    for (const match of this.matchmaker.sweep()) {
      this.startCall(match).catch((err) => console.error("Couldn't start call:", err));
    }

    // End adult calls whose access lapsed mid-call (e.g. the day pass expired).
    for (const s of this.sessions.values()) {
      if (!s.partnerId || !s.intent) continue;
      const intent = getIntent(s.intent);
      const denial = intent && checkAccess(s.user, intent);
      if (denial) {
        this.endCall(s, "partner_left");
        send(s.socket, { type: "denied", intent: s.intent, reason: denial });
      }
    }

    const counts = this.matchmaker.waitingCounts();
    for (const s of this.sessions.values()) send(s.socket, { type: "counts", counts });
  }
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}
