import { randomUUID } from "node:crypto";
import { ADULT_PRICING } from "./config.ts";
import { getUserById, type User } from "./users.ts";

export interface PaymentProvider {
  // Returns a URL for the processor's hosted checkout (CCBill, Segpay, Epoch, ...).
  createDayPassCheckout(user: User, returnUrl: string): Promise<{ url: string; reference: string }>;
}

// Called from the processor's "payment succeeded" webhook. Extends an active
// pass rather than resetting it, so buying early never loses time.
export function grantDayPass(userId: string, now = Date.now()): User | undefined {
  const user = getUserById(userId);
  if (!user) return undefined;
  const start = Math.max(now, user.adultPassExpiresAt ?? 0);
  user.adultPassExpiresAt = start + ADULT_PRICING.dayPassHours * 3_600_000;
  return user;
}

// Development stand-in. Its checkout page is /dev/checkout.html.
export const mockPaymentProvider: PaymentProvider = {
  async createDayPassCheckout(user, returnUrl) {
    const reference = `mockpay_${randomUUID()}`;
    const url = `/dev/checkout.html?user=${encodeURIComponent(user.id)}&ref=${reference}&cents=${ADULT_PRICING.dayPassCents}&return=${encodeURIComponent(returnUrl)}`;
    return { url, reference };
  },
};
