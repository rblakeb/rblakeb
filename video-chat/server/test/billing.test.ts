import { test } from "node:test";
import assert from "node:assert/strict";
import {
  areSalesClosed,
  grantCredits,
  refundableCents,
  refundLog,
  refundUnusedCredits,
  runInactivitySweep,
  spendOnDayPass,
  windDown,
  type Notice,
  type Notifier,
  type PaymentProvider,
} from "../src/billing.ts";
import { createUser, creditBalance } from "../src/users.ts";

const DAY = 86_400_000;
let refCounter = 0;
const ref = () => `pay_${++refCounter}`;

function fakeProvider(failRefs: string[] = []): PaymentProvider & { refunds: [string, number][] } {
  const refunds: [string, number][] = [];
  return {
    refunds,
    async createCreditCheckout() {
      return { url: "", reference: "" };
    },
    async refund(paymentRef, amountCents) {
      if (failRefs.includes(paymentRef)) return false;
      refunds.push([paymentRef, amountCents]);
      return true;
    },
  };
}

// Tests share one user store, so only record notices for the user under test.
function fakeNotifier(onlyUserId?: string): Notifier & { sent: Notice[] } {
  const sent: Notice[] = [];
  return {
    sent,
    async notify(user, message) {
      if (!onlyUserId || user.id === onlyUserId) sent.push(message);
    },
  };
}

test("a retried payment webhook only adds credits once", () => {
  const user = createUser("t");
  const r = ref();
  grantCredits(user.id, { credits: 12, priceCents: 1000 }, r);
  grantCredits(user.id, { credits: 12, priceCents: 1000 }, r);
  assert.equal(creditBalance(user), 12);
});

test("spends the oldest purchase first", () => {
  const user = createUser("t");
  const first = ref();
  grantCredits(user.id, { credits: 1, priceCents: 100 }, first);
  grantCredits(user.id, { credits: 5, priceCents: 500 }, ref());
  spendOnDayPass(user);
  assert.equal(user.creditLots[0].remaining, 0);
  assert.equal(user.creditLots[1].remaining, 5);
});

test("refunds unused credits at the price paid, in the customer's favor", async () => {
  const user = createUser("t");
  const r = ref();
  grantCredits(user.id, { credits: 12, priceCents: 1000 }, r);
  spendOnDayPass(user);
  // 1 of 12 credits used: $10.00 - floor(83.3c) = $9.17
  assert.equal(refundableCents(user), 917);
  const provider = fakeProvider();
  const summary = await refundUnusedCredits(user, provider, "requested");
  assert.deepEqual(provider.refunds, [[r, 917]]);
  assert.equal(summary.refundedCredits, 11);
  assert.equal(creditBalance(user), 0);
});

test("an untouched pack refunds in full", async () => {
  const user = createUser("t");
  grantCredits(user.id, { credits: 12, priceCents: 1000 }, ref());
  assert.equal(refundableCents(user), 1000);
});

test("a failed refund keeps the credits usable and flags them", async () => {
  const user = createUser("t");
  const r = ref();
  grantCredits(user.id, { credits: 5, priceCents: 500 }, r);
  const summary = await refundUnusedCredits(user, fakeProvider([r]), "requested");
  assert.equal(summary.failedCents, 500);
  assert.equal(creditBalance(user), 5);
  assert.equal(user.creditLots[0].refundFailed, true);
  assert.ok(refundLog.some((x) => x.paymentRef === r && !x.succeeded));
});

test("inactive accounts get a reminder, then a refund", async () => {
  const user = createUser("t");
  const t0 = user.lastActiveAt;
  grantCredits(user.id, { credits: 5, priceCents: 500 }, ref(), "a@example.com", t0);
  const provider = fakeProvider();
  const notifier = fakeNotifier(user.id);

  await runInactivitySweep(provider, notifier, t0 + 100 * DAY);
  assert.equal(notifier.sent.length, 0);

  await runInactivitySweep(provider, notifier, t0 + 151 * DAY);
  await runInactivitySweep(provider, notifier, t0 + 152 * DAY);
  assert.deepEqual(notifier.sent.map((n) => n.kind), ["inactivity_reminder"]);

  await runInactivitySweep(provider, notifier, t0 + 181 * DAY);
  assert.equal(creditBalance(user), 0);
  assert.deepEqual(notifier.sent.map((n) => n.kind), ["inactivity_reminder", "refunded"]);
});

test("the sweep doesn't retry a refund that already failed", async () => {
  const user = createUser("t");
  const r = ref();
  grantCredits(user.id, { credits: 5, priceCents: 500 }, r, undefined, user.lastActiveAt);
  const notifier = fakeNotifier(user.id);
  const provider = fakeProvider([r]);
  await runInactivitySweep(provider, notifier, user.lastActiveAt + 181 * DAY);
  await runInactivitySweep(provider, notifier, user.lastActiveAt + 182 * DAY);
  assert.deepEqual(notifier.sent.map((n) => n.kind), ["refund_failed"]);
});

// Runs last: wind-down closes sales for the whole process.
test("wind-down closes sales and refunds every unused credit", async () => {
  const a = createUser("a");
  const b = createUser("b");
  const failing = ref();
  grantCredits(a.id, { credits: 12, priceCents: 1000 }, ref());
  grantCredits(b.id, { credits: 5, priceCents: 500 }, failing, "b@example.com");
  const result = await windDown(fakeProvider([failing]), fakeNotifier());
  assert.equal(areSalesClosed(), true);
  assert.equal(creditBalance(a), 0);
  assert.ok(result.needsManualRefund.some((x) => x.userId === b.id && x.email === "b@example.com" && x.cents === 500));
});
