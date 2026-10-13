import type { AiProvider, CoverLetterDraft, FactForPrompt } from "@careerfiend/ai";
import { collapseWhitespace, wordCount } from "@careerfiend/shared";
import { mentionsExcluded } from "@careerfiend/profile";

/**
 * Cover letter (D3): voice/structure from the job-application skill; facts
 * only from resume.json facts and CONFIRMED_BY_USER skills. Every factual
 * sentence carries provenance keys; deterministic validation enforces it.
 */

export interface LetterSentence {
  part: number;
  text: string;
  claimKeys: string[];
  sources: { key: string; text: string }[];
}

export interface CoverLetter {
  paragraphs: string[];
  sentences: LetterSentence[];
  wordCount: number;
  generator: "ai" | "fallback" | "user";
  problems: string[];
}

export const MAX_WORDS = 350;

const BANNED: { re: RegExp; why: string }[] = [
  { re: /\bpassionate\b/i, why: 'uses "passionate"' },
  { re: /\bdriven\b/i, why: 'uses "driven"' },
  { re: /\bleverag(e|ing)\b/i, why: 'uses "leverage"' },
  { re: /\bexcited to\b/i, why: 'uses "excited to"' },
  { re: /\bin today'?s fast[- ]paced\b/i, why: "throat-clearing opener" },
  { re: /\bas the (new )?(year|season)\b/i, why: "seasonal opener" },
  { re: /\bwelcome the opportunity\b/i, why: '"I would welcome the opportunity to discuss"' },
  { re: /\bnot just\b.*\bbut\b/i, why: '"not just X but Y" construction' },
  { re: /—/, why: "em dash" },
  { re: /\bstealth\b/i, why: "names a stealth employer (describe it as an early-stage startup)" },
];

const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "fifteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "hundred",
  "thousand",
];

export function numericTokens(text: string): string[] {
  const digits = [...text.matchAll(/\d[\d,.]*\d%?|\d%?/g)].map((m) => m[0].replace(/[.,]$/, ""));
  const words = NUMBER_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
  return [...digits, ...words];
}

export interface AllowedFact {
  key: string;
  text: string;
}

/** Sentence-level validation shared by AI drafts and user edits. */
export function validateSentences(
  sentences: { part: number; text: string; claimKeys: string[] }[],
  allowed: Map<string, string>,
  opts: { requireFourParts: boolean },
): string[] {
  const problems: string[] = [];
  const parts = new Set(sentences.map((s) => s.part));
  if (opts.requireFourParts && (parts.size !== 4 || ![1, 2, 3, 4].every((p) => parts.has(p)))) {
    problems.push(`Letter must have exactly four parts (got ${[...parts].sort().join(", ") || "none"}).`);
  }
  const words = wordCount(sentences.map((s) => s.text).join(" "));
  if (words >= MAX_WORDS) problems.push(`Letter is ${words} words; the limit is under ${MAX_WORDS}.`);
  for (const s of sentences) {
    const where = `Part ${s.part}: "${s.text.slice(0, 60)}${s.text.length > 60 ? "…" : ""}"`;
    const excluded = mentionsExcluded(s.text);
    if (excluded) problems.push(`${where} mentions excluded item ${excluded}.`);
    for (const b of BANNED) if (b.re.test(s.text)) problems.push(`${where} ${b.why}.`);
    const unknown = s.claimKeys.filter((k) => !allowed.has(k));
    if (unknown.length) problems.push(`${where} cites keys that are not verified facts: ${unknown.join(", ")}.`);
    if ((s.part === 2 || s.part === 3) && s.claimKeys.length === 0) problems.push(`${where} states experience without a source key.`);
    const cited = s.claimKeys.map((k) => allowed.get(k) ?? "").join(" \n ");
    for (const n of numericTokens(s.text)) {
      const found = /^\d/.test(n) ? cited.includes(n) : new RegExp(`\\b${n}\\b`, "i").test(cited);
      if (!found) problems.push(`${where} uses the number "${n}", which is not in its cited facts.`);
    }
  }
  return problems;
}

function toLetter(
  draft: { part: number; text: string; claimKeys: string[] }[],
  allowed: Map<string, string>,
  generator: CoverLetter["generator"],
  problems: string[],
): CoverLetter {
  const sentences: LetterSentence[] = draft.map((s) => ({
    part: s.part,
    text: collapseWhitespace(s.text),
    claimKeys: s.claimKeys,
    sources: s.claimKeys.map((k) => ({ key: k, text: allowed.get(k) ?? "(unknown key)" })),
  }));
  const paragraphs = [1, 2, 3, 4]
    .map((p) =>
      sentences
        .filter((s) => s.part === p)
        .map((s) => s.text)
        .join(" "),
    )
    .filter(Boolean);
  return { paragraphs, sentences, wordCount: wordCount(paragraphs.join(" ")), generator, problems };
}

function flatten(draft: CoverLetterDraft): { part: number; text: string; claimKeys: string[] }[] {
  return draft.parts.flatMap((p) => p.sentences.map((s) => ({ part: p.part, text: s.text, claimKeys: s.claimKeys })));
}

/* -------------------------------------------------------------- fallback */

export interface FallbackBullet {
  key: string;
  text: string;
  experienceId: string;
  experienceType: string;
  title: string;
  titleKey: string;
  organization: string;
  organizationKey: string | null;
}

/**
 * How an organization may be named in a letter. A "stealth" employer on a
 * résumé is described, never named (the person chose not to disclose it).
 */
export function letterOrgName(org: string): string {
  if (/\bstealth\b/i.test(org)) return "an early-stage startup";
  return org;
}

function lowerFirst(s: string): string {
  return s.length > 1 && /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/**
 * Deterministic letter used when no AI provider is configured: built from the
 * two most relevant verbatim bullets. Truthful but plain; flagged for editing.
 */
export function fallbackLetter(job: { company: string; title: string }, bullets: FallbackBullet[], allowed: Map<string, string>): CoverLetter {
  const first = bullets[0];
  const second =
    bullets.find((b) => first && b.experienceId !== first.experienceId && b.experienceType !== first.experienceType) ??
    bullets.find((b) => first && b.experienceId !== first.experienceId);
  // No ordering words ("before that", "then"): the two roles are picked by relevance, not date.
  const sentence = (b: FallbackBullet, also: boolean) => {
    const org = b.organization ? ` at ${letterOrgName(b.organization)}` : "";
    const keys = [b.titleKey, b.key, ...(b.organizationKey && !/\bstealth\b/i.test(b.organization) ? [b.organizationKey] : [])];
    return { text: `As ${b.title}${org}, I ${also ? "also " : ""}${lowerFirst(b.text.replace(/\.$/, ""))}.`, claimKeys: keys };
  };
  const draft: { part: number; text: string; claimKeys: string[] }[] = [
    { part: 1, text: `I'm applying for the ${job.title} role at ${job.company}.`, claimKeys: [] },
  ];
  if (first) draft.push({ part: 2, ...sentence(first, false) });
  if (second) draft.push({ part: 3, ...sentence(second, true) });
  draft.push({ part: 4, text: "Thanks for reading.", claimKeys: [] });
  const problems = validateSentences(draft, allowed, { requireFourParts: false });
  return toLetter(draft, allowed, "fallback", problems);
}

/* ---------------------------------------------------------------- driver */

export interface CoverLetterInput {
  company: string;
  title: string;
  jobExcerpt: string;
  facts: AllowedFact[];
  fallbackBullets: FallbackBullet[];
}

export async function generateCoverLetter(provider: AiProvider, input: CoverLetterInput): Promise<CoverLetter> {
  const allowed = new Map(input.facts.map((f) => [f.key, f.text]));
  if (!provider.available) return fallbackLetter(input, input.fallbackBullets, allowed);
  const facts: FactForPrompt[] = input.facts;
  // An employer listed as "stealth" is described, never named or explained.
  const orgDisplayRules = [
    ...new Set(
      input.facts
        .filter((f) => /\bstealth\b/i.test(f.text) && /\.organization$/.test(f.key))
        .map((f) => `Refer to "${f.text}" only as "an early-stage startup". Never name it or describe its product.`),
    ),
  ];
  let feedback: string[] | undefined;
  let last: CoverLetter | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const draft = await provider.draftCoverLetter({
      company: input.company,
      title: input.title,
      jobExcerpt: input.jobExcerpt,
      facts,
      orgDisplayRules,
      feedback,
    });
    const flat = flatten(draft);
    const problems = validateSentences(flat, allowed, { requireFourParts: true });
    last = toLetter(flat, allowed, "ai", problems);
    if (!problems.length) return last;
    feedback = problems;
  }
  return last!;
}

/**
 * Re-validate a letter after the user edits it in the dashboard. User text is
 * the user's own statement, so claims are not required to cite keys, but
 * numbers and excluded names are still checked against the facts.
 */
export function validateUserLetter(paragraphs: string[], allFacts: AllowedFact[]): CoverLetter {
  const allowed = new Map(allFacts.map((f) => [f.key, f.text]));
  const corpus = allFacts.map((f) => f.text).join(" \n ");
  const problems: string[] = [];
  const sentences: LetterSentence[] = [];
  paragraphs.forEach((p, i) => {
    const text = collapseWhitespace(p);
    if (!text) return;
    sentences.push({ part: i + 1, text, claimKeys: [], sources: [] });
    const excluded = mentionsExcluded(text);
    if (excluded) problems.push(`Paragraph ${i + 1} mentions excluded item ${excluded}.`);
    for (const n of numericTokens(text)) {
      const found = /^\d/.test(n) ? corpus.includes(n) : new RegExp(`\\b${n}\\b`, "i").test(corpus);
      if (!found) problems.push(`Paragraph ${i + 1} uses the number "${n}", which does not appear in any verified fact.`);
    }
  });
  const letter = toLetter(sentences, allowed, "user", problems);
  if (letter.wordCount >= MAX_WORDS) letter.problems.push(`Letter is ${letter.wordCount} words; the limit is under ${MAX_WORDS}.`);
  return letter;
}
