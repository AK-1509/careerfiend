import { randomId, type ApplicationState } from "@careerfiend/shared";
import { toJson } from "@careerfiend/db";
import { checkSubmitInvariant, SUBMIT_CONFIRMATION } from "@careerfiend/policy";
import type { AppContext } from "./context";
import { ATS_HOSTS, type PageProvider } from "./prepare";
import { enqueue, markFailed, staleLeases } from "./queue";
import { allWarnings } from "./review";
import { readFileSync } from "node:fs";
import { localFile, materialize, readStoredFile, storeDir } from "./files";
import { currentRevision, openAnswer, recomputeHash, unresolvedRequired } from "./revision";
import { transition } from "./transitions";

export class SubmissionRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`Submission refused: ${reasons.join(" ")}`);
  }
}

export interface SubmissionRequest {
  attemptId: string;
  /** True when this call found an attempt that already existed (double click / replay). */
  existing: boolean;
}

/**
 * The server-side submit boundary. In ONE transaction:
 *   1. recompute the revision hash from the current file bytes;
 *   2. run the approval invariant (state, approval, hash, fields, warnings, confirmation);
 *   3. consume the approval with a conditional update (only one caller can win);
 *   4. create the SubmissionAttempt (unique approvalId + idempotency key);
 *   5. move APPROVED → SUBMITTING and enqueue exactly one SUBMIT job.
 * A second call for the same approval returns the existing attempt; it never
 * creates another submission.
 */
export async function requestSubmission(ctx: AppContext, applicationId: string, input: { confirmation: string }): Promise<SubmissionRequest> {
  const key = ctx.key();
  // Idempotent replay: an attempt already exists for the latest approval.
  const latest = await ctx.db.approval.findFirst({ where: { applicationId }, orderBy: { approvedAt: "desc" }, include: { attempt: true } });
  if (latest?.attempt) return { attemptId: latest.attempt.id, existing: true };

  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } });
  const rev = await currentRevision(ctx.db, applicationId);
  const approval = latest && !latest.invalidatedAt ? latest : null;
  const warnings = await allWarnings(ctx, applicationId);
  const acknowledged = approval ? ((JSON.parse(approval.audit) as { acknowledgedWarnings?: string[] }).acknowledgedWarnings ?? []) : [];
  const verdict = checkSubmitInvariant({
    state: app.state as ApplicationState,
    currentRevisionHash: rev?.row.hash ?? null,
    recomputedHash: rev ? await recomputeHash(rev.payload, key, (p) => readStoredFile(ctx, p)) : null,
    approval: approval
      ? { revisionHash: approval.revisionHash, consumedAt: approval.consumedAt, invalidatedAt: approval.invalidatedAt, confirmation: approval.confirmation }
      : null,
    unresolvedRequiredFields: rev ? unresolvedRequired(rev.payload).length : 1,
    warnings,
    acknowledgedWarningCodes: acknowledged,
    expectedConfirmation: SUBMIT_CONFIRMATION,
    submitConfirmation: input.confirmation,
  });
  if (!verdict.ok) {
    ctx.logger.warn("submit.refused", { applicationId, count: verdict.reasons.length });
    throw new SubmissionRefused(verdict.reasons);
  }

  const attemptId = randomId("sub");
  try {
    await ctx.db.$transaction(async (tx) => {
      const consumed = await tx.approval.updateMany({
        where: { id: approval!.id, consumedAt: null, invalidatedAt: null, revisionHash: rev!.row.hash },
        data: { consumedAt: ctx.now() },
      });
      if (consumed.count !== 1) throw new SubmissionRefused(["The approval was consumed or invalidated concurrently."]);
      await tx.submissionAttempt.create({
        data: {
          id: attemptId,
          applicationId,
          approvalId: approval!.id,
          idempotencyKey: `submit:${applicationId}:${approval!.id}`,
          revisionHash: rev!.row.hash,
        },
      });
      await transition(tx, applicationId, "SUBMITTING", "user:dashboard", `Submit confirmed for revision ${rev!.row.number}`);
    });
  } catch (err) {
    // A concurrent request that lost the race sees the winner's attempt.
    const again = await ctx.db.approval.findUnique({ where: { id: approval!.id }, include: { attempt: true } });
    if (again?.attempt) return { attemptId: again.attempt.id, existing: true };
    throw err;
  }
  await enqueue(ctx.db, "SUBMIT", { applicationId, attemptId }, { dedupeKey: `submit:${attemptId}` });
  ctx.logger.info("submit.requested", { applicationId });
  return { attemptId, existing: false };
}

/**
 * Worker side: replay the approved revision and click submit once.
 * Never retried. Ambiguous results become SUBMISSION_UNCERTAIN.
 */
export async function performSubmission(ctx: AppContext, attemptId: string, pages: PageProvider): Promise<string> {
  const key = ctx.key();
  const attempt = await ctx.db.submissionAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  if (attempt.result !== "PENDING") return attempt.result;
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: attempt.applicationId }, include: { job: true } });
  if (app.state !== "SUBMITTING") return `skipped (${app.state})`;
  const rev = await currentRevision(ctx.db, app.id);
  // The worker uploads its local copies (fetched from the database when a file
  // was made elsewhere, e.g. a letter edited on the hosted dashboard), so the
  // hash is checked against exactly those bytes.
  const readLocal = async (p: string) => {
    const local = await materialize(ctx, p);
    return local ? readFileSync(local) : null;
  };
  if (!rev || rev.row.hash !== attempt.revisionHash || (await recomputeHash(rev.payload, key, readLocal)) !== attempt.revisionHash) {
    await ctx.db.submissionAttempt.update({
      where: { id: attemptId },
      data: {
        result: "FAILED",
        endedAt: ctx.now(),
        errorCategory: "VALIDATION_FAILED",
        errorMessage: "Revision changed after approval. Nothing was submitted.",
      },
    });
    await transition(ctx.db, app.id, "MANUAL", "worker:submit", "Revision changed after approval; nothing was submitted.", {
      failureCategory: "VALIDATION_FAILED",
      failedDuringSubmit: true,
    });
    return "FAILED";
  }
  const answers: Record<string, string> = {};
  for (const a of rev.payload.answers) {
    const v = openAnswer(a, key);
    if (v !== null && v !== "") answers[a.fieldKey] = v;
  }
  const uploads = Object.fromEntries(rev.payload.uploads.map((u) => [u.fieldKey, { path: localFile(ctx, u.path), sha256: u.sha256 }]));
  const host = new URL(rev.payload.targetUrl).hostname;
  let outcome;
  const { page } = await pages.page(app.id);
  try {
    const { submitRevision } = await import("@careerfiend/form-engine");
    outcome = await submitRevision(
      page,
      {
        targetUrl: rev.payload.targetUrl,
        outputDir: `${ctx.config.paths.outputDir}/${app.id}/r${rev.row.number}`,
        allowedHosts: [host, ...ATS_HOSTS, ...(ctx.config.ALLOW_LOCALHOST_TARGETS === "true" ? ["localhost", "127.0.0.1"] : [])],
        confirmTimeoutMs: Number(process.env.CF_CONFIRM_TIMEOUT_MS ?? 20_000),
      },
      { answers, uploads },
    );
  } catch (err) {
    outcome = {
      result: "UNCERTAIN" as const,
      confirmationUrl: null,
      confirmationText: null,
      screenshotPath: null,
      errorCategory: "SUBMISSION_UNCERTAIN" as const,
      message: `Submission crashed: ${(err as Error).message.split("\n")[0]}`,
    };
  } finally {
    await pages.release(app.id, false).catch(() => undefined);
  }
  const resultCode = outcome.result === "SUBMITTED" ? "SUBMITTED" : outcome.result === "FAILED" ? "FAILED" : "UNCERTAIN";
  await ctx.db.submissionAttempt.update({
    where: { id: attemptId },
    data: {
      result: resultCode,
      endedAt: ctx.now(),
      confirmationUrl: outcome.confirmationUrl,
      confirmationText: outcome.confirmationText,
      screenshotPath: outcome.screenshotPath,
      errorCategory: outcome.errorCategory,
      errorMessage: outcome.message,
    },
  });
  // Confirmation screenshot for the dashboard; the result above is already recorded.
  await storeDir(ctx, app.id, `${ctx.config.paths.outputDir}/${app.id}/r${rev.row.number}/steps`).catch((err) =>
    ctx.logger.warn("files.store_failed", { applicationId: app.id, message: String(err) }),
  );
  if (resultCode === "SUBMITTED") {
    await recordTracking(ctx, app.id, outcome.confirmationText);
    await transition(ctx.db, app.id, "SUBMITTED", "worker:submit", outcome.message);
  } else if (resultCode === "FAILED") {
    // The site refused it (often a spam or bot check). Nothing is retried: the documents stay ready to apply by hand.
    await transition(ctx.db, app.id, "MANUAL", "worker:submit", outcome.message, {
      failureCategory: outcome.errorCategory,
      failureMessage: outcome.message,
      failedDuringSubmit: true,
    });
  } else {
    await transition(ctx.db, app.id, "SUBMISSION_UNCERTAIN", "worker:submit", outcome.message, {
      failureCategory: "SUBMISSION_UNCERTAIN",
      failureMessage: outcome.message,
    });
  }
  ctx.logger.info("submit.finished", { applicationId: app.id, status: resultCode });
  return resultCode;
}

/** Email-matching context for a submitted application (company, domains, ATS ids, when). */
async function recordTracking(ctx: AppContext, applicationId: string, confirmationText: string | null): Promise<void> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId }, include: { job: true } });
  const row = await ctx.db.userProfile.findUnique({ where: { id: "me" } });
  const profile = (row ? JSON.parse(row.contact) : {}) as { email?: string };
  const job = JSON.parse(app.job.normalized) as { applyUrl: string | null; canonicalUrl: string; atsIdentifiers: Record<string, string> };
  const hosts = [job.applyUrl, job.canonicalUrl].filter(Boolean).map((u) => new URL(u!).hostname.replace(/^www\./, ""));
  await ctx.db.application.update({
    where: { id: app.id },
    data: {
      tracking: toJson({
        company: app.job.company,
        role: app.job.title,
        domains: [...new Set(hosts.filter((h) => !ATS_HOSTS.some((a) => h.endsWith(a))))],
        atsHosts: [...new Set(hosts.filter((h) => ATS_HOSTS.some((a) => h.endsWith(a))))],
        atsIdentifiers: job.atsIdentifiers,
        recipient: profile.email ?? "",
        submittedAt: ctx.now().toISOString(),
        confirmationText,
      }),
    },
  });
}

/**
 * Manual resolution after the user checked email / the employer portal. "Not
 * submitted" leaves the application for you to apply yourself (never retried).
 */
export async function resolveUncertain(ctx: AppContext, applicationId: string, outcome: "SUBMITTED" | "FAILED", note: string): Promise<void> {
  await transition(
    ctx.db,
    applicationId,
    outcome === "SUBMITTED" ? "SUBMITTED" : "MANUAL",
    "user:dashboard",
    `Manually resolved: ${note || outcome}`,
    outcome === "FAILED"
      ? { failureCategory: "SUBMISSION_UNCERTAIN", failureMessage: `Not submitted: ${note || "checked by you"}.`, failedDuringSubmit: true }
      : {},
  );
  if (outcome === "SUBMITTED") await recordTracking(ctx, applicationId, null);
  const attempt = await ctx.db.submissionAttempt.findFirst({ where: { applicationId }, orderBy: { startedAt: "desc" } });
  if (attempt)
    await ctx.db.submissionAttempt.update({
      where: { id: attempt.id },
      data: { result: outcome, errorMessage: `${attempt.errorMessage ?? ""} | resolved manually: ${note}` },
    });
}

/** You applied on the employer's site yourself: the application is tracked as submitted from now on. */
export async function markAppliedManually(ctx: AppContext, applicationId: string, note = ""): Promise<void> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } });
  if (app.state !== "MANUAL" && app.state !== "FAILED")
    throw new SubmissionRefused([`Only applications waiting for you to apply can be marked as applied (state is ${app.state}).`]);
  await transition(ctx.db, applicationId, "SUBMITTED", "user:dashboard", note ? `Applied manually: ${note}` : "Applied manually on the employer's site", {
    failureCategory: null,
    failureMessage: null,
  });
  await recordTracking(ctx, applicationId, null);
}

/** Re-queue preparation of an application you were asked to apply to yourself. Never after a submission attempt. */
export async function retryPreparation(ctx: AppContext, applicationId: string): Promise<void> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } });
  if (app.failedDuringSubmit)
    throw new SubmissionRefused(["This application failed during submission. Check the employer portal; it cannot be re-queued automatically."]);
  await transition(ctx.db, applicationId, "QUEUED", "user:dashboard", "Retry preparation", { failureCategory: null, failureMessage: null });
  await enqueue(ctx.db, "PREPARE", { applicationId }, { dedupeKey: `prepare:${applicationId}` });
}

/**
 * Restart recovery. A SUBMIT item whose lease expired may have clicked submit
 * before the crash, so it becomes SUBMISSION_UNCERTAIN (never retried).
 * Other stale items are released for another attempt.
 */
export async function recoverAfterRestart(ctx: AppContext): Promise<{ released: number; uncertain: number }> {
  const { releaseStale } = await import("./queue");
  let released = 0;
  let uncertain = 0;
  for (const item of await staleLeases(ctx.db, ctx.now())) {
    if (item.kind === "SUBMIT") {
      const { applicationId, attemptId } = JSON.parse(item.payload) as { applicationId: string; attemptId: string };
      await markFailed(ctx.db, item.id, "Worker stopped during submission.");
      const attempt = await ctx.db.submissionAttempt.findUnique({ where: { id: attemptId } });
      if (attempt?.result === "PENDING") {
        await ctx.db.submissionAttempt.update({
          where: { id: attemptId },
          data: { result: "UNCERTAIN", endedAt: ctx.now(), errorCategory: "SUBMISSION_UNCERTAIN", errorMessage: "Worker stopped during submission." },
        });
        const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } });
        if (app.state === "SUBMITTING") {
          await transition(
            ctx.db,
            applicationId,
            "SUBMISSION_UNCERTAIN",
            "system:recovery",
            "Worker stopped during submission; check before doing anything else.",
            { failureCategory: "SUBMISSION_UNCERTAIN" },
          );
        }
        uncertain++;
      }
    } else {
      await releaseStale(ctx.db, item.id);
      released++;
    }
  }
  return { released, uncertain };
}
