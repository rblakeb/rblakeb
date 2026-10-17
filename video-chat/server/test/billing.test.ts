import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  areSalesClosed,
  grantCredits,
  refundableCents,
  refundUnusedCredits,
  runInactivitySweep,
  spendOnDayPass,
  windDown,
  type Notice,
  type Notifier,
  type PaymentProvider,
} from "../src/billing.ts";
import { getDb } from "../src/db.ts";
import { creditBalance, loadUser } from "../src/users.ts";
import { freshDb, newUser, ref } from "./helpers.ts";

const DAY = 86_400_000;

before(freshDb);

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

// Tests share one database, so only record notices for the user under test.
function fakeNotifier(onlyUserId?: string): Notifier & { sent: Notice[] } {
  const sent: Notice[] = [];
  return {
    sent,
    async notify(user, message) {
      if (!onlyUserId || user.id === onlyUserId) sent.push(message);
    },
  };
}

const balance = async (id: string) => creditBalance((await loadUser(id))!);

test("a retried payment webhook only adds credits once", async () => {
  const user = await newUser();
  const r = ref();
  await grantCredits(user.id, { credits: 12, priceCents: 1000 }, r);
  await grantCredits(user.id, { credits: 12, priceCents: 1000 }, r);
  assert.equal(await balance(user.id), 12);
});

test("credits for an unknown user are not granted", async () => {
  assert.equal(await grantCredits("00000000-0000-0000-0000-000000000000", { credits: 5, priceCents: 500 }, ref()), undefined);
});

test("spends the oldest purchase first", async () => {
  const user = await newUser();
  const now = Date.now();
  await grantCredits(user.id, { credits: 1, priceCents: 100 }, ref(), undefined, now - 1000);
  await grantCredits(user.id, { credits: 5, priceCents: 500 }, ref(), undefined, now);
  await spendOnDayPass(user.id);
  const lots = (await loadUser(user.id))!.creditLots;
  assert.deepEqual(lots.map((l) => l.remaining), [0, 5]);
});

test("refunds unused credits at the price paid, in the customer's favor", async () => {
  const user = await newUser();
  const r = ref();
  await grantCredits(user.id, { credits: 12, priceCents: 1000 }, r);
  await spendOnDayPass(user.id);
  // 1 of 12 credits used: $10.00 - floor(83.3c) = $9.17
  assert.equal(refundableCents((await loadUser(user.id))!), 917);
  const provider = fakeProvider();
  const summary = await refundUnusedCredits(user.id, provider, "requested");
  assert.deepEqual(provider.refunds, [[r, 917]]);
  assert.equal(summary.refundedCredits, 11);
  assert.equal(await balance(user.id), 0);
  const [row] = await getDb().query<{ succeeded: boolean; amount_cents: number }>(
    "select succeeded, amount_cents from refunds where payment_ref = $1",
    [r],
  );
  assert.deepEqual(row, { succeeded: true, amount_cents: 917 });
});

test("an untouched pack refunds in full", async () => {
  const user = await newUser();
  await grantCredits(user.id, { credits: 12, priceCents: 1000 }, ref());
  assert.equal(refundableCents((await loadUser(user.id))!), 1000);
});

test("a failed refund keeps the credits usable and flags them", async () => {
  const user = await newUser();
  const r = ref();
  await grantCredits(user.id, { credits: 5, priceCents: 500 }, r);
  const summary = await refundUnusedCredits(user.id, fakeProvider([r]), "requested");
  assert.equal(summary.failedCents, 500);
  const after = (await loadUser(user.id))!;
  assert.equal(creditBalance(after), 5);
  assert.equal(after.creditLots[0].refundFailed, true);
  const [row] = await getDb().query<{ succeeded: boolean }>("select succeeded from refunds where payment_ref = $1", [r]);
  assert.equal(row.succeeded, false);
});

async function idleUserWithCredits(failRef?: string) {
  const user = await newUser();
  const r = failRef ?? ref();
  await grantCredits(user.id, { credits: 5, priceCents: 500 }, r, "a@example.com", user.lastActiveAt);
  return { user, ref: r };
}

test("inactive accounts get a reminder, then a refund", async () => {
  const { user } = await idleUserWithCredits();
  const t0 = user.lastActiveAt;
  const provider = fakeProvider();
  const notifier = fakeNotifier(user.id);

  await runInactivitySweep(provider, notifier, t0 + 100 * DAY);
  assert.equal(notifier.sent.length, 0);

  await runInactivitySweep(provider, notifier, t0 + 151 * DAY);
  await runInactivitySweep(provider, notifier, t0 + 152 * DAY);
  assert.deepEqual(notifier.sent.map((n) => n.kind), ["inactivity_reminder"]);

  await runInactivitySweep(provider, notifier, t0 + 181 * DAY);
  assert.equal(await balance(user.id), 0);
  assert.deepEqual(notifier.sent.map((n) => n.kind), ["inactivity_reminder", "refunded"]);
});

test("the sweep doesn't retry a refund that already failed", async () => {
  const failing = ref();
  const { user } = await idleUserWithCredits(failing);
  const notifier = fakeNotifier(user.id);
  const provider = fakeProvider([failing]);
  await runInactivitySweep(provider, notifier, user.lastActiveAt + 181 * DAY);
  await runInactivitySweep(provider, notifier, user.lastActiveAt + 182 * DAY);
  assert.deepEqual(notifier.sent.map((n) => n.kind), ["refund_failed"]);
});

// Runs last: wind-down closes sales for the whole database.
test("wind-down closes sales and refunds every unused credit", async () => {
  const a = await newUser();
  const b = await newUser();
  const failing = ref();
  await grantCredits(a.id, { credits: 12, priceCents: 1000 }, ref());
  await grantCredits(b.id, { credits: 5, priceCents: 500 }, failing, "b@example.com");
  const result = await windDown(fakeProvider([failing]), fakeNotifier());
  assert.equal(await areSalesClosed(), true);
  assert.equal(await balance(a.id), 0);
  assert.ok(result.needsManualRefund.some((x) => x.userId === b.id && x.email === "b@example.com" && x.cents === 500));
});
