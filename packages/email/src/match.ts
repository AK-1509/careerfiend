import { normalizeLabel } from "@careerfiend/shared";
import type { EmailMeta } from "./types";

/**
 * Multi-signal matching of one email to submitted applications. Never a
 * single keyword: a match needs at least two independent signals, a score of
 * 0.7 and a clear margin over the next candidate. Everything else goes to
 * the Unmatched review queue (or is ignored when nothing points at a job).
 */

export interface TrackedApplication {
  id: string;
  company: string;
  role: string;
  domains: string[];
  atsHosts: string[];
  atsIdentifiers: Record<string, string>;
  recipient: string | null;
  submittedAt: Date;
  /** Gmail thread ids already linked to this application. */
  threadIds: string[];
}

export interface Candidate {
  applicationId: string;
  score: number;
  signals: string[];
}

export interface MatchDecision {
  status: "MATCHED" | "UNMATCHED" | "IGNORED";
  best: Candidate | null;
  candidates: Candidate[];
}

export const MATCH_THRESHOLD = 0.7;
export const MATCH_MARGIN = 0.25;

function emailDomain(from: string): string {
  const m = /@([A-Za-z0-9.-]+)/.exec(from);
  return (m?.[1] ?? "").toLowerCase();
}

function domainMatches(sender: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return sender === d || sender.endsWith(`.${d}`);
}

const ATS_SENDERS = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "hire.lever.co",
  "ashbyhq.com",
  "myworkday.com",
  "myworkdayjobs.com",
  "icims.com",
  "smartrecruiters.com",
  "jobvite.com",
];

export function scoreCandidate(msg: EmailMeta, app: TrackedApplication): Candidate {
  const signals: string[] = [];
  let score = 0;
  const sender = emailDomain(msg.from);
  const text = normalizeLabel(`${msg.subject} ${msg.snippet} ${msg.from}`);
  const companyKey = normalizeLabel(app.company);
  const roleKey = normalizeLabel(app.role);

  if (app.threadIds.includes(msg.threadId)) {
    score += 0.6;
    signals.push("thread already linked");
  }
  if (app.domains.some((d) => domainMatches(sender, d))) {
    score += 0.45;
    signals.push(`sender domain ${sender}`);
  } else if ([...app.atsHosts, ...ATS_SENDERS].some((d) => domainMatches(sender, d))) {
    score += 0.15;
    signals.push(`ATS sender ${sender}`);
  }
  if (companyKey.length >= 3 && text.includes(companyKey)) {
    score += 0.3;
    signals.push("company name");
  }
  if (roleKey.length >= 4 && text.includes(roleKey)) {
    score += 0.3;
    signals.push("role title");
  }
  for (const [ats, ident] of Object.entries(app.atsIdentifiers)) {
    const id = ident.split("/").pop() ?? "";
    if (id.length >= 4 && `${msg.subject} ${msg.snippet}`.includes(id)) {
      score += 0.4;
      signals.push(`${ats} id ${id}`);
    }
  }
  if (app.recipient && msg.to.toLowerCase().includes(app.recipient.toLowerCase())) {
    score += 0.05;
    signals.push("sent to the address used");
  }
  // Time window: mail from before the submission cannot be about it.
  if (msg.date.getTime() < app.submittedAt.getTime() - 60 * 60_000) {
    return { applicationId: app.id, score: 0, signals: ["before submission"] };
  }
  return { applicationId: app.id, score: Math.min(score, 1.5), signals };
}

export function matchEmail(msg: EmailMeta, apps: TrackedApplication[]): MatchDecision {
  const candidates = apps
    .map((a) => scoreCandidate(msg, a))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? null;
  if (!best) return { status: "IGNORED", best: null, candidates };
  const second = candidates[1]?.score ?? 0;
  const distinctSignals = new Set(best.signals.filter((s) => s !== "sent to the address used").map((s) => s.split(" ")[0])).size;
  if (best.score >= MATCH_THRESHOLD && best.score - second >= MATCH_MARGIN && distinctSignals >= 2) {
    return { status: "MATCHED", best, candidates };
  }
  return { status: best.score >= 0.3 ? "UNMATCHED" : "IGNORED", best, candidates };
}

/** Bounded Gmail search for the first sync: only mail that could concern an application. */
export function searchQuery(apps: TrackedApplication[]): string {
  const domains = [...new Set([...apps.flatMap((a) => a.domains), ...ATS_SENDERS])].slice(0, 40);
  const earliest = apps.reduce((min, a) => (a.submittedAt < min ? a.submittedAt : min), new Date());
  const after = new Date(earliest.getTime() - 86_400_000);
  const date = `${after.getUTCFullYear()}/${after.getUTCMonth() + 1}/${after.getUTCDate()}`;
  return `after:${date} (from:(${domains.join(" OR ")}) OR subject:(application OR interview OR offer))`;
}
