import os from "node:os";
import type { Page } from "playwright";
import { CareerFiendError, randomId } from "@careerfiend/shared";
import { openPersistent, openEphemeral, openServerless, openSystemBrowser, renderHtml, type BrowserSession } from "@careerfiend/form-engine";
import { plainHtmlFetcher } from "@careerfiend/job-parser";
import {
  acquireRunLock,
  applyRetention,
  complete,
  enqueue,
  fail,
  gmailProvider,
  heartbeat,
  ingestUrl,
  computeTransfers,
  demandMapExists,
  generateDemandMap,
  requestDemandMap,
  releaseHeldApplications,
  backfillPostedJobs,
  bankBackfillPending,
  lease,
  importProfileIfEmpty,
  performLocalTask,
  performSubmission,
  pollEmail,
  pollWatchlist,
  prepare,
  regenerateDocuments,
  preparedToday,
  recordResumeHead,
  recoverAfterRestart,
  releaseRunLock,
  withinWindow,
  workerSettings,
  tenantContext,
  type AppContext,
  type LeasedItem,
  type LocalTask,
  type PageProvider,
  type WorkKind,
} from "@careerfiend/core";

/**
 * The background worker. Everything it does comes from the durable queue,
 * so a restart resumes where it stopped. Browser concurrency is one: items
 * run sequentially. It never submits anything that was not approved and
 * confirmed in the dashboard (SUBMIT items are created only by the
 * submission service after the invariant check).
 */

export interface WorkerOptions {
  headless?: boolean;
  /** Use a throwaway browser (tests, demo) instead of the persistent profile. */
  ephemeralBrowser?: boolean;
  /** Headless serverless Chromium (the hosted worker in a Vercel function). */
  serverless?: boolean;
  /** Desktop app: the computer's own Edge or Chrome, headless (no visible window, no saved profile). */
  systemBrowser?: boolean;
  pollMs?: number;
  /** How long a leased item stays reserved (default 10 minutes). */
  leaseMs?: number;
}

/** Time an item may need once started; the hosted worker starts nothing it cannot finish. */
const NEEDS_MS: Partial<Record<WorkKind, number>> = {
  SUBMIT: 150_000,
  PREPARE: 150_000,
  INGEST_URL: 45_000,
  WATCHLIST_POLL: 60_000,
  TRANSFER_MATCH: 60_000,
  DEMAND_MAP: 120_000,
  REGENERATE_DOCUMENTS: 120_000,
};

/**
 * The hosted worker: one bounded run under the run lock. Returns ran=false when
 * another run already holds the lock. `ctx` is one account's tenant context.
 */
export async function runCloudWorker(
  ctx: AppContext,
  budgetMs: number,
  opts: { serverless?: boolean; systemBrowser?: boolean } = {},
): Promise<{ ran: boolean; processed: number; more: boolean }> {
  const serverless = opts.serverless ?? true;
  const worker = new Worker(ctx, { serverless, systemBrowser: opts.systemBrowser, headless: serverless ? true : undefined, leaseMs: budgetMs + 60_000 });
  if (!(await acquireRunLock(ctx, worker.id, budgetMs + 60_000))) return { ran: false, processed: 0, more: false };
  try {
    return { ran: true, ...(await worker.runFor(budgetMs)) };
  } finally {
    await worker.stop();
    await releaseRunLock(ctx, worker.id);
  }
}

/** Time one account may use before the next one gets a turn (an item that needs longer still runs to the end). */
const TENANT_SLICE_MS = 190_000;

/**
 * Public edition: bounded runs over every account, least recently served
 * first, each in its own tenant context and under its own run lock. `more` is
 * true when an account still has due work or was not reached in this run.
 */
export async function runAllTenants(
  base: AppContext,
  budgetMs: number,
  opts: { serverless?: boolean; systemBrowser?: boolean } = {},
): Promise<{ accounts: number; processed: number; more: boolean }> {
  const deadline = Date.now() + budgetMs;
  const accounts = await base.db.account.findMany({
    orderBy: [{ lastWorkedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: { id: true, email: true, tenant: true },
  });
  let processed = 0;
  let more = false;
  let served = 0;
  for (const a of accounts) {
    const left = deadline - Date.now();
    if (left < 45_000) {
      more = true;
      break;
    }
    try {
      const ctx = await tenantContext(base, a);
      const r = await runCloudWorker(ctx, Math.min(left, TENANT_SLICE_MS), opts);
      processed += r.processed;
      more ||= r.more;
    } catch (err) {
      base.logger.error("worker.tenant_failed", { error: err });
    }
    await base.db.account.update({ where: { id: a.id }, data: { lastWorkedAt: new Date() } }).catch(() => undefined);
    served++;
  }
  return { accounts: served, processed, more };
}

export class Worker {
  readonly id = `worker-${os.hostname()}-${process.pid}-${randomId("w").slice(2, 8)}`;
  private browser: BrowserSession | null = null;
  private open = new Map<string, Page>();
  private stopping = false;

  constructor(
    private ctx: AppContext,
    private opts: WorkerOptions = {},
  ) {}

  private browserFailed = false;

  private async session(): Promise<BrowserSession> {
    if (this.browserFailed) throw new Error("No browser is available on this computer.");
    if (!this.browser) {
      const headless = this.opts.headless ?? this.ctx.config.BROWSER_HEADLESS === "true";
      try {
        this.browser = this.opts.serverless
          ? await openServerless()
          : this.opts.systemBrowser
            ? await openSystemBrowser()
            : this.opts.ephemeralBrowser
              ? await openEphemeral(headless)
              : await openPersistent(this.ctx.config.paths.browserProfileDir, headless);
      } catch (err) {
        this.browserFailed = true;
        this.ctx.logger.warn("worker.no_browser", { error: err });
        throw err;
      }
    }
    return this.browser;
  }

  /** Listing pages: rendered in the browser when there is one, else read over plain HTTP. */
  private readonly renderOrFetch = async (url: string) => {
    const session = await this.session().catch(() => null);
    return session ? renderHtml(session, url) : plainHtmlFetcher(url);
  };

  readonly pages: PageProvider = {
    page: async (id) => {
      const existing = this.open.get(id);
      if (existing && !existing.isClosed()) return { page: existing, reused: true };
      const page = await (await this.session()).newPage();
      this.open.set(id, page);
      return { page, reused: false };
    },
    release: async (id, keepOpen) => {
      if (keepOpen) return; // takeover: the page stays open in the visible browser
      const p = this.open.get(id);
      this.open.delete(id);
      await p?.close().catch(() => undefined);
    },
  };

  /** Kinds eligible to run now, in priority order. */
  private async eligibleKinds(remainingMs = Infinity): Promise<WorkKind[]> {
    return (await this.kindsNow()).filter((k) => (NEEDS_MS[k] ?? 30_000) <= remainingMs);
  }

  private async kindsNow(): Promise<WorkKind[]> {
    const s = await workerSettings(this.ctx);
    if (s.paused) return [];
    const kinds: WorkKind[] = ["SUBMIT", "LOCAL_TASK", "INGEST_URL", "REGENERATE_DOCUMENTS", "TRANSFER_MATCH", "DEMAND_MAP"];
    const inWindow = withinWindow(this.ctx.now(), s.runWindow, this.ctx.config.DISPLAY_TIMEZONE);
    const underLimit = s.dailyLimit === null || (await preparedToday(this.ctx)) < s.dailyLimit;
    if (inWindow && underLimit) kinds.push("PREPARE");
    kinds.push("EMAIL_POLL", "WATCHLIST_POLL", "RETENTION");
    return kinds;
  }

  /** `deadline` (epoch ms): when a bounded run needs this item to have stopped. */
  private async handle(item: LeasedItem, deadline?: number): Promise<void> {
    const p = item.payload as Record<string, string | boolean>;
    switch (item.kind) {
      case "INGEST_URL":
        // Every INGEST_URL comes from links you pasted; items queued before the flag existed count too.
        await ingestUrl(this.ctx, String(p.url), { endorse: p.endorse !== false });
        return;
      case "DEMAND_MAP":
        await generateDemandMap(this.ctx);
        return;
      case "TRANSFER_MATCH":
        if (await bankBackfillPending(this.ctx)) await backfillPostedJobs(this.ctx);
        await computeTransfers(this.ctx, { deadline });
        return;
      case "REGENERATE_DOCUMENTS":
        await regenerateDocuments(this.ctx, String(p.applicationId));
        return;
      case "PREPARE":
        await prepare(this.ctx, String(p.applicationId), this.pages, { resumeTakeover: !!p.resumeTakeover });
        return;
      case "SUBMIT":
        await performSubmission(this.ctx, String(p.attemptId), this.pages);
        return;
      case "EMAIL_POLL": {
        const provider = await gmailProvider(this.ctx);
        if (provider) await pollEmail(this.ctx, provider);
        return;
      }
      case "WATCHLIST_POLL":
        await pollWatchlist(this.ctx);
        return;
      case "RETENTION":
        await applyRetention(this.ctx);
        return;
      case "LOCAL_TASK":
        await performLocalTask(this.ctx, String(p.task) as LocalTask);
        return;
    }
  }

  /** Schedule recurring work (idempotent via dedupe keys). */
  async scheduleRecurring(): Promise<void> {
    const now = this.ctx.now().getTime();
    await recordResumeHead(this.ctx);
    await releaseHeldApplications(this.ctx);
    if (!(await demandMapExists(this.ctx)) && (await this.ctx.db.job.count({ where: { endorsed: true } }))) await requestDemandMap(this.ctx);
    if (await bankBackfillPending(this.ctx)) await enqueue(this.ctx.db, "TRANSFER_MATCH", {}, { dedupeKey: "transfer:pending" });
    if (await this.ctx.db.oAuthToken.findUnique({ where: { provider: "gmail" } })) {
      await enqueue(this.ctx.db, "EMAIL_POLL", {}, { dedupeKey: "recurring:email", runAt: new Date(now + this.ctx.config.EMAIL_POLL_MINUTES * 60_000) });
    }
    if (await this.ctx.db.watchlistCompany.count({ where: { enabled: true } })) {
      await enqueue(this.ctx.db, "WATCHLIST_POLL", {}, { dedupeKey: "recurring:watchlist", runAt: new Date(now + 6 * 3600_000) });
    }
    if (this.ctx.config.RETENTION_DAYS) {
      await enqueue(this.ctx.db, "RETENTION", {}, { dedupeKey: "recurring:retention", runAt: new Date(now + 24 * 3600_000) });
    }
  }

  /** Process one due item. Returns false when nothing was due. */
  async runOnce(remainingMs = Infinity): Promise<boolean> {
    await heartbeat(this.ctx, this.id);
    const kinds = await this.eligibleKinds(remainingMs);
    if (!kinds.length) return false;
    const item = await lease(this.ctx.db, this.id, kinds, this.ctx.now(), this.opts.leaseMs);
    if (!item) return false;
    const started = Date.now();
    try {
      await this.handle(item, remainingMs === Infinity ? undefined : started + remainingMs - 30_000);
      await complete(this.ctx.db, item.id);
      this.ctx.logger.info("work.done", { workItemId: item.id, kind: item.kind, durationMs: Date.now() - started });
    } catch (err) {
      const retryable = err instanceof CareerFiendError ? err.retryable : false;
      const outcome = await fail(this.ctx.db, item.id, (err as Error).message, retryable, this.ctx.now());
      this.ctx.logger.error("work.failed", {
        workItemId: item.id,
        kind: item.kind,
        errorCategory: err instanceof CareerFiendError ? err.category : "UNEXPECTED",
        status: outcome,
        error: err,
      });
    }
    return true;
  }

  /** Drain everything currently due (tests and the demo). */
  async drain(max = 100): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }

  /** Items due now that this worker would pick up (window, limit and pause respected). */
  async dueCount(): Promise<number> {
    const kinds = await this.eligibleKinds();
    if (!kinds.length) return 0;
    return this.ctx.db.workItem.count({ where: { status: "PENDING", runAt: { lte: this.ctx.now() }, kind: { in: kinds } } });
  }

  /**
   * One bounded run (the hosted worker, inside a serverless function): recover,
   * schedule recurring work, import the profile into an empty database, then
   * process due items until the budget runs out. `more` says whether due work
   * is left for another run.
   */
  async runFor(budgetMs: number): Promise<{ processed: number; more: boolean }> {
    const deadline = Date.now() + budgetMs;
    await recoverAfterRestart(this.ctx);
    await this.scheduleRecurring().catch((err) => this.ctx.logger.warn("worker.schedule_failed", { error: err }));
    await importProfileIfEmpty(this.ctx);
    // Listing pages that need JavaScript are rendered in this run's browser (started only if needed).
    this.ctx.fetchers = { ...(this.ctx.fetchers ?? {}), html: this.renderOrFetch };
    let processed = 0;
    while (!this.stopping && deadline - Date.now() > 30_000 && (await this.runOnce(deadline - Date.now()))) processed++;
    return { processed, more: (await this.dueCount()) > 0 };
  }

  async start(): Promise<void> {
    const first = await importProfileIfEmpty(this.ctx);
    if (first) this.ctx.logger.info("worker.profile_imported", { status: first.ok ? "ok" : `failed: ${first.message}` });
    const rec = await recoverAfterRestart(this.ctx);
    this.ctx.logger.info("worker.started", { count: rec.released, status: `uncertain=${rec.uncertain}` });
    if (this.opts.ephemeralBrowser !== true) {
      // Listing pages that need JavaScript are rendered in the same browser.
      this.ctx.fetchers = { ...(this.ctx.fetchers ?? {}), html: this.renderOrFetch };
    }
    let lastRecurring = 0;
    // Back off while idle so a hosted database (Neon) can scale to zero between bursts.
    const minIdle = this.opts.pollMs ?? 2000;
    const maxIdle = Math.max(minIdle, this.ctx.config.WORKER_MAX_IDLE_SECONDS * 1000);
    let idle = minIdle;
    while (!this.stopping) {
      if (Date.now() - lastRecurring > 60_000) {
        await this.scheduleRecurring().catch((err) => this.ctx.logger.warn("worker.schedule_failed", { error: err }));
        lastRecurring = Date.now();
      }
      const did = await this.runOnce().catch((err) => {
        this.ctx.logger.error("worker.loop_error", { error: err });
        return false;
      });
      if (did) idle = minIdle;
      else {
        await new Promise((r) => setTimeout(r, idle));
        idle = Math.min(idle * 2, maxIdle);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const p of this.open.values()) await p.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}
