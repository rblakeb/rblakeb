import { COMPANION_PRICING } from "./config.ts";
import { getDb } from "./db.ts";
import { loadUser } from "./users.ts";

export interface CallBalance {
  // Call time left without converting another credit.
  secondsRemaining: number;
  credits: number;
  // True when the charge couldn't be covered: no call time and no credits left.
  exhausted: boolean;
}

// Charges `seconds` of call time. Uses the user's remaining seconds first, then
// converts credits (oldest purchase first) into blocks of minutes as needed.
// Locks the user's row and credits so two charges at once can't double-spend.
export async function chargeCallTime(userId: string, seconds: number): Promise<CallBalance> {
  const charge = Math.max(0, Math.round(seconds));
  const result = await getDb().transaction(async (tx) => {
    const [user] = await tx.query<{ companion_seconds: number }>(
      "select companion_seconds from users where id = $1 for update",
      [userId],
    );
    if (!user) return { secondsRemaining: 0, credits: 0, exhausted: true };
    const lots = await tx.query<{ payment_ref: string; remaining: number }>(
      `select payment_ref, remaining from credit_lots
       where user_id = $1 and remaining > 0 order by purchased_at, payment_ref for update`,
      [userId],
    );

    let balance = user.companion_seconds;
    let owed = charge;
    const blockSeconds = COMPANION_PRICING.minutesPerCredit * 60;
    for (const lot of lots) {
      while (owed > balance && lot.remaining > 0) {
        lot.remaining--;
        balance += blockSeconds;
        await tx.query("update credit_lots set remaining = remaining - 1 where payment_ref = $1", [lot.payment_ref]);
      }
      if (owed <= balance) break;
    }
    const exhausted = owed > balance;
    balance = Math.max(0, balance - owed);
    await tx.query("update users set companion_seconds = $2 where id = $1", [userId, balance]);
    return {
      secondsRemaining: balance,
      credits: lots.reduce((sum, l) => sum + l.remaining, 0),
      exhausted,
    };
  });
  await loadUser(userId);
  return result;
}

// Whether the user can talk at all right now: call time left, or a credit to convert.
export function canCall(user: { companionSeconds: number; creditLots: { remaining: number }[] }): boolean {
  return user.companionSeconds > 0 || user.creditLots.some((l) => l.remaining > 0);
}

// ---------- Memory between calls ----------

export async function getMemory(userId: string, character: string): Promise<string> {
  const [row] = await getDb().query<{ notes: string }>(
    "select notes from companion_memories where user_id = $1 and character = $2",
    [userId, character],
  );
  return row?.notes ?? "";
}

export async function saveMemory(userId: string, character: string, notes: string): Promise<void> {
  await getDb().query(
    `insert into companion_memories (user_id, character, notes, updated_at) values ($1, $2, $3, now())
     on conflict (user_id, character) do update set notes = excluded.notes, updated_at = now()`,
    [userId, character, notes.slice(0, 2000)],
  );
}

export async function deleteMemory(userId: string, character: string): Promise<void> {
  await getDb().query("delete from companion_memories where user_id = $1 and character = $2", [userId, character]);
}
