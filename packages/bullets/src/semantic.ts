import type { Decomposition, ExperienceProfile, SparseVector } from "./types";
import { actionFamily, contentStems, relatedConcepts } from "./vocabulary";

/**
 * Semantic space shared by job templates and experiences. The platform has no
 * embedding service, so this is a sparse concept embedding built from the
 * canonical vocabulary: concept families (with soft weight on related
 * families), action families, named tools, stakeholder categories and
 * domains carry most of the weight; leftover word stems add a little lexical
 * signal. "Develop KPIs and success metrics" and "Defined performance metrics
 * for the dashboard" land close together without sharing a keyword.
 */

const W = {
  concept: 3,
  conceptWeak: 1.2,
  related: 0.8,
  domain: 0.5,
  action: 1.5,
  actionRelated: 0.4,
  tool: 3,
  stakeholder: 1,
  stem: 0.35,
};

function add(v: SparseVector, k: string, w: number): void {
  v[k] = Math.max(v[k] ?? 0, w);
}

export function normalizeVector(v: SparseVector): SparseVector {
  const n = Math.sqrt(Object.values(v).reduce((a, x) => a + x * x, 0));
  if (!n) return v;
  const out: SparseVector = {};
  for (const [k, x] of Object.entries(v)) out[k] = Math.round((x / n) * 1e4) / 1e4;
  return out;
}

export function embed(d: Pick<Decomposition, "concepts" | "actions" | "tools" | "stakeholders" | "core">): SparseVector {
  const v: SparseVector = {};
  const covered = new Set<string>();
  for (const c of d.concepts) {
    add(v, `c:${c.id}`, c.weak ? W.conceptWeak : W.concept);
    add(v, `d:${c.domain}`, W.domain);
    for (const r of relatedConcepts(c.id)) add(v, `c:${r}`, W.related * (c.weak ? 0.5 : 1));
    for (const s of contentStems(c.term)) covered.add(s);
  }
  for (const a of d.actions) {
    add(v, `a:${a.family}`, W.action);
    for (const r of actionFamily(a.family)?.related ?? []) add(v, `a:${r}`, W.actionRelated);
    covered.add(a.verb);
  }
  for (const t of d.tools) {
    add(v, `t:${t.toLowerCase()}`, W.tool);
    add(v, "d:technical", W.domain);
    for (const s of contentStems(t)) covered.add(s);
  }
  for (const s of d.stakeholders) add(v, `s:${s.category}`, W.stakeholder);
  for (const s of contentStems(d.core)) if (!covered.has(s) && s.length > 2) add(v, `w:${s}`, W.stem);
  return normalizeVector(v);
}

export function cosine(a: SparseVector, b: SparseVector): number {
  let dot = 0;
  const [small, large] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  for (const [k, x] of Object.entries(small)) {
    const y = large[k];
    if (y) dot += x * y;
  }
  return Math.round(dot * 1e4) / 1e4;
}

export function sumVectors(vs: SparseVector[]): SparseVector {
  const out: SparseVector = {};
  for (const v of vs) for (const [k, x] of Object.entries(v)) out[k] = (out[k] ?? 0) + x;
  return normalizeVector(out);
}

export interface Retrieved {
  experienceId: string;
  score: number;
  /** Bullet/summary spans by similarity, strongest first. */
  spans: { id: string; score: number }[];
}

/**
 * Stage A: semantic candidate retrieval. Each experience is scored by its best
 * line (most of the weight) and its whole profile (context); top `k` returned.
 */
export function retrieve(templateVector: SparseVector, profiles: ExperienceProfile[], k = 3): Retrieved[] {
  return profiles
    .map((p) => {
      const spans = p.evidence
        .filter((e) => e.kind !== "skills")
        .map((e) => ({ id: e.id, score: cosine(templateVector, p.spanVectors[e.id] ?? {}) }))
        .sort((a, b) => b.score - a.score);
      const best = spans[0]?.score ?? 0;
      const score = Math.round((0.75 * best + 0.25 * cosine(templateVector, p.vector)) * 1e4) / 1e4;
      return { experienceId: p.experienceId, score, spans: spans.slice(0, 3) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
