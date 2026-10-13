import { stableId, type ExperienceFactData, type FactKind } from "@careerfiend/shared";
import type { Experience, Resume } from "./resume-schema";

/**
 * Terms that must never reach a document (matched against id, title and
 * organization). Empty in the public edition: each person decides what is on
 * their résumé by editing it. Kept as a hook for self-hosters.
 */
export const EXCLUDED_TERMS: readonly string[] = [];

export function mentionsExcluded(text: string): string | null {
  for (const term of EXCLUDED_TERMS) {
    if (text.toLowerCase().includes(term.toLowerCase())) return term;
  }
  return null;
}

export function isExcludedExperience(exp: Pick<Experience, "id" | "title" | "organization">): boolean {
  return mentionsExcluded(`${exp.id} ${exp.title} ${exp.organization}`) !== null;
}

export interface ExtractedFact extends ExperienceFactData {
  experienceType: string | null;
  ordinal: number;
}

/**
 * Deterministic JSON → facts (D1). No model is involved.
 * Provenance keys:
 *   profile.<field>, profile.links[<n>]
 *   experiences[<id>].title|organization|location|startDate|endDate|url
 *   experiences[<id>].summary
 *   experiences[<id>].responsibilities[<n>]   (zero-based)
 *   experiences[<id>].endorsedSkills
 *   skills[<id>]
 *   languages
 * Fact ids depend only on the source checksum and the key, so parsing the
 * same commit twice yields identical ids.
 */
export function extractFacts(resume: Resume, checksum: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  let ordinal = 0;
  const push = (key: string, kind: FactKind, text: string, experienceId: string | null = null, experienceType: string | null = null) => {
    facts.push({
      id: stableId("fact", checksum, key),
      key,
      kind,
      experienceId,
      experienceType,
      text,
      status: "VERIFIED_FROM_SOURCE",
      ordinal: ordinal++,
    });
  };

  const p = resume.profile;
  push("profile.name", "profile", p.name);
  push("profile.headline", "profile", p.headline);
  push("profile.location", "profile", p.location);
  push("profile.email", "profile", p.email);
  p.links.forEach((l, i) => push(`profile.links[${i}]`, "profile", `${l.label}: ${l.url}`));

  for (const exp of resume.experiences) {
    if (isExcludedExperience(exp)) continue;
    const base = `experiences[${exp.id}]`;
    push(`${base}.title`, "experience", exp.title, exp.id, exp.type);
    if (exp.organization) push(`${base}.organization`, "experience", exp.organization, exp.id, exp.type);
    push(`${base}.location`, "experience", exp.location, exp.id, exp.type);
    push(`${base}.startDate`, "experience", exp.startDate, exp.id, exp.type);
    push(`${base}.endDate`, "experience", exp.endDate ?? "present", exp.id, exp.type);
    if (exp.url) push(`${base}.url`, "experience", exp.url, exp.id, exp.type);
    if (exp.summary) push(`${base}.summary`, "summary", exp.summary, exp.id, exp.type);
    exp.responsibilities.forEach((r, i) => push(`${base}.responsibilities[${i}]`, "responsibility", r, exp.id, exp.type));
    if (exp.endorsedSkills.length) push(`${base}.endorsedSkills`, "experience", exp.endorsedSkills.join(", "), exp.id, exp.type);
  }

  for (const s of resume.skills) push(`skills[${s.id}]`, "skill", s.label);
  push("languages", "language", resume.languages.join(", "));
  return facts;
}

/** Look up the text behind a provenance key in a parsed resume. */
export function resolveKey(resume: Resume, key: string): string | null {
  const exp = /^experiences\[([a-z0-9-]+)\]\.(\w+)(?:\[(\d+)\])?$/.exec(key);
  if (exp) {
    const e = resume.experiences.find((x) => x.id === exp[1]);
    if (!e || isExcludedExperience(e)) return null;
    const field = exp[2]!;
    if (field === "responsibilities") {
      const i = Number(exp[3]);
      return exp[3] === undefined ? null : (e.responsibilities[i] ?? null);
    }
    if (field === "endorsedSkills") return e.endorsedSkills.join(", ");
    if (field === "endDate") return e.endDate ?? "present";
    const v = (e as Record<string, unknown>)[field];
    return typeof v === "string" && v !== "" ? v : null;
  }
  if (key === "languages") return resume.languages.join(", ");
  const skill = /^skills\[([a-z0-9-]+)\]$/.exec(key);
  if (skill) return resume.skills.find((s) => s.id === skill[1])?.label ?? null;
  const link = /^profile\.links\[(\d+)\]$/.exec(key);
  if (link) {
    const l = resume.profile.links[Number(link[1])];
    return l ? `${l.label}: ${l.url}` : null;
  }
  const prof = /^profile\.(\w+)$/.exec(key);
  if (prof) {
    const v = (resume.profile as Record<string, unknown>)[prof[1]!];
    return typeof v === "string" ? v : null;
  }
  return null;
}

/**
 * Every string value in resume.json, decoded. The résumé substring test (D2)
 * checks generated text against this corpus, so JSON escaping cannot cause a
 * false failure and nothing outside a string value (keys, punctuation) counts.
 */
export function resumeStringCorpus(rawText: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(JSON.parse(rawText));
  return out;
}

export function isVerbatimSubstring(corpus: string[], text: string): boolean {
  return corpus.some((s) => s.includes(text));
}
