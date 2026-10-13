/**
 * Application answers (typed on the Profile page, or imported from markdown) → profile values.
 * Filled lines become CONFIRMED_BY_USER; blank lines stay UNVERIFIED and turn
 * into NEEDS_INPUT when a form asks (never guessed).
 */

export interface AnswerSpec {
  key: string;
  /** Prefix of the line label in answers-later.md (case-insensitive). */
  prefix: string;
  label: string;
  sensitive: boolean;
}

export const ANSWER_SPECS: AnswerSpec[] = [
  { key: "contact.phone", prefix: "Phone", label: "Phone", sensitive: false },
  { key: "contact.addressDetail", prefix: "Address detail", label: "Address detail to share", sensitive: false },
  { key: "contact.portfolio", prefix: "Portfolio link", label: "Portfolio link", sensitive: false },
  { key: "education.expected", prefix: "Graduation date to show", label: "Graduation date to show (degree in progress)", sensitive: false },
  { key: "work.authorization", prefix: "Work authorization", label: "Work authorization in the US", sensitive: true },
  { key: "work.sponsorship", prefix: "Sponsorship", label: "Sponsorship needed now or later", sensitive: true },
  { key: "work.minimumPay", prefix: "Minimum pay", label: "Minimum pay", sensitive: true },
  { key: "work.startDate", prefix: "Earliest start date", label: "Earliest start date / notice period", sensitive: false },
  { key: "work.relocation", prefix: "Relocation", label: "Willing to relocate", sensitive: true },
  { key: "work.backgroundChecks", prefix: "Background checks", label: "Background checks and assessments", sensitive: true },
  { key: "eeo.policy", prefix: "Policy", label: "Demographic / EEO policy", sensitive: true },
  { key: "language.english", prefix: "English", label: "English proficiency", sensitive: false },
  { key: "language.spanish", prefix: "Spanish", label: "Spanish proficiency", sensitive: false },
  { key: "language.french", prefix: "French", label: "French proficiency", sensitive: false },
  { key: "language.german", prefix: "German", label: "German proficiency", sensitive: false },
  { key: "language.chinese", prefix: "Chinese", label: "Chinese proficiency", sensitive: false },
  { key: "language.hindi", prefix: "Hindi", label: "Hindi proficiency", sensitive: false },
  { key: "volume.dailyLimit", prefix: "Daily preparation limit", label: "Daily preparation limit", sensitive: false },
];

export interface ParsedAnswer {
  spec: AnswerSpec;
  value: string | null;
}

/**
 * Parse "- Label (hint): value" lines. The value is everything after the last
 * "): " when the label has a parenthetical hint, else after the first ": ".
 */
export function parseAnswers(markdown: string): ParsedAnswer[] {
  const lines = markdown.split(/\r?\n/).filter((l) => /^\s*-\s+/.test(l));
  return ANSWER_SPECS.map((spec) => {
    const line = lines.find((l) =>
      l
        .replace(/^\s*-\s+/, "")
        .toLowerCase()
        .startsWith(spec.prefix.toLowerCase()),
    );
    if (!line) return { spec, value: null };
    const body = line.replace(/^\s*-\s+/, "");
    let value: string;
    const hintEnd = body.lastIndexOf("):");
    const firstColon = body.indexOf(":");
    const parenStart = body.indexOf("(");
    if (hintEnd >= 0 && parenStart >= 0 && parenStart < firstColon) value = body.slice(hintEnd + 2);
    else value = firstColon >= 0 ? body.slice(firstColon + 1) : "";
    // A bare URL inside the label (e.g. the portfolio hint) must not be read as a value.
    value = value.trim();
    return { spec, value: value === "" ? null : value };
  });
}

/** Policies with fixed wording from answers-later.md. */
export type EeoPolicy = "PREFER_NOT_TO_ANSWER" | "ASK_EACH_TIME" | "STORED_ANSWERS" | "UNSET";

export function parseEeoPolicy(value: string | null | undefined): EeoPolicy {
  if (!value) return "UNSET";
  const v = value.toLowerCase();
  if (v.includes("prefer not")) return "PREFER_NOT_TO_ANSWER";
  if (v.includes("ask")) return "ASK_EACH_TIME";
  if (v.includes("stored")) return "STORED_ANSWERS";
  return "UNSET";
}

export function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
