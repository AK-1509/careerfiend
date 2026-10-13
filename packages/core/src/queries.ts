import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { decrypt, isEncrypted, RECOVERY_INSTRUCTIONS, type FailureCategory, type NormalizedJob, type Warning } from "@careerfiend/shared";
import { fromJson } from "@careerfiend/db";
import type { AppContext } from "./context";
import { listStored } from "./files";
import { allWarnings } from "./review";
import { startOfDay } from "./settings";
import { currentRevision, openAnswer, unresolvedRequired } from "./revision";

export const BUCKET_LABELS: Record<string, string> = {
  queued: "Queued",
  preparing: "Preparing",
  needsInput: "Needs input",
  ready: "Ready for review",
  approved: "Approved",
  submitted: "Submitted",
  uncertain: "Uncertain",
  manual: "Apply yourself",
  closed: "Closed",
};

export const BUCKETS: Record<string, string[]> = {
  queued: ["QUEUED"],
  preparing: ["READING_JOB", "GENERATING_DOCUMENTS", "FILLING"],
  needsInput: ["NEEDS_INPUT"],
  ready: ["READY_FOR_REVIEW"],
  approved: ["APPROVED", "SUBMITTING"],
  submitted: ["SUBMITTED", "CONFIRMATION_RECEIVED", "RESPONDED", "INTERVIEW", "OFFER"],
  uncertain: ["SUBMISSION_UNCERTAIN"],
  manual: ["MANUAL", "FAILED"],
  closed: ["REJECTED", "CLOSED"],
};

/** Links pasted on the dashboard that the worker has not read yet. */
export async function pendingIngest(ctx: AppContext): Promise<{ url: string; createdAt: Date; attempts: number; lastError: string | null }[]> {
  const rows = await ctx.db.workItem.findMany({
    where: { kind: "INGEST_URL", status: { in: ["PENDING", "RUNNING"] } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return rows.map((r) => ({
    url: String((JSON.parse(r.payload) as { url?: string }).url ?? ""),
    createdAt: r.createdAt,
    attempts: r.attempts,
    lastError: r.lastError,
  }));
}

/** Links the worker tried and could not read in the last 7 days, newest first, with the reason. */
export async function failedIngest(ctx: AppContext): Promise<{ url: string; reason: string; at: Date }[]> {
  const since = new Date(ctx.now().getTime() - 7 * 86_400_000);
  const rows = await ctx.db.workItem.findMany({
    where: { kind: "INGEST_URL", status: "FAILED", updatedAt: { gte: since } },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  return rows.map((r) => {
    const url = String((JSON.parse(r.payload) as { url?: string }).url ?? "");
    const raw = r.lastError ?? "Unknown error";
    const reason = /robots\.txt/i.test(raw)
      ? "The site's robots.txt forbids automated reading of this page. Paste the employer's own Apply link instead."
      : raw;
    return { url, reason, at: r.updatedAt };
  });
}

/** A worker counts as running if it checked the queue within two of its longest idle pauses. */
export function workerAlive(ctx: AppContext, beat: { at: string } | null): boolean {
  return !!beat && ctx.now().getTime() - new Date(beat.at).getTime() < Math.max(90, ctx.config.WORKER_MAX_IDLE_SECONDS * 2 + 30) * 1000;
}

export async function dashboardCounts(ctx: AppContext): Promise<Record<string, number>> {
  const rows = await ctx.db.application.groupBy({ by: ["state"], _count: { _all: true } });
  const out: Record<string, number> = Object.fromEntries(Object.keys(BUCKETS).map((k) => [k, 0]));
  for (const r of rows) for (const [b, states] of Object.entries(BUCKETS)) if (states.includes(r.state)) out[b]! += r._count._all;
  return out;
}

export interface ApplicationRow {
  id: string;
  state: string;
  company: string;
  title: string;
  location: string;
  coverage: number | null;
  priority: number;
  deferredUntil: Date | null;
  updatedAt: Date;
  createdAt: Date;
  source: string;
  failureCategory: string | null;
  emailStatus: string | null;
}

export async function listApplications(
  ctx: AppContext,
  filter: { q?: string; bucket?: string; state?: string; source?: string; from?: Date; to?: Date; emailStatus?: string } = {},
): Promise<ApplicationRow[]> {
  const states = filter.state ? [filter.state] : filter.bucket ? BUCKETS[filter.bucket] : undefined;
  const apps = await ctx.db.application.findMany({
    where: {
      ...(states ? { state: { in: states } } : {}),
      ...(filter.from || filter.to ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
      ...(filter.source ? { job: { source: filter.source } } : {}),
      ...(filter.q ? { OR: [{ job: { company: { contains: filter.q } } }, { job: { title: { contains: filter.q } } }] } : {}),
    },
    include: { job: true, emails: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
  });
  return apps
    .map((a) => ({
      id: a.id,
      state: a.state,
      company: a.job.company,
      title: a.job.title,
      location: a.job.location,
      coverage: a.job.coverage,
      priority: a.priority,
      deferredUntil: a.deferredUntil,
      updatedAt: a.updatedAt,
      createdAt: a.createdAt,
      source: a.job.source,
      failureCategory: a.failureCategory,
      emailStatus: a.emails[0]?.classification ?? null,
    }))
    .filter((r) => !filter.emailStatus || (filter.emailStatus === "none" ? r.emailStatus === null : r.emailStatus === filter.emailStatus));
}

/** End-of-day review queue: READY_FOR_REVIEW, not deferred, by priority. */
export async function readyQueue(ctx: AppContext): Promise<ApplicationRow[]> {
  const now = ctx.now();
  return (await listApplications(ctx, { bucket: "ready" })).filter((r) => !r.deferredUntil || r.deferredUntil <= now);
}

export async function applicationDetail(ctx: AppContext, id: string) {
  const key = ctx.key();
  const app = await ctx.db.application.findUniqueOrThrow({
    where: { id },
    include: {
      job: { include: { matches: true } },
      documents: { orderBy: [{ revisionNumber: "desc" }, { type: "asc" }] },
      approvals: { orderBy: { approvedAt: "desc" } },
      attempts: { orderBy: { startedAt: "desc" } },
      events: { orderBy: { createdAt: "asc" } },
      questions: { orderBy: { createdAt: "asc" } },
      emails: { include: { email: true }, orderBy: { createdAt: "desc" } },
    },
  });
  const rev = await currentRevision(ctx.db, id);
  const latestDraft = app.documents[0]?.revisionNumber ?? rev?.row.number ?? null;
  const fields =
    latestDraft === null ? [] : await ctx.db.formField.findMany({ where: { applicationId: id, revisionNumber: latestDraft }, orderBy: [{ step: "asc" }] });
  const docsForDraft = app.documents.filter((d) => d.revisionNumber === latestDraft);
  // Documents regenerated after the last revision (e.g. to apply yourself) are newer than the revision's: show those.
  const revDocs = rev && !(latestDraft !== null && latestDraft > rev.row.number) ? rev : null;
  const resumeDoc = revDocs ? null : docsForDraft.find((d) => d.type === "resume" && d.format === "pdf");
  const revisionDocs = revDocs ? revDocs.payload.documents : docsForDraft.map((d) => ({ type: d.type, format: d.format, path: d.path, sha256: d.sha256 }));
  const resumeProvenance = (
    app.documents.find(
      (d) =>
        d.type === "resume" &&
        d.format === "pdf" &&
        (!revDocs || d.path === revDocs.payload.documents.find((x) => x.type === "resume" && x.format === "pdf")?.path),
    ) ?? resumeDoc
  )?.provenance;
  const letterProv = (
    revDocs
      ? app.documents.find(
          (d) =>
            d.type === "cover_letter" &&
            d.format === "pdf" &&
            d.path === revDocs.payload.documents.find((x) => x.type === "cover_letter" && x.format === "pdf")?.path,
        )
      : docsForDraft.find((d) => d.type === "cover_letter" && d.format === "pdf")
  )?.provenance;
  // Screenshots come from the database (the hosted dashboard has no disk); older local-only files as a fallback.
  const stepsPrefix = latestDraft !== null ? `${id}/r${latestDraft}/steps/` : null;
  const stepsDir = latestDraft !== null ? path.join(ctx.config.paths.outputDir, id, `r${latestDraft}`, "steps") : null;
  const stored = stepsPrefix ? (await listStored(ctx, stepsPrefix)).filter((f) => f.endsWith(".png")) : [];
  const screenshots = stored.length
    ? stored
    : stepsDir && existsSync(stepsDir)
      ? readdirSync(stepsDir)
          .filter((f) => f.endsWith(".png"))
          .sort()
          .map((f) => path.join(stepsDir, f))
      : [];
  const warnings: Warning[] = rev ? await allWarnings(ctx, id) : [];
  return {
    app,
    job: fromJson<NormalizedJob>(app.job.normalized, null as unknown as NormalizedJob),
    matches: app.job.matches,
    revision: rev
      ? {
          number: rev.row.number,
          hash: rev.row.hash,
          reason: rev.row.reason,
          createdAt: rev.row.createdAt,
          payload: rev.payload,
          answers: rev.payload.answers.map((a) => ({ ...a, value: openAnswer(a, key) })),
          unresolved: unresolvedRequired(rev.payload).length,
        }
      : null,
    warnings,
    documents: revisionDocs,
    resumeReport: fromJson<{
      sourceCommit?: string;
      lines?: { line: string; key: string | null; kind?: string; original?: string }[];
      ats?: { keywords: { label: string; found: boolean; weight: number }[]; tailoredBullets: number; rejectedRewrites: number; skillsAdded: string[] };
      generatedBullets?: {
        bullets: { anchorId: string; template: string; evidenceIds: string[]; matchedTerms: string[]; relevanceScore: number }[];
        metrics: { discarded: number; llmCalls: number };
      } | null;
      matchReport?: {
        requirement: string;
        category: string;
        status: string;
        skills: string[];
        bullet: string | null;
        bulletKey: string | null;
        note: string;
      }[];
      dropped?: { key: string; reason: string }[];
      pages?: number;
    } | null>(resumeProvenance, null),
    letter:
      fromJson<{
        letter: {
          paragraphs: string[];
          sentences: { part: number; text: string; claimKeys: string[]; sources: { key: string; text: string }[] }[];
          generator: string;
          problems: string[];
          wordCount: number;
        };
      } | null>(letterProv, null)?.letter ?? null,
    fields: fields.map((f) => ({
      ...f,
      proposedValue: f.proposedValue && isEncrypted(f.proposedValue) ? decrypt(f.proposedValue, key) : f.proposedValue,
      options: fromJson<string[]>(f.options, []),
      provenance: fromJson<string[]>(f.provenance, []),
    })),
    questions: app.questions.map((q) => ({
      ...q,
      answer: q.answer && isEncrypted(q.answer) ? decrypt(q.answer, key) : q.answer,
      options: fromJson<string[]>(q.options, []),
    })),
    screenshots,
    recovery: app.failureCategory ? (RECOVERY_INSTRUCTIONS[app.failureCategory as FailureCategory] ?? null) : null,
    tracking: fromJson<Record<string, unknown>>(app.tracking, {}),
  };
}

/** filter: "added" (you chose it: has an application) | "found" (watchlist finds you have not applied to). */
export async function listJobs(ctx: AppContext, filter?: string) {
  return ctx.db.job.findMany({
    where: filter === "added" ? { endorsed: true } : filter === "found" ? { endorsed: false } : {},
    orderBy: { createdAt: "desc" },
    include: { applications: { select: { id: true, state: true } } },
  });
}

/** In-app end-of-day summary: what is ready, blocked or waiting for you to apply today. Nothing is submitted. */
export async function endOfDaySummary(ctx: AppContext, day = ctx.now()) {
  const start = startOfDay(day, ctx.config.DISPLAY_TIMEZONE);
  const touched = await listApplications(ctx, { from: start });
  return {
    ready: touched.filter((a) => a.state === "READY_FOR_REVIEW"),
    blocked: touched.filter((a) => a.state === "NEEDS_INPUT"),
    manual: touched.filter((a) => a.state === "MANUAL" || a.state === "FAILED"),
    uncertain: touched.filter((a) => a.state === "SUBMISSION_UNCERTAIN"),
    submitted: touched.filter((a) => a.state === "SUBMITTED"),
  };
}
