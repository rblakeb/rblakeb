import { MATCHING, type IntentId } from "./config.ts";

export interface QueueEntry {
  userId: string;
  intent: IntentId;
  // Hard filter until widened: only match people who speak one of these. Empty = any.
  languages: string[];
  // Soft preference: more shared tags ranks a candidate higher.
  tags: string[];
  joinedAt: number;
}

export interface Match {
  a: QueueEntry;
  b: QueueEntry;
}

function normalize(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
}

function pairKey(x: string, y: string): string {
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

export class Matchmaker {
  private queues = new Map<IntentId, QueueEntry[]>();
  private recentPairs = new Map<string, number>();

  // Re-checked at match time so someone whose pass expired while waiting isn't paired.
  constructor(private canMatch: (userId: string, intent: IntentId) => boolean = () => true) {}

  enqueue(input: Omit<QueueEntry, "joinedAt">, now = Date.now()): Match | null {
    this.remove(input.userId);
    const entry: QueueEntry = {
      ...input,
      languages: normalize(input.languages),
      tags: normalize(input.tags),
      joinedAt: now,
    };
    const queue = this.queues.get(entry.intent) ?? [];
    this.queues.set(entry.intent, queue);

    const partner = this.findPartner(entry, queue, now);
    if (partner) {
      queue.splice(queue.indexOf(partner), 1);
      return this.pair(entry, partner, now);
    }
    queue.push(entry);
    return null;
  }

  remove(userId: string): void {
    for (const queue of this.queues.values()) {
      const i = queue.findIndex((e) => e.userId === userId);
      if (i !== -1) queue.splice(i, 1);
    }
  }

  // Run periodically: once filters widen, people already waiting may now fit each other.
  sweep(now = Date.now()): Match[] {
    const matches: Match[] = [];
    for (const [key, at] of this.recentPairs) {
      if (now - at > MATCHING.recentPairTtlMs) this.recentPairs.delete(key);
    }
    for (const queue of this.queues.values()) {
      for (let i = 0; i < queue.length; i++) {
        const entry = queue[i];
        if (!this.canMatch(entry.userId, entry.intent)) continue;
        const others = queue.slice(i + 1);
        const partner = this.findPartner(entry, others, now);
        if (!partner) continue;
        queue.splice(queue.indexOf(partner), 1);
        queue.splice(i, 1);
        i--;
        matches.push(this.pair(entry, partner, now));
      }
    }
    return matches;
  }

  waitingCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [intent, queue] of this.queues) counts[intent] = queue.length;
    return counts;
  }

  private pair(a: QueueEntry, b: QueueEntry, now: number): Match {
    this.recentPairs.set(pairKey(a.userId, b.userId), now);
    return { a, b };
  }

  private findPartner(entry: QueueEntry, candidates: QueueEntry[], now: number): QueueEntry | null {
    let best: QueueEntry | null = null;
    let bestScore = -1;
    for (const c of candidates) {
      if (c.userId === entry.userId) continue;
      if (!this.compatible(entry, c, now)) continue;
      if (!this.canMatch(c.userId, c.intent)) continue;
      const score = c.tags.filter((t) => entry.tags.includes(t)).length;
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  }

  private compatible(a: QueueEntry, b: QueueEntry, now: number): boolean {
    if (a.intent !== b.intent) return false;
    const recent = this.recentPairs.get(pairKey(a.userId, b.userId));
    if (recent !== undefined && now - recent < MATCHING.recentPairTtlMs) return false;
    return this.languageOk(a, b, now) && this.languageOk(b, a, now);
  }

  // Whether `who`'s language filter accepts `other`.
  private languageOk(who: QueueEntry, other: QueueEntry, now: number): boolean {
    if (who.languages.length === 0) return true;
    if (now - who.joinedAt >= MATCHING.widenAfterMs) return true;
    return other.languages.some((l) => who.languages.includes(l));
  }
}
