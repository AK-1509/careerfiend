import { normalizeLabel, type InventorySkill, type NormalizedJob } from "@careerfiend/shared";
import { bankedSkillsIn, competenciesIn, type BankEntry } from "./bank";
import { mentions, skillsMentioned, surfaceForms, unknownSkillCandidates } from "./skills";

/**
 * ATS keywords: the skills, tools and competencies a listing names, in the
 * forms an applicant tracking system would search for. Used to steer tailoring
 * and to show which ones the tailored résumé contains. Never a gate.
 */
export interface JobKeyword {
  label: string;
  /** Any of these appearing in the résumé counts. */
  forms: string[];
  /** required / preferred items weigh more than responsibilities. */
  weight: number;
}

const WEIGHT: Record<string, number> = { required: 3, preferred: 2, responsibility: 1 };

export function jobKeywords(job: NormalizedJob, skills: InventorySkill[], bank: BankEntry[] = []): JobKeyword[] {
  const out = new Map<string, JobKeyword>();
  const usable = skills.filter((s) => s.status !== "REJECTED_BY_USER");
  const add = (label: string, forms: string[], weight: number) => {
    const k = normalizeLabel(label);
    if (!k) return;
    const prev = out.get(k);
    if (prev) {
      prev.weight = Math.max(prev.weight, weight);
      for (const f of forms) if (!prev.forms.includes(f)) prev.forms.push(f);
    } else out.set(k, { label, forms: [...new Set([label, ...forms])], weight });
  };
  for (const req of job.requirements) {
    const weight = WEIGHT[req.category];
    if (!weight || ["degree", "license", "certification", "clearance", "location"].includes(req.kind)) continue;
    for (const s of skillsMentioned(req.text, usable)) {
      // Use the wording the listing used, so the résumé can mirror it.
      const used = surfaceForms(s).filter((f) => mentions(req.text, f));
      add(used[0] ?? s.label, [s.label, ...surfaceForms(s)], weight);
    }
    for (const b of bankedSkillsIn(req.text, bank)) add(b.label, [b.label], weight);
    for (const label of unknownSkillCandidates(req.text, usable)) add(label, [label], weight);
    for (const c of competenciesIn(req.text)) add(c.label, c.forms, weight);
  }
  return [...out.values()].sort((a, b) => b.weight - a.weight);
}

/** Which listing keywords appear in a résumé's text. */
export function keywordCoverage(keywords: JobKeyword[], resumeText: string): { label: string; found: boolean; weight: number }[] {
  return keywords.map((k) => ({ label: k.label, weight: k.weight, found: k.forms.some((f) => mentions(resumeText, f)) }));
}
