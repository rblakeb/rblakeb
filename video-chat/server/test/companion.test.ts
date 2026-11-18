import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { addUserTurn, claudeBrain, getConversation, mockBrain, startConversation } from "../src/companion.ts";

const FRAME = "aGVsbG8=";

test("only the newest turn keeps its camera frame", () => {
  const c = startConversation("u1", "tutor", "fr");
  addUserTurn(c, "bonjour", FRAME);
  c.messages.push({ role: "assistant", content: "Salut !" });
  addUserTurn(c, "ça va", FRAME);
  const images = c.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "image");
  assert.equal(images.length, 1);
  const last = c.messages.at(-1)!.content as Anthropic.Beta.BetaContentBlockParam[];
  assert.equal(last[0].type, "image");
});

test("conversations belong to the user who started them", () => {
  const c = startConversation("owner", "music", "en");
  assert.ok(getConversation(c.id, "owner"));
  assert.equal(getConversation(c.id, "someone-else"), undefined);
});

// A stand-in for the SDK's streaming call that records the request and plays back text.
function fakeClient(reply: string, stopReason: string = "end_turn") {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: any) {
          requests.push(params);
          const listeners: ((t: string) => void)[] = [];
          return {
            on(event: string, fn: (t: string) => void) {
              if (event === "text") listeners.push(fn);
            },
            async finalMessage() {
              if (reply) for (const piece of reply.split(" ")) listeners.forEach((fn) => fn(piece + " "));
              return { content: reply ? [{ type: "text", text: reply }] : [], stop_reason: stopReason };
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

test("claude brain sends the persona, the frame and the history, and streams the reply", async () => {
  const c = startConversation("u2", "tutor", "es");
  addUserTurn(c, "hola, mira mi gato", FRAME);
  const { client, requests } = fakeClient("¡Qué gato tan bonito! ¿Cómo se llama?");
  const streamed: string[] = [];
  const reply = await claudeBrain(client).reply(c, (t) => streamed.push(t));

  assert.equal(reply, "¡Qué gato tan bonito! ¿Cómo se llama?");
  assert.ok(streamed.join("").includes("gato"));
  const req = requests[0];
  assert.equal(req.model, "claude-opus-5-5");
  assert.match(req.system.map((b: any) => b.text).join("\n"), /practice speaking Spanish/);
  assert.match(req.system[0].text, /never claim to be one/);
  // The SDK got the live history array, which now ends with the reply; the user turn is before it.
  assert.equal(req.messages.at(-2).content[0].source.data, FRAME);
  assert.deepEqual(c.messages.at(-1), { role: "assistant", content: reply });
});

test("a declined turn gets a graceful line instead of silence", async () => {
  const c = startConversation("u3", "music", "en");
  addUserTurn(c, "something off-limits");
  const { client } = fakeClient("", "refusal");
  const streamed: string[] = [];
  const reply = await claudeBrain(client).reply(c, (t) => streamed.push(t));
  assert.match(reply, /can't help with that/);
  assert.equal(streamed.join(""), reply);
});

test("mock brain answers without an API key", async () => {
  const c = startConversation("u4", "music", "en");
  addUserTurn(c, "check out my guitar", FRAME);
  const reply = await mockBrain().reply(c, () => {});
  assert.match(reply, /check out my guitar/);
  assert.match(reply, /picture from your camera/);
});
