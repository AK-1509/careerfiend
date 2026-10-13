import { mentions } from "@careerfiend/matcher";
import type { Candidate, Decomposition, EvidencePacket, EvidenceSpan, ExperienceProfile, ProvenElement, RequirementTemplate, RerankVerdict } from "./types";
import { conceptsIn, contentStems, relatedConcepts, stakeholderCategory } from "./vocabulary";

/**
 * Evidence extraction: separates what is relevant from what is proven.
 *
 *   relevant - the experience is related to what the employer wants (scores);
 *   proven   - this specific element can be stated about the person, because a
 *              cited résumé line shows it (same concept family, same tool,
 *              same stakeholder category, same action family).
 *
 * Tools, stakeholders, people management and outcomes are proven only by the
 * lines themselves. The reranking model may additionally vouch for a general
 * concept the deterministic match missed, and only on lines it cites; it can
 * never vouch for a tool, a stakeholder, a credential or a metric.
 *
 * "Develop pricing models using SQL" against "Analyzed product pricing and
 * revenue trends": pricing is proven, SQL is not, so SQL goes on the
 * unsupported list and may not appear in the bullet.
 */

export const MIN_RELEVANCE = 0.3;

function spanText(spans: EvidenceSpan[]): string {
  return spans.map((s) => s.text).join(" \n ");
}

function union(spans: EvidenceSpan[], p: ExperienceProfile) {
  const ds = spans.map((s) => p.spans[s.id]).filter((d): d is Decomposition => !!d);
  return {
    actions: new Map(ds.flatMap((d, i) => d.actions.map((a) => [a.family, spans[i]!.id] as const))),
    concepts: new Map(ds.flatMap((d, i) => d.concepts.map((c) => [c.id, spans[i]!.id] as const))),
    tools: new Map(ds.flatMap((d, i) => d.tools.map((t) => [t.toLowerCase(), spans[i]!.id] as const))),
    stakeholders: new Map(ds.flatMap((d, i) => d.stakeholders.map((s) => [s.category, spans[i]!.id] as const))),
    managerial: ds.some((d) => d.managerial),
    outcome: ds.some((d) => !!d.outcome || d.metrics.length > 0),
  };
}

/** Pick the lines to build from: the strongest bullet as anchor, optionally one more bullet that proves something new, plus summary/skills lines. */
function chooseSpans(t: RequirementTemplate, p: ExperienceProfile, c: Candidate, verdict?: RerankVerdict): EvidenceSpan[] {
  const cited = verdict?.evidenceIds.length ? new Set(verdict.evidenceIds) : null;
  const allowed = p.evidence.filter((e) => !cited || cited.has(e.id) || e.kind === "skills");
  const ranked = c.spanIds.map((id) => allowed.find((e) => e.id === id)).filter((e): e is EvidenceSpan => !!e);
  // Cited lines the candidate did not rank still count.
  for (const e of allowed) if (cited?.has(e.id) && !ranked.includes(e)) ranked.push(e);
  const bullets = ranked.filter((e) => e.kind === "bullet");
  if (!bullets.length) return [];
  const anchor = bullets[0]!;
  const spans = [anchor];
  const anchorDec = p.spans[anchor.id]!;
  const anchorFamilies = new Set([...anchorDec.concepts.map((x) => x.id), ...anchorDec.tools.map((x) => x.toLowerCase())]);
  const wanted = new Set([...t.concepts.map((x) => x.id), ...t.tools.map((x) => x.toLowerCase())]);
  const wantedActions = new Set(t.actions.map((a) => a.family));
  const anchorActions = new Set(anchorDec.actions.map((a) => a.family));
  // A second line of the same entry joins when it proves another part of the requirement (a concept, tool or action).
  const extra = bullets.slice(1).find((b) => {
    const d = p.spans[b.id]!;
    const families = [...d.concepts.map((x) => x.id), ...d.tools.map((x) => x.toLowerCase())];
    const addsConcept = families.some((f) => wanted.has(f) && !anchorFamilies.has(f));
    // A shared verb alone is not enough: the line must also be about the requirement's subject.
    const onTopic =
      d.concepts.some((x) => wanted.has(x.id) || relatedConcepts(x.id).some((r) => wanted.has(r))) ||
      t.objects.flatMap(contentStems).some((s) => contentStems(d.core).includes(s));
    const addsAction = onTopic && d.actions.some((a) => wantedActions.has(a.family) && !anchorActions.has(a.family));
    return addsConcept || addsAction;
  });
  if (extra) spans.push(extra);
  // Summary/skills lines of the same experience can prove a tool or concept (never become the bullet).
  for (const e of p.evidence) {
    if (e.kind === "bullet" || spans.includes(e)) continue;
    const d = p.spans[e.id]!;
    if ([...d.concepts.map((x) => x.id), ...d.tools.map((x) => x.toLowerCase())].some((f) => wanted.has(f))) spans.push(e);
  }
  return spans;
}

export function buildPacket(t: RequirementTemplate, p: ExperienceProfile, c: Candidate, verdict?: RerankVerdict): EvidencePacket | null {
  if (verdict && verdict.supportLevel === "none") return null;
  const spans = chooseSpans(t, p, c, verdict);
  if (!spans.length) return null;
  const u = union(spans, p);
  const text = spanText(spans);
  const proven: ProvenElement[] = [];
  const unsupported = new Set<string>();

  for (const a of t.actions) {
    const src = u.actions.get(a.family);
    if (src) proven.push({ kind: "action", value: a.family, jdTerm: a.verb, match: mentions(text, a.verb) ? "exact" : "equivalent", sources: [src] });
  }
  for (const k of t.concepts) {
    const src = u.concepts.get(k.id);
    if (src) {
      proven.push({ kind: "concept", value: k.id, jdTerm: k.term, match: mentions(text, k.term) ? "exact" : "equivalent", sources: [src] });
      continue;
    }
    // The model may vouch for a general concept on a line it cites (never for tools, people or metrics).
    const vouched = verdict?.supportedSkills.some((s) => conceptsIn(s).some((x) => x.id === k.id));
    const citedBullet = spans.find((s) => s.kind === "bullet" && verdict?.evidenceIds.includes(s.id));
    if (vouched && citedBullet && !k.weak && k.domain !== "technical") {
      proven.push({ kind: "concept", value: k.id, jdTerm: k.term, match: "equivalent", sources: [citedBullet.id] });
    } else unsupported.add(k.term);
  }
  for (const tool of t.tools) {
    const src = u.tools.get(tool.toLowerCase()) ?? (mentions(text, tool) ? spans[0]!.id : undefined);
    if (src) proven.push({ kind: "tool", value: tool, jdTerm: tool, match: "exact", sources: [src] });
    else unsupported.add(tool);
  }
  const phrases: string[] = [];
  for (const s of t.stakeholders) {
    const cat = stakeholderCategory(s.category);
    const src = u.stakeholders.get(s.category);
    if (src && cat) {
      proven.push({ kind: "stakeholder", value: s.category, jdTerm: cat.phrase, match: "equivalent", sources: [src] });
      phrases.push(cat.phrase);
    } else {
      unsupported.add(s.as);
      if (cat) unsupported.add(cat.phrase);
    }
  }
  // People the evidence itself mentions may be named broadly even if the listing did not ask.
  for (const [cat] of u.stakeholders) {
    const phrase = stakeholderCategory(cat)?.phrase;
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  if (t.managerial && !u.managerial) for (const m of ["managed a team", "team management", "led a team", "supervised", "direct reports"]) unsupported.add(m);
  if (t.outcome) {
    if (u.outcome) proven.push({ kind: "outcome", value: "outcome", jdTerm: "", match: "equivalent", sources: [spans[0]!.id] });
  }
  // The model may add items it judges unsupported, but cannot veto what the lines deterministically prove.
  const provenWording = new Set(proven.map((e) => e.jdTerm.toLowerCase()));
  const provenFamilies = new Set(proven.map((e) => e.value));
  for (const x of verdict?.unsupported ?? []) {
    const term = x.trim();
    if (!term || !t.sourceText.toLowerCase().includes(term.toLowerCase()) || provenWording.has(term.toLowerCase())) continue;
    if (conceptsIn(term).some((c) => provenFamilies.has(c.id))) continue;
    unsupported.add(term);
  }
  // Never list as unsupported something the evidence does say.
  for (const x of [...unsupported]) if (mentions(text, x)) unsupported.delete(x);

  const coreProof = proven.filter((e) => e.kind === "concept" || e.kind === "tool");
  // An action proves the requirement when it acts on the same objects, or, for "coordinate with X", on the same people.
  const actionProof = proven.some((e) => e.kind === "action") && (c.dims.object >= 0.3 || (!t.objects.length && proven.some((e) => e.kind === "stakeholder")));
  if (!coreProof.length && !actionProof) return null; // relevant, maybe, but nothing provable: no bullet
  const relevance = Math.round((verdict ? 0.5 * c.score + 0.5 * verdict.matchScore : c.score) * 1000) / 1000;
  if (relevance < MIN_RELEVANCE) return null;
  const strong = coreProof.length >= 2 || (coreProof.length >= 1 && proven.some((e) => e.kind === "action"));
  return {
    requirementId: t.requirementId,
    experienceId: p.experienceId,
    anchorId: spans[0]!.id,
    spans,
    proven,
    unsupported: [...unsupported],
    stakeholderPhrases: phrases,
    relevance,
    supportLevel: strong && relevance >= 0.55 ? "strong" : coreProof.length || actionProof ? "partial" : "weak",
    transformation: verdict?.transformation ?? "",
  };
}
