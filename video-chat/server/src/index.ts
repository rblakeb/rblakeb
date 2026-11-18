import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { WebSocketServer } from "ws";
import { ADULT_PRICING, COMPANION_PRICING, CREDIT_PACKS, INTENTS, getCreditPack, type Sex } from "./config.ts";
import { adultIsFreeFor, checkAccess, hasActivePass } from "./access.ts";
import {
  areSalesClosed,
  consoleNotifier,
  grantCredits,
  mockPaymentProvider,
  refundableCents,
  refundUnusedCredits,
  runInactivitySweep,
  spendOnDayPass,
  windDown,
} from "./billing.ts";
import {
  CALL_OPENER,
  CHARACTERS,
  LANGUAGES,
  addUserTurn,
  brainFromEnv,
  buildInstructions,
  getConversationById,
  endConversation,
  getCharacter,
  getConversation,
  hasUserSpeech,
  startConversation,
  takeIdleConversations,
  type Conversation,
} from "./companion.ts";
import {
  canCall,
  chargeCallTime,
  deleteMemory,
  getMemory,
  saveMemory,
  type CallBalance,
} from "./companionAccount.ts";
import { openDb, setDb } from "./db.ts";
import { liveKitFromEnv } from "./media.ts";
import { registerSeo } from "./seo.ts";
import { SignalingHub } from "./signaling.ts";
import { createUser, loadUser, loadUserByToken, publicProfile, setBanned, touch, type User } from "./users.ts";
import { applyVerificationResult, mockVerificationProvider } from "./verification.ts";

const PORT = Number(process.env.PORT ?? 3000);
const IS_PROD = process.env.NODE_ENV === "production";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicDir = path.join(rootDir, "public");

if (IS_PROD && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
// Calls must go through a media server in production so they can be monitored and cut.
const media = liveKitFromEnv();
if (IS_PROD && !media) throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required in production");
// Without DATABASE_URL, an embedded Postgres keeps its data in .data/ between restarts.
setDb(await openDb({ url: process.env.DATABASE_URL, dataDir: path.join(rootDir, ".data/pglite") }));

// Replace the mocks with real vendor adapters before launch.
const verificationProvider = mockVerificationProvider;
const paymentProvider = mockPaymentProvider;
const notifier = consoleNotifier;

const hub = new SignalingHub(media);
const brain = brainFromEnv();
// With a media server and COMPANION_AGENT=1, companion calls are run by the
// voice agent in agent/ (server-side speech, voice, avatar) instead of the
// browser's built-in speech. The agent calls back to AGENT_CALLBACK_BASE.
const agentCalls = media !== null && process.env.COMPANION_AGENT === "1";
const agentCallbackBase = (process.env.AGENT_CALLBACK_BASE ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const app = express();
// Companion turns carry a camera frame and agent transcripts can be long, so
// those routes set their own body limits; everything else gets a small one.
const hasOwnBodyLimit = (p: string) =>
  /^\/api\/companions\/conversations\/[^/]+\/turn$/.test(p) || /^\/internal\/companions\/conversations\/[^/]+\/transcript$/.test(p);
const smallJson = express.json({ limit: "16kb" });
app.use((req, res, next) => (hasOwnBodyLimit(req.path) ? next() : smallJson(req, res, next)));

type AuthedRequest = Request & { user: User };

// Express 4 doesn't catch rejected promises; pass them to the error handler.
function route(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => fn(req, res).catch(next);
}

// A route that needs a signed-in, non-banned user.
function authed(fn: (req: AuthedRequest, res: Response) => Promise<unknown>): RequestHandler {
  return route(async (req, res) => {
    const token = req.header("authorization")?.replace(/^Bearer /, "");
    const user = await loadUserByToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    if (user.banned) return res.status(403).json({ error: "banned" });
    await touch(user);
    return fn(Object.assign(req, { user }), res);
  });
}

async function accountState(user: User) {
  return {
    user: publicProfile(user),
    adult: {
      verified: user.verifiedAdult,
      free: user.verifiedAdult && adultIsFreeFor(user),
      passActive: hasActivePass(user),
      refundableCents: refundableCents(user),
    },
    salesClosed: await areSalesClosed(),
    access: Object.fromEntries(INTENTS.map((i) => [i.id, checkAccess(user, i)])),
  };
}

app.post(
  "/api/session",
  route(async (req, res) => {
    const { user, token } = await createUser(String(req.body?.displayName ?? ""));
    res.json({ token, ...(await accountState(user)) });
  }),
);

app.get(
  "/api/me",
  authed(async (req, res) => res.json(await accountState(req.user))),
);

app.get("/api/config", (_req, res) => {
  const iceServers: unknown[] = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.json({
    intents: INTENTS,
    pricing: { dayPassCredits: ADULT_PRICING.dayPassCredits, dayPassHours: ADULT_PRICING.dayPassHours, packs: CREDIT_PACKS },
    iceServers,
  });
});

app.post(
  "/api/verification/start",
  authed(async (req, res) => {
    const { url } = await verificationProvider.startSession(req.user, "/");
    res.json({ url });
  }),
);

app.post(
  "/api/billing/checkout",
  authed(async (req, res) => {
    const user = req.user;
    // Credits pay for AI companion minutes as well as adult-room access, so
    // anyone signed in can buy them.
    if (await areSalesClosed()) return res.status(400).json({ error: "sales_closed" });
    const pack = getCreditPack(String(req.body?.packId));
    if (!pack) return res.status(400).json({ error: "unknown_pack" });
    // Send the buyer back to the page they bought from. Only paths on this site:
    // "//host" and "/\host" would leave it.
    const returnTo = String(req.body?.returnTo ?? "/");
    const { url } = await paymentProvider.createCreditCheckout(user, pack, /^\/(?![\/\\])/.test(returnTo) ? returnTo : "/");
    res.json({ url });
  }),
);

app.post(
  "/api/adult/unlock",
  authed(async (req, res) => {
    const user = req.user;
    if (!user.verifiedAdult) return res.status(400).json({ error: "not_verified" });
    if (adultIsFreeFor(user)) return res.status(400).json({ error: "already_free" });
    const result = await spendOnDayPass(user.id);
    if (result !== "ok") return res.status(402).json({ error: result });
    res.json(await accountState((await loadUser(user.id))!));
  }),
);

app.post(
  "/api/billing/refund",
  authed(async (req, res) => {
    const summary = await refundUnusedCredits(req.user.id, paymentProvider, "requested");
    res.json({ ...summary, ...(await accountState((await loadUser(req.user.id))!)) });
  }),
);

// ---------- AI companions ----------

app.get("/api/companions", (_req, res) => {
  res.json({
    characters: Object.values(CHARACTERS).map(({ id, name, tagline, voiceLang }) => ({ id, name, tagline, voiceLang })),
    languages: LANGUAGES,
    pricing: COMPANION_PRICING,
  });
});

app.post(
  "/api/companions/:character/start",
  authed(async (req, res) => {
    const character = getCharacter(String(req.params.character));
    if (!character) return res.status(404).json({ error: "unknown_character" });
    if (!canCall(req.user)) return res.status(402).json({ error: "no_minutes" });
    const memory = await getMemory(req.user.id, character.id);
    const conversation = startConversation(req.user.id, character.id, String(req.body?.language ?? "es"), memory);
    const voiceLang = character.id === "tutor" ? String(req.body?.language ?? "es") : character.voiceLang;
    const started = { conversationId: conversation.id, name: character.name, voiceLang, secondsRemaining: req.user.companionSeconds };
    if (!agentCalls || !media) return res.json(started);

    // Agent call: open a room with seats for the agent and its avatar, then send the agent in.
    conversation.agentToken = randomUUID();
    try {
      const join = await media.openCall(conversation.id, [{ userId: req.user.id, displayName: req.user.displayName }], {
        extraSeats: 2,
        allowData: true,
      });
      await media.dispatchAgent(
        conversation.id,
        "companion",
        JSON.stringify({
          conversationId: conversation.id,
          character: character.id,
          name: character.name,
          voiceLang,
          voiceGender: character.voiceGender,
          instructions: buildInstructions(conversation),
          callbackUrl: `${agentCallbackBase}/internal/companions/conversations/${conversation.id}/transcript`,
          callbackToken: conversation.agentToken,
        }),
      );
      res.json({ ...started, livekit: join.get(req.user.id) });
    } catch (err) {
      console.error("Couldn't start agent call:", err);
      endConversation(conversation.id);
      await media.closeCall(conversation.id);
      res.status(502).json({ error: "media_unavailable" });
    }
  }),
);

// Charges the call time since the last charge, capped so a closed tab or lost
// connection isn't billed for the gap.
async function chargeElapsed(conversation: Conversation): Promise<CallBalance> {
  const now = Date.now();
  const elapsed = Math.min(now - conversation.lastBilledAt, COMPANION_PRICING.maxBilledGapSeconds * 1000) / 1000;
  conversation.lastBilledAt = now;
  return chargeCallTime(conversation.userId, elapsed);
}

// Saves what the character learned this call. Runs when a call ends or goes idle.
async function wrapUp(conversation: Conversation): Promise<void> {
  if (!hasUserSpeech(conversation)) return;
  try {
    await saveMemory(conversation.userId, conversation.character, await brain.updateMemory(conversation));
  } catch (err) {
    console.error("Couldn't save companion memory:", err);
  }
}

// The browser reports call time every few seconds while a call is open.
app.post(
  "/api/companions/conversations/:id/heartbeat",
  authed(async (req, res) => {
    const conversation = getConversation(String(req.params.id), req.user.id);
    if (!conversation || conversation.ended) return res.status(404).json({ error: "unknown_conversation" });
    conversation.lastUsed = Date.now();
    const balance = await chargeElapsed(conversation);
    // Out of time: hang up the agent's call too.
    if (balance.exhausted && conversation.agentToken) await endAgentCall(conversation);
    res.json(balance);
  }),
);

// Stops billing and closes the room. The agent then sends its transcript,
// which is when the character's memory gets updated.
async function endAgentCall(conversation: Conversation): Promise<void> {
  conversation.ended = true;
  await media?.closeCall(conversation.id);
}

app.post(
  "/api/companions/conversations/:id/end",
  authed(async (req, res) => {
    const conversation = getConversation(String(req.params.id), req.user.id);
    if (!conversation || conversation.ended) return res.status(404).json({ error: "unknown_conversation" });
    const balance = await chargeElapsed(conversation);
    if (conversation.agentToken) {
      await endAgentCall(conversation);
      return res.json(balance);
    }
    endConversation(conversation.id);
    res.json(balance);
    await wrapUp(conversation);
  }),
);

// The voice agent sends the call's transcript here when the call ends. It
// proves which call it's for with that call's one-time token.
app.post(
  "/internal/companions/conversations/:id/transcript",
  express.json({ limit: "512kb" }),
  route(async (req, res) => {
    const conversation = getConversationById(String(req.params.id));
    const token = Buffer.from(req.header("authorization")?.replace(/^Bearer /, "") ?? "");
    const expected = Buffer.from(conversation?.agentToken ?? "");
    if (!conversation || !expected.length || token.length !== expected.length || !timingSafeEqual(token, expected)) {
      return res.status(404).end();
    }
    const lines: unknown[] = Array.isArray(req.body?.lines) ? req.body.lines : [];
    conversation.messages = lines.flatMap((line) => {
      const { role, text } = (line ?? {}) as { role?: unknown; text?: unknown };
      if ((role !== "user" && role !== "assistant") || typeof text !== "string" || !text) return [];
      return [{ role, content: text.slice(0, 4000) }];
    });
    endConversation(conversation.id);
    conversation.agentToken = null;
    res.json({ ok: true });
    await wrapUp(conversation);
  }),
);

const busyConversations = new Set<string>();

app.post(
  "/api/companions/conversations/:id/turn",
  express.json({ limit: "1mb" }),
  authed(async (req, res) => {
    const conversation = getConversation(String(req.params.id), req.user.id);
    if (!conversation) return res.status(404).json({ error: "unknown_conversation" });
    // Agent calls talk to the agent over the room, not through this route.
    if (conversation.agentToken) return res.status(409).json({ error: "agent_call" });
    // The browser flags the call's first turn; the server supplies the hidden opener line.
    const text = req.body?.opener === true ? CALL_OPENER : String(req.body?.text ?? "").slice(0, 2000);
    const frame = typeof req.body?.frame === "string" ? req.body.frame : undefined;
    if (frame && (frame.length > 1_000_000 || !/^[A-Za-z0-9+/]+=*$/.test(frame))) {
      return res.status(400).json({ error: "bad_frame" });
    }
    // One reply at a time per conversation, so a stuck client can't run up model costs.
    if (busyConversations.has(conversation.id)) return res.status(409).json({ error: "busy" });
    const balance = await chargeElapsed(conversation);
    if (balance.exhausted) return res.status(402).json({ error: "no_minutes", ...balance });
    busyConversations.add(conversation.id);

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      addUserTurn(conversation, text, frame);
      await brain.reply(conversation, (delta) => send({ type: "text", text: delta }));
      send({ type: "done" });
    } catch (err) {
      console.error("Companion reply failed:", err);
      send({ type: "error" });
    } finally {
      busyConversations.delete(conversation.id);
      res.end();
    }
  }),
);

// What a character remembers about the signed-in user, and a way to clear it.
app.get(
  "/api/companions/:character/memory",
  authed(async (req, res) => {
    const character = getCharacter(String(req.params.character));
    if (!character) return res.status(404).json({ error: "unknown_character" });
    res.json({ notes: await getMemory(req.user.id, character.id) });
  }),
);

app.delete(
  "/api/companions/:character/memory",
  authed(async (req, res) => {
    const character = getCharacter(String(req.params.character));
    if (!character) return res.status(404).json({ error: "unknown_character" });
    await deleteMemory(req.user.id, character.id);
    res.json({ ok: true });
  }),
);

setInterval(() => {
  for (const conversation of takeIdleConversations()) {
    // An agent call nobody's using any more: hang the agent up as well.
    if (conversation.agentToken && !conversation.ended) media?.closeCall(conversation.id).catch(() => {});
    wrapUp(conversation);
  }
}, 60_000).unref();

// Shutting the site down: closes credit sales and refunds every unused credit.
// Disabled unless ADMIN_TOKEN is set.
app.post(
  "/admin/wind-down",
  route(async (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken || req.header("x-admin-token") !== adminToken) return res.status(404).end();
    res.json(await windDown(paymentProvider, notifier));
  }),
);

// Moderation kill switch: ends a user's call immediately for both sides.
// With "ban": true also bans the account and disconnects them.
app.post(
  "/admin/end-call",
  route(async (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken || req.header("x-admin-token") !== adminToken) return res.status(404).end();
    const userId = String(req.body?.userId ?? "");
    const ban = req.body?.ban === true;
    if (ban) await setBanned(userId);
    const ended = hub.endCallFor(userId, { disconnect: ban });
    res.json({ ended, banned: ban });
  }),
);

// Real vendor and payment webhooks go here. Each must check the vendor's
// signature before calling applyVerificationResult / grantCredits.

if (!IS_PROD) {
  // Endpoints behind the mock vendor pages in public/dev/. Never exposed in production.
  app.post(
    "/dev/api/verification-result",
    route(async (req, res) => {
      const { userId, reference, outcome, sex } = req.body ?? {};
      const user = await applyVerificationResult({
        userId: String(userId),
        reference: String(reference),
        approved: outcome !== "rejected",
        isAdult: outcome === "adult",
        documentSex: (["M", "F", "X"].includes(sex) ? sex : null) as Sex | null,
      });
      if (!user) return res.status(404).json({ error: "unknown_user" });
      res.json({ ok: true });
    }),
  );

  app.post(
    "/dev/api/payment-success",
    route(async (req, res) => {
      const pack = getCreditPack(String(req.body?.packId));
      if (!pack) return res.status(400).json({ error: "unknown_pack" });
      const user = await grantCredits(String(req.body?.userId), pack, String(req.body?.reference));
      if (!user) return res.status(404).json({ error: "unknown_user" });
      res.json({ ok: true });
    }),
  );
} else {
  app.use("/dev", (_req, res) => res.status(404).end());
}

registerSeo(app, publicDir, PORT);
app.use(express.static(publicDir));
// MediaPipe (camera behavior tracking) runs in the browser from our own origin.
app.use("/vendor/mediapipe", express.static(path.join(rootDir, "node_modules/@mediapipe/tasks-vision")));
// The LiveKit browser client, served from our own origin rather than a CDN.
app.get("/vendor/livekit-client.esm.mjs", (_req, res) =>
  res.sendFile(path.join(rootDir, "node_modules/livekit-client/dist/livekit-client.esm.mjs")),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Client mistakes the body parser reports (body too large, malformed JSON) keep their 4xx status.
  const status = (err as { status?: number }).status;
  if (status && status >= 400 && status < 500) return res.status(status).json({ error: "bad_request" });
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

setInterval(() => {
  runInactivitySweep(paymentProvider, notifier).catch((err) => console.error("Inactivity sweep failed:", err));
}, 3_600_000).unref();

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });
wss.on("connection", (socket) => hub.handleConnection(socket));

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}${IS_PROD ? "" : " (dev mode: mock verification and payments enabled)"}`);
  console.log(media ? `Calls routed through LiveKit at ${process.env.LIVEKIT_URL}` : "Calls are peer-to-peer (set LIVEKIT_* to route through a media server)");
});
