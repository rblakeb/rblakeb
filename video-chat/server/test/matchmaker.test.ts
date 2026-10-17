import { test } from "node:test";
import assert from "node:assert/strict";
import { MATCHING } from "../src/config.ts";
import { Matchmaker } from "../src/matchmaker.ts";

const entry = (userId: string, extra: Partial<{ intent: "chat" | "music"; languages: string[]; tags: string[] }> = {}) => ({
  userId,
  intent: extra.intent ?? "chat",
  languages: extra.languages ?? [],
  tags: extra.tags ?? [],
});

test("pairs two people in the same intent", () => {
  const mm = new Matchmaker();
  assert.equal(mm.enqueue(entry("a")), null);
  const match = mm.enqueue(entry("b"));
  assert.deepEqual([match?.a.userId, match?.b.userId], ["b", "a"]);
});

test("never pairs across intents", () => {
  const mm = new Matchmaker();
  mm.enqueue(entry("a", { intent: "music" }));
  assert.equal(mm.enqueue(entry("b", { intent: "chat" })), null);
});

test("language filter holds until widened", () => {
  const mm = new Matchmaker();
  const t0 = 1_000_000;
  mm.enqueue(entry("a", { languages: ["es"] }), t0);
  assert.equal(mm.enqueue(entry("b", { languages: ["en"] }), t0), null);
  assert.equal(mm.sweep(t0 + 1000).length, 0);
  assert.equal(mm.sweep(t0 + MATCHING.widenAfterMs).length, 1);
});

test("prefers the candidate with more shared tags", () => {
  const mm = new Matchmaker();
  // a and c speak different languages so they don't pair with each other.
  mm.enqueue(entry("a", { languages: ["en"], tags: ["rock"] }));
  mm.enqueue(entry("c", { languages: ["es"], tags: ["techno", "house"] }));
  const match = mm.enqueue(entry("d", { languages: ["en", "es"], tags: ["House", "techno"] }));
  assert.equal(match?.b.userId, "c");
});

test("does not immediately re-pair the same two people", () => {
  const mm = new Matchmaker();
  mm.enqueue(entry("a"));
  assert.ok(mm.enqueue(entry("b")));
  mm.enqueue(entry("a"));
  assert.equal(mm.enqueue(entry("b")), null);
});

test("skips candidates that fail the access check", () => {
  const mm = new Matchmaker((id) => id !== "a");
  mm.enqueue(entry("a"));
  assert.equal(mm.enqueue(entry("b")), null);
});
