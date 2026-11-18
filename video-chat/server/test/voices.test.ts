import { test } from "node:test";
import assert from "node:assert/strict";
// The browser's voice picker; plain JS with no browser APIs, so it runs here too.
import { pickVoice, voiceGender } from "../../public/voices.js";

const v = (name: string, lang: string, localService = true) => ({ name, lang, localService });

// Voices as macOS Chrome lists them for English and Spanish, male first, as in the bug report.
const MAC = [
  v("Daniel", "en-GB"),
  v("Alex", "en-US"),
  v("Samantha", "en-US"),
  v("Jorge", "es-ES"),
  v("Monica", "es-ES"),
  v("Google español", "es-ES", false),
  v("Google UK English Male", "en-GB", false),
  v("Google US English", "en-US", false),
];

test("Lucía gets a female Spanish voice even when a male one is listed first", () => {
  const { voice, pitch } = pickVoice(MAC, "es-ES", "female");
  assert.equal(voiceGender(voice!), "female");
  assert.equal(voice!.lang, "es-ES");
  assert.equal(pitch, 1);
});

test("Jay gets a male English voice", () => {
  const { voice, pitch } = pickVoice(MAC, "en-US", "male");
  assert.equal(voice!.name, "Alex");
  assert.equal(pitch, 1);
});

test("Windows voice names are recognized", () => {
  const win = [v("Microsoft Zira - English (United States)", "en-US"), v("Microsoft David - English (United States)", "en-US")];
  assert.equal(pickVoice(win, "en-US", "male").voice!.name, "Microsoft David - English (United States)");
  assert.equal(pickVoice(win, "en-US", "female").voice!.name, "Microsoft Zira - English (United States)");
});

test("names aren't matched inside other words", () => {
  assert.equal(voiceGender(v("Thomas", "fr-FR")), "male");
  assert.equal(voiceGender(v("Samantha", "en-US")), "female");
  assert.equal(voiceGender(v("Google UK English Male", "en-GB")), "male");
  assert.equal(voiceGender(v("Google UK English Female", "en-GB")), "female");
});

test("with no voice of the right gender, the pitch is shifted instead", () => {
  const { voice, pitch } = pickVoice([v("Jorge", "es-ES")], "es-ES", "female");
  assert.equal(voice!.name, "Jorge");
  assert.ok(pitch > 1);
});

test("no voice for the language returns none", () => {
  assert.equal(pickVoice(MAC, "ja-JP", "female").voice, null);
});
