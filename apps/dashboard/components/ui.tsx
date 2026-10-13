import { humanState } from "@/lib/format";

const TONE: Record<string, string> = {
  READY_FOR_REVIEW: "info",
  APPROVED: "info",
  SUBMITTING: "warn",
  SUBMITTED: "ok",
  CONFIRMATION_RECEIVED: "ok",
  RESPONDED: "ok",
  INTERVIEW: "ok",
  OFFER: "ok",
  NEEDS_INPUT: "warn",
  SUBMISSION_UNCERTAIN: "bad",
  MANUAL: "info",
  FAILED: "info",
  REJECTED: "muted",
  CLOSED: "muted",
  VERIFIED_FROM_SOURCE: "ok",
  CONFIRMED_BY_USER: "ok",
  UNVERIFIED: "warn",
  REJECTED_BY_USER: "muted",
  COVERED: "ok",
  TRANSFERABLE: "info",
  GAP: "bad",
  NEEDS_CONFIRM: "warn",
  NOT_APPLICABLE: "muted",
  BLOCKER: "bad",
  WARNING: "warn",
  FILLED: "ok",
  SENSITIVE_PENDING: "bad",
  SKIPPED_OPTIONAL: "muted",
  FILL_FAILED: "bad",
  MATCHED: "ok",
  UNMATCHED: "warn",
  IGNORED: "muted",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge ${TONE[value] ?? "muted"}`}>{label ?? humanState(value)}</span>;
}

export function Flash({ msg, error }: { msg?: string; error?: string }) {
  if (!msg && !error) return null;
  return (
    <div role="status" aria-live="polite" className={`flash ${error ? "bad" : "ok"}`}>
      {error ?? msg}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="muted">{children}</p>;
}
