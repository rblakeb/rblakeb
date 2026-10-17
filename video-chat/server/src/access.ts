import { ADULT_PRICING, type Intent } from "./config.ts";
import type { User } from "./users.ts";

export type AccessDenial = "banned" | "not_verified" | "payment_required";

export function adultIsFreeFor(user: User): boolean {
  return user.verifiedSex !== null && ADULT_PRICING.freeForSex.includes(user.verifiedSex);
}

export function hasActivePass(user: User, now = Date.now()): boolean {
  return user.adultPassExpiresAt !== null && user.adultPassExpiresAt > now;
}

// The single gate for every queue. Checked on queue join and again at match time.
export function checkAccess(user: User, intent: Intent, now = Date.now()): AccessDenial | null {
  if (user.banned) return "banned";
  if (!intent.adult) return null;
  if (!user.verifiedAdult) return "not_verified";
  if (!adultIsFreeFor(user) && !hasActivePass(user, now)) return "payment_required";
  return null;
}
