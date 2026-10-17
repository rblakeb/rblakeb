export type IntentId = "chat" | "music" | "gaming" | "language" | "adult";

export interface Intent {
  id: IntentId;
  label: string;
  description: string;
  adult: boolean;
}

export const INTENTS: Intent[] = [
  { id: "chat", label: "Just Chat", description: "Meet random people and talk", adult: false },
  { id: "music", label: "Music & DJ", description: "Play, jam, or spin for an audience", adult: false },
  { id: "gaming", label: "Gaming", description: "Talk games, find teammates", adult: false },
  { id: "language", label: "Language Exchange", description: "Practice a language with a native speaker", adult: false },
  { id: "adult", label: "Adult 18+", description: "Verified adults only", adult: true },
];

export function getIntent(id: string): Intent | undefined {
  return INTENTS.find((i) => i.id === id);
}

// Pricing for the adult section. Everything else on the site is free.
// `freeForSex` uses the sex printed on the verified ID (reported by the
// verification vendor), not a self-selected profile field.
export const ADULT_PRICING = {
  dayPassCredits: 1,
  dayPassHours: 24,
  freeForSex: ["F"] as Sex[],
};

// Credits are bought in packs so each card charge is large enough that
// per-transaction processor fees don't eat the sale.
export interface CreditPack {
  id: string;
  credits: number;
  priceCents: number;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: "pack5", credits: 5, priceCents: 500 },
  { id: "pack12", credits: 12, priceCents: 1000 },
  { id: "pack30", credits: 30, priceCents: 2000 },
];

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

export type Sex = "M" | "F" | "X";

export const MATCHING = {
  // After this long in the queue, optional filters (language, tags) are dropped.
  widenAfterMs: 10_000,
  // Don't re-pair the same two people within this window.
  recentPairTtlMs: 10 * 60_000,
};
