import { before, test } from "node:test";
import assert from "node:assert/strict";
import { grantCredits } from "../src/billing.ts";
import { addUserTurn, CALL_OPENER, hasUserSpeech, startConversation, transcript } from "../src/companion.ts";
import { canCall, chargeCallTime, deleteMemory, getMemory, saveMemory } from "../src/companionAccount.ts";
import { COMPANION_PRICING } from "../src/config.ts";
import { creditBalance, loadUser } from "../src/users.ts";
import { freshDb, newUser, ref } from "./helpers.ts";

before(freshDb);

const TRIAL = COMPANION_PRICING.freeTrialMinutes * 60;
const BLOCK = COMPANION_PRICING.minutesPerCredit * 60;

test("new accounts start with the free trial", async () => {
  const user = await newUser();
  assert.equal(user.companionSeconds, TRIAL);
  assert.ok(canCall(user));
});

test("call time comes out of the trial first", async () => {
  const user = await newUser();
  const balance = await chargeCallTime(user.id, 100);
  assert.deepEqual(balance, { secondsRemaining: TRIAL - 100, credits: 0, exhausted: false });
});

test("when the trial runs out, a credit becomes a block of minutes", async () => {
  const user = await newUser();
  await grantCredits(user.id, { credits: 5, priceCents: 500 }, ref());
  const balance = await chargeCallTime(user.id, TRIAL + 60);
  assert.equal(balance.exhausted, false);
  assert.equal(balance.credits, 4);
  assert.equal(balance.secondsRemaining, BLOCK - 60);
  assert.equal(creditBalance((await loadUser(user.id))!), 4);
});

test("a long charge converts as many credits as it needs", async () => {
  const user = await newUser();
  await grantCredits(user.id, { credits: 5, priceCents: 500 }, ref());
  const balance = await chargeCallTime(user.id, TRIAL + BLOCK * 2 + 1);
  assert.equal(balance.credits, 2);
  assert.equal(balance.secondsRemaining, BLOCK - 1);
});

test("with no time or credits left the charge is exhausted and the user can't call", async () => {
  const user = await newUser();
  const balance = await chargeCallTime(user.id, TRIAL + 10);
  assert.deepEqual(balance, { secondsRemaining: 0, credits: 0, exhausted: true });
  assert.equal(canCall((await loadUser(user.id))!), false);
});

test("two charges at once don't convert the same credit twice", async () => {
  const user = await newUser();
  await chargeCallTime(user.id, TRIAL);
  await grantCredits(user.id, { credits: 1, priceCents: 100 }, ref());
  const results = await Promise.all([chargeCallTime(user.id, 30), chargeCallTime(user.id, 30)]);
  assert.ok(results.every((r) => !r.exhausted));
  const after = (await loadUser(user.id))!;
  assert.equal(after.companionSeconds, BLOCK - 60);
  assert.equal(creditBalance(after), 0);
});

test("memory is saved, replaced, kept per character, and can be cleared", async () => {
  const user = await newUser();
  assert.equal(await getMemory(user.id, "tutor"), "");
  await saveMemory(user.id, "tutor", "Learning French, beginner.");
  await saveMemory(user.id, "tutor", "Learning French, now intermediate.");
  await saveMemory(user.id, "music", "Plays bass.");
  assert.equal(await getMemory(user.id, "tutor"), "Learning French, now intermediate.");
  assert.equal(await getMemory(user.id, "music"), "Plays bass.");
  await deleteMemory(user.id, "tutor");
  assert.equal(await getMemory(user.id, "tutor"), "");
  assert.equal(await getMemory(user.id, "music"), "Plays bass.");
});

test("the transcript skips the hidden opener and camera frames", () => {
  const c = startConversation("u", "music", "en");
  addUserTurn(c, CALL_OPENER);
  c.messages.push({ role: "assistant", content: "Hey! What are you playing?" });
  assert.equal(hasUserSpeech(c), false);
  addUserTurn(c, "my new bass", "aGVsbG8=");
  assert.equal(transcript(c), "Jay: Hey! What are you playing?\nUser: my new bass");
  assert.equal(hasUserSpeech(c), true);
});
