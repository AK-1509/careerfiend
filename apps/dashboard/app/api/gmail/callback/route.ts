import { finishGmailConnect } from "@careerfiend/core";
import { ctx } from "@/lib/ctx";
import { hasSession } from "@/lib/session";

/** OAuth redirect target: loopback (Desktop client) locally, PUBLIC_URL (Web client) when hosted. */
export async function GET(req: Request) {
  if (!(await hasSession())) return new Response("Sign in first.", { status: 401 });
  const u = new URL(req.url);
  const back = (q: string) => Response.redirect(new URL(`/email?${q}`, u.origin), 303);
  const error = u.searchParams.get("error");
  if (error) return back(`error=${encodeURIComponent(`Google returned: ${error}`)}`);
  try {
    const account = await finishGmailConnect(await ctx(), u.searchParams.get("code") ?? "", u.searchParams.get("state") ?? "");
    return back(`msg=${encodeURIComponent(`Gmail connected: ${account}`)}`);
  } catch (err) {
    return back(`error=${encodeURIComponent((err as Error).message)}`);
  }
}
