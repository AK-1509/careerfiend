import "server-only";
import { loadConfig, SESSION_DAYS } from "@careerfiend/shared";

/** Session cookie attributes: httpOnly, lax, secure whenever served over https. */
export function sessionCookieOptions() {
  const c = loadConfig();
  return {
    httpOnly: true,
    secure: c.CAREERFIEND_MODE === "hosted" || (c.PUBLIC_URL ?? "").startsWith("https:"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  };
}
