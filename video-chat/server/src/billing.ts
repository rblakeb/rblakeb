import { randomUUID } from "node:crypto";
import { ADULT_PRICING, REFUND_POLICY, type CreditPack } from "./config.ts";
import { allUsers, creditBalance, getUserById, type CreditLot, type User } from "./users.ts";

const DAY_MS = 86_400_000;

export interface PaymentProvider {
  // Returns a URL for the processor's hosted checkout (CCBill, Segpay, ...).
  createCreditCheckout(user: User, pack: CreditPack, returnUrl: string): Promise<{ url: string; reference: string }>;
  // Refunds part or all of an earlier charge to the card it was paid with.
  // Resolves false when the processor can't (card expired, charge too old).
  refund(paymentRef: string, amountCents: number): Promise<boolean>;
}

export interface Notifier {
  notify(user: User, message: Notice): Promise<void>;
}

export type Notice =
  | { kind: "inactivity_reminder"; credits: number; refundOn: number }
  | { kind: "refunded"; reason: RefundReason; refundedCents: number }
  | { kind: "refund_failed"; reason: RefundReason; failedCents: number };

export type RefundReason = "requested" | "inactivity" | "shutdown";

// Every refund attempt, for the books and for following up on failures.
export interface RefundRecord {
  userId: string;
  paymentRef: string;
  amountCents: number;
  credits: number;
  reason: RefundReason;
  succeeded: boolean;
  at: number;
}

// In-memory for the MVP; store alongside users in the database.
const appliedPayments = new Set<string>();
export const refundLog: RefundRecord[] = [];
let salesClosed = false;

export function areSalesClosed(): boolean {
  return salesClosed;
}

// Called from the processor's "payment succeeded" webhook. Processors retry
// webhooks, so the same payment can arrive more than once and must only add
// credits once.
export function grantCredits(
  userId: string,
  pack: Pick<CreditPack, "credits" | "priceCents">,
  paymentRef: string,
  email?: string,
  now = Date.now(),
): User | undefined {
  const user = getUserById(userId);
  if (!user) return undefined;
  if (appliedPayments.has(paymentRef)) return user;
  appliedPayments.add(paymentRef);
  user.creditLots.push({
    paymentRef,
    purchasedAt: now,
    packCredits: pack.credits,
    packCents: pack.priceCents,
    remaining: pack.credits,
    refundFailed: false,
  });
  if (email) user.email = email;
  return user;
}

export type SpendResult = "ok" | "insufficient_credits";

// Spends credits on 24h of adult access, oldest purchase first. Extends an
// active pass rather than resetting it, so unlocking early never loses time.
export function spendOnDayPass(user: User, now = Date.now()): SpendResult {
  let cost = ADULT_PRICING.dayPassCredits;
  if (creditBalance(user) < cost) return "insufficient_credits";
  for (const lot of user.creditLots) {
    const take = Math.min(lot.remaining, cost);
    lot.remaining -= take;
    cost -= take;
    if (cost === 0) break;
  }
  const start = Math.max(now, user.adultPassExpiresAt ?? 0);
  user.adultPassExpiresAt = start + ADULT_PRICING.dayPassHours * 3_600_000;
  return "ok";
}

// What's left of a purchase in cents: the charge minus the value of credits
// used, with rounding in the customer's favor. All unused = full charge back.
export function refundValueCents(lot: CreditLot): number {
  const used = lot.packCredits - lot.remaining;
  return lot.packCents - Math.floor((used * lot.packCents) / lot.packCredits);
}

export function refundableCents(user: User): number {
  return user.creditLots.reduce((sum, lot) => sum + (lot.remaining > 0 ? refundValueCents(lot) : 0), 0);
}

export interface RefundSummary {
  refundedCents: number;
  refundedCredits: number;
  failedCents: number;
  failedCredits: number;
}

// Refunds every unused credit back to the charge it came from. Credits whose
// refund fails stay on the account (still usable) and are flagged for a manual
// refund by another method.
export async function refundUnusedCredits(
  user: User,
  provider: PaymentProvider,
  reason: RefundReason,
  now = Date.now(),
): Promise<RefundSummary> {
  const summary: RefundSummary = { refundedCents: 0, refundedCredits: 0, failedCents: 0, failedCredits: 0 };
  for (const lot of user.creditLots) {
    if (lot.remaining === 0) continue;
    // The automatic sweep doesn't keep retrying refunds that already failed.
    if (reason === "inactivity" && lot.refundFailed) continue;
    const amountCents = refundValueCents(lot);
    const credits = lot.remaining;
    const succeeded = await provider.refund(lot.paymentRef, amountCents);
    refundLog.push({ userId: user.id, paymentRef: lot.paymentRef, amountCents, credits, reason, succeeded, at: now });
    if (succeeded) {
      lot.remaining = 0;
      lot.refundFailed = false;
      summary.refundedCents += amountCents;
      summary.refundedCredits += credits;
    } else {
      lot.refundFailed = true;
      summary.failedCents += amountCents;
      summary.failedCredits += credits;
    }
  }
  return summary;
}

async function refundAndNotify(user: User, provider: PaymentProvider, notifier: Notifier, reason: RefundReason, now: number) {
  const summary = await refundUnusedCredits(user, provider, reason, now);
  if (summary.refundedCents > 0) await notifier.notify(user, { kind: "refunded", reason, refundedCents: summary.refundedCents });
  if (summary.failedCents > 0) await notifier.notify(user, { kind: "refund_failed", reason, failedCents: summary.failedCents });
  return summary;
}

// Run periodically. Reminds inactive users who hold credits, then refunds them.
export async function runInactivitySweep(provider: PaymentProvider, notifier: Notifier, now = Date.now()): Promise<void> {
  for (const user of allUsers()) {
    // Skip balances whose refund already failed; retrying won't help.
    if (!user.creditLots.some((lot) => lot.remaining > 0 && !lot.refundFailed)) continue;
    const idleDays = (now - user.lastActiveAt) / DAY_MS;
    if (idleDays >= REFUND_POLICY.inactivityRefundDays) {
      await refundAndNotify(user, provider, notifier, "inactivity", now);
    } else if (idleDays >= REFUND_POLICY.inactivityReminderDays && !(user.inactivityReminderSentAt && user.inactivityReminderSentAt > user.lastActiveAt)) {
      user.inactivityReminderSentAt = now;
      await notifier.notify(user, {
        kind: "inactivity_reminder",
        credits: creditBalance(user),
        refundOn: user.lastActiveAt + REFUND_POLICY.inactivityRefundDays * DAY_MS,
      });
    }
  }
}

// Shutting the site down: stop selling credits and refund every unused one.
// Returns totals plus the users whose refunds failed and need paying another way.
export async function windDown(provider: PaymentProvider, notifier: Notifier, now = Date.now()) {
  salesClosed = true;
  const totals: RefundSummary = { refundedCents: 0, refundedCredits: 0, failedCents: 0, failedCredits: 0 };
  const needsManualRefund: { userId: string; email: string | null; cents: number }[] = [];
  for (const user of allUsers()) {
    if (creditBalance(user) === 0) continue;
    const s = await refundAndNotify(user, provider, notifier, "shutdown", now);
    totals.refundedCents += s.refundedCents;
    totals.refundedCredits += s.refundedCredits;
    totals.failedCents += s.failedCents;
    totals.failedCredits += s.failedCredits;
    if (s.failedCents > 0) needsManualRefund.push({ userId: user.id, email: user.email, cents: s.failedCents });
  }
  return { ...totals, needsManualRefund };
}

// Development stand-ins. The mock checkout page is /dev/checkout.html.
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
  async refund(paymentRef, amountCents) {
    console.log(`[mock refund] ${paymentRef}: $${(amountCents / 100).toFixed(2)}`);
    return true;
  },
};

export const consoleNotifier: Notifier = {
  async notify(user, message) {
    console.log(`[notify] ${user.email ?? user.id}: ${JSON.stringify(message)}`);
  },
};
