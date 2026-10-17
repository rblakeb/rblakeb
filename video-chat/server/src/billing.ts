import { randomUUID } from "node:crypto";
import { ADULT_PRICING, REFUND_POLICY, type CreditPack } from "./config.ts";
import { getDb } from "./db.ts";
import { creditBalance, loadUser, type CreditLot, type User } from "./users.ts";

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

export async function areSalesClosed(): Promise<boolean> {
  const [row] = await getDb().query<{ value: boolean }>("select value from settings where key = 'sales_closed'");
  return row?.value === true;
}

// Called from the processor's "payment succeeded" webhook. Processors retry
// webhooks; the payment reference is the primary key, so a repeat adds nothing.
export async function grantCredits(
  userId: string,
  pack: Pick<CreditPack, "credits" | "priceCents">,
  paymentRef: string,
  email?: string,
  now = Date.now(),
): Promise<User | undefined> {
  const db = getDb();
  const exists = await db.query("select 1 from users where id = $1", [userId]);
  if (!exists.length) return undefined;
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into credit_lots (payment_ref, user_id, purchased_at, pack_credits, pack_cents, remaining)
       values ($1, $2, $3, $4, $5, $4) on conflict (payment_ref) do nothing`,
      [paymentRef, userId, new Date(now), pack.credits, pack.priceCents],
    );
    if (email) await tx.query("update users set email = $2 where id = $1", [userId, email]);
  });
  return loadUser(userId);
}

export type SpendResult = "ok" | "insufficient_credits";

// Spends credits on 24h of adult access, oldest purchase first. Extends an
// active pass rather than resetting it, so unlocking early never loses time.
// Locks the user's credits so two requests at once can't spend the same credit.
export async function spendOnDayPass(userId: string, now = Date.now()): Promise<SpendResult> {
  const result = await getDb().transaction(async (tx) => {
    const [user] = await tx.query<{ adult_pass_expires_at: Date | null }>(
      "select adult_pass_expires_at from users where id = $1 for update",
      [userId],
    );
    if (!user) return "insufficient_credits" as const;
    const lots = await tx.query<{ payment_ref: string; remaining: number }>(
      `select payment_ref, remaining from credit_lots
       where user_id = $1 and remaining > 0 order by purchased_at, payment_ref for update`,
      [userId],
    );
    let cost = ADULT_PRICING.dayPassCredits;
    if (lots.reduce((sum, l) => sum + l.remaining, 0) < cost) return "insufficient_credits" as const;
    for (const lot of lots) {
      const take = Math.min(lot.remaining, cost);
      await tx.query("update credit_lots set remaining = remaining - $2 where payment_ref = $1", [lot.payment_ref, take]);
      cost -= take;
      if (cost === 0) break;
    }
    const start = Math.max(now, user.adult_pass_expires_at?.getTime() ?? 0);
    await tx.query("update users set adult_pass_expires_at = $2 where id = $1", [
      userId,
      new Date(start + ADULT_PRICING.dayPassHours * 3_600_000),
    ]);
    return "ok" as const;
  });
  await loadUser(userId);
  return result;
}

// What's left of a purchase in cents: the charge minus the value of credits
// used, with rounding in the customer's favor. All unused = full charge back.
export function refundValueCents(lot: Pick<CreditLot, "packCredits" | "packCents" | "remaining">): number {
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
// refund fails go back on the account (still usable), flagged for a manual
// refund by another method.
export async function refundUnusedCredits(
  userId: string,
  provider: PaymentProvider,
  reason: RefundReason,
  now = Date.now(),
): Promise<RefundSummary> {
  const db = getDb();
  const summary: RefundSummary = { refundedCents: 0, refundedCredits: 0, failedCents: 0, failedCredits: 0 };
  // The automatic sweep doesn't keep retrying refunds that already failed.
  const lots = await db.query<{ payment_ref: string }>(
    `select payment_ref from credit_lots where user_id = $1 and remaining > 0
     ${reason === "inactivity" ? "and not refund_failed" : ""} order by purchased_at, payment_ref`,
    [userId],
  );

  for (const { payment_ref } of lots) {
    // Claim the lot's credits (so they can't be spent or refunded twice while
    // the processor call is in flight) and log the attempt as pending.
    const claim = await db.transaction(async (tx) => {
      const [lot] = await tx.query<{ remaining: number; pack_credits: number; pack_cents: number }>(
        "select remaining, pack_credits, pack_cents from credit_lots where payment_ref = $1 and remaining > 0 for update",
        [payment_ref],
      );
      if (!lot) return null;
      const amountCents = refundValueCents({ packCredits: lot.pack_credits, packCents: lot.pack_cents, remaining: lot.remaining });
      await tx.query("update credit_lots set remaining = 0 where payment_ref = $1", [payment_ref]);
      const [refund] = await tx.query<{ id: string }>(
        `insert into refunds (user_id, payment_ref, amount_cents, credits, reason, created_at)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [userId, payment_ref, amountCents, lot.remaining, reason, new Date(now)],
      );
      return { refundId: refund.id, credits: lot.remaining, amountCents };
    });
    if (!claim) continue;

    const succeeded = await provider.refund(payment_ref, claim.amountCents).catch(() => false);
    await db.transaction(async (tx) => {
      await tx.query("update refunds set succeeded = $2 where id = $1", [claim.refundId, succeeded]);
      if (succeeded) {
        await tx.query("update credit_lots set refund_failed = false where payment_ref = $1", [payment_ref]);
      } else {
        await tx.query("update credit_lots set remaining = remaining + $2, refund_failed = true where payment_ref = $1", [
          payment_ref,
          claim.credits,
        ]);
      }
    });
    if (succeeded) {
      summary.refundedCents += claim.amountCents;
      summary.refundedCredits += claim.credits;
    } else {
      summary.failedCents += claim.amountCents;
      summary.failedCredits += claim.credits;
    }
  }
  await loadUser(userId);
  return summary;
}

async function refundAndNotify(userId: string, provider: PaymentProvider, notifier: Notifier, reason: RefundReason, now: number) {
  const summary = await refundUnusedCredits(userId, provider, reason, now);
  const user = await loadUser(userId);
  if (user && summary.refundedCents > 0) await notifier.notify(user, { kind: "refunded", reason, refundedCents: summary.refundedCents });
  if (user && summary.failedCents > 0) await notifier.notify(user, { kind: "refund_failed", reason, failedCents: summary.failedCents });
  return summary;
}

// Run periodically. Reminds inactive users who hold credits, then refunds them.
export async function runInactivitySweep(provider: PaymentProvider, notifier: Notifier, now = Date.now()): Promise<void> {
  const db = getDb();
  const reminderCutoff = new Date(now - REFUND_POLICY.inactivityReminderDays * DAY_MS);
  const candidates = await db.query<{ id: string }>(
    `select distinct u.id from users u join credit_lots l on l.user_id = u.id
     where l.remaining > 0 and not l.refund_failed and u.last_active_at <= $1`,
    [reminderCutoff],
  );
  for (const { id } of candidates) {
    const user = await loadUser(id);
    if (!user) continue;
    const idleDays = (now - user.lastActiveAt) / DAY_MS;
    if (idleDays >= REFUND_POLICY.inactivityRefundDays) {
      await refundAndNotify(id, provider, notifier, "inactivity", now);
    } else if (!(user.inactivityReminderSentAt && user.inactivityReminderSentAt > user.lastActiveAt)) {
      await db.query("update users set inactivity_reminder_sent_at = $2 where id = $1", [id, new Date(now)]);
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
  const db = getDb();
  await db.query(
    "insert into settings (key, value) values ('sales_closed', 'true') on conflict (key) do update set value = 'true'",
  );
  const totals: RefundSummary = { refundedCents: 0, refundedCredits: 0, failedCents: 0, failedCredits: 0 };
  const needsManualRefund: { userId: string; email: string | null; cents: number }[] = [];
  const holders = await db.query<{ user_id: string; email: string | null }>(
    `select distinct l.user_id, u.email from credit_lots l join users u on u.id = l.user_id where l.remaining > 0`,
  );
  for (const { user_id, email } of holders) {
    const s = await refundAndNotify(user_id, provider, notifier, "shutdown", now);
    totals.refundedCents += s.refundedCents;
    totals.refundedCredits += s.refundedCredits;
    totals.failedCents += s.failedCents;
    totals.failedCredits += s.failedCredits;
    if (s.failedCents > 0) needsManualRefund.push({ userId: user_id, email, cents: s.failedCents });
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
