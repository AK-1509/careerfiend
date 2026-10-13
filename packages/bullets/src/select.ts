import type { BulletDraft, EvidencePacket, GeneratedBullet, RequirementTemplate, ValidationReport } from "./types";
import { decompose } from "./normalize";
import { cosine, embed } from "./semantic";
import { employerTermsIn, jaccard, supportedTerms } from "./validate";

/**
 * Selection: one bullet per important responsibility, never two bullets for
 * the same capability, never two replacements of the same résumé line, and a
 * generated bullet only where it beats the original line on the combination
 * of evidence, requirement fit and supported employer wording. Otherwise the
 * original line stays (it is already factual).
 */

export interface Validated {
  draft: BulletDraft;
  report: ValidationReport;
  packet: EvidencePacket;
  template: RequirementTemplate;
  attempts: number;
}

export interface Selection {
  bullets: GeneratedBullet[];
  keptOriginal: { requirementId: string; experienceId: string; reason: string }[];
}

function strength(alignment: number, matched: number, terms: number, relevance: number): number {
  return 0.45 * alignment + 0.35 * (terms ? matched / terms : 0) + 0.2 * relevance;
}

export function selectBullets(validated: Validated[], maxBullets = 8): Selection {
  const used = new Set<string>();
  const out: GeneratedBullet[] = [];
  const keptOriginal: Selection["keptOriginal"] = [];
  const ordered = [...validated].sort((a, b) => b.template.importance - a.template.importance || b.packet.relevance - a.packet.relevance);
  for (const v of ordered) {
    if (out.length >= maxBullets) break;
    const { packet, template, draft, report } = v;
    if (out.some((b) => b.requirementId === template.requirementId)) continue;
    if (used.has(packet.anchorId)) {
      keptOriginal.push({
        requirementId: template.requirementId,
        experienceId: packet.experienceId,
        reason: "line already tailored for a more important requirement",
      });
      continue;
    }
    const original = packet.spans.find((s) => s.id === packet.anchorId)!.text;
    const terms = supportedTerms(packet);
    const origMatched = employerTermsIn(original, packet, template);
    const origAlign = cosine(embed(decompose(original, { mode: "resume" })), template.vector);
    const gen = strength(report.alignment, report.matchedTerms.length, terms.length, packet.relevance);
    const orig = strength(origAlign, origMatched.length, terms.length, packet.relevance);
    const addsTerms = report.matchedTerms.some((t) => !origMatched.includes(t));
    if (!(gen > orig + 0.03 || addsTerms)) {
      keptOriginal.push({ requirementId: template.requirementId, experienceId: packet.experienceId, reason: "original line is already as strong" });
      continue;
    }
    if (out.some((b) => jaccard(b.text, draft.text) >= 0.6)) {
      keptOriginal.push({ requirementId: template.requirementId, experienceId: packet.experienceId, reason: "same capability as another bullet" });
      continue;
    }
    const cited = new Set(draft.ledger.flatMap((l) => l.sources));
    const absorbed = packet.spans.filter((s) => s.kind === "bullet" && s.id !== packet.anchorId && cited.has(s.id) && !used.has(s.id)).map((s) => s.id);
    used.add(packet.anchorId);
    for (const a of absorbed) used.add(a);
    out.push({
      experienceId: packet.experienceId,
      requirementId: template.requirementId,
      anchorId: packet.anchorId,
      absorbedIds: absorbed,
      text: draft.text.trim(),
      originalText: original,
      template: template.template,
      relevanceScore: packet.relevance,
      groundingStatus: "verified",
      evidenceIds: [...cited].filter((id) => packet.spans.some((s) => s.id === id)),
      matchedTerms: report.matchedTerms,
      ledger: draft.ledger,
      attempts: v.attempts,
    });
  }
  return { bullets: out, keptOriginal };
}
