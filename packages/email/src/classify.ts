import type { EmailClass } from "@careerfiend/shared";
import type { EmailMeta } from "./types";

/**
 * Deterministic first-pass classification. Strong phrases decide; otherwise
 * the caller may ask the AI provider (validated) or fall back to "other".
 */
const RULES: { cls: EmailClass; re: RegExp; confidence: number }[] = [
  { cls: "offer", re: /\b(pleased to (extend|offer)|offer letter|extend (you )?an offer|job offer|formal offer)\b/i, confidence: 0.9 },
  {
    cls: "rejection",
    re: /\b(unfortunately|not (be )?moving forward|decided (not to|to (move|go) forward with other)|pursue other candidates|position has been filled|will not be proceeding|not selected|regret to inform)\b/i,
    confidence: 0.9,
  },
  {
    cls: "interview",
    re: /\b(interview|phone screen|schedule (a|some) time|your availability|calendly\.com|meet with (the|our) (team|hiring))\b/i,
    confidence: 0.85,
  },
  {
    cls: "action_required",
    re: /\b(action required|complete (the|your|this) (assessment|questionnaire|survey|profile)|verify your email|additional information (is )?(needed|required)|next step[s]?: (please )?complete)\b/i,
    confidence: 0.85,
  },
  {
    cls: "confirmation",
    re: /\b(thank(s| you) for (applying|your application|your interest)|received your application|application (has been |was )?(received|submitted)|we('ve| have) got your application)\b/i,
    confidence: 0.9,
  },
];

export function classifyDeterministic(msg: Pick<EmailMeta, "subject" | "snippet" | "from">): { classification: EmailClass; confidence: number } {
  const text = `${msg.subject}\n${msg.snippet}`;
  for (const r of RULES) if (r.re.test(text)) return { classification: r.cls, confidence: r.confidence };
  if (/^re:/i.test(msg.subject.trim()) && !/no-?reply|donotreply|notifications?@/i.test(msg.from))
    return { classification: "recruiter_response", confidence: 0.7 };
  return { classification: "other", confidence: 0.5 };
}
