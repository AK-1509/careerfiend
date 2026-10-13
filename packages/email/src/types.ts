/**
 * Email provider abstraction (Gmail first; Outlook could implement the same
 * interface). Deliberately has NO send, reply, forward, delete, archive or
 * mark-read operation: the MVP only reads and adds labels (D8).
 */

export interface EmailMeta {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: Date;
  snippet: string;
}

export interface SyncPage {
  messages: EmailMeta[];
  /** Opaque cursor for the next incremental poll (Gmail historyId). */
  cursor: string | null;
  /** True if the cursor was too old and a bounded query sync was used instead. */
  fullSync: boolean;
}

export interface EmailProvider {
  readonly name: string;
  /** "label" applies Gmail labels; "readonly" only reads (dashboard tracking). */
  readonly mode: "label" | "readonly";
  account(): Promise<string>;
  /**
   * Messages added since `cursor`. On the first call (null cursor) a bounded
   * search is used: only mail that could relate to applications.
   */
  sync(cursor: string | null, query: string): Promise<SyncPage>;
  ensureLabel(name: string): Promise<string>;
  addLabels(messageId: string, labelIds: string[]): Promise<void>;
}

export const ROOT_LABEL = "Job Applications";
export const STATUS_LABELS = {
  confirmation: `${ROOT_LABEL}/Applied`,
  action_required: `${ROOT_LABEL}/Action Needed`,
  recruiter_response: `${ROOT_LABEL}/Action Needed`,
  interview: `${ROOT_LABEL}/Interview`,
  rejection: `${ROOT_LABEL}/Rejection`,
  offer: `${ROOT_LABEL}/Offer`,
  other: null,
} as const;

/** Stable per-application label: "Job Applications/Apps/Acme - Product Manager - A1B2C3". */
export function applicationLabel(company: string, role: string, applicationId: string): string {
  const clean = (s: string) =>
    s
      .replace(/[\\/]+/g, "-")
      .replace(/[^\p{L}\p{N} &().,'+-]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50);
  const short = applicationId.replace(/^app_/, "").slice(0, 6).toUpperCase();
  return `${ROOT_LABEL}/Apps/${clean(company)} - ${clean(role)} - ${short}`;
}
