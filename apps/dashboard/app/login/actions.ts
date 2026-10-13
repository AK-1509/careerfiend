"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { login, signup } from "@careerfiend/core";
import { safeNextPath, SESSION_COOKIE } from "@careerfiend/shared";
import { baseCtx } from "@/lib/ctx";
import { sessionCookieOptions } from "@/lib/cookie";

export async function loginAction(f: FormData) {
  const next = safeNextPath(String(f.get("next") ?? ""));
  const r = await login(baseCtx(), String(f.get("email") ?? ""), String(f.get("password") ?? ""));
  if (!r.ok) {
    await new Promise((res) => setTimeout(res, 400)); // slows guessing
    redirect(`/login?error=${encodeURIComponent(r.error)}&next=${encodeURIComponent(next)}`);
  }
  (await cookies()).set(SESSION_COOKIE, r.token, sessionCookieOptions());
  redirect(next);
}

export async function signupAction(f: FormData) {
  const password = String(f.get("password") ?? "");
  if (password !== String(f.get("confirm") ?? "")) redirect(`/login?mode=signup&error=${encodeURIComponent("The passwords do not match.")}`);
  const r = await signup(baseCtx(), String(f.get("email") ?? ""), password);
  if (!r.ok) redirect(`/login?mode=signup&error=${encodeURIComponent(r.error)}`);
  (await cookies()).set(SESSION_COOKIE, r.token, sessionCookieOptions());
  redirect("/?welcome=1");
}

export async function logoutAction() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
