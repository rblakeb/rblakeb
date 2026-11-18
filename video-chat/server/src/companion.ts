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

export interface Conversation {
  id: string;
  userId: string;
  character: CharacterId;
  targetLanguage: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  lastUsed: number;
  // Notes the character kept from earlier calls with this user.
  memory: string;
  // When call time was last charged.
  lastBilledAt: number;
}

// In memory for the prototype; conversations end when the server restarts.
const conversations = new Map<string, Conversation>();
const MAX_TURNS_KEPT = 40;
const IDLE_EXPIRY_MS = 30 * 60_000;

// Removes and returns conversations nobody has used for a while (a closed tab,
// a dropped connection), so the caller can wrap them up like an ended call.
export function takeIdleConversations(now = Date.now()): Conversation[] {
  const idle: Conversation[] = [];
  for (const [id, c] of conversations) {
    if (now - c.lastUsed > IDLE_EXPIRY_MS) {
      conversations.delete(id);
      idle.push(c);
    }
  }
  return idle;
}

export function endConversation(id: string): void {
  conversations.delete(id);
}

export function startConversation(userId: string, character: CharacterId, targetLanguage: string, memory = ""): Conversation {
  const now = Date.now();
  const conversation: Conversation = {
    id: randomUUID(),
    userId,
    character,
    targetLanguage: LANGUAGES[targetLanguage] ?? "Spanish",
    messages: [],
    lastUsed: now,
    memory,
    lastBilledAt: now,
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
  // Rewrites the character's notes about the user to include what came up in this call.
  updateMemory(conversation: Conversation): Promise<string>;
}

// Marks the hidden instruction that opens each call, so it's not mistaken for the user.
export const CALL_OPENER = "(The call just connected. Greet the user and start the conversation.)";

const MEMORY_RULES = `You keep short private notes for an AI character about one user, so the character can pick up where they left off next call.

Rewrite the notes to include anything useful from the latest call. Keep: the name they want to be called, their level and goals, interests, ongoing projects (songs, topics, trips), recurring mistakes or things they're working on, and what you last talked about. Drop anything stale or trivial. Never record health conditions, finances, addresses, other people's personal details, or anything they asked to keep private.

Write plain sentences in English, at most 120 words. Reply with the notes only.`;

// The call's spoken lines as plain text, without camera frames or the opener.
export function transcript(conversation: Conversation): string {
  const name = CHARACTERS[conversation.character].name;
  const lines: string[] = [];
  for (const m of conversation.messages) {
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).flatMap((b) => (b.type === "text" && "text" in b ? [b.text] : [])).join(" ");
    if (!text || text === CALL_OPENER) continue;
    lines.push(`${m.role === "user" ? "User" : name}: ${text}`);
  }
  return lines.join("\n");
}

// Whether the user said anything worth remembering this call.
export function hasUserSpeech(conversation: Conversation): boolean {
  return transcript(conversation).split("\n").some((line) => line.startsWith("User: "));
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
          // After the cache breakpoint: it differs per user.
          ...(conversation.memory
            ? [
                {
                  type: "text" as const,
                  text: `You've talked with this user before. Your notes from earlier calls:\n${conversation.memory}\n\nUse them naturally, the way a friend remembers things; don't recite them.`,
                },
              ]
            : []),
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

    async updateMemory(conversation) {
      const message = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 1000,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: MEMORY_RULES,
        messages: [
          {
            role: "user",
            content: `Current notes:\n${conversation.memory || "(none yet)"}\n\nLatest call:\n${transcript(conversation)}`,
          },
        ],
      });
      if (message.stop_reason === "refusal") return conversation.memory;
      const notes = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return notes || conversation.memory;
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

    async updateMemory(conversation) {
      const said = transcript(conversation)
        .split("\n")
        .filter((line) => line.startsWith("User: "))
        .map((line) => line.slice(6))
        .join(" / ");
      return [conversation.memory, `Last call they said: ${said.slice(0, 200)}`].filter(Boolean).join("\n");
    },
  };
}

export function brainFromEnv(): Brain {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return claudeBrain();
  console.warn("No ANTHROPIC_API_KEY: AI companions run in test mode with canned replies.");
  return mockBrain();
}
