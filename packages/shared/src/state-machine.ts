import { z } from "zod";

export const APPLICATION_STATES = [
  "QUEUED",
  "READING_JOB",
  "GENERATING_DOCUMENTS",
  "FILLING",
  "NEEDS_INPUT",
  "READY_FOR_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUBMITTING",
  "SUBMITTED",
  "SUBMISSION_UNCERTAIN",
  "MANUAL",
  "FAILED",
  "CONFIRMATION_RECEIVED",
  "RESPONDED",
  "INTERVIEW",
  "OFFER",
  "CLOSED",
] as const;
export const ApplicationStateSchema = z.enum(APPLICATION_STATES);
export type ApplicationState = z.infer<typeof ApplicationStateSchema>;

/**
 * Every allowed transition. Anything not listed is rejected by
 * `assertTransition`. Follows BUILD-GUIDE.md with these explicit additions:
 * - preparation steps may fail or pause (NEEDS_INPUT) before FILLING;
 * - NEEDS_INPUT may return to GENERATING_DOCUMENTS (after a skill confirmation);
 * - APPROVED -> READY_FOR_REVIEW (an edit invalidates the approval);
 * - SUBMISSION_UNCERTAIN is resolved manually to SUBMITTED or MANUAL;
 * - replies may arrive without a confirmation email first;
 * - MANUAL ("apply yourself") replaces FAILED: when CareerFiend cannot finish an
 *   application (a CAPTCHA or spam check, a site it may not automate, an
 *   error), the documents stay ready and you apply on the employer's site, then
 *   mark it submitted. It may be re-queued only if nothing was submitted.
 * - FAILED is kept for rows written before MANUAL existed (migrated to MANUAL).
 */
export const TRANSITIONS: Record<ApplicationState, readonly ApplicationState[]> = {
  QUEUED: ["READING_JOB", "MANUAL", "CLOSED"],
  READING_JOB: ["GENERATING_DOCUMENTS", "NEEDS_INPUT", "MANUAL", "CLOSED"],
  GENERATING_DOCUMENTS: ["FILLING", "NEEDS_INPUT", "READY_FOR_REVIEW", "MANUAL"],
  FILLING: ["NEEDS_INPUT", "READY_FOR_REVIEW", "MANUAL"],
  NEEDS_INPUT: ["FILLING", "GENERATING_DOCUMENTS", "REJECTED", "CLOSED"],
  READY_FOR_REVIEW: ["APPROVED", "REJECTED", "FILLING", "GENERATING_DOCUMENTS"],
  APPROVED: ["SUBMITTING", "READY_FOR_REVIEW", "REJECTED"],
  REJECTED: [],
  SUBMITTING: ["SUBMITTED", "SUBMISSION_UNCERTAIN", "MANUAL"],
  SUBMITTED: ["CONFIRMATION_RECEIVED", "RESPONDED", "INTERVIEW", "REJECTED", "OFFER", "CLOSED"],
  SUBMISSION_UNCERTAIN: ["SUBMITTED", "MANUAL"],
  MANUAL: ["SUBMITTED", "QUEUED", "REJECTED", "CLOSED"],
  FAILED: ["MANUAL", "SUBMITTED", "QUEUED", "REJECTED", "CLOSED"],
  CONFIRMATION_RECEIVED: ["RESPONDED", "INTERVIEW", "REJECTED", "OFFER", "CLOSED"],
  RESPONDED: ["INTERVIEW", "REJECTED", "OFFER", "CLOSED"],
  INTERVIEW: ["REJECTED", "OFFER", "CLOSED"],
  OFFER: ["CLOSED"],
  CLOSED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ApplicationState,
    readonly to: ApplicationState,
  ) {
    super(`Invalid application transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ApplicationState, to: ApplicationState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** States in which the worker is actively preparing. */
export const PREPARING_STATES: readonly ApplicationState[] = ["QUEUED", "READING_JOB", "GENERATING_DOCUMENTS", "FILLING"];

/** States after a confirmed submission. */
export const POST_SUBMIT_STATES: readonly ApplicationState[] = ["SUBMITTED", "CONFIRMATION_RECEIVED", "RESPONDED", "INTERVIEW", "OFFER"];
