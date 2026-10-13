import { isExcludedExperience, type Resume } from "@careerfiend/profile";
import type { Attribute, Decomposition, EvidenceSpan, ExperienceProfile } from "./types";
import { decompose, groundedIn } from "./normalize";
import { embed, sumVectors } from "./semantic";
import { conceptsIn, stakeholdersIn, toolsIn } from "./vocabulary";

/**
 * Experience representation: each work or project entry becomes a structured
 * capability profile (actions, objects, skills, tools, methods, stakeholders,
 * outputs, outcomes, metrics, scale), every attribute pointing back at the
 * résumé lines it came from. Built deterministically; a fast model pass can
 * enrich it (enrichProfiles), only with fragments found in the line itself.
 * Profiles are cached per résumé version by the caller, never rebuilt per job.
 */

export const PROFILE_VERSION = 1;

const METHOD_CONCEPTS = new Set([
  "user_research",
  "usability_testing",
  "experimentation",
  "data_analysis",
  "market_research",
  "competitive_analysis",
  "research_methods",
  "prototyping",
  "process_improvement",
  "financial_modeling",
  "data_modeling",
  "machine_learning",
  "lab_research",
  "compliance",
  "quality_control",
]);
const OUTPUT_FAMILIES = new Set(["build", "design", "launch", "communicate", "plan"]);

function industryOf(domains: string[]): string | null {
  const counts = new Map<string, number>();
  const map: Record<string, string> = {
    quality: "life sciences",
    research: "research",
    technical: "technology",
    finance: "finance",
    business: "business",
    marketing: "marketing",
    design: "design",
    product: "product",
    analytics: "analytics",
    operations: "operations",
  };
  for (const d of domains) {
    const k = map[d];
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function push(list: Attribute[], value: string, source: string, family?: string): void {
  const key = (family ?? value).toLowerCase();
  const prev = list.find((a) => (a.family ?? a.value).toLowerCase() === key);
  if (prev) {
    if (!prev.sources.includes(source)) prev.sources.push(source);
  } else list.push({ value, ...(family ? { family } : {}), sources: [source] });
}

/** Evidence spans of an experience: its bullets, summary and endorsed-skills line, keyed by provenance key. */
export function evidenceSpans(exp: Resume["experiences"][number]): EvidenceSpan[] {
  const base = `experiences[${exp.id}]`;
  const spans: EvidenceSpan[] = exp.responsibilities.map((text, i) => ({ id: `${base}.responsibilities[${i}]`, kind: "bullet" as const, text }));
  if (exp.summary) spans.push({ id: `${base}.summary`, kind: "summary", text: exp.summary });
  if (exp.endorsedSkills.length) spans.push({ id: `${base}.endorsedSkills`, kind: "skills", text: exp.endorsedSkills.join(", ") });
  return spans;
}

function decomposeSpan(span: EvidenceSpan): Decomposition {
  if (span.kind === "skills") {
    const text = span.text.replace(/-/g, " ");
    return {
      actions: [],
      clauses: [],
      objects: [],
      concepts: conceptsIn(text).map((c) => ({ id: c.id, label: c.label, domain: c.domain, term: c.term, weak: c.weak })),
      tools: toolsIn(span.text),
      stakeholders: [],
      outcome: null,
      context: null,
      metrics: [],
      managerial: false,
      frame: "skill",
      discarded: [],
      core: text,
    };
  }
  return decompose(span.text, { mode: "resume" });
}

/** Aggregate per-span decompositions into the profile's attributes and vectors. */
export interface ExperienceHeader {
  id: string;
  type: string;
  title: string;
  organization: string | null;
}

export function assembleProfile(exp: ExperienceHeader, evidence: EvidenceSpan[], spans: Record<string, Decomposition>): ExperienceProfile {
  const p: ExperienceProfile = {
    experienceId: exp.id,
    type: exp.type,
    role: exp.title,
    organization: exp.organization ?? null,
    industry: null,
    actions: [],
    objects: [],
    concepts: [],
    tools: [],
    methods: [],
    stakeholders: [],
    outputs: [],
    outcomes: [],
    metrics: [],
    scale: [],
    userExposure: false,
    managerial: false,
    evidence,
    spans,
    spanVectors: {},
    vector: {},
  };
  const domains: string[] = [];
  for (const e of evidence) {
    const d = spans[e.id]!;
    for (const a of d.actions) push(p.actions, a.verb, e.id, a.family);
    for (const o of d.objects) push(p.objects, o, e.id);
    for (const c of d.concepts) {
      push(p.concepts, c.term, e.id, c.id);
      if (METHOD_CONCEPTS.has(c.id)) push(p.methods, c.term, e.id, c.id);
      domains.push(c.domain);
    }
    for (const t of d.tools) push(p.tools, t, e.id);
    for (const s of d.stakeholders) push(p.stakeholders, s.as, e.id, s.category);
    if (d.actions.some((a) => OUTPUT_FAMILIES.has(a.family))) for (const o of d.objects.slice(0, 2)) push(p.outputs, o, e.id);
    if (d.outcome) push(p.outcomes, d.outcome, e.id);
    for (const m of d.metrics) {
      push(p.metrics, m, e.id);
      if (/^\d[\d,]*\+?\s+[a-z]/i.test(m) && !/%/.test(m)) push(p.scale, m, e.id);
    }
    if (d.stakeholders.some((s) => s.category === "customers")) p.userExposure = true;
    if (d.managerial) p.managerial = true;
    p.spanVectors[e.id] = embed(d);
  }
  p.industry = industryOf(domains);
  p.vector = sumVectors(Object.values(p.spanVectors));
  return p;
}

/** Deterministic profiles for every work and project entry (education and excluded entries are never sources). */
export function buildProfiles(resume: Pick<Resume, "experiences">): ExperienceProfile[] {
  return resume.experiences
    .filter((e) => !isExcludedExperience(e) && e.type !== "education")
    .map((exp) => {
      const evidence = evidenceSpans(exp);
      const spans = Object.fromEntries(evidence.map((s) => [s.id, decomposeSpan(s)]));
      return assembleProfile({ id: exp.id, type: exp.type, title: exp.title, organization: exp.organization || null }, evidence, spans);
    })
    .filter((p) => p.evidence.some((e) => e.kind === "bullet"));
}

/* ------------------------------------------------------ model enrichment */

export interface SpanExtraction {
  id: string;
  actions: string[];
  objects: string[];
  skills: string[];
  stakeholders: string[];
  outcomes: string[];
  metrics: string[];
}

/**
 * Merge a fast-model extraction into the profiles. A fragment is used only if
 * it occurs in its own line; skills map to vocabulary families or named tools,
 * stakeholders to broad categories.
 */
export function enrichProfiles(profiles: ExperienceProfile[], extraction: SpanExtraction[]): ExperienceProfile[] {
  const byId = new Map(extraction.map((x) => [x.id, x]));
  return profiles.map((p) => {
    let changed = false;
    const spans: Record<string, Decomposition> = {};
    for (const e of p.evidence) {
      const d = structuredClone(p.spans[e.id]!);
      const x = byId.get(e.id);
      if (x && e.kind !== "skills") {
        const before = JSON.stringify(d);
        for (const o of x.objects) {
          if (groundedIn(o, e.text) && !d.objects.some((y) => y.toLowerCase() === o.toLowerCase())) d.objects.push(o.trim());
        }
        for (const s of x.skills.filter((y) => groundedIn(y, e.text))) {
          for (const c of conceptsIn(s)) {
            if (!d.concepts.some((y) => y.id === c.id)) d.concepts.push({ id: c.id, label: c.label, domain: c.domain, term: c.term, weak: c.weak });
          }
          for (const t of toolsIn(s)) if (!d.tools.includes(t)) d.tools.push(t);
        }
        for (const s of x.stakeholders.filter((y) => groundedIn(y, e.text))) {
          for (const h of stakeholdersIn(s))
            if (!d.stakeholders.some((y) => y.category === h.category)) d.stakeholders.push({ category: h.category, as: h.as });
        }
        if (!d.outcome) d.outcome = x.outcomes.find((y) => groundedIn(y, e.text)) ?? null;
        for (const m of x.metrics) if (groundedIn(m, e.text) && /\d/.test(m) && !d.metrics.includes(m)) d.metrics.push(m);
        if (JSON.stringify(d) !== before) changed = true;
      }
      spans[e.id] = d;
    }
    return changed ? assembleProfile({ id: p.experienceId, type: p.type, title: p.role, organization: p.organization }, p.evidence, spans) : p;
  });
}
