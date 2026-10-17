import { randomUUID } from "node:crypto";
import type { Sex } from "./config.ts";
import { getDb } from "./db.ts";
import { loadUser, type User } from "./users.ts";

// Result a vendor (Didit, Yoti, Veriff, Persona, ...) reports after ID + selfie + face match.
// We keep only these fields. The ID images stay with the vendor.
export interface VerificationResult {
  userId: string;
  reference: string;
  approved: boolean;
  isAdult: boolean;
  documentSex: Sex | null;
}

export interface VerificationProvider {
  // Returns a URL to send the user to for the vendor's hosted ID check.
  startSession(user: User, returnUrl: string): Promise<{ url: string; reference: string }>;
}

export async function applyVerificationResult(result: VerificationResult): Promise<User | undefined> {
  const verifiedAdult = result.approved && result.isAdult;
  const rows = await getDb().query(
    `update users set verification_ref = $2, verified_adult = $3, verified_sex = $4
     where id = $1 returning id`,
    [result.userId, result.reference, verifiedAdult, verifiedAdult ? result.documentSex : null],
  );
  return rows.length ? loadUser(result.userId) : undefined;
}

// Development stand-in for a real vendor. Its hosted page is /dev/verify.html,
// which lets you pick the outcome. Disabled when NODE_ENV=production.
export const mockVerificationProvider: VerificationProvider = {
  async startSession(user, returnUrl) {
    const reference = `mock_${randomUUID()}`;
    const url = `/dev/verify.html?user=${encodeURIComponent(user.id)}&ref=${reference}&return=${encodeURIComponent(returnUrl)}`;
    return { url, reference };
  },
};
