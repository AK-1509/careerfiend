import { z } from "zod";

export const FAILURE_CATEGORIES = [
  "PAGE_CHANGED",
  "LOGIN_REQUIRED",
  "CAPTCHA_OR_BOT_CHECK",
  "UNSUPPORTED_FIELD",
  "MISSING_PROFILE_DATA",
  "SENSITIVE_ANSWER_REQUIRED",
  "DOCUMENT_GENERATION_FAILED",
  "VALIDATION_FAILED",
  "SUBMISSION_UNCERTAIN",
  "EMAIL_MATCH_AMBIGUOUS",
  "SITE_NOT_PERMITTED",
  "NETWORK_TRANSIENT",
  "FATAL_CONFIGURATION",
  "UNEXPECTED_NAVIGATION",
  "SOURCE_CHANGED",
  "DOCUMENTS_READY",
] as const;
export const FailureCategorySchema = z.enum(FAILURE_CATEGORIES);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

/** Recovery text shown in the dashboard for each category. */
export const RECOVERY_INSTRUCTIONS: Record<FailureCategory, string> = {
  PAGE_CHANGED: "The page no longer matches what was captured. Open the listing, confirm it is still live, then re-queue preparation.",
  LOGIN_REQUIRED: "The site needs you to sign in. Click 'Take over', sign in inside the visible browser window, then click 'Resume'.",
  CAPTCHA_OR_BOT_CHECK: "A CAPTCHA or bot check appeared. CareerFiend never solves these. Click 'Take over', complete it yourself, then click 'Resume'.",
  UNSUPPORTED_FIELD: "A control type the form engine cannot operate. Fill it yourself during takeover, or answer the question and re-run.",
  MISSING_PROFILE_DATA: "A required answer is not in your verified profile. Answer the open question below; tick 'reuse' to save it as a rule.",
  SENSITIVE_ANSWER_REQUIRED: "A sensitive question (authorization, EEO, salary, attestation, …) has no stored rule. Answer it below.",
  DOCUMENT_GENERATION_FAILED: "The résumé or cover letter could not be generated or failed validation. Check the warnings list, then regenerate.",
  VALIDATION_FAILED: "The site rejected one or more values. The captured validation messages are listed in the field manifest.",
  SUBMISSION_UNCERTAIN:
    "The submit result could not be confirmed. Do NOT resubmit. Check your email and the employer portal, then record whether it was submitted.",
  EMAIL_MATCH_AMBIGUOUS: "An email could belong to more than one application. Assign it from the Unmatched email queue.",
  SITE_NOT_PERMITTED: "Automation of this site is not permitted (see docs/site-support.md). Apply manually from the original link.",
  NETWORK_TRANSIENT: "A network error occurred. The worker retries automatically for preparation steps only.",
  FATAL_CONFIGURATION: "Something needed is missing (usually your résumé: upload it or fill out the Profile page). Fix it, then retry.",
  UNEXPECTED_NAVIGATION: "The form navigated somewhere unexpected (login, payment, other domain). Take over, check the page, then resume.",
  SOURCE_CHANGED: "Your résumé changed since this draft was built. Regenerate the documents so they use the current version.",
  DOCUMENTS_READY:
    "Your tailored résumé and cover letter are ready. Download them below, open the application link, apply on the employer's site, then press 'Mark as submitted'.",
};

export class CareerFiendError extends Error {
  readonly category: FailureCategory;
  readonly retryable: boolean;
  constructor(category: FailureCategory, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "CareerFiendError";
    this.category = category;
    this.retryable = opts.retryable ?? category === "NETWORK_TRANSIENT";
  }
}
