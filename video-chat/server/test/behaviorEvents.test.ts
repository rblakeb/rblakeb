import { test } from "node:test";
import assert from "node:assert/strict";
// The browser's camera-event rules; plain JS, so it runs here too.
import { BehaviorDetector, yawFromMatrix, type BehaviorFrame } from "../../public/behaviorEvents.js";

// Feeds `frame` every 100 ms for `ms` and returns the events seen.
function run(detector: BehaviorDetector, events: string[], from: number, ms: number, frame: Omit<BehaviorFrame, "t">) {
  for (let t = from; t <= from + ms; t += 100) detector.update({ t, ...frame });
  return events;
}

const face = { faceVisible: true, smile: 0, jawOpen: 0, yawDeg: 0, gesture: null };

test("a held smile fires once, and again only after it clears", () => {
  const events: string[] = [];
  const d = new BehaviorDetector((e) => events.push(e));
  run(d, events, 0, 300, { ...face, smile: 0.8 });
  assert.deepEqual(events, []); // too short
  run(d, events, 400, 2000, { ...face, smile: 0.8 });
  assert.deepEqual(events, ["smile"]);
  run(d, events, 2500, 1200, face);
  run(d, events, 3800, 800, { ...face, smile: 0.8 });
  assert.deepEqual(events, ["smile", "smile"]);
});

test("a smile with an open mouth is a laugh", () => {
  const events: string[] = [];
  run(new BehaviorDetector((e) => events.push(e)), events, 0, 800, { ...face, smile: 0.9, jawOpen: 0.6 });
  assert.deepEqual(events, ["laugh"]);
});

test("a wave and a thumbs up are recognized, with a pause before repeating", () => {
  const events: string[] = [];
  const d = new BehaviorDetector((e) => events.push(e));
  run(d, events, 0, 600, { ...face, gesture: "Open_Palm" });
  run(d, events, 700, 1000, face);
  run(d, events, 1800, 600, { ...face, gesture: "Open_Palm" }); // within the re-arm pause
  run(d, events, 2500, 600, { ...face, gesture: "Thumb_Up" });
  assert.deepEqual(events, ["wave", "thumbs_up"]);
});

test("looking away for a few seconds, then back", () => {
  const events: string[] = [];
  const d = new BehaviorDetector((e) => events.push(e));
  run(d, events, 0, 2000, { ...face, yawDeg: 45 });
  assert.deepEqual(events, []);
  run(d, events, 2100, 1500, { ...face, yawDeg: -45 });
  run(d, events, 3700, 1200, face);
  assert.deepEqual(events, ["away", "back"]);
});

test("leaving the frame and coming back", () => {
  const events: string[] = [];
  const d = new BehaviorDetector((e) => events.push(e));
  run(d, events, 0, 5200, { faceVisible: false });
  run(d, events, 5300, 1200, face);
  assert.deepEqual(events, ["left", "returned"]);
});

test("yaw comes out of the face transform", () => {
  const facing = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.equal(Math.round(yawFromMatrix(facing)), 0);
  const a = (40 * Math.PI) / 180;
  const turned = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
  assert.equal(Math.round(yawFromMatrix(turned)), 40);
});
