import { NextResponse, type NextRequest } from "next/server";
import { authMisconfigured, loadConfig, readSession, SESSION_COOKIE } from "@careerfiend/shared";

/**
 * Sends every request without a signed session to /login (API calls get 401).
 * This only checks the signature and expiry; pages, actions and routes check
 * the account itself (lib/ctx.ts).
 */
const setupNeeded = (msg: string) =>
  new NextResponse(`CareerFiend is not set up yet: ${msg}\nSee README → "Deploy".`, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export function proxy(req: NextRequest) {
  // Public: a setup check (booleans only) and background triggers that only advance work people already queued.
  const open = ["/api/health", "/api/worker", "/api/projects/run"];
  if (open.includes(req.nextUrl.pathname)) return NextResponse.next();
  let c: ReturnType<typeof loadConfig>;
  try {
    c = loadConfig();
  } catch (err) {
    return setupNeeded((err as Error).message);
  }
  const { pathname, search } = req.nextUrl;
  const problem = authMisconfigured(c);
  if (problem) return setupNeeded(`sign-in is not configured. ${problem}`);
  const ok = readSession(req.cookies.get(SESSION_COOKIE)?.value, c.SESSION_SECRET!) !== null;
  if (pathname === "/login") return NextResponse.next();
  if (ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const login = new URL("/login", req.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
