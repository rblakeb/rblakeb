import { createHash, randomUUID } from "node:crypto";
import type { Sex } from "./config.ts";
import { getDb, type Db } from "./db.ts";

export interface User {
  id: string;
  displayName: string;
  createdAt: number;
  // Set only by the verification vendor's result, never by the client.
  verifiedAdult: boolean;
  verifiedSex: Sex | null;
  verificationRef: string | null;
  adultPassExpiresAt: number | null;
  creditLots: CreditLot[];
  // From the payment processor's checkout; used for refund and inactivity notices.
  email: string | null;
  lastActiveAt: number;
  inactivityReminderSentAt: number | null;
  banned: boolean;
  reportCount: number;
}

// Credits from one purchase. Tracked per purchase so a refund goes back to the
// charge it came from, at the price actually paid.
export interface CreditLot {
  paymentRef: string;
  purchasedAt: number;
  packCredits: number;
  packCents: number;
  remaining: number;
  // A refund was attempted and failed (expired card, charge too old to refund).
  // The credits stay usable; someone has to refund this by another method.
  refundFailed: boolean;
}

interface UserRow {
  id: string;
  display_name: string;
  created_at: Date;
  verified_adult: boolean;
  verified_sex: Sex | null;
  verification_ref: string | null;
  adult_pass_expires_at: Date | null;
  email: string | null;
  last_active_at: Date;
  inactivity_reminder_sent_at: Date | null;
  banned: boolean;
  report_count: number;
}

interface LotRow {
  payment_ref: string;
  purchased_at: Date;
  pack_credits: number;
  pack_cents: number;
  remaining: number;
  refund_failed: boolean;
}

const ms = (d: Date | null) => (d ? d.getTime() : null);

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Users with a live WebSocket stay in memory so signaling can check access
// every tick without a query. loadUser() refreshes these objects in place, so
// a change made through the API (verification, unlocking) shows up there too.
const live = new Map<string, User>();

export function pinUser(user: User): void {
  live.set(user.id, user);
}

export function unpinUser(id: string): void {
  live.delete(id);
}

export function liveUser(id: string): User | undefined {
  return live.get(id);
}

// Returns the new user and their session token. The token is only stored hashed.
export async function createUser(displayName: string, db: Db = getDb()): Promise<{ user: User; token: string }> {
  const token = randomUUID();
  const id = randomUUID();
  await db.query("insert into users (id, token_hash, display_name) values ($1, $2, $3)", [
    id,
    hashToken(token),
    displayName.trim().slice(0, 32) || "Guest",
  ]);
  return { user: (await loadUser(id, db))!, token };
}

export async function loadUser(id: string, db: Db = getDb()): Promise<User | undefined> {
  const [row] = await db.query<UserRow>("select * from users where id = $1", [id]);
  if (!row) return undefined;
  const lots = await db.query<LotRow>(
    "select * from credit_lots where user_id = $1 order by purchased_at, payment_ref",
    [id],
  );
  const fresh: User = {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at.getTime(),
    verifiedAdult: row.verified_adult,
    verifiedSex: row.verified_sex,
    verificationRef: row.verification_ref,
    adultPassExpiresAt: ms(row.adult_pass_expires_at),
    creditLots: lots.map((l) => ({
      paymentRef: l.payment_ref,
      purchasedAt: l.purchased_at.getTime(),
      packCredits: l.pack_credits,
      packCents: l.pack_cents,
      remaining: l.remaining,
      refundFailed: l.refund_failed,
    })),
    email: row.email,
    lastActiveAt: row.last_active_at.getTime(),
    inactivityReminderSentAt: ms(row.inactivity_reminder_sent_at),
    banned: row.banned,
    reportCount: row.report_count,
  };
  const pinned = live.get(id);
  return pinned ? Object.assign(pinned, fresh) : fresh;
}

export async function loadUserByToken(token: string | undefined, db: Db = getDb()): Promise<User | undefined> {
  if (!token) return undefined;
  const [row] = await db.query<{ id: string }>("select id from users where token_hash = $1", [hashToken(token)]);
  return row ? loadUser(row.id, db) : undefined;
}

// Records activity, at most once a minute per user to keep writes down.
export async function touch(user: User, now = Date.now(), db: Db = getDb()): Promise<void> {
  if (now - user.lastActiveAt < 60_000) return;
  user.lastActiveAt = now;
  await db.query("update users set last_active_at = $2 where id = $1", [user.id, new Date(now)]);
}

// Logs a report against `reportedId` and bans them once they reach `banAt` reports.
export async function recordReport(
  reporterId: string,
  reportedId: string,
  reason: string,
  banAt: number,
  db: Db = getDb(),
): Promise<{ banned: boolean }> {
  const [row] = await db.transaction(async (tx) => {
    await tx.query("insert into reports (reporter_id, reported_id, reason) values ($1, $2, $3)", [reporterId, reportedId, reason]);
    return tx.query<{ banned: boolean }>(
      `update users set report_count = report_count + 1, banned = banned or report_count + 1 >= $2
       where id = $1 returning banned`,
      [reportedId, banAt],
    );
  });
  await loadUser(reportedId, db);
  return { banned: row?.banned ?? false };
}

export async function setBanned(id: string, db: Db = getDb()): Promise<void> {
  await db.query("update users set banned = true where id = $1", [id]);
  await loadUser(id, db);
}

export function creditBalance(user: User): number {
  return user.creditLots.reduce((sum, lot) => sum + lot.remaining, 0);
}

export function publicProfile(user: User) {
  return {
    id: user.id,
    displayName: user.displayName,
    verifiedAdult: user.verifiedAdult,
    adultPassExpiresAt: user.adultPassExpiresAt,
    credits: creditBalance(user),
  };
}
