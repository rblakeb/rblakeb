// Types for voices.js, so the server's TypeScript tests can import it.
export interface VoiceLike {
  name: string;
  lang: string;
  localService?: boolean;
}
export function voiceGender(voice: VoiceLike): "female" | "male" | "unknown";
export function pickVoice<V extends VoiceLike>(voices: V[], lang: string, gender: "female" | "male"): { voice: V | null; pitch: number };
