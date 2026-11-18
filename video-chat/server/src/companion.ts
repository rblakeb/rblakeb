import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

// AI companions: the user talks (browser speech-to-text sends text) and shows
// themselves on camera (a still frame per turn); the character replies in short
// spoken sentences that the browser voices and lip-syncs.
//
// Characters here run on Claude, whose usage policies don't allow sexual
// content. The adult companion needs its own model stack and is not served here.

export type CharacterId = "tutor" | "music";

export interface Character {
  id: CharacterId;
  name: string;
  tagline: string;
  // Language the character speaks by default; the tutor speaks the target language.
  voiceLang: string;
  persona: (opts: { targetLanguage: string }) => string;
}

export const LANGUAGES: Record<string, string> = {
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ja: "Japanese",
  en: "English",
};

// Applies to every character. Covers the disclosure and crisis-response duties
// in AI companion laws (e.g. New York, California).
const SHARED_RULES = `You are an AI character on a live video call. You are not a human and never claim to be one; if asked, say plainly that you're an AI.

How the call works:
- The user speaks and their words arrive as text from speech recognition, so expect missing punctuation, homophones and misheard words. Infer what they meant.
- You may also get a still frame from their camera, taken as they finished speaking. React to what you see only when it's relevant or worth a quick, natural remark; don't describe the frame every turn. If there's no frame, don't mention the camera.
- Your reply is read aloud by a voice. Write only what should be spoken: no markdown, lists, emoji, stage directions or URLs. Keep it to one to three short sentences unless the user asks for more, and end with something that keeps the conversation going when that fits.

Wellbeing:
- If the user mentions wanting to hurt themselves or someone else, or seems in crisis, drop the character's task, respond with care, and tell them they can call or text 988 (the Suicide & Crisis Lifeline in the US) or their local emergency number. Don't diagnose.
- Never ask for or repeat personal details like their address, full name or financial information.`;

export const CHARACTERS: Record<CharacterId, Character> = {
  tutor: {
    id: "tutor",
    name: "Lucía",
    tagline: "Language tutor",
    voiceLang: "es",
    persona: ({ targetLanguage }) => `You are Lucía, a warm, upbeat language tutor helping the user practice speaking ${targetLanguage}.

- Speak mostly in ${targetLanguage}, at a level just above what the user shows. If they're clearly a beginner, use short, simple sentences and add a brief English gloss when needed.
- When they make a mistake that matters, give the corrected phrase naturally in your reply ("Ah, you went to the beach, fuiste a la playa!") rather than lecturing. At most one correction per turn.
- Use what you see on camera as conversation material: name objects, ask about them, and get the user to describe things.
- If the user asks something in English, answer briefly in English, then steer back to ${targetLanguage}.`,
  },
  music: {
    id: "music",
    name: "Jay",
    tagline: "Music buddy",
    voiceLang: "en",
    persona: () => `You are Jay, a relaxed, encouraging music buddy who loves every genre and talks like a friend at a jam session.

- Chat about music, gear, artists, practice and songwriting. Suggest songs, chord progressions, exercises or ideas when it helps.
- Use what you see on camera: notice instruments, how they're holding them, posture, their setup or room, and comment the way a friend would.
- You can't hear audio on this call; you only get their spoken words as text and a camera still. If they play for you, say honestly that you can't hear it yet and ask them to tell you what they played, or react to what you can see.`,
  },
};

export function getCharacter(id: string): Character | undefined {
  return CHARACTERS[id as CharacterId];
}

interface Conversation {
  id: string;
  userId: string;
  character: CharacterId;
  targetLanguage: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  lastUsed: number;
}

// In memory for the prototype; conversations end when the server restarts.
const conversations = new Map<string, Conversation>();
const MAX_TURNS_KEPT = 40;
const IDLE_EXPIRY_MS = 30 * 60_000;

setInterval(() => {
  const cutoff = Date.now() - IDLE_EXPIRY_MS;
  for (const [id, c] of conversations) if (c.lastUsed < cutoff) conversations.delete(id);
}, 60_000).unref();

export function startConversation(userId: string, character: CharacterId, targetLanguage: string): Conversation {
  const conversation: Conversation = {
    id: randomUUID(),
    userId,
    character,
    targetLanguage: LANGUAGES[targetLanguage] ?? "Spanish",
    messages: [],
    lastUsed: Date.now(),
  };
  conversations.set(conversation.id, conversation);
  return conversation;
}

export function getConversation(id: string, userId: string): Conversation | undefined {
  const c = conversations.get(id);
  return c && c.userId === userId ? c : undefined;
}

export interface Brain {
  // Streams the character's reply, calling onText with each piece as it arrives.
  // Resolves with the full reply.
  reply(conversation: Conversation, onText: (text: string) => void): Promise<string>;
}

// Adds the user's turn. Only the newest turn carries a camera frame; earlier
// frames are dropped from history to keep each request small.
export function addUserTurn(conversation: Conversation, text: string, frameJpegBase64?: string): void {
  for (const m of conversation.messages) {
    if (m.role === "user" && Array.isArray(m.content)) {
      m.content = m.content.filter((b) => b.type !== "image");
    }
  }
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (frameJpegBase64) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frameJpegBase64 } });
  }
  content.push({ type: "text", text: text || "(The user didn't say anything; they may be waiting for you or showing you something.)" });
  conversation.messages.push({ role: "user", content });
  conversation.messages = conversation.messages.slice(-MAX_TURNS_KEPT * 2);
  // History must start with a user turn.
  while (conversation.messages[0]?.role === "assistant") conversation.messages.shift();
  conversation.lastUsed = Date.now();
}

export function claudeBrain(client = new Anthropic()): Brain {
  return {
    async reply(conversation, onText) {
      const character = CHARACTERS[conversation.character];
      const stream = client.beta.messages.stream({
        model: "claude-opus-5-5",
        max_tokens: 2000,
        // Conversation, not hard reasoning: low effort keeps replies fast.
        output_config: { effort: "low" },
        // If a turn is declined by a safety classifier, the API reruns it on a
        // fallback model instead of the call going silent.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [
          { type: "text", text: SHARED_RULES },
          {
            type: "text",
            text: character.persona({ targetLanguage: conversation.targetLanguage }),
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: conversation.messages,
      });
      stream.on("text", onText);
      const message = await stream.finalMessage();
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      const reply = message.stop_reason === "refusal" || !text ? "Sorry, I can't help with that one. Want to talk about something else?" : text;
      if (!text) onText(reply);
      conversation.messages.push({ role: "assistant", content: reply });
      return reply;
    },
  };
}

// Stand-in used when no Claude credentials are configured, so the call loop
// (speech, camera, voice, avatar) can be tried and tested without an API key.
export function mockBrain(): Brain {
  return {
    async reply(conversation, onText) {
      const character = CHARACTERS[conversation.character];
      const last = conversation.messages.at(-1);
      const blocks = Array.isArray(last?.content) ? last.content : [];
      const sawFrame = blocks.some((b) => b.type === "image");
      const heard = blocks.find((b) => b.type === "text");
      const said = heard && "text" in heard ? heard.text : "";
      const reply =
        `This is ${character.name} in test mode. I heard: ${said.slice(0, 120)}. ` +
        (sawFrame ? "I got a picture from your camera too. " : "") +
        "Add a Claude API key to talk to me for real.";
      for (const word of reply.split(/(?<= )/)) {
        onText(word);
        await new Promise((r) => setTimeout(r, 15));
      }
      conversation.messages.push({ role: "assistant", content: reply });
      return reply;
    },
  };
}

export function brainFromEnv(): Brain {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return claudeBrain();
  console.warn("No ANTHROPIC_API_KEY: AI companions run in test mode with canned replies.");
  return mockBrain();
}
