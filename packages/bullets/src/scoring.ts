import type { Candidate, Decomposition, DimensionScores, ExperienceProfile, RequirementTemplate } from "./types";
import { cosine, retrieve, sumVectors } from "./semantic";
import { actionFamily, contentStems, relatedConcepts } from "./vocabulary";

/**
 * Stage B: structured similarity. A retrieved experience is scored on separate
 * dimensions (action, object/domain, skill, method, stakeholder, outcome,
 * industry/context, overall semantic) with weights that depend on what kind
 * of requirement it is: for "Develop KPIs and success metrics" the analytics
 * concepts matter and the exact industry barely does; for "Test prototypes
 * with users" testing, prototyping and users matter, not the word "software".
 */

const METHODS = new Set([
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
  "quality_control",
]);

type Weights = DimensionScores;

const BASE: Weights = { action: 0.2, object: 0.15, skill: 0.25, method: 0.1, stakeholder: 0.05, outcome: 0.05, industry: 0.05, semantic: 0.15 };

function weightsFor(t: RequirementTemplate): Weights {
  const w = { ...BASE };
  switch (t.domain) {
    case "analytics":
    case "business":
    case "finance":
    case "product":
      Object.assign(w, { skill: 0.3, object: 0.2, industry: 0.02 });
      break;
    case "technical":
      Object.assign(w, { skill: 0.35, action: 0.15, industry: 0.03 });
      break;
    case "design":
    case "research":
      Object.assign(w, { method: 0.2, stakeholder: 0.1, object: 0.15, industry: 0.02 });
      break;
    case "operations":
    case "quality":
      Object.assign(w, { action: 0.2, object: 0.2, skill: 0.25, industry: 0.08 });
      break;
  }
  if (t.frame === "skill") w.action = 0;
  return w;
}

function familiesOf(spans: Decomposition[]) {
  return {
    actions: new Set(spans.flatMap((d) => d.actions.map((a) => a.family))),
    concepts: new Set(spans.flatMap((d) => d.concepts.map((c) => c.id))),
    tools: new Set(spans.flatMap((d) => d.tools.map((x) => x.toLowerCase()))),
    stakeholders: new Set(spans.flatMap((d) => d.stakeholders.map((s) => s.category))),
    stems: new Set(spans.flatMap((d) => [...d.objects.flatMap(contentStems), ...contentStems(d.core)])),
    outcomes: spans.some((d) => !!d.outcome || d.metrics.length > 0),
    domains: new Set(spans.flatMap((d) => d.concepts.map((c) => c.domain))),
  };
}

export function scoreCandidate(t: RequirementTemplate, p: ExperienceProfile, spanIds: string[], retrievalScore = 0): Candidate {
  const spans = spanIds.map((id) => p.spans[id]).filter((d): d is Decomposition => !!d);
  const f = familiesOf(spans);
  const na = new Set<keyof DimensionScores>();

  let action = 0;
  if (!t.actions.length) na.add("action");
  for (const a of t.actions) {
    if (f.actions.has(a.family)) action = 1;
    else if ((actionFamily(a.family)?.related ?? []).some((r) => f.actions.has(r))) action = Math.max(action, 0.6);
  }

  const objStems = [...new Set(t.objects.flatMap(contentStems))];
  let object = 0;
  if (!objStems.length) na.add("object");
  else object = objStems.filter((s) => f.stems.has(s)).length / objStems.length;

  const conceptScore = (id: string) => (f.concepts.has(id) ? 1 : relatedConcepts(id).some((r) => f.concepts.has(r)) ? 0.5 : 0);
  const skillItems = [
    ...t.concepts.map((c) => ({ w: c.weak ? 0.5 : 1, s: conceptScore(c.id) })),
    ...t.tools.map((x) => ({ w: 1.5, s: f.tools.has(x.toLowerCase()) ? 1 : 0 })),
  ];
  let skill = 0;
  if (!skillItems.length) na.add("skill");
  else skill = skillItems.reduce((a, x) => a + x.w * x.s, 0) / skillItems.reduce((a, x) => a + x.w, 0);

  const methodItems = t.concepts.filter((c) => METHODS.has(c.id));
  let method = 0;
  if (!methodItems.length) na.add("method");
  else method = methodItems.reduce((a, c) => a + conceptScore(c.id), 0) / methodItems.length;

  const cats = [...new Set(t.stakeholders.map((s) => s.category))];
  let stakeholder = 0;
  if (!cats.length) na.add("stakeholder");
  else stakeholder = cats.filter((c) => f.stakeholders.has(c)).length / cats.length;

  let outcome = 0;
  if (!t.outcome) na.add("outcome");
  else outcome = f.outcomes ? 1 : 0;

  const industry = f.domains.has(t.domain) ? 1 : p.industry && t.domain === "general" ? 0.5 : 0;
  const semantic = cosine(t.vector, sumVectors(spanIds.map((id) => p.spanVectors[id] ?? {})));

  const dims: DimensionScores = { action, object, skill, method, stakeholder, outcome, industry, semantic };
  const w = weightsFor(t);
  let total = 0;
  let weight = 0;
  for (const k of Object.keys(dims) as (keyof DimensionScores)[]) {
    if (na.has(k) || !w[k]) continue;
    total += w[k] * dims[k];
    weight += w[k];
  }
  const score = weight ? Math.round((total / weight) * 1000) / 1000 : 0;
  return { requirementId: t.requirementId, experienceId: p.experienceId, spanIds, retrieval: retrievalScore, dims, score };
}

export const MIN_CANDIDATE_SCORE = 0.25;

/**
 * Stages A + B for one template: semantic retrieval of the closest
 * experiences, then structured scoring of each on its best lines. Returns at
 * most `perTemplate` candidates above the floor, best first.
 */
export function candidatesFor(t: RequirementTemplate, profiles: ExperienceProfile[], perTemplate = 2): Candidate[] {
  return retrieve(t.vector, profiles, 4)
    .map((r) => {
      const p = profiles.find((x) => x.experienceId === r.experienceId)!;
      // Score the best single line and the best pair; keep whichever is stronger.
      const one = scoreCandidate(
        t,
        p,
        r.spans.slice(0, 1).map((s) => s.id),
        r.score,
      );
      const two =
        r.spans.length > 1
          ? scoreCandidate(
              t,
              p,
              r.spans.slice(0, 2).map((s) => s.id),
              r.score,
            )
          : one;
      return two.score > one.score + 0.05 ? two : one;
    })
    .filter((c) => c.score >= MIN_CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, perTemplate);
}
