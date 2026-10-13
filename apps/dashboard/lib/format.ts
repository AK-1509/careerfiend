import { loadConfig } from "@careerfiend/shared";

// Hosted servers run in UTC; DISPLAY_TIMEZONE shows your local time.
const timeZone = () => loadConfig().DISPLAY_TIMEZONE;

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timeZone() });
}

export function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: timeZone() });
}

export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`;
}

/** Labels that read better than the state name ("FAILED" is the old name for "apply yourself"). */
const STATE_LABELS: Record<string, string> = { MANUAL: "Apply yourself", FAILED: "Apply yourself" };

export function humanState(s: string): string {
  if (STATE_LABELS[s]) return STATE_LABELS[s];
  return s
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function qs(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : "";
}
