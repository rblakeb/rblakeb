import { randomUUID } from "node:crypto";
import type { Sex } from "./config.ts";

export interface User {
  id: string;
  token: string;
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

// In-memory store for the MVP. Swap for Postgres before launch.
const byId = new Map<string, User>();
const byToken = new Map<string, User>();

export function createUser(displayName: string): User {
  const user: User = {
    id: randomUUID(),
    token: randomUUID(),
    displayName: displayName.trim().slice(0, 32) || "Guest",
    createdAt: Date.now(),
    verifiedAdult: false,
    verifiedSex: null,
    verificationRef: null,
    adultPassExpiresAt: null,
    creditLots: [],
    email: null,
    lastActiveAt: Date.now(),
    inactivityReminderSentAt: null,
    banned: false,
    reportCount: 0,
  };
  byId.set(user.id, user);
  byToken.set(user.token, user);
  return user;
}

export function allUsers(): IterableIterator<User> {
  return byId.values();
}

export function creditBalance(user: User): number {
  return user.creditLots.reduce((sum, lot) => sum + lot.remaining, 0);
}

export function touch(user: User, now = Date.now()): void {
  user.lastActiveAt = now;
}

export function getUserById(id: string): User | undefined {
  return byId.get(id);
}

export function getUserByToken(token: string | undefined): User | undefined {
  return token ? byToken.get(token) : undefined;
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
