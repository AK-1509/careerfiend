import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Config } from "./config";
import { sha256 } from "./hash";

/**
 * Sign-in for the public edition: one account per person (email + password,
 * stored only as a scrypt hash) and a signed, expiring session cookie that
 * names the account. Changing a password or SESSION_SECRET signs sessions out.
 */

export const SESSION_COOKIE = "cf_session";
export const SESSION_DAYS = 14;
export const MIN_PASSCODE_LENGTH = 10;
export const MIN_PASSWORD_LENGTH = MIN_PASSCODE_LENGTH;

const N = 32768;
const R = 8;
const P = 1;
const MAXMEM = 64 * 1024 * 1024;

export function hashPasscode(passcode: string): string {
  if (passcode.length < MIN_PASSCODE_LENGTH) throw new Error(`Use at least ${MIN_PASSCODE_LENGTH} characters.`);
  const salt = randomBytes(16);
  const hash = scryptSync(passcode.normalize("NFKC"), salt, 32, { N, r: R, p: P, maxmem: MAXMEM });
  // ":" separators: "$" would be expanded by some .env loaders.
  return `scrypt:${N}:${R}:${P}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPasscode(passcode: string, stored: string): boolean {
  const m = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(stored.trim());
  if (!m) return false;
  const expected = Buffer.from(m[5]!, "base64");
  const actual = scryptSync(passcode.normalize("NFKC"), Buffer.from(m[4]!, "base64"), expected.length, {
    N: Number(m[1]),
    r: Number(m[2]),
    p: Number(m[3]),
    maxmem: MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Normalized sign-in email (trimmed, lowercase). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/** A reason sign-in cannot work yet (no session secret), or null. */
export function authMisconfigured(config: Pick<Config, "SESSION_SECRET">): string | null {
  if (!config.SESSION_SECRET || Buffer.from(config.SESSION_SECRET, "base64").length < 32)
    return "SESSION_SECRET is missing or shorter than 32 bytes (run npm run hosted:env).";
  return null;
}

const mac = (secret: string, body: string) => createHmac("sha256", Buffer.from(secret, "base64")).update(body).digest("base64url");

/**
 * Session token: `v2.<accountId>.<expiresAt>.<passwordFingerprint>.<mac>`.
 * The password fingerprint signs everyone out of an account when its password changes.
 */
export function signSession(secret: string, accountId: string, passwordHash: string, now = Date.now()): string {
  const body = `v2.${accountId}.${now + SESSION_DAYS * 86_400_000}.${sha256(passwordHash).slice(0, 16)}`;
  return `${body}.${mac(secret, body)}`;
}

/** The session's account id and password fingerprint when the token is genuine and unexpired, else null. */
export function readSession(token: string | undefined, secret: string, now = Date.now()): { accountId: string; fingerprint: string } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "v2" || !/^[a-z0-9_]+$/.test(parts[1]!)) return null;
  const body = parts.slice(0, 4).join(".");
  const given = Buffer.from(parts[4]!);
  const want = Buffer.from(mac(secret, body));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  if (!(Number(parts[2]) > now)) return null;
  return { accountId: parts[1]!, fingerprint: parts[3]! };
}

/** Whether a session's fingerprint still matches the account's current password hash. */
export function sessionMatchesPassword(fingerprint: string, passwordHash: string): boolean {
  return fingerprint === sha256(passwordHash).slice(0, 16);
}

/** A same-site path to return to after login ("/" for anything else). */
export function safeNextPath(next: string | null | undefined): string {
  return next && /^\/(?![/\\])/.test(next) ? next : "/";
}
