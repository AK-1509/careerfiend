import { isUsableStatus, normalizeLabel, type DegreeLevel, type InventorySkill, type NormalizedJob, type Requirement } from "@careerfiend/shared";
import { canSatisfy, skillsMentioned, unknownSkillCandidates } from "./skills";
import { bankedDutiesFor, bankedSkillsIn, type BankEntry } from "./bank";

/**
 * Job analysis for tailoring. CareerFiend never decides whether you should
 * apply: you decide by pasting a link (or pressing Apply on a watchlist
 * find). This maps each requirement in the listing to the evidence you have,
 * so the résumé and cover letter can lead with what the employer asks for
 * and the ATS keyword check can show what is missing. Nothing here skips,
 * holds or gates an application.
 *
 *   COVERED       a verified or confirmed skill (or your degree) shows it
 *   TRANSFERABLE  your skill bank shows it (skills from listings you posted)
 *   NEEDS_CONFIRM a skill in your inventory you have not confirmed
 *   GAP           not on your résumé yet
 *   NOT_APPLICABLE logistics and bare years-of-experience lines
 */
export type RequirementStatus = "COVERED" | "TRANSFERABLE" | "GAP" | "NEEDS_CONFIRM" | "NOT_APPLICABLE";

export interface RequirementResult {
  requirement: Requirement;
  status: RequirementStatus;
  skillIds: string[];
  /** Inventory skills that would show this item if you confirmed them. */
  unverifiedSkillIds: string[];
  evidenceKeys: string[];
  /** Skill-bank entries that make this item TRANSFERABLE. */
  bankIds: string[];
  confidence: number;
  note: string;
  /** Part of the keyword-match percentage (required/preferred skill items). */
  countsTowardCoverage: boolean;
}

/** Optional model proposal: requirement → skill ids with confidence. Policy code decides. */
export interface AiMapping {
  requirementId: string;
  skillIds: string[];
  confidence: number;
}

export interface MatchResult {
  /** Share of the listing's skill items your documents can show (information for tailoring, never a gate). */
  coverage: number;
  results: RequirementResult[];
  /** Requirement lines not shown on your résumé yet. */
  gaps: string[];
  warnings: { code: string; message: string }[];
  /** Skill labels in the listing that your inventory does not know. */
  newSkills: { label: string; requirement: string; requirementId: string }[];
}

export const LOW_CONFIDENCE = 0.7;

const DEGREE_RANK: DegreeLevel[] = ["none", "associate", "bachelor", "master", "professional", "doctorate"];

function anyMode(text: string): boolean {
  return /\b(or|such as|e\.g\.|including|like|one of|any of)\b/i.test(text);
}

function evidenceFor(skills: InventorySkill[]): string[] {
  return [...new Set(skills.flatMap((s) => s.evidence.map((e) => e.key)))];
}

export function matchJob(
  job: NormalizedJob,
  skills: InventorySkill[],
  opts: {
    /** Highest completed degree on the résumé (for degree lines). */
    degreeLevel?: DegreeLevel;
    aiMappings?: AiMapping[];
    /** Active skill-bank entries (skills and duties from listings you posted). */
    bank?: BankEntry[];
  } = {},
): MatchResult {
  const warnings: MatchResult["warnings"] = [];
  const newSkills: MatchResult["newSkills"] = [];
  const byId = new Map(skills.map((s) => [s.id, s]));
  const aiById = new Map((opts.aiMappings ?? []).map((m) => [m.requirementId, m]));
  const degreeLevel = opts.degreeLevel ?? "none";

  const results: RequirementResult[] = job.requirements.map((req) => {
    const base = {
      requirement: req,
      skillIds: [] as string[],
      unverifiedSkillIds: [] as string[],
      evidenceKeys: [] as string[],
      bankIds: [] as string[],
      confidence: 1,
      note: "",
    };

    if (req.category === "logistics" || req.kind === "location") {
      return { ...base, status: "NOT_APPLICABLE" as const, note: "Logistics: answered on the form.", countsTowardCoverage: false };
    }
    if (req.category === "responsibility" || req.category === "unknown") {
      // Responsibilities steer which bullets lead; they are not part of the keyword match.
      const found = skillsMentioned(req.text, skills);
      const usable = found.filter((s) => canSatisfy(s, req).usable);
      return {
        ...base,
        status: usable.length ? ("COVERED" as const) : ("NOT_APPLICABLE" as const),
        skillIds: usable.map((s) => s.id),
        evidenceKeys: evidenceFor(usable),
        note: req.category === "unknown" ? "Uncategorized item." : "Responsibility (orders your bullets).",
        countsTowardCoverage: false,
      };
    }

    if (req.kind === "clearance" || req.kind === "license" || req.kind === "certification") {
      const held = skillsMentioned(req.text, skills).filter((s) => s.status === "CONFIRMED_BY_USER" || s.status === "VERIFIED_FROM_SOURCE");
      if (held.length) {
        return { ...base, status: "COVERED" as const, skillIds: held.map((s) => s.id), evidenceKeys: evidenceFor(held), countsTowardCoverage: false };
      }
      return { ...base, status: "GAP" as const, note: `Not on your résumé (${req.kind}).`, countsTowardCoverage: false };
    }
    if (req.kind === "degree") {
      const needed = req.degreeLevel ?? "bachelor";
      const shown = DEGREE_RANK.indexOf(degreeLevel) >= DEGREE_RANK.indexOf(needed);
      return {
        ...base,
        status: shown ? ("COVERED" as const) : ("GAP" as const),
        note: shown ? `Your ${degreeLevel} degree is on the résumé.` : `Listing mentions a ${needed} degree; your résumé shows ${degreeLevel}.`,
        countsTowardCoverage: false,
      };
    }

    // skill or experience-years item
    const mentioned = skillsMentioned(req.text, skills);
    const ai = aiById.get(req.id);
    let aiNote = "";
    if (ai) {
      if (ai.confidence < LOW_CONFIDENCE) aiNote = `Model mapping below confidence ${LOW_CONFIDENCE}: ignored.`;
      else
        for (const id of ai.skillIds) {
          const s = byId.get(id);
          if (s && !mentioned.includes(s)) mentioned.push(s);
        }
    }
    const usable = mentioned.filter((s) => canSatisfy(s, req).usable);
    const unverified = mentioned.filter((s) => s.status === "UNVERIFIED");
    const limited = mentioned.filter((s) => isUsableStatus(s.status) && !canSatisfy(s, req).usable);
    const unknown = req.kind === "skill" || req.kind === "experience-years" ? unknownSkillCandidates(req.text, skills) : [];
    for (const label of unknown) newSkills.push({ label, requirement: req.text, requirementId: req.id });

    // A bare "N years of experience" names nothing to tailor toward.
    if (req.kind === "experience-years" && mentioned.length === 0 && unknown.length === 0) {
      return { ...base, status: "NOT_APPLICABLE" as const, note: "Years of experience: nothing to tailor.", countsTowardCoverage: false };
    }

    const rejected = mentioned.filter((s) => s.status === "REJECTED_BY_USER");
    const detected = new Set(skillsMentioned(req.text, skills).map((s) => s.id));
    // Deterministic label matches carry 0.95; coverage that relies only on a model mapping carries the model's confidence.
    const confidence = usable.length && usable.every((s) => !detected.has(s.id)) && ai ? ai.confidence : 0.95;
    const blocked = unknown.length > 0 || limited.length > 0 || rejected.length > 0;
    let covered: boolean;
    let coveredIfConfirmed: boolean;
    if (anyMode(req.text)) {
      // "X or Y", "such as": one usable skill is enough.
      covered = usable.length > 0;
      coveredIfConfirmed = !covered && unverified.length > 0;
    } else {
      // "X and Y": every named skill must be usable.
      covered = usable.length > 0 && unverified.length === 0 && !blocked;
      coveredIfConfirmed = !covered && unverified.length > 0 && !blocked;
    }

    if (covered && confidence >= LOW_CONFIDENCE) {
      return {
        ...base,
        status: "COVERED" as const,
        skillIds: usable.map((s) => s.id),
        evidenceKeys: evidenceFor(usable),
        confidence,
        note: [usable.map((s) => canSatisfy(s, req).reason).join("; "), aiNote].filter(Boolean).join(" "),
        countsTowardCoverage: true,
      };
    }
    const transfer =
      rejected.length === 0
        ? transferable(req.text, anyMode(req.text), [...unverified, ...limited].map((s) => s.label).concat(unknown), opts.bank ?? [])
        : null;
    if (transfer) {
      return {
        ...base,
        status: "TRANSFERABLE" as const,
        skillIds: usable.map((s) => s.id),
        evidenceKeys: [...new Set([...evidenceFor(usable), ...transfer.entries.flatMap((e) => e.evidenceKeys)])],
        bankIds: transfer.entries.map((e) => e.id),
        confidence: 0.9,
        note: transfer.note,
        countsTowardCoverage: true,
      };
    }
    if (coveredIfConfirmed) {
      return {
        ...base,
        status: "NEEDS_CONFIRM" as const,
        skillIds: usable.map((s) => s.id),
        unverifiedSkillIds: unverified.map((s) => s.id),
        evidenceKeys: evidenceFor(usable),
        confidence,
        note: `In your inventory but not confirmed: ${unverified.map((s) => s.label).join(", ")}. Confirm on the Skills page to use it.`,
        countsTowardCoverage: true,
      };
    }
    const why = [
      ...limited.map((s) => canSatisfy(s, req).reason),
      ...mentioned.filter((s) => s.status === "REJECTED_BY_USER").map((s) => `${s.label} rejected by you`),
      ...unknown.map((u) => `${u} is not on your résumé yet`),
      aiNote,
    ].filter(Boolean);
    return {
      ...base,
      status: "GAP" as const,
      skillIds: [],
      evidenceKeys: [],
      confidence: mentioned.length || unknown.length ? confidence : 0.5,
      note: why.length ? why.join("; ") : "Not shown on your résumé yet",
      countsTowardCoverage: true,
    };
  });

  // Keyword match: required skill items your documents can show (all skill items when none are marked required).
  let counted = results.filter((r) => r.countsTowardCoverage && r.requirement.category === "required");
  if (counted.length === 0) counted = results.filter((r) => r.countsTowardCoverage);
  const covered = counted.filter((r) => r.status === "COVERED" || r.status === "TRANSFERABLE").length;
  const coverage = counted.length ? covered / counted.length : 0;
  if (counted.length === 0) {
    warnings.push({
      code: "NO_REQUIREMENTS",
      message: "No skill requirements could be read from the listing; documents are tailored from the whole description.",
    });
  }

  // De-duplicate new skills by normalized label.
  const seen = new Set<string>();
  const uniqueNew = newSkills.filter((n) => {
    const k = normalizeLabel(n.label);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    coverage,
    results,
    gaps: results.filter((r) => r.status === "GAP" && r.countsTowardCoverage).map((r) => r.requirement.text),
    warnings,
    newSkills: uniqueNew,
  };
}

/**
 * Whether the skill bank covers a requirement: a banked duty worded the same
 * way, or banked skills for everything the line names that you have not verified.
 */
function transferable(text: string, any: boolean, unbacked: string[], bank: BankEntry[]): { entries: BankEntry[]; note: string } | null {
  if (!bank.length) return null;
  const duties = bankedDutiesFor(text, bank);
  const skills = bankedSkillsIn(text, bank);
  const isBanked = (label: string) => {
    const n = normalizeLabel(label);
    // "Communication" banked also covers "Written communication" (and the reverse).
    return skills.some((b) => {
      const m = normalizeLabel(b.label);
      return m === n || (Math.min(m.length, n.length) > 3 && (m.includes(n) || n.includes(m)));
    });
  };
  const backed = (entries: BankEntry[]) => {
    const withEvidence = entries.filter((e) => e.evidenceKeys.length).length;
    return withEvidence ? ` Backed by your experience for ${withEvidence} of ${entries.length}.` : "";
  };
  if (duties.length) {
    const entries = [duties[0]!.entry, ...skills];
    return {
      entries,
      note: `Transferable: you posted a listing with the same duty (${Math.round(duties[0]!.ratio * 100)}% of terms shared).${backed(entries)}`,
    };
  }
  if (!skills.length) return null;
  if (!any && !unbacked.every(isBanked)) return null;
  return { entries: skills, note: `Transferable: ${skills.map((s) => s.label).join(", ")} from listings you posted.${backed(skills)}` };
}
