import path from "node:path";
import { randomId, type ApplicationState, type Warning } from "@careerfiend/shared";
import { toJson } from "@careerfiend/db";
import { currentFacts } from "@careerfiend/profile";
import { buildLetterFiles, validateUserLetter, writeDocuments } from "@careerfiend/documents";
import { APPROVAL_CONFIRMATION, checkApprovable } from "@careerfiend/policy";
import type { AppContext } from "./context";
import { storeFiles } from "./files";
import { resumeHead } from "./local-tasks";
import { cancelForApplication } from "./queue";
import { createRevision, currentRevision, unresolvedRequired, type RevisionPayload } from "./revision";
import { transition } from "./transitions";

export class ReviewError extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" "));
  }
}

/** Warnings computed at read time (not stored), e.g. the résumé changed. */
export async function dynamicWarnings(ctx: AppContext, payload: RevisionPayload): Promise<Warning[]> {
  const out: Warning[] = [];
  const head = await resumeHead(ctx);
  if (head && head !== payload.sourceCommit) {
    out.push({
      code: "SOURCE_CHANGED",
      message: `Your résumé changed from ${payload.sourceCommit.slice(0, 12)} to ${head.slice(0, 12)} after this draft was built. Regenerate before approving.`,
      blocking: true,
      acknowledged: false,
    });
  }
  return out;
}

export async function allWarnings(ctx: AppContext, applicationId: string): Promise<Warning[]> {
  const rev = await currentRevision(ctx.db, applicationId);
  if (!rev) return [];
  return [...rev.warnings, ...(await dynamicWarnings(ctx, rev.payload))];
}

/**
 * Approve the exact revision the user reviewed. `revisionHash` comes from the
 * page the user looked at; a newer revision makes the approval fail.
 */
export async function approve(
  ctx: AppContext,
  applicationId: string,
  input: { revisionHash: string; confirmation: string; acknowledgedWarnings: string[]; userAgent?: string },
): Promise<string> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } });
  const rev = await currentRevision(ctx.db, applicationId);
  if (!rev) throw new ReviewError(["There is no revision to approve."]);
  if (rev.row.hash !== input.revisionHash) throw new ReviewError(["The application changed after you opened it. Reload and review the current revision."]);
  const warnings = await allWarnings(ctx, applicationId);
  const check = checkApprovable({
    state: app.state as ApplicationState,
    unresolvedRequiredFields: unresolvedRequired(rev.payload).length,
    warnings,
    acknowledgedWarningCodes: input.acknowledgedWarnings,
    confirmation: input.confirmation,
  });
  if (!check.ok) throw new ReviewError(check.reasons);
  const id = randomId("apr");
  await ctx.db.$transaction(async (tx) => {
    await tx.approval.create({
      data: {
        id,
        applicationId,
        revisionHash: rev.row.hash,
        confirmation: APPROVAL_CONFIRMATION,
        audit: toJson({ acknowledgedWarnings: input.acknowledgedWarnings, revisionNumber: rev.row.number, userAgent: input.userAgent ?? null }),
      },
    });
    await transition(tx, applicationId, "APPROVED", "user:dashboard", `Approved revision ${rev.row.number} (${rev.row.hash.slice(0, 12)})`);
  });
  return id;
}

export async function rejectApplication(ctx: AppContext, applicationId: string, reason: string): Promise<void> {
  await transition(ctx.db, applicationId, "REJECTED", "user:dashboard", reason || "Rejected by you");
  await cancelForApplication(ctx.db, applicationId, ["PREPARE"]);
}

async function invalidateApprovals(ctx: AppContext, applicationId: string, reason: string): Promise<void> {
  await ctx.db.approval.updateMany({
    where: { applicationId, consumedAt: null, invalidatedAt: null },
    data: { invalidatedAt: ctx.now(), invalidReason: reason },
  });
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } });
  if (app.state === "APPROVED") await transition(ctx.db, applicationId, "READY_FOR_REVIEW", "user:dashboard", `Approval invalidated: ${reason}`);
}

function assertEditable(state: string): void {
  if (state !== "READY_FOR_REVIEW" && state !== "APPROVED") throw new ReviewError([`Edits are allowed only before submission (state is ${state}).`]);
}

/** Edit one answer: creates a new revision and invalidates any approval. */
export async function editAnswer(ctx: AppContext, applicationId: string, fieldKey: string, value: string): Promise<{ revisionNumber: number }> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } });
  assertEditable(app.state);
  const rev = await currentRevision(ctx.db, applicationId);
  if (!rev) throw new ReviewError(["No revision."]);
  const target = rev.payload.answers.find((a) => a.fieldKey === fieldKey);
  if (!target) throw new ReviewError([`Unknown field ${fieldKey}.`]);
  const payload: RevisionPayload = {
    ...rev.payload,
    answers: rev.payload.answers.map((a) =>
      a.fieldKey === fieldKey
        ? {
            ...a,
            value: value.trim() === "" ? null : value,
            source: "user-answer",
            provenance: [`edited:${ctx.now().toISOString()}`],
            confidence: 1,
            note: "Edited by you",
          }
        : a,
    ),
  };
  const created = await createRevision(ctx.db, applicationId, payload, rev.warnings, `Edited "${target.label}"`, ctx.key());
  await invalidateApprovals(ctx, applicationId, `answer "${target.label}" edited`);
  return { revisionNumber: created.number };
}

/** Replace the cover letter with the user's text: new files, new revision, approvals invalidated. */
export async function editCoverLetter(ctx: AppContext, applicationId: string, paragraphs: string[]): Promise<{ revisionNumber: number; problems: string[] }> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId }, include: { job: true } });
  assertEditable(app.state);
  const rev = await currentRevision(ctx.db, applicationId);
  if (!rev) throw new ReviewError(["No revision."]);
  const facts = (await currentFacts(ctx.db)).map((f) => ({ key: f.key, text: f.text }));
  const letter = validateUserLetter(
    paragraphs.filter((p) => p.trim()),
    facts,
  );
  const profile = JSON.parse((await ctx.db.userProfile.findUniqueOrThrow({ where: { id: "me" } })).contact) as {
    name: string;
    email: string;
    location: string;
  };
  const header = [profile.name, profile.email, profile.location, "", app.job.company, `Re: ${app.job.title}`];
  const files = await buildLetterFiles(letter, header);
  const n = rev.row.number + 1;
  const dir = path.join(ctx.config.paths.outputDir, applicationId, `r${n}`);
  const written = writeDocuments(dir, [
    { type: "cover_letter", format: "pdf", name: "cover-letter.pdf", data: files.pdf },
    { type: "cover_letter", format: "docx", name: "cover-letter.docx", data: files.docx },
    { type: "cover_letter", format: "txt", name: "cover-letter.txt", data: files.text },
  ]);
  await storeFiles(
    ctx,
    applicationId,
    written.map((w) => w.path),
  );
  for (const w of written) {
    await ctx.db.generatedDocument.create({
      data: {
        id: randomId("doc"),
        applicationId,
        revisionNumber: n,
        type: w.type,
        format: w.format,
        path: w.path,
        sha256: w.sha256,
        templateVersion: "letter-user-edit",
        provenance: toJson({ letter, warnings: [] }),
      },
    });
  }
  const oldPdf = rev.payload.documents.find((d) => d.type === "cover_letter" && d.format === "pdf");
  const newPdf = written.find((w) => w.format === "pdf")!;
  const payload: RevisionPayload = {
    ...rev.payload,
    documents: [
      ...rev.payload.documents.filter((d) => d.type !== "cover_letter"),
      ...written.map((w) => ({ type: w.type, format: w.format, path: w.path, sha256: w.sha256 })),
    ],
    uploads: rev.payload.uploads.map((u) => (oldPdf && u.path === oldPdf.path ? { ...u, path: newPdf.path, sha256: newPdf.sha256 } : u)),
    answers: rev.payload.answers.map((a) =>
      a.semanticType === "cover_letter_text" ? { ...a, value: letter.paragraphs.join("\n\n"), source: "user-answer", note: "Edited by you" } : a,
    ),
    coverLetter: { paragraphs: letter.paragraphs, generator: "user" },
  };
  const warnings = rev.warnings.filter((w) => !["COVER_LETTER_INVALID", "COVER_LETTER_FALLBACK", "LETTER_NUMBERS_UNVERIFIED"].includes(w.code));
  if (letter.problems.length)
    warnings.push({
      code: "LETTER_NUMBERS_UNVERIFIED",
      message: letter.problems.join(" "),
      blocking: letter.problems.some((p) => /excluded/.test(p)),
      acknowledged: false,
    });
  const created = await createRevision(ctx.db, applicationId, payload, warnings, "Cover letter edited", ctx.key());
  await invalidateApprovals(ctx, applicationId, "cover letter edited");
  return { revisionNumber: created.number, problems: letter.problems };
}

/** Throw the draft away and prepare again (e.g. after SOURCE_CHANGED). */
/** States in which the worker is already building this application; regenerating waits until it stops. */
const BUSY: readonly ApplicationState[] = ["QUEUED", "READING_JOB", "GENERATING_DOCUMENTS", "FILLING", "SUBMITTING"];

/**
 * Regenerate the résumé and cover letter. Before submission this rebuilds the
 * draft (and the form answers) as a new revision, invalidating any approval.
 * In every other state (apply yourself, submitted, closed...) it rebuilds just
 * the documents and leaves the state alone, so nothing is ever re-submitted.
 */
export async function regenerate(ctx: AppContext, applicationId: string): Promise<"draft" | "documents"> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } });
  const state = app.state as ApplicationState;
  if (BUSY.includes(state))
    throw new ReviewError([`CareerFiend is working on this application right now (${state.toLowerCase().replace(/_/g, " ")}). Try again when it finishes.`]);
  const { enqueue } = await import("./queue");
  if (state === "READY_FOR_REVIEW" || state === "APPROVED" || state === "NEEDS_INPUT") {
    if (state === "APPROVED") await invalidateApprovals(ctx, applicationId, "regenerating documents");
    await transition(ctx.db, applicationId, "GENERATING_DOCUMENTS", "user:dashboard", "Regenerate requested");
    await enqueue(ctx.db, "PREPARE", { applicationId }, { dedupeKey: `prepare:${applicationId}` });
    return "draft";
  }
  await enqueue(ctx.db, "REGENERATE_DOCUMENTS", { applicationId }, { dedupeKey: `regenerate:${applicationId}` });
  return "documents";
}

export function canRegenerate(state: string): boolean {
  return !BUSY.includes(state as ApplicationState);
}

export async function defer(ctx: AppContext, applicationId: string, days: number): Promise<void> {
  await ctx.db.application.update({ where: { id: applicationId }, data: { deferredUntil: new Date(ctx.now().getTime() + days * 86_400_000) } });
}

export async function reprioritize(ctx: AppContext, applicationId: string, priority: number): Promise<void> {
  await ctx.db.application.update({ where: { id: applicationId }, data: { priority } });
}
