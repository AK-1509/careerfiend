import type { AiProvider } from "@careerfiend/ai";
import type { Requirement } from "@careerfiend/shared";
import type { GeneratedBulletSet } from "./types";
import { buildProfiles } from "./experience";
import { generateJobSpecificBullets } from "./pipeline";
import { jaccard, numbersIn } from "./validate";
import { TITLE_PATTERN, toolsIn } from "./vocabulary";

/**
 * Evaluation for job-specific bullets. Each case is a stored job/résumé pair
 * with claims that must never appear and requirements that should get a
 * bullet. The oracle here is independent of the validators (it checks the
 * output against the whole résumé text), so a validator regression shows up
 * as an unsupported claim. The headline metric is unsupported claim rate = 0.
 */

export interface EvalCase {
  name: string;
  job: { company: string; title: string; requirements: { text: string; category?: Requirement["category"]; kind?: Requirement["kind"] }[] };
  resume: { id: string; type?: "work" | "project"; title?: string; organization?: string; bullets: string[]; skills?: string[] }[];
  /** Scripted model answers (regression runs): per requirement pattern, one answer per attempt ("" = no honest bullet). */
  script?: { match: string; attempts: string[] }[];
  expect: {
    /** Regexes for claims the résumé does not support. */
    mustNotContain: string[];
    /** Requirement-text patterns that should end up with a bullet. */
    bulletFor?: string[];
  };
}

export interface CaseResult {
  name: string;
  bullets: { requirement: string; text: string; attempts: number; matchedTerms: string[] }[];
  violations: { text: string; reason: string }[];
  expectedMissing: string[];
  metrics: {
    bullets: number;
    groundingAccuracy: number;
    unsupportedClaimRate: number;
    alignment: number;
    supportedKeywordCoverage: number;
    duplicateRate: number;
    avgRetries: number;
    latencyMs: number;
    llmCalls: number;
  };
}

function resumeText(c: EvalCase): string {
  return c.resume.flatMap((e) => [...e.bullets, ...(e.skills ?? [])]).join(" \n ");
}

/** Independent check of one bullet against everything the résumé says. */
export function oracle(text: string, c: EvalCase): string[] {
  const all = resumeText(c);
  const lower = all.toLowerCase();
  const out: string[] = [];
  for (const p of c.expect.mustNotContain) if (new RegExp(p, "i").test(text)) out.push(`forbidden claim /${p}/`);
  for (const n of numbersIn(text)) if (!lower.includes(n.toLowerCase())) out.push(`number ${n} not in the résumé`);
  for (const t of toolsIn(text)) if (!lower.includes(t.toLowerCase())) out.push(`tool ${t} not in the résumé`);
  for (const m of text.match(TITLE_PATTERN) ?? []) if (!lower.includes(m.toLowerCase())) out.push(`title ${m} not in the résumé`);
  if (
    /\b(managed|supervised|led)\s+(a\s+|the\s+)?(team|staff|group)\b/i.test(text) &&
    !/\b(managed|supervised|led)\s+(a\s+|the\s+)?(team|staff|group)\b/i.test(all)
  )
    out.push("people management not in the résumé");
  return out;
}

export function scoreCase(c: EvalCase, set: GeneratedBulletSet, reqText: (id: string) => string): CaseResult {
  const bullets = set.bullets.map((b) => ({ requirement: reqText(b.requirementId), text: b.text, attempts: b.attempts, matchedTerms: b.matchedTerms }));
  const violations = set.bullets.flatMap((b) => oracle(b.text, c).map((reason) => ({ text: b.text, reason })));
  const badBullets = new Set(violations.map((v) => v.text)).size;
  const expectedMissing = (c.expect.bulletFor ?? []).filter((p) => !bullets.some((b) => new RegExp(p, "i").test(b.requirement)));
  let dupPairs = 0;
  for (let i = 0; i < bullets.length; i++) for (let j = i + 1; j < bullets.length; j++) if (jaccard(bullets[i]!.text, bullets[j]!.text) >= 0.7) dupPairs++;
  const n = bullets.length;
  const aligned = c.expect.bulletFor?.length ? (c.expect.bulletFor.length - expectedMissing.length) / c.expect.bulletFor.length : 1;
  const termsAvailable = set.bullets.length ? set.bullets.reduce((a, b) => a + Math.max(1, b.matchedTerms.length), 0) : 0;
  const termsUsed = set.bullets.reduce((a, b) => a + b.matchedTerms.length, 0);
  return {
    name: c.name,
    bullets,
    violations,
    expectedMissing,
    metrics: {
      bullets: n,
      groundingAccuracy: n ? (n - badBullets) / n : 1,
      unsupportedClaimRate: n ? badBullets / n : 0,
      alignment: aligned,
      supportedKeywordCoverage: termsAvailable ? termsUsed / termsAvailable : 0,
      duplicateRate: n ? dupPairs / n : 0,
      avgRetries: n ? bullets.reduce((a, b) => a + (b.attempts - 1), 0) / n : 0,
      latencyMs: set.metrics.durationMs,
      llmCalls: set.metrics.llmCalls,
    },
  };
}

export async function runCase(c: EvalCase, ai: AiProvider): Promise<CaseResult> {
  const job = {
    company: c.job.company,
    title: c.job.title,
    location: { raw: "", locations: [], workplaceType: "unknown" as const, remoteScope: null },
    requirements: c.job.requirements.map((r, i) => ({
      id: `req${i}`,
      category: r.category ?? "required",
      kind: r.kind ?? "skill",
      text: r.text,
      depth: "unspecified" as const,
    })),
  };
  const resume = {
    experiences: c.resume.map((e) => ({
      id: e.id,
      type: e.type ?? "work",
      title: e.title ?? "Analyst",
      organization: e.organization ?? "Org",
      location: "",
      startDate: "2024-01",
      endDate: "2024-06",
      summary: "",
      responsibilities: e.bullets,
      endorsedSkills: e.skills ?? [],
      gallery: [],
    })),
  } as unknown as Parameters<typeof buildProfiles>[0];
  const profiles = buildProfiles(resume);
  const existing = Object.fromEntries(c.resume.flatMap((e) => e.bullets.map((t, i) => [`experiences[${e.id}].responsibilities[${i}]`, t])));
  const set = await generateJobSpecificBullets({ job }, profiles, { ai, existing });
  return scoreCase(c, set, (id) => job.requirements.find((r) => r.id === id)?.text ?? id);
}

export interface EvalReport {
  cases: CaseResult[];
  totals: CaseResult["metrics"] & { cases: number; violations: number; expectedMissing: number };
}

export function summarize(results: CaseResult[]): EvalReport {
  const sum = (k: keyof CaseResult["metrics"]) => results.reduce((a, r) => a + r.metrics[k], 0);
  const bullets = sum("bullets");
  const weighted = (k: keyof CaseResult["metrics"]) => (bullets ? results.reduce((a, r) => a + r.metrics[k] * r.metrics.bullets, 0) / bullets : 0);
  const violations = results.reduce((a, r) => a + new Set(r.violations.map((v) => v.text)).size, 0);
  return {
    cases: results,
    totals: {
      cases: results.length,
      bullets,
      groundingAccuracy: bullets ? (bullets - violations) / bullets : 1,
      unsupportedClaimRate: bullets ? violations / bullets : 0,
      alignment: results.length ? sum("alignment") / results.length : 0,
      supportedKeywordCoverage: weighted("supportedKeywordCoverage"),
      duplicateRate: weighted("duplicateRate"),
      avgRetries: weighted("avgRetries"),
      latencyMs: results.length ? Math.round(sum("latencyMs") / results.length) : 0,
      llmCalls: results.length ? sum("llmCalls") / results.length : 0,
      violations,
      expectedMissing: results.reduce((a, r) => a + r.expectedMissing.length, 0),
    },
  };
}

export function reportMarkdown(r: EvalReport): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const t = r.totals;
  const lines = [
    "# Job-specific bullets: evaluation",
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Unsupported claim rate (target 0) | ${pct(t.unsupportedClaimRate)} (${t.violations}) |`,
    `| Grounding accuracy | ${pct(t.groundingAccuracy)} |`,
    `| JD requirement alignment | ${pct(t.alignment)} |`,
    `| Supported keyword coverage | ${pct(t.supportedKeywordCoverage)} |`,
    `| Duplicate bullet rate | ${pct(t.duplicateRate)} |`,
    `| Average generation retries | ${t.avgRetries.toFixed(2)} |`,
    `| Generation latency (avg per résumé) | ${t.latencyMs} ms |`,
    `| LLM calls per curated résumé | ${t.llmCalls.toFixed(1)} |`,
    `| Bullets / cases | ${t.bullets} / ${t.cases} |`,
    "",
  ];
  for (const c of r.cases) {
    lines.push(`## ${c.name}`, "");
    for (const b of c.bullets) lines.push(`- ${b.text}  _(for: ${b.requirement}; attempts ${b.attempts})_`);
    if (!c.bullets.length) lines.push("- (no bullets: original lines kept)");
    for (const v of c.violations) lines.push(`- **Violation:** ${v.reason} in "${v.text}"`);
    for (const m of c.expectedMissing) lines.push(`- Expected a bullet for /${m}/`);
    lines.push("");
  }
  return lines.join("\n");
}
