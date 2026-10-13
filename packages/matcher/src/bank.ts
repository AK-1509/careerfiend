import { normalizeLabel, type InventorySkill, type NormalizedJob, type Requirement } from "@careerfiend/shared";
import { canSatisfy, mentions, skillsMentioned, unknownSkillCandidates } from "./skills";
import { contentTokens } from "./relevance";

/**
 * Skill bank (user-endorsed skills). When you post a listing yourself you have
 * read it and judged yourself a match, so its skills and duties are banked and
 * count toward later listings as TRANSFERABLE. Anything that can be checked as
 * a fact (years, degrees, licenses, certifications, clearance, GPA, work
 * authorization, location) is never banked. Banked skills never fill a form
 * field; they steer tailoring (which bullets lead, which keywords appear)
 * and point at the résumé facts and GitHub projects that back them.
 */

export type BankKind = "skill" | "duty";
export type BankCategory = "tool" | "competency" | "duty";

export interface BankEntry {
  id: string;
  kind: BankKind;
  label: string;
  category: BankCategory;
  /** Résumé fact keys and "github:owner/repo" refs from transferable matches. */
  evidenceKeys: string[];
}

export interface HarvestItem {
  kind: BankKind;
  label: string;
  category: BankCategory;
  requirementId: string;
  requirement: string;
}

/** General competencies: how they are written in listings, and words that show them in experience. */
export interface Competency {
  label: string;
  forms: string[];
  /** Words in a résumé bullet or project summary that show this competency. */
  shows: string[];
}

export const COMPETENCIES: Competency[] = [
  {
    label: "Communication",
    forms: ["communication skills", "communication", "communicate", "communicating", "verbal and written", "written and verbal", "interpersonal"],
    shows: ["present", "presented", "wrote", "written", "report", "documented", "published", "explained", "pitched", "taught", "workshop", "communicated"],
  },
  {
    label: "Collaboration",
    forms: [
      "collaboration",
      "collaborate",
      "collaborative",
      "cross-functional",
      "cross functional",
      "cross-functionally",
      "team player",
      "teamwork",
      "work with teams",
    ],
    shows: ["team", "partnered", "collaborated", "coordinated", "cross-functional", "together", "alongside", "teams"],
  },
  {
    label: "Leadership",
    forms: ["leadership", "lead teams", "leading teams", "mentor", "mentoring", "take ownership", "end-to-end ownership", "drive initiatives"],
    shows: ["led", "managed", "founded", "co-founded", "mentored", "supervised", "directed", "organized", "president", "captain", "chair", "head"],
  },
  {
    label: "Problem solving",
    forms: ["problem solving", "problem-solving", "solve problems", "solving problems", "troubleshoot", "troubleshooting", "debugging", "critical thinking"],
    shows: ["solved", "resolved", "troubleshot", "debugged", "diagnosed", "optimized", "improved", "fixed", "reduced", "identified"],
  },
  {
    label: "Analytical skills",
    forms: ["analytical", "analytical skills", "analysis", "analyze", "analyse", "analyzing", "data-driven", "insights", "quantitative"],
    shows: ["analyzed", "analysis", "data", "statistics", "statistical", "model", "modeled", "regression", "dashboard", "quantified", "measured", "evaluated"],
  },
  {
    label: "Project management",
    forms: [
      "project management",
      "manage projects",
      "managing projects",
      "multiple projects",
      "meet deadlines",
      "prioritize",
      "prioritization",
      "organizational skills",
      "timelines",
    ],
    shows: ["managed", "coordinated", "planned", "scheduled", "delivered", "roadmap", "timeline", "launched", "organized", "deadline"],
  },
  {
    label: "Attention to detail",
    forms: ["attention to detail", "detail-oriented", "detail oriented", "accuracy", "accurate", "meticulous", "thorough"],
    shows: ["documentation", "compliance", "quality", "audit", "verified", "reviewed", "accuracy", "sop", "gmp", "validated", "inspected"],
  },
  {
    label: "Adaptability",
    forms: [
      "fast-paced",
      "fast paced",
      "adaptable",
      "adaptability",
      "ambiguity",
      "self-starter",
      "self starter",
      "independently",
      "learn quickly",
      "quick learner",
      "curious",
      "curiosity",
      "growth mindset",
    ],
    shows: ["founded", "built", "independently", "launched", "startup", "learned", "self-taught", "pivoted", "new"],
  },
  {
    label: "Stakeholder management",
    forms: ["stakeholders", "stakeholder", "client-facing", "customer-facing", "clients", "customer needs", "relationship building", "relationships"],
    shows: ["client", "clients", "customer", "customers", "stakeholder", "stakeholders", "partner", "partners", "investor", "investors", "vendor", "vendors"],
  },
  {
    label: "Research",
    forms: ["research", "researching", "investigate", "investigation", "literature review", "experimentation", "experiments"],
    shows: ["research", "researched", "study", "experiment", "experiments", "lab", "investigated", "published", "thesis", "survey", "interviews"],
  },
  {
    label: "Presentations",
    forms: ["presentation skills", "presentations", "present findings", "presenting", "public speaking"],
    shows: ["presented", "presentation", "pitch", "pitched", "talk", "poster", "conference", "demo", "keynote"],
  },
  {
    label: "Writing and documentation",
    forms: ["documentation", "technical writing", "writing skills", "write reports", "reports", "documenting"],
    shows: ["wrote", "documented", "report", "reports", "sop", "manual", "article", "published", "drafted", "authored"],
  },
  {
    label: "Strategy",
    forms: ["strategy", "strategic", "strategic thinking", "business acumen", "go-to-market", "market analysis", "business strategy"],
    shows: ["strategy", "market", "competitive", "venture", "investment", "business", "financial", "pricing", "growth", "go-to-market"],
  },
  {
    label: "Software development",
    forms: ["software development", "software engineering", "programming", "coding", "develop software", "build software", "write code", "scripting"],
    shows: ["built", "developed", "coded", "implemented", "deployed", "app", "software", "python", "javascript", "typescript", "api", "pipeline", "tool"],
  },
  {
    label: "Creativity and design thinking",
    forms: ["creative", "creativity", "design thinking", "innovative", "innovation", "user-centered", "user centered"],
    shows: ["designed", "created", "invented", "prototype", "prototyped", "design", "concept", "novel"],
  },
  {
    label: "Customer focus",
    forms: ["customer focus", "customer-focused", "customer service", "user empathy", "customer experience", "user experience"],
    shows: ["user", "users", "customer", "customers", "feedback", "interviews", "usability", "experience"],
  },
];

/** Text that can be checked as a fact (and is therefore never banked). */
const FACTUAL =
  /\b(\d+\s*\+?\s*(?:-\s*\d+\s*)?(?:years?|yrs?|months?)|years? of|degree|bachelor'?s?|master'?s?|mba|ph\.?\s?d|doctorate|b\.s\.|b\.a\.|m\.s\.|gpa|graduat\w*|enrolled|coursework in|diploma|licen[cs]e\w*|certif\w*|clearance|citizen\w*|authori[sz]ed to work|work authori[sz]ation|visa|sponsorship|relocat\w*|travel|on-?site|in-?office|hybrid|remote|commute|located in|reside|driver'?s|age \d+|18 years|background check|drug (?:test|screen)|physical(?:ly)? able|lift \d+|shifts?|weekends?|overtime)\b/i;

export function isFactualText(text: string): boolean {
  return FACTUAL.test(text);
}

const BANKABLE_KINDS: Requirement["kind"][] = ["skill", "experience-years", "other"];
const BANKABLE_CATEGORIES: Requirement["category"][] = ["required", "preferred", "responsibility"];

export function competenciesIn(text: string): Competency[] {
  return COMPETENCIES.filter((c) => c.forms.some((f) => mentions(text, f)));
}

/**
 * What a posted listing contributes to the bank. Skill labels come from the
 * inventory (skills you have not verified), the known-tools list and trigger
 * phrases, the competency list, and any model-proposed labels that appear
 * verbatim. Whole requirement lines are banked as duties so a later listing
 * with the same duty in other words is matched too. Rejected skills stay out.
 */
export function harvestJob(job: NormalizedJob, skills: InventorySkill[], extraLabels: { requirementId: string; label: string }[] = []): HarvestItem[] {
  const out = new Map<string, HarvestItem>();
  const rejected = new Set(skills.filter((s) => s.status === "REJECTED_BY_USER").map((s) => normalizeLabel(s.label)));
  const add = (item: HarvestItem) => {
    const key = `${item.kind}:${normalizeLabel(item.label)}`;
    if (!normalizeLabel(item.label) || rejected.has(normalizeLabel(item.label)) || out.has(key)) return;
    if (item.kind === "skill" && (isFactualText(item.label) || item.label.length > 60)) return;
    out.set(key, item);
  };
  for (const req of job.requirements) {
    if (!BANKABLE_CATEGORIES.includes(req.category) || !BANKABLE_KINDS.includes(req.kind)) continue;
    const base = { requirementId: req.id, requirement: req.text };
    for (const s of skillsMentioned(req.text, skills)) {
      if (s.status === "REJECTED_BY_USER" || canSatisfy(s, req).usable) continue; // already counts, or you said no
      add({ ...base, kind: "skill", label: s.label, category: s.category === "soft" ? "competency" : "tool" });
    }
    for (const label of unknownSkillCandidates(req.text, skills)) add({ ...base, kind: "skill", label, category: "tool" });
    for (const c of competenciesIn(req.text)) add({ ...base, kind: "skill", label: c.label, category: "competency" });
    for (const l of extraLabels.filter((x) => x.requirementId === req.id)) {
      if (normalizeLabel(req.text).includes(normalizeLabel(l.label))) add({ ...base, kind: "skill", label: l.label, category: "tool" });
    }
    // The whole line as a duty: not for years items, not for anything checkable, not for fragments.
    if (req.kind !== "experience-years" && !isFactualText(req.text) && contentTokens(req.text).size >= 3) {
      add({ ...base, kind: "duty", label: req.text.slice(0, 300), category: "duty" });
    }
  }
  return [...out.values()];
}

/* ------------------------------------------------------------ matching */

/** Share of the smaller token set found in the larger one, and the overlap size. */
export function tokenOverlap(a: string, b: string): { ratio: number; shared: string[] } {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  const shared = [...ta].filter((t) => tb.has(t));
  const denom = Math.min(ta.size, tb.size);
  return { ratio: denom ? shared.length / denom : 0, shared };
}

/** A banked duty matches a requirement worded differently when most terms are shared. */
export const DUTY_MATCH = 0.6;
const DUTY_MIN_SHARED = 3;

function competencyOf(label: string): Competency | undefined {
  const n = normalizeLabel(label);
  return COMPETENCIES.find((c) => normalizeLabel(c.label) === n);
}

/** Banked skills named in a requirement (competencies by any of their listing forms). */
export function bankedSkillsIn(text: string, bank: BankEntry[]): BankEntry[] {
  return bank.filter((b) => {
    if (b.kind !== "skill") return false;
    const c = competencyOf(b.label);
    return mentions(text, b.label) || (c ? c.forms.some((f) => mentions(text, f)) : false);
  });
}

export function bankedDutiesFor(text: string, bank: BankEntry[]): { entry: BankEntry; ratio: number }[] {
  return bank
    .filter((b) => b.kind === "duty")
    .map((entry) => {
      const o = tokenOverlap(text, entry.label);
      return { entry, ratio: o.shared.length >= DUTY_MIN_SHARED ? o.ratio : 0 };
    })
    .filter((x) => x.ratio >= DUTY_MATCH)
    .sort((a, b) => b.ratio - a.ratio);
}

/* ------------------------------------------------------- transfer scoring */

export interface TransferCandidate {
  type: "RESUME_FACT" | "GITHUB_REPO";
  ref: string;
  text: string;
}

export interface TransferScore {
  score: number;
  method: "direct" | "related" | "overlap";
  rationale: string;
}

/** "presented to leadership", "worked with stakeholders": the audience, not the ability. */
const AUDIENCE = /\b(?:to|with|for|and|across)\s+(?:senior\s+|executive\s+|company\s+)?(?:leadership|stakeholders|clients|customers)\b/gi;

/**
 * How well one piece of real experience backs a banked entry. Deterministic:
 *  - direct: the skill itself is named in the fact or project (1.0; 0.85 for a general competency)
 *  - related: a résumé line shows the same competency family (0.6 to 0.9)
 *  - overlap: shared terms with a banked duty or multi-word skill (0.4 to 0.8)
 * A GitHub README is long and generic ("run the tests", "built with"), so a
 * project needs the skill named or three shared terms; softer links come from
 * the AI step, which must explain itself.
 */
export function transferScore(entry: Pick<BankEntry, "kind" | "label">, candidate: TransferCandidate): TransferScore | null {
  const repo = candidate.type === "GITHUB_REPO";
  const where = repo ? `GitHub project ${candidate.ref}` : "this résumé line";
  const text = candidate.text.replace(AUDIENCE, " ");
  if (entry.kind === "skill") {
    const c = competencyOf(entry.label);
    if (mentions(text, entry.label) || (c && c.forms.some((f) => mentions(text, f)))) {
      return { score: c ? 0.85 : 1, method: "direct", rationale: `${entry.label} is named in ${where}.` };
    }
    if (c) {
      const hits = c.shows.filter((w) => mentions(text, w));
      if (hits.length && !repo) {
        return {
          score: Math.min(0.9, 0.5 + 0.1 * hits.length),
          method: "related",
          rationale: `This résumé line shows ${entry.label.toLowerCase()} (${hits.slice(0, 4).join(", ")}).`,
        };
      }
      return null;
    }
  }
  const o = tokenOverlap(entry.label, text);
  const need = repo ? 3 : entry.kind === "duty" ? 2 : Math.min(2, contentTokens(entry.label).size);
  if (o.shared.length >= need && need > 0 && o.ratio >= (repo ? 0.5 : 0.34)) {
    return { score: Math.min(0.8, 0.3 + o.ratio * 0.5), method: "overlap", rationale: `Shared terms with ${where}: ${o.shared.slice(0, 5).join(", ")}.` };
  }
  return null;
}
