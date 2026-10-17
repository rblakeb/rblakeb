import { randomUUID } from "node:crypto";
import { ADULT_PRICING, type CreditPack } from "./config.ts";
import { getUserById, type User } from "./users.ts";

export interface PaymentProvider {
  // Returns a URL for the processor's hosted checkout (CCBill, Segpay, ...).
  createCreditCheckout(user: User, pack: CreditPack, returnUrl: string): Promise<{ url: string; reference: string }>;
}

// Payment references already credited. Processors retry webhooks, so the same
// payment can arrive more than once and must only add credits once.
// In-memory for the MVP; store alongside users in the database.
const appliedPayments = new Set<string>();

// Called from the processor's "payment succeeded" webhook.
export function grantCredits(userId: string, credits: number, paymentRef: string): User | undefined {
  const user = getUserById(userId);
  if (!user) return undefined;
  if (appliedPayments.has(paymentRef)) return user;
  appliedPayments.add(paymentRef);
  user.credits += credits;
  return user;
}

export type SpendResult = "ok" | "insufficient_credits";

// Spends credits on 24h of adult access. Extends an active pass rather than
// resetting it, so unlocking early never loses time.
export function spendOnDayPass(user: User, now = Date.now()): SpendResult {
  if (user.credits < ADULT_PRICING.dayPassCredits) return "insufficient_credits";
  user.credits -= ADULT_PRICING.dayPassCredits;
  const start = Math.max(now, user.adultPassExpiresAt ?? 0);
  user.adultPassExpiresAt = start + ADULT_PRICING.dayPassHours * 3_600_000;
  return "ok";
}

// Development stand-in. Its checkout page is /dev/checkout.html.
export const mockPaymentProvider: PaymentProvider = {
  async createCreditCheckout(user, pack, returnUrl) {
    const reference = `mockpay_${randomUUID()}`;
    const params = new URLSearchParams({
      user: user.id,
      ref: reference,
      pack: pack.id,
      credits: String(pack.credits),
      cents: String(pack.priceCents),
      return: returnUrl,
    });
    return { url: `/dev/checkout.html?${params}`, reference };
  },
};
