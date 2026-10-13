import { createAppContext } from "@careerfiend/core";
import { runAllTenants } from "./worker";

/**
 * The worker on your own computer or server (self-hosting): bounded runs over
 * every account, again and again, backing off while there is nothing to do.
 * On Vercel the same runs happen in /api/worker instead.
 */
const base = createAppContext();
let stopping = false;

const shutdown = async (signal: string) => {
  base.logger.info("worker.stopping", { status: signal });
  stopping = true;
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const dbUrl = base.config.paths.databaseUrl;
console.log(/^postgres/.test(dbUrl) ? `Database: ${new URL(dbUrl).hostname}` : `Database: embedded on this computer (${dbUrl.slice(7)}).`);
console.log("CareerFiend worker running for every account. Ctrl+C to stop.");

const minIdle = 2000;
const maxIdle = Math.max(minIdle, base.config.WORKER_MAX_IDLE_SECONDS * 1000);
let idle = minIdle;
while (!stopping) {
  const r = await runAllTenants(base, 5 * 60_000, { serverless: false }).catch((err) => {
    base.logger.error("worker.loop_error", { error: err });
    return { accounts: 0, processed: 0, more: false };
  });
  if (r.processed > 0 || r.more) idle = minIdle;
  else {
    await new Promise((res) => setTimeout(res, idle));
    idle = Math.min(idle * 2, maxIdle);
  }
}
await base.db.$disconnect();
process.exit(0);
