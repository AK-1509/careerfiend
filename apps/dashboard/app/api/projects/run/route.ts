import { after } from "next/server";
import { advanceProjectRun, tenantContext } from "@careerfiend/core";
import { baseCtx } from "@/lib/ctx";
import { pokeWorker } from "@/lib/kick";

/**
 * Project Recommendations background step: runs one phase of a run someone
 * started on their Project Recommendations page, then hands the next phase to a
 * fresh invocation. Public like /api/worker: it only advances runs created by a
 * signed-in action (in that account's own data), one claimed at a time.
 * `?account=<id>` names the account that started it; without it, the first
 * account with a run waiting is advanced.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function start(req: Request): Promise<Response> {
  const c = baseCtx();
  const only = new URL(req.url).searchParams.get("account");
  after(async () => {
    try {
      const accounts = await c.db.account.findMany({
        where: only && /^[a-z0-9_]+$/.test(only) ? { id: only } : undefined,
        select: { id: true, email: true, tenant: true },
        orderBy: { createdAt: "asc" },
      });
      for (const a of accounts) {
        const r = await advanceProjectRun(await tenantContext(c, a));
        if (!r.ran) continue;
        if (r.more) await pokeWorker(`/api/projects/run?account=${a.id}`);
        break;
      }
    } catch (err) {
      c.logger.error("projects.run_failed", { error: err });
    }
  });
  return Response.json({ started: true }, { status: 202, headers: { "cache-control": "no-store" } });
}

export const GET = start;
export const POST = start;
