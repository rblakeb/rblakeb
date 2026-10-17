import type { WebSocket } from "ws";
import { getIntent, type IntentId } from "./config.ts";
import { checkAccess } from "./access.ts";
import { Matchmaker, type Match } from "./matchmaker.ts";
import { getUserById, getUserByToken, touch, type User } from "./users.ts";

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
}

export class SignalingHub {
  private sessions = new Map<string, Session>();
  readonly matchmaker = new Matchmaker((userId, intent) => {
    const user = getUserById(userId);
    const i = getIntent(intent);
    return !!user && !!i && this.sessions.has(userId) && checkAccess(user, i) === null;
  });

  constructor() {
    setInterval(() => this.tick(), 1000).unref();
  }

  handleConnection(socket: WebSocket): void {
    let session: Session | null = null;

    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === "auth") {
        const user = getUserByToken(msg.token);
        if (!user || user.banned) {
          send(socket, { type: "error", error: user ? "banned" : "unauthorized" });
          socket.close();
          return;
        }
        touch(user);
        // One live connection per account.
        this.sessions.get(user.id)?.socket.close();
        session = { user, socket, intent: null, partnerId: null };
        this.sessions.set(user.id, session);
        send(socket, { type: "ready" });
        return;
      }

      if (!session) return send(socket, { type: "error", error: "unauthorized" });
      this.handle(session, msg);
    });

    socket.on("close", () => {
      if (!session || this.sessions.get(session.user.id) !== session) return;
      this.endCall(session, "partner_left");
      this.matchmaker.remove(session.user.id);
      this.sessions.delete(session.user.id);
    });
  }

  private handle(s: Session, msg: ClientMessage): void {
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
        if (match) this.startCall(match);
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
          partner.user.reportCount++;
          console.warn(`[report] ${s.user.id} reported ${partner.user.id}: ${String(msg.reason ?? "").slice(0, 200)}`);
          if (partner.user.reportCount >= REPORTS_BEFORE_BAN) {
            partner.user.banned = true;
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

  private startCall({ a, b }: Match): void {
    const sa = this.sessions.get(a.userId);
    const sb = this.sessions.get(b.userId);
    if (!sa || !sb) return;
    sa.partnerId = sb.user.id;
    sb.partnerId = sa.user.id;
    const sharedTags = a.tags.filter((t) => b.tags.includes(t));
    send(sa.socket, { type: "matched", initiator: true, partner: { displayName: sb.user.displayName }, sharedTags });
    send(sb.socket, { type: "matched", initiator: false, partner: { displayName: sa.user.displayName }, sharedTags });
  }

  // Ends `s`'s current call, if any, and tells the partner.
  private endCall(s: Session, reason: "partner_left"): void {
    if (!s.partnerId) return;
    const partner = this.sessions.get(s.partnerId);
    s.partnerId = null;
    if (partner && partner.partnerId === s.user.id) {
      partner.partnerId = null;
      send(partner.socket, { type: reason });
    }
  }

  private tick(): void {
    for (const match of this.matchmaker.sweep()) this.startCall(match);

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
