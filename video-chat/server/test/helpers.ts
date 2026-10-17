import { openDb, setDb } from "../src/db.ts";
import { createUser, type User } from "../src/users.ts";
import { applyVerificationResult } from "../src/verification.ts";

// Each test file gets its own in-memory Postgres with the real migrations applied.
export async function freshDb(): Promise<void> {
  setDb(await openDb());
}

export async function newUser(): Promise<User> {
  return (await createUser("t")).user;
}

export async function verifiedUser(sex: "M" | "F"): Promise<User> {
  const user = await newUser();
  return (await applyVerificationResult({ userId: user.id, reference: "r", approved: true, isAdult: true, documentSex: sex }))!;
}

let refCounter = 0;
export const ref = () => `pay_${++refCounter}`;
