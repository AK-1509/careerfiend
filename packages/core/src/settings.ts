import { closedBoard, JOB_BOARD_LINK_HELP } from "@careerfiend/job-parser";
import type { AppContext } from "./context";
import { enqueue } from "./queue";

/** Worker controls stored in the database so the dashboard can change them. */
export interface WorkerSettings {
  paused: boolean;
  dailyLimit: number | null;
  runWindow: string;
  endOfDay: string;
  concurrency: number;
}

async function get(ctx: AppContext, key: string): Promise<string | null> {
  return (await ctx.db.setting.findUnique({ where: { key } }))?.value ?? null;
}
async function put(ctx: AppContext, key: string, value: string): Promise<void> {
  await ctx.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function workerSettings(ctx: AppContext): Promise<WorkerSettings> {
  const limit = (await get(ctx, "worker.dailyLimit")) ?? (ctx.config.DAILY_PREPARE_LIMIT ? String(ctx.config.DAILY_PREPARE_LIMIT) : null);
  return {
    paused: (await get(ctx, "worker.paused")) === "true",
    dailyLimit: limit ? Number(limit) : null,
    runWindow: (await get(ctx, "worker.runWindow")) ?? ctx.config.RUN_WINDOW,
    endOfDay: (await get(ctx, "worker.endOfDay")) ?? ctx.config.END_OF_DAY,
    concurrency: ctx.config.BROWSER_CONCURRENCY,
  };
}

export async function updateWorkerSettings(
  ctx: AppContext,
  patch: Partial<Pick<WorkerSettings, "paused" | "dailyLimit" | "runWindow" | "endOfDay">>,
): Promise<void> {
  if (patch.paused !== undefined) await put(ctx, "worker.paused", String(patch.paused));
  if (patch.dailyLimit !== undefined) await put(ctx, "worker.dailyLimit", patch.dailyLimit === null ? "" : String(patch.dailyLimit));
  if (patch.runWindow !== undefined) {
    if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(patch.runWindow)) throw new Error('Run window must look like "08:00-20:00".');
    await put(ctx, "worker.runWindow", patch.runWindow);
  }
  if (patch.endOfDay !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(patch.endOfDay)) throw new Error('End of day must look like "18:00".');
    await put(ctx, "worker.endOfDay", patch.endOfDay);
  }
}

/** Wall-clock parts in a time zone (the server runs in UTC on Vercel; your day is in DISPLAY_TIMEZONE). */
export function zonedParts(now: Date, timeZone?: string): { year: number; month: number; day: number; hour: number; minute: number } {
  if (!timeZone) return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), minute: now.getMinutes() };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/** Start of "today" in a time zone, as an instant. */
export function startOfDay(now: Date, timeZone?: string): Date {
  const p = zonedParts(now, timeZone);
  const sinceMidnightMs = (p.hour * 60 + p.minute) * 60_000 + now.getSeconds() * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - sinceMidnightMs);
}

export function withinWindow(now: Date, window: string, timeZone?: string): boolean {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!m) return true;
  const z = zonedParts(now, timeZone);
  const mins = z.hour * 60 + z.minute;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) return true; // "00:00-00:00" = always
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end;
}

/** Applications the worker started preparing today (for the daily limit). */
export async function preparedToday(ctx: AppContext): Promise<number> {
  const start = startOfDay(ctx.now(), ctx.config.DISPLAY_TIMEZONE);
  return ctx.db.statusEvent.count({ where: { to: "READING_JOB", actor: "worker:prepare", createdAt: { gte: start } } });
}

export async function heartbeat(ctx: AppContext, workerId: string): Promise<void> {
  await put(ctx, "worker.heartbeat", JSON.stringify({ workerId, at: ctx.now().toISOString() }));
}

export async function workerHeartbeat(ctx: AppContext): Promise<{ workerId: string; at: string } | null> {
  const v = await get(ctx, "worker.heartbeat");
  return v ? (JSON.parse(v) as { workerId: string; at: string }) : null;
}

/** Bulk paste/import: one URL per line (blank lines and duplicates ignored). */
export interface EnqueueUrlsResult {
  queued: number;
  /** Already waiting in the queue (pasted earlier and not read yet). */
  alreadyQueued: string[];
  /** Links on job boards that forbid automated reading, with the board's name. */
  blocked: { url: string; board: string }[];
  invalid: string[];
}

export async function enqueueUrls(ctx: AppContext, text: string): Promise<EnqueueUrlsResult> {
  const out: EnqueueUrlsResult = { queued: 0, alreadyQueued: [], blocked: [], invalid: [] };
  const urls = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  for (const u of urls) {
    let url: URL;
    try {
      url = new URL(u);
      if (!/^https?:$/.test(url.protocol)) throw new Error("scheme");
    } catch {
      out.invalid.push(u);
      continue;
    }
    const board = closedBoard(url.toString());
    if (board) {
      out.blocked.push({ url: url.toString(), board });
      continue;
    }
    // Links you paste are listings you chose: their skills go to your skill bank.
    const r = await enqueue(ctx.db, "INGEST_URL", { url: url.toString(), endorse: true }, { dedupeKey: `ingest:${url.toString()}` });
    if (r.created) out.queued++;
    else out.alreadyQueued.push(url.toString());
  }
  return out;
}

/** One line for the dashboard describing what happened to pasted links. */
export function describeEnqueue(r: EnqueueUrlsResult): string {
  const parts = [`${r.queued} link${r.queued === 1 ? "" : "s"} queued.`];
  if (r.alreadyQueued.length) parts.push(`${r.alreadyQueued.length} already waiting in the queue (not added twice).`);
  if (r.blocked.length) {
    const boards = [...new Set(r.blocked.map((b) => b.board))];
    const linkedInOrIndeed = boards.some((b) => b === "LinkedIn" || b === "Indeed");
    parts.push(
      `${r.blocked.length} not queued (${boards.join(", ")}). ${
        linkedInOrIndeed
          ? JOB_BOARD_LINK_HELP
          : "That site forbids automated reading of job pages. Open each posting, follow it to the employer's application page and send that link instead."
      }`,
    );
  }
  if (r.invalid.length) parts.push(`Not links: ${r.invalid.slice(0, 5).join(", ")}${r.invalid.length > 5 ? "…" : ""}.`);
  return parts.join(" ");
}

/* ---- One hosted worker run at a time ------------------------------------ */

const RUN_LOCK = "worker.runLock";

/** Take the run lock (compare-and-swap on the settings row). False when another run holds it. */
export async function acquireRunLock(ctx: AppContext, owner: string, ttlMs: number): Promise<boolean> {
  const now = ctx.now().getTime();
  const value = `${new Date(now + ttlMs).toISOString()}|${owner}`;
  const row = await ctx.db.setting.findUnique({ where: { key: RUN_LOCK } });
  if (!row) {
    try {
      await ctx.db.setting.create({ data: { key: RUN_LOCK, value } });
      return true;
    } catch {
      return false; // someone else created it first
    }
  }
  const [until, holder] = row.value.split("|");
  if (holder !== owner && until && new Date(until).getTime() > now) return false;
  return (await ctx.db.setting.updateMany({ where: { key: RUN_LOCK, value: row.value }, data: { value } })).count === 1;
}

export async function releaseRunLock(ctx: AppContext, owner: string): Promise<void> {
  const row = await ctx.db.setting.findUnique({ where: { key: RUN_LOCK } });
  if (row?.value.endsWith(`|${owner}`))
    await ctx.db.setting.updateMany({ where: { key: RUN_LOCK, value: row.value }, data: { value: `${new Date(0).toISOString()}|` } });
}

/** True while a hosted worker run holds the lock. */
export async function runLockActive(ctx: AppContext): Promise<boolean> {
  const until = (await get(ctx, RUN_LOCK))?.split("|")[0];
  return !!until && new Date(until).getTime() > ctx.now().getTime();
}
