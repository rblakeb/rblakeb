import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { WebSocketServer } from "ws";
import { ADULT_PRICING, CREDIT_PACKS, INTENTS, getCreditPack, type Sex } from "./config.ts";
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
  CHARACTERS,
  LANGUAGES,
  addUserTurn,
  brainFromEnv,
  getCharacter,
  getConversation,
  startConversation,
} from "./companion.ts";
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
const app = express();
// Companion turns carry a camera frame, so they get a larger body limit than everything else.
const isCompanionTurn = (p: string) => /^\/api\/companions\/conversations\/[^/]+\/turn$/.test(p);
const smallJson = express.json({ limit: "16kb" });
app.use((req, res, next) => (isCompanionTurn(req.path) ? next() : smallJson(req, res, next)));

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
    // Credits only buy adult access, so don't sell them to people who can't use them.
    if (!user.verifiedAdult) return res.status(400).json({ error: "not_verified" });
    if (adultIsFreeFor(user)) return res.status(400).json({ error: "already_free" });
    if (await areSalesClosed()) return res.status(400).json({ error: "sales_closed" });
    const pack = getCreditPack(String(req.body?.packId));
    if (!pack) return res.status(400).json({ error: "unknown_pack" });
    const { url } = await paymentProvider.createCreditCheckout(user, pack, "/");
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
  });
});

app.post(
  "/api/companions/:character/start",
  authed(async (req, res) => {
    const character = getCharacter(String(req.params.character));
    if (!character) return res.status(404).json({ error: "unknown_character" });
    const conversation = startConversation(req.user.id, character.id, String(req.body?.language ?? "es"));
    const voiceLang = character.id === "tutor" ? String(req.body?.language ?? "es") : character.voiceLang;
    res.json({ conversationId: conversation.id, name: character.name, voiceLang });
  }),
);

const busyConversations = new Set<string>();

app.post(
  "/api/companions/conversations/:id/turn",
  express.json({ limit: "1mb" }),
  authed(async (req, res) => {
    const conversation = getConversation(String(req.params.id), req.user.id);
    if (!conversation) return res.status(404).json({ error: "unknown_conversation" });
    const text = String(req.body?.text ?? "").slice(0, 2000);
    const frame = typeof req.body?.frame === "string" ? req.body.frame : undefined;
    if (frame && (frame.length > 1_000_000 || !/^[A-Za-z0-9+/]+=*$/.test(frame))) {
      return res.status(400).json({ error: "bad_frame" });
    }
    // One reply at a time per conversation, so a stuck client can't run up model costs.
    if (busyConversations.has(conversation.id)) return res.status(409).json({ error: "busy" });
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
