import { before, test } from "node:test";
import assert from "node:assert/strict";
import { checkAccess } from "../src/access.ts";
import { grantCredits, spendOnDayPass } from "../src/billing.ts";
import { getIntent } from "../src/config.ts";
import { creditBalance, loadUser } from "../src/users.ts";
import { applyVerificationResult } from "../src/verification.ts";
import { freshDb, newUser, ref, verifiedUser } from "./helpers.ts";

const adult = getIntent("adult")!;
const chat = getIntent("chat")!;

before(freshDb);

test("non-adult intents are open to everyone not banned", async () => {
  const user = await newUser();
  assert.equal(checkAccess(user, chat), null);
  user.banned = true;
  assert.equal(checkAccess(user, chat), "banned");
});

test("adult requires verification regardless of sex", async () => {
  const user = await newUser();
  assert.equal(checkAccess(user, adult), "not_verified");
  const minor = await applyVerificationResult({ userId: user.id, reference: "r", approved: true, isAdult: false, documentSex: "F" });
  assert.equal(checkAccess(minor!, adult), "not_verified");
  assert.equal(minor!.verifiedSex, null);
});

test("verified women enter adult free", async () => {
  assert.equal(checkAccess(await verifiedUser("F"), adult), null);
});

test("verified men need an active day pass, bought with credits", async () => {
  const user = await verifiedUser("M");
  const now = Date.now();
  assert.equal(checkAccess(user, adult, now), "payment_required");
  assert.equal(await spendOnDayPass(user.id, now), "insufficient_credits");
  await grantCredits(user.id, { credits: 5, priceCents: 500 }, ref());
  assert.equal(await spendOnDayPass(user.id, now), "ok");
  const after = (await loadUser(user.id))!;
  assert.equal(creditBalance(after), 4);
  assert.equal(checkAccess(after, adult, now), null);
  assert.equal(checkAccess(after, adult, now + 25 * 3_600_000), "payment_required");
});

test("unlocking early extends rather than resets", async () => {
  const user = await verifiedUser("M");
  const now = Date.now();
  await grantCredits(user.id, { credits: 2, priceCents: 200 }, ref());
  await spendOnDayPass(user.id, now);
  await spendOnDayPass(user.id, now + 3_600_000);
  assert.equal((await loadUser(user.id))!.adultPassExpiresAt, now + 48 * 3_600_000);
});

test("two unlocks at once can't spend the same credit", async () => {
  const user = await verifiedUser("M");
  await grantCredits(user.id, { credits: 1, priceCents: 100 }, ref());
  const results = await Promise.all([spendOnDayPass(user.id), spendOnDayPass(user.id)]);
  assert.deepEqual(results.sort(), ["insufficient_credits", "ok"]);
  assert.equal(creditBalance((await loadUser(user.id))!), 0);
});
