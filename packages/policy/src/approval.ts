import type { ApplicationState, Warning } from "@careerfiend/shared";

/**
 * The approval invariant (BUILD-GUIDE "Approval invariant"). Pure function so
 * it can be tested exhaustively; the core service calls it inside the same DB
 * transaction that consumes the approval and creates the submission attempt.
 */

export interface InvariantInput {
  state: ApplicationState;
  /** Hash stored on the current revision row. */
  currentRevisionHash: string | null;
  /** Hash recomputed now from the revision payload and the files on disk. */
  recomputedHash: string | null;
  approval: { revisionHash: string; consumedAt: Date | null; invalidatedAt: Date | null; confirmation: string } | null;
  unresolvedRequiredFields: number;
  warnings: Warning[];
  acknowledgedWarningCodes: string[];
  /** The exact value the user must type/click to confirm submission. */
  expectedConfirmation: string;
  submitConfirmation: string;
}

export type InvariantResult = { ok: true } | { ok: false; reasons: string[] };

export const APPROVAL_CONFIRMATION = "APPROVE";
export const SUBMIT_CONFIRMATION = "SUBMIT";

export function checkSubmitInvariant(i: InvariantInput): InvariantResult {
  const reasons: string[] = [];
  if (i.state !== "APPROVED") reasons.push(`Application is ${i.state}, not APPROVED.`);
  if (!i.approval) reasons.push("No approval exists for the current revision.");
  else {
    if (i.approval.confirmation !== APPROVAL_CONFIRMATION) reasons.push("Approval lacks the explicit confirmation value.");
    if (i.approval.consumedAt) reasons.push("Approval was already used for a submission.");
    if (i.approval.invalidatedAt) reasons.push("Approval was invalidated by a later edit.");
    if (!i.currentRevisionHash || i.approval.revisionHash !== i.currentRevisionHash) reasons.push("Approval does not match the current revision hash.");
  }
  if (!i.recomputedHash || i.recomputedHash !== i.currentRevisionHash) {
    reasons.push("The revision's documents, answers or target changed since it was staged (hash mismatch).");
  }
  if (i.unresolvedRequiredFields > 0) reasons.push(`${i.unresolvedRequiredFields} required field(s) are unresolved.`);
  const blocking = i.warnings.filter((w) => w.blocking);
  if (blocking.length) reasons.push(`Blocking warnings: ${blocking.map((w) => w.code).join(", ")}.`);
  const unacked = i.warnings.filter((w) => !w.blocking && !i.acknowledgedWarningCodes.includes(w.code));
  if (unacked.length) reasons.push(`Warnings not acknowledged at approval: ${unacked.map((w) => w.code).join(", ")}.`);
  if (i.submitConfirmation !== i.expectedConfirmation) reasons.push("The second confirmation value is missing or wrong.");
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/** Can the current revision be approved? (READY_FOR_REVIEW, no blockers, all warnings acknowledged.) */
export function checkApprovable(i: {
  state: ApplicationState;
  unresolvedRequiredFields: number;
  warnings: Warning[];
  acknowledgedWarningCodes: string[];
  confirmation: string;
}): InvariantResult {
  const reasons: string[] = [];
  if (i.state !== "READY_FOR_REVIEW") reasons.push(`Only READY_FOR_REVIEW revisions can be approved (state is ${i.state}).`);
  if (i.confirmation !== APPROVAL_CONFIRMATION) reasons.push(`Type ${APPROVAL_CONFIRMATION} to approve.`);
  if (i.unresolvedRequiredFields > 0) reasons.push(`${i.unresolvedRequiredFields} required field(s) are unresolved.`);
  const blocking = i.warnings.filter((w) => w.blocking);
  if (blocking.length) reasons.push(`Resolve blocking warnings first: ${blocking.map((w) => w.code).join(", ")}.`);
  const unacked = i.warnings.filter((w) => !w.blocking && !i.acknowledgedWarningCodes.includes(w.code));
  if (unacked.length) reasons.push(`Acknowledge warnings: ${unacked.map((w) => w.code).join(", ")}.`);
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
