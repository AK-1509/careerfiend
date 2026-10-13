import { after } from "next/server";
import { runAllTenants } from "@careerfiend/worker";
import { baseCtx } from "@/lib/ctx";
import { pokeWorker } from "@/lib/kick";

/**
 * The hosted worker. Started by dashboard actions, page views, the daily Vercel
 * cron and a scheduled GitHub Action. Public on purpose: it only processes work
 * already in people's queues (each account under its own run lock, least
 * recently served first) and returns immediately.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BUDGET_MS = 270_000;

async function start(): Promise<Response> {
  const c = baseCtx();
  if (c.config.CAREERFIEND_MODE !== "hosted") return Response.json({ started: false, reason: "not hosted" }, { status: 404 });
  after(async () => {
    try {
      const r = await runAllTenants(c, BUDGET_MS);
      c.logger.info("worker.run", { count: r.processed, status: r.more ? "more" : "done" });
      // Hand over to a fresh run while due work is left (only after progress, so nothing loops).
      if (r.more && r.processed > 0) await pokeWorker();
    } catch (err) {
      c.logger.error("worker.run_failed", { error: err });
    }
  });
  return Response.json({ started: true }, { status: 202, headers: { "cache-control": "no-store" } });
}

export const GET = start;
export const POST = start;
