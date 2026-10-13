import { randomId } from "@careerfiend/shared";
import type { Db } from "@careerfiend/db";

/**
 * Durable, database-backed work queue (no in-memory timers). Items are
 * leased with a deadline; a crashed worker's lease expires and recovery
 * decides what happens next. SUBMIT items are never retried.
 */

/**
 * LOCAL_TASK: profile maintenance (re-extract the facts of the stored résumé).
 * TRANSFER_MATCH: link new skill-bank entries to your résumé facts and GitHub projects.
 * DEMAND_MAP: rebuild the skills-to-demonstrate list from the jobs you added.
 * REGENERATE_DOCUMENTS: rebuild one application's résumé and cover letter without touching its state.
 */
export type WorkKind =
  "INGEST_URL" | "PREPARE" | "SUBMIT" | "EMAIL_POLL" | "WATCHLIST_POLL" | "RETENTION" | "LOCAL_TASK" | "TRANSFER_MATCH" | "DEMAND_MAP" | "REGENERATE_DOCUMENTS";

export const MAX_ATTEMPTS: Record<WorkKind, number> = {
  INGEST_URL: 3,
  PREPARE: 3,
  SUBMIT: 1,
  EMAIL_POLL: 5,
  WATCHLIST_POLL: 3,
  RETENTION: 1,
  LOCAL_TASK: 1,
  TRANSFER_MATCH: 2,
  DEMAND_MAP: 2,
  REGENERATE_DOCUMENTS: 2,
};

export async function enqueue(
  db: Db,
  kind: WorkKind,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; runAt?: Date } = {},
): Promise<{ id: string; created: boolean }> {
  if (opts.dedupeKey) {
    const existing = await db.workItem.findUnique({ where: { dedupeKey: opts.dedupeKey } });
    if (existing) {
      if (existing.status === "DONE" || existing.status === "FAILED" || existing.status === "CANCELLED") {
        // Terminal items free their dedupe key for a new round (never for SUBMIT: its key is per attempt).
        await db.workItem.update({ where: { id: existing.id }, data: { dedupeKey: `${opts.dedupeKey}#${existing.id}` } });
      } else {
        return { id: existing.id, created: false };
      }
    }
  }
  const id = randomId("wi");
  await db.workItem.create({
    data: {
      id,
      kind,
      payload: JSON.stringify(payload),
      dedupeKey: opts.dedupeKey ?? null,
      runAt: opts.runAt ?? new Date(),
      maxAttempts: MAX_ATTEMPTS[kind],
    },
  });
  return { id, created: true };
}

export interface LeasedItem {
  id: string;
  kind: WorkKind;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Atomically lease the next due item of the given kinds. */
export async function lease(db: Db, workerId: string, kinds: WorkKind[], now: Date, leaseMs = 10 * 60_000): Promise<LeasedItem | null> {
  for (let tries = 0; tries < 5; tries++) {
    const next = await db.workItem.findFirst({
      where: { status: "PENDING", runAt: { lte: now }, kind: { in: kinds } },
      orderBy: [{ runAt: "asc" }, { createdAt: "asc" }],
    });
    if (!next) return null;
    const res = await db.workItem.updateMany({
      where: { id: next.id, status: "PENDING" },
      data: { status: "RUNNING", leasedBy: workerId, leaseUntil: new Date(now.getTime() + leaseMs), attempts: { increment: 1 } },
    });
    if (res.count === 1) return { id: next.id, kind: next.kind as WorkKind, payload: JSON.parse(next.payload), attempts: next.attempts + 1 };
  }
  return null;
}

export async function complete(db: Db, id: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status: "DONE", leaseUntil: null, lastError: null } });
}

/** Record a failure. Retryable failures back off exponentially until maxAttempts. */
export async function fail(db: Db, id: string, error: string, retryable: boolean, now: Date): Promise<"RETRY" | "FAILED"> {
  const item = await db.workItem.findUniqueOrThrow({ where: { id } });
  if (retryable && item.kind !== "SUBMIT" && item.attempts < item.maxAttempts) {
    const delay = Math.min(60 * 60_000, 30_000 * 2 ** (item.attempts - 1));
    await db.workItem.update({
      where: { id },
      data: { status: "PENDING", runAt: new Date(now.getTime() + delay), lastError: error.slice(0, 500), leaseUntil: null },
    });
    return "RETRY";
  }
  await db.workItem.update({ where: { id }, data: { status: "FAILED", lastError: error.slice(0, 500), leaseUntil: null } });
  return "FAILED";
}

/** Items whose worker died mid-run. */
export async function staleLeases(db: Db, now: Date) {
  return db.workItem.findMany({ where: { status: "RUNNING", leaseUntil: { lt: now } } });
}

export async function releaseStale(db: Db, id: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status: "PENDING", leaseUntil: null, leasedBy: null } });
}

export async function markFailed(db: Db, id: string, reason: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status: "FAILED", lastError: reason, leaseUntil: null } });
}

export async function cancelForApplication(db: Db, applicationId: string, kinds: WorkKind[]): Promise<void> {
  const items = await db.workItem.findMany({ where: { status: "PENDING", kind: { in: kinds } } });
  for (const i of items) {
    if ((JSON.parse(i.payload) as { applicationId?: string }).applicationId === applicationId) {
      await db.workItem.update({ where: { id: i.id }, data: { status: "CANCELLED" } });
    }
  }
}
