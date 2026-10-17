import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAccess } from "../src/access.ts";
import { grantCredits, spendOnDayPass } from "../src/billing.ts";
import { getIntent } from "../src/config.ts";
import { createUser } from "../src/users.ts";
import { applyVerificationResult } from "../src/verification.ts";

const adult = getIntent("adult")!;
const chat = getIntent("chat")!;

function verified(sex: "M" | "F") {
  const user = createUser("t");
  applyVerificationResult({ userId: user.id, reference: "r", approved: true, isAdult: true, documentSex: sex });
  return user;
}

test("non-adult intents are open to everyone not banned", () => {
  const user = createUser("t");
  assert.equal(checkAccess(user, chat), null);
  user.banned = true;
  assert.equal(checkAccess(user, chat), "banned");
});

test("adult requires verification regardless of sex", () => {
  const user = createUser("t");
  assert.equal(checkAccess(user, adult), "not_verified");
  applyVerificationResult({ userId: user.id, reference: "r", approved: true, isAdult: false, documentSex: "F" });
  assert.equal(checkAccess(user, adult), "not_verified");
  assert.equal(user.verifiedSex, null);
});

test("verified women enter adult free", () => {
  assert.equal(checkAccess(verified("F"), adult), null);
});

test("verified men need an active day pass, bought with credits", () => {
  const user = verified("M");
  const now = Date.now();
  assert.equal(checkAccess(user, adult, now), "payment_required");
  assert.equal(spendOnDayPass(user, now), "insufficient_credits");
  grantCredits(user.id, 5, "pay_1");
  assert.equal(spendOnDayPass(user, now), "ok");
  assert.equal(user.credits, 4);
  assert.equal(checkAccess(user, adult, now), null);
  assert.equal(checkAccess(user, adult, now + 25 * 3_600_000), "payment_required");
});

test("unlocking early extends rather than resets", () => {
  const user = verified("M");
  const now = Date.now();
  grantCredits(user.id, 2, "pay_2");
  spendOnDayPass(user, now);
  spendOnDayPass(user, now + 3_600_000);
  assert.equal(user.adultPassExpiresAt, now + 48 * 3_600_000);
});

test("a retried payment webhook only adds credits once", () => {
  const user = verified("M");
  grantCredits(user.id, 12, "pay_3");
  grantCredits(user.id, 12, "pay_3");
  assert.equal(user.credits, 12);
});
