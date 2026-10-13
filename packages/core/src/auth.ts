import {
  authMisconfigured,
  hashPasscode,
  looksLikeEmail,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  randomId,
  signSession,
  verifyPasscode,
} from "@careerfiend/shared";
import type { AppContext } from "./context";
import { dropTenant, tenantName, type AccountRef } from "./tenancy";

/**
 * Accounts (public edition). `ctx` here is the base context: its database is
 * the shared accounts database. A wrong password counts against that account:
 * after 5 in a row, sign-in is refused for 15 minutes (doubling with each
 * further lock, up to 24 hours). State lives in the database so it holds
 * across serverless instances.
 */
const FREE_ATTEMPTS = 5;

export type LoginResult = { ok: true; token: string; account: AccountRef } | { ok: false; error: string };

// Spent on unknown emails too, so response time does not reveal which emails have accounts.
const DUMMY_HASH = hashPasscode("not-a-real-password-0000");

export async function signup(ctx: AppContext, emailRaw: string, password: string): Promise<LoginResult> {
  const c = ctx.config;
  const problem = authMisconfigured(c);
  if (problem) return { ok: false, error: `Sign-in is not configured: ${problem}` };
  if (c.SIGNUPS_OPEN !== "true") return { ok: false, error: "New sign-ups are closed on this site." };
  const email = normalizeEmail(emailRaw);
  if (!looksLikeEmail(email)) return { ok: false, error: "Enter a valid email address." };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, error: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (password.length > 200) return { ok: false, error: "That password is too long." };
  if (await ctx.db.account.findUnique({ where: { email } })) return { ok: false, error: "An account with that email already exists. Sign in instead." };
  const id = randomId("a")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase();
  const passwordHash = hashPasscode(password);
  const account = { id, email, tenant: tenantName(id) };
  try {
    await ctx.db.account.create({ data: { ...account, passwordHash, lastLoginAt: ctx.now() } });
  } catch {
    return { ok: false, error: "An account with that email already exists. Sign in instead." };
  }
  ctx.logger.info("auth.signup", {});
  return { ok: true, account, token: signSession(c.SESSION_SECRET!, id, passwordHash, ctx.now().getTime()) };
}

export async function login(ctx: AppContext, emailRaw: string, password: string): Promise<LoginResult> {
  const c = ctx.config;
  const problem = authMisconfigured(c);
  if (problem) return { ok: false, error: `Sign-in is not configured: ${problem}` };
  const email = normalizeEmail(emailRaw);
  const row = await ctx.db.account.findUnique({ where: { email } });
  if (!row) {
    verifyPasscode(password, DUMMY_HASH);
    return { ok: false, error: "Wrong email or password." };
  }
  const now = ctx.now();
  if (row.lockedUntil && row.lockedUntil > now) {
    const mins = Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 60_000);
    ctx.logger.warn("auth.locked", { count: row.failedLogins });
    return { ok: false, error: `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` };
  }
  if (verifyPasscode(password, row.passwordHash)) {
    await ctx.db.account.update({ where: { id: row.id }, data: { failedLogins: 0, lockedUntil: null, lockCount: 0, lastLoginAt: now } });
    ctx.logger.info("auth.login", {});
    return {
      ok: true,
      account: { id: row.id, email: row.email, tenant: row.tenant },
      token: signSession(c.SESSION_SECRET!, row.id, row.passwordHash, now.getTime()),
    };
  }
  const failures = row.failedLogins + 1;
  if (failures >= FREE_ATTEMPTS) {
    const minutes = Math.min(15 * 2 ** row.lockCount, 24 * 60);
    await ctx.db.account.update({
      where: { id: row.id },
      data: { failedLogins: 0, lockedUntil: new Date(now.getTime() + minutes * 60_000), lockCount: row.lockCount + 1 },
    });
    ctx.logger.warn("auth.lockout", { count: failures });
    return { ok: false, error: `Wrong email or password. Sign-in to this account is locked for ${minutes} minutes.` };
  }
  await ctx.db.account.update({ where: { id: row.id }, data: { failedLogins: failures } });
  ctx.logger.warn("auth.failed", { count: failures });
  return { ok: false, error: "Wrong email or password." };
}

/** Change the password; every other session of the account is signed out. Returns a fresh session token. */
export async function changePassword(ctx: AppContext, accountId: string, current: string, next: string): Promise<string> {
  const row = await ctx.db.account.findUniqueOrThrow({ where: { id: accountId } });
  if (!verifyPasscode(current, row.passwordHash)) throw new Error("The current password is wrong.");
  if (next.length < MIN_PASSWORD_LENGTH) throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  const passwordHash = hashPasscode(next);
  await ctx.db.account.update({ where: { id: accountId }, data: { passwordHash } });
  return signSession(ctx.config.SESSION_SECRET!, accountId, passwordHash, ctx.now().getTime());
}

/** Delete the account and every piece of its data (its whole tenant database). */
export async function deleteAccount(ctx: AppContext, accountId: string, password: string): Promise<void> {
  const row = await ctx.db.account.findUniqueOrThrow({ where: { id: accountId } });
  if (!verifyPasscode(password, row.passwordHash)) throw new Error("The password is wrong.");
  await dropTenant(ctx.config, row.tenant);
  await ctx.db.account.delete({ where: { id: accountId } });
  ctx.logger.info("auth.account_deleted", {});
}

export async function findAccount(ctx: AppContext, accountId: string) {
  return ctx.db.account.findUnique({ where: { id: accountId } });
}
