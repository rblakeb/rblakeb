import { randomUUID } from "node:crypto";
import type { Sex } from "./config.ts";

export interface User {
  id: string;
  token: string;
  displayName: string;
  createdAt: number;
  // Set only by the verification vendor's result, never by the client.
  verifiedAdult: boolean;
  verifiedSex: Sex | null;
  verificationRef: string | null;
  adultPassExpiresAt: number | null;
  credits: number;
  banned: boolean;
  reportCount: number;
}

// In-memory store for the MVP. Swap for Postgres before launch.
const byId = new Map<string, User>();
const byToken = new Map<string, User>();

export function createUser(displayName: string): User {
  const user: User = {
    id: randomUUID(),
    token: randomUUID(),
    displayName: displayName.trim().slice(0, 32) || "Guest",
    createdAt: Date.now(),
    verifiedAdult: false,
    verifiedSex: null,
    verificationRef: null,
    adultPassExpiresAt: null,
    credits: 0,
    banned: false,
    reportCount: 0,
  };
  byId.set(user.id, user);
  byToken.set(user.token, user);
  return user;
}

export function getUserById(id: string): User | undefined {
  return byId.get(id);
}

export function getUserByToken(token: string | undefined): User | undefined {
  return token ? byToken.get(token) : undefined;
}

export function publicProfile(user: User) {
  return {
    id: user.id,
    displayName: user.displayName,
    verifiedAdult: user.verifiedAdult,
    adultPassExpiresAt: user.adultPassExpiresAt,
    credits: user.credits,
  };
}
