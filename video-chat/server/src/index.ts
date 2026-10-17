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
import { openDb, setDb } from "./db.ts";
import { registerSeo } from "./seo.ts";
import { SignalingHub } from "./signaling.ts";
import { createUser, loadUser, loadUserByToken, publicProfile, touch, type User } from "./users.ts";
import { applyVerificationResult, mockVerificationProvider } from "./verification.ts";

const PORT = Number(process.env.PORT ?? 3000);
const IS_PROD = process.env.NODE_ENV === "production";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicDir = path.join(rootDir, "public");

if (IS_PROD && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
// Without DATABASE_URL, an embedded Postgres keeps its data in .data/ between restarts.
setDb(await openDb({ url: process.env.DATABASE_URL, dataDir: path.join(rootDir, ".data/pglite") }));

// Replace the mocks with real vendor adapters before launch.
const verificationProvider = mockVerificationProvider;
const paymentProvider = mockPaymentProvider;
const notifier = consoleNotifier;

const app = express();
app.use(express.json({ limit: "16kb" }));

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

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

setInterval(() => {
  runInactivitySweep(paymentProvider, notifier).catch((err) => console.error("Inactivity sweep failed:", err));
}, 3_600_000).unref();

const server = http.createServer(app);
const hub = new SignalingHub();
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });
wss.on("connection", (socket) => hub.handleConnection(socket));

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}${IS_PROD ? "" : " (dev mode: mock verification and payments enabled)"}`);
});
