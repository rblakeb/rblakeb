import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer } from "ws";
import { ADULT_PRICING, INTENTS, type Sex } from "./config.ts";
import { adultIsFreeFor, checkAccess, hasActivePass } from "./access.ts";
import { grantDayPass, mockPaymentProvider } from "./billing.ts";
import { SignalingHub } from "./signaling.ts";
import { createUser, getUserByToken, publicProfile, type User } from "./users.ts";
import { applyVerificationResult, mockVerificationProvider } from "./verification.ts";

const PORT = Number(process.env.PORT ?? 3000);
const IS_PROD = process.env.NODE_ENV === "production";
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

// Replace the mocks with real vendor adapters before launch.
const verificationProvider = mockVerificationProvider;
const paymentProvider = mockPaymentProvider;

const app = express();
app.use(express.json({ limit: "16kb" }));

type AuthedRequest = Request & { user: User };

function requireUser(req: Request, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer /, "");
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  if (user.banned) return res.status(403).json({ error: "banned" });
  (req as AuthedRequest).user = user;
  next();
}

function accountState(user: User) {
  return {
    user: publicProfile(user),
    adult: {
      verified: user.verifiedAdult,
      free: user.verifiedAdult && adultIsFreeFor(user),
      passActive: hasActivePass(user),
    },
    access: Object.fromEntries(INTENTS.map((i) => [i.id, checkAccess(user, i)])),
  };
}

app.post("/api/session", (req, res) => {
  const user = createUser(String(req.body?.displayName ?? ""));
  res.json({ token: user.token, ...accountState(user) });
});

app.get("/api/me", requireUser, (req, res) => {
  res.json(accountState((req as AuthedRequest).user));
});

app.get("/api/config", (_req, res) => {
  const iceServers: unknown[] = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.json({
    intents: INTENTS,
    pricing: { dayPassCents: ADULT_PRICING.dayPassCents, dayPassHours: ADULT_PRICING.dayPassHours },
    iceServers,
  });
});

app.post("/api/verification/start", requireUser, async (req, res) => {
  const { url } = await verificationProvider.startSession((req as AuthedRequest).user, "/");
  res.json({ url });
});

app.post("/api/billing/day-pass", requireUser, async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user.verifiedAdult) return res.status(400).json({ error: "not_verified" });
  if (adultIsFreeFor(user)) return res.status(400).json({ error: "already_free" });
  const { url } = await paymentProvider.createDayPassCheckout(user, "/");
  res.json({ url });
});

// Real vendor and payment webhooks go here. Each must check the vendor's
// signature before calling applyVerificationResult / grantDayPass.

if (!IS_PROD) {
  // Endpoints behind the mock vendor pages in public/dev/. Never exposed in production.
  app.post("/dev/api/verification-result", (req, res) => {
    const { userId, reference, outcome, sex } = req.body ?? {};
    const user = applyVerificationResult({
      userId: String(userId),
      reference: String(reference),
      approved: outcome !== "rejected",
      isAdult: outcome === "adult",
      documentSex: (["M", "F", "X"].includes(sex) ? sex : null) as Sex | null,
    });
    if (!user) return res.status(404).json({ error: "unknown_user" });
    res.json({ ok: true });
  });

  app.post("/dev/api/payment-success", (req, res) => {
    const user = grantDayPass(String(req.body?.userId));
    if (!user) return res.status(404).json({ error: "unknown_user" });
    res.json({ ok: true });
  });
} else {
  app.use("/dev", (_req, res) => res.status(404).end());
}

app.use(express.static(publicDir));

const server = http.createServer(app);
const hub = new SignalingHub();
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });
wss.on("connection", (socket) => hub.handleConnection(socket));

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}${IS_PROD ? "" : " (dev mode: mock verification and payments enabled)"}`);
});
