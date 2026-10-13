/**
 * Classify a clickable control. Never by position: accessible name, nearby
 * text, form structure and the step context decide. Ambiguous controls that
 * could submit are treated as final submission (never clicked while preparing).
 */

export type ButtonRole = "final_submit" | "next" | "back" | "save_draft" | "upload" | "other";

export interface ButtonDescriptor {
  name: string;
  type: string;
  tag: string;
  /** Text of the surrounding form/section, used for review-page detection. */
  nearbyText: string;
  /** True when the control submits its form (submit type, or default button). */
  submitsForm: boolean;
  /** How many other forward-looking buttons are on the page. */
  forwardButtonsOnPage: number;
  /** True if the page looks like a final review step. */
  reviewPage: boolean;
}

const FINAL =
  /\b(submit( my| your)?( application)?|send application|apply( now)?|finish( application)?|complete (application|submission)|confirm (and|&) submit|submit & finish|i'?m done)\b/i;
const NEXT =
  /^(next|continue|save (and|&) continue|proceed|next step|next page|review( application)?|go to review|continue to (next|review)|start application|begin)\b/i;
const BACK = /^(back|previous|prev|go back|edit)\b/i;
const DRAFT = /\b(save (as )?draft|save for later)\b/i;
const UPLOAD = /\b(upload|attach|choose file|browse|add file|remove file|replace file)\b/i;

export function classifyButton(b: ButtonDescriptor): ButtonRole {
  const name = b.name.trim().replace(/\s+/g, " ");
  if (!name) return b.submitsForm ? "final_submit" : "other";
  if (BACK.test(name)) return "back";
  if (DRAFT.test(name)) return "save_draft";
  if (UPLOAD.test(name) && !FINAL.test(name)) return "upload";
  if (FINAL.test(name)) return "final_submit";
  if (NEXT.test(name)) {
    // "Review" / "Continue" on a page that already summarizes everything may itself submit.
    if (b.reviewPage && b.submitsForm && b.forwardButtonsOnPage === 0) return "final_submit";
    return "next";
  }
  // Unknown label that submits the form: assume it is the final action.
  if (b.submitsForm) return "final_submit";
  return "other";
}
