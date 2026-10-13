import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { findAccount, tenantContext, type AccountRef, type AppContext } from "@careerfiend/core";
import { baseCtx } from "./base";
import { authMisconfigured, readSession, SESSION_COOKIE, sessionMatchesPassword } from "@careerfiend/shared";

export { baseCtx };

/** The signed-in account for this request, or null (checked against the database, so deleted accounts and old passwords sign out). */
export const currentAccount = cache(async (): Promise<AccountRef | null> => {
  const base = baseCtx();
  if (authMisconfigured(base.config)) return null;
  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, base.config.SESSION_SECRET!);
  if (!session) return null;
  const row = await findAccount(base, session.accountId);
  if (!row || !sessionMatchesPassword(session.fingerprint, row.passwordHash)) return null;
  return { id: row.id, email: row.email, tenant: row.tenant };
});

/**
 * The signed-in person's context: their own database, key and language model.
 * Redirects to sign-in without a valid session. One per request.
 */
export const ctx = cache(async (): Promise<AppContext> => {
  const account = await currentAccount();
  if (!account) redirect("/login");
  return tenantContext(baseCtx(), account);
});
