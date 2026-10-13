import type { RequirementResult } from "./match";

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in into is it its of on or our that the their to we will with you your this these those who what which while within across over under including such using use used ability able strong excellent experience work working team teams role skills skill years year plus preferred required must etc".split(
    " ",
  ),
);

export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    // Light stemming so "processes"/"process", "testing"/"tests" meet.
    const t = raw.replace(/(ing|ings|ed|es|s)$/, "");
    if (t.length >= 3) out.add(t);
  }
  return out;
}

export interface RankableBullet {
  key: string;
  experienceId: string;
  text: string;
}

export interface RankedBullet extends RankableBullet {
  score: number;
  /** Requirement ids this bullet evidences. */
  supports: string[];
}

export const CATEGORY_WEIGHT: Record<string, number> = { required: 3, preferred: 2, responsibility: 1, unknown: 0.5, logistics: 0 };

/**
 * Score every verbatim bullet against the job. Deterministic: evidence links
 * from covered requirements dominate; token overlap breaks ties.
 */
export function rankBullets(bullets: RankableBullet[], results: RequirementResult[], jobText: string): RankedBullet[] {
  const jobTokens = contentTokens(jobText);
  return bullets
    .map((b, index) => {
      let score = 0;
      const supports: string[] = [];
      for (const r of results) {
        if (r.status !== "COVERED" && r.status !== "TRANSFERABLE") continue;
        if (r.evidenceKeys.includes(b.key)) {
          // A transferable link (from your skill bank) ranks a bullet a little below a direct one.
          score += (CATEGORY_WEIGHT[r.requirement.category] ?? 0) * (r.status === "COVERED" ? 1 : 0.75);
          supports.push(r.requirement.id);
        }
      }
      const overlap = [...contentTokens(b.text)].filter((t) => jobTokens.has(t)).length;
      score += overlap * 0.4;
      // Stable tie-break: earlier bullets in resume.json first.
      score -= index * 1e-6;
      return { ...b, score, supports };
    })
    .sort((a, b) => b.score - a.score);
}

export function rankSkillLabels(
  skills: { id: string; label: string }[],
  results: RequirementResult[],
  jobText: string,
): { id: string; label: string; score: number }[] {
  const jobTokens = contentTokens(jobText);
  return skills
    .map((s, index) => {
      const direct = results.filter((r) => (r.status === "COVERED" || r.status === "TRANSFERABLE") && r.skillIds.includes(s.id));
      let score = direct.reduce((acc, r) => acc + (CATEGORY_WEIGHT[r.requirement.category] ?? 0), 0);
      score += [...contentTokens(s.label)].filter((t) => jobTokens.has(t)).length * 0.5;
      return { ...s, score: score - index * 1e-6 };
    })
    .sort((a, b) => b.score - a.score);
}
