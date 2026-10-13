import { authMisconfigured } from "@careerfiend/shared";
import { baseCtx } from "@/lib/ctx";

/** Public setup check (no personal data): is the accounts database reachable and migrated, is sign-in configured, is the server key set. */
export async function GET() {
  const out: Record<string, boolean | string> = { ok: false };
  try {
    const c = baseCtx();
    out.login = !authMisconfigured(c.config);
    out.signups = c.config.SIGNUPS_OPEN === "true";
    out.encryptionKey = (() => {
      try {
        c.key();
        return true;
      } catch {
        return false;
      }
    })();
    await c.db.account.count();
    out.database = true;
    out.formFilling = c.config.FORM_FILLING;
    out.ok = out.login === true && out.encryptionKey === true;
  } catch (err) {
    out.error = (err as Error).message.split("\n")[0]!.replace(/postgres(ql)?:\/\/\S+/g, "postgres://…");
  }
  return Response.json(out, { status: out.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
