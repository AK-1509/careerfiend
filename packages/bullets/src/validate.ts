import { mentions } from "@careerfiend/matcher";
import type { BulletDraft, Decomposition, EvidencePacket, ExperienceProfile, Failure, RequirementTemplate, ValidationReport } from "./types";
import { decompose } from "./normalize";
import { cosine, embed } from "./semantic";
import {
  CONCEPT_IMPLIES_ACTION,
  FILLER_PHRASES,
  TITLE_PATTERN,
  actionFamily,
  actionOf,
  conceptFamily,
  conceptsIn,
  contentStems,
  isPastTenseVerb,
  relatedConcepts,
  toolsIn,
} from "./vocabulary";

/**
 * Validation. A generated bullet enters the résumé only if it passes all four:
 *
 *   1. grounding  - every substantive claim (numbers, tools, concepts, actions,
 *                   stakeholders, titles, management, outcomes, credentials) is
 *                   shown by the evidence lines the ledger cites;
 *   2. alignment  - it addresses the requirement it was written for;
 *   3. ATS        - it uses the employer's wording for at least one concept the
 *                   evidence supports (no stuffing: repetition fails quality);
 *   4. quality    - concise, starts with a past-tense action verb, no filler,
 *                   no duplicates, and an improvement over the original line.
 */

export interface StyleContext {
  /** All of the user's résumé lines (their own wording: filler they already use is allowed). */
  corpus: string[];
  /** Average length of the user's bullets in characters. */
  avgChars: number;
  /** Résumé line id -> text (to catch duplicates). */
  existing: Record<string, string>;
}

const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "fifteen",
  "twenty",
  "hundred",
  "thousand",
  "million",
  "billion",
  "dozens",
  "hundreds",
  "thousands",
];

export function numbersIn(text: string): string[] {
  const digits = [...text.matchAll(/\d[\d,.]*\d%?|\d%?/g)].map((m) => m[0].replace(/[.,]$/, ""));
  const words = NUMBER_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
  return [...digits, ...words];
}

const CAPS_IGNORE = new Set(["A", "An", "The", "And", "Or", "For", "With", "To", "Of", "In", "On", "By", "As", "At", "From", "Into", "Across", "Via", "I"]);

/** Tool-like or proper-noun terms: acronyms, mixed case, digits with letters, capitalized words mid-sentence. */
export function namedTerms(text: string): string[] {
  const out: string[] = [];
  text
    .replace(/[“”"()]/g, " ")
    .split(/\s+/)
    .forEach((raw, i) => {
      const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, "");
      if (!w) return;
      const acronym = /^[A-Z][A-Z0-9&/+.-]{1,}s?$/.test(w);
      const symbolic = /[0-9+#]/.test(w) && /[A-Za-z]/.test(w);
      const midCap = i > 0 && /^[A-Z][a-z]/.test(w) && !CAPS_IGNORE.has(w);
      const innerCap = /^[a-z]+[A-Z]/.test(w);
      if (acronym || symbolic || midCap || innerCap) out.push(w);
    });
  return out;
}

const inText = (text: string, term: string) => text.toLowerCase().includes(term.toLowerCase());
const TITLE_TEST = new RegExp(TITLE_PATTERN.source, "i");
const OUTCOME_CLAIM = /\b(increas|improv|reduc|grew|grow|boost|cut|sav|accelerat|decreas|lower|rais|doubl|tripl|exceed)\w*|\bresulting in\b|\bleading to\b/i;
const CREDENTIAL = /\b(certified|certification|certificate|licensed|license|ph\.?d|mba|cpa|pmp|degree|accredited)\b/i;
const FIRST_PERSON = /\b(i|my|me|we|our)\b/i;

export function jaccard(a: string, b: string): number {
  const A = new Set(contentStems(a));
  const B = new Set(contentStems(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

interface EvidenceFacts {
  text: string;
  actions: Set<string>;
  concepts: Set<string>;
  tools: Set<string>;
  stakeholders: Set<string>;
  managerial: boolean;
  outcome: boolean;
}

function factsOf(ids: string[], packet: EvidencePacket, profile: ExperienceProfile): EvidenceFacts {
  const spans = packet.spans.filter((s) => ids.includes(s.id));
  const ds = spans.map((s) => profile.spans[s.id]).filter((d): d is Decomposition => !!d);
  return {
    text: spans.map((s) => s.text).join(" \n "),
    // An activity concept implies its verb family ("ran usability sessions" supports "tested").
    actions: new Set(
      ds.flatMap((d) => [...d.actions.map((a) => a.family), ...d.concepts.map((c) => CONCEPT_IMPLIES_ACTION[c.id]).filter((x): x is string => !!x)]),
    ),
    concepts: new Set(ds.flatMap((d) => d.concepts.map((c) => c.id))),
    tools: new Set(ds.flatMap((d) => d.tools.map((t) => t.toLowerCase()))),
    stakeholders: new Set(ds.flatMap((d) => d.stakeholders.map((s) => s.category))),
    managerial: ds.some((d) => d.managerial),
    // A count ("3 product lines") is scale, not a result; a result is stated or is an improvement verb.
    outcome: ds.some((d) => !!d.outcome || d.actions.some((a) => a.family === "improve")),
  };
}

/** Supported employer terms for ATS, most valuable first (named tools, then specific concepts). */
export function supportedTerms(packet: EvidencePacket): string[] {
  const tools = packet.proven.filter((e) => e.kind === "tool").map((e) => e.jdTerm);
  const concepts = packet.proven.filter((e) => e.kind === "concept").map((e) => e.jdTerm);
  return [...new Set([...tools, ...concepts])].filter(Boolean);
}

/**
 * High-value supported terms: named tools and the specific concepts that form
 * the requirement's core object ("develop KPIs" -> KPIs). At most two, so the
 * check asks for the employer's wording without encouraging stuffing.
 */
export function highValueTerms(packet: EvidencePacket, t: RequirementTemplate): string[] {
  const objectText = t.objects.join(" ").toLowerCase();
  const weak = new Set(t.concepts.filter((c) => c.weak).map((c) => c.term.toLowerCase()));
  const tools = packet.proven.filter((e) => e.kind === "tool").map((e) => e.jdTerm);
  const core = packet.proven
    .filter((e) => e.kind === "concept" && !weak.has(e.jdTerm.toLowerCase()) && objectText.includes(e.jdTerm.toLowerCase()))
    .map((e) => e.jdTerm);
  const first = packet.proven.find((e) => e.kind === "concept" && !weak.has(e.jdTerm.toLowerCase()))?.jdTerm;
  return [...new Set([...tools, ...core, ...(core.length || tools.length || !first ? [] : [first])])].slice(0, 2);
}

/* ------------------------------------------------------------ validators */

export function validateGrounding(draft: BulletDraft, packet: EvidencePacket, profile: ExperienceProfile, bullet: Decomposition): Failure[] {
  const f: Failure[] = [];
  const fail = (code: Failure["code"], detail: string) => f.push({ validator: "grounding", code, detail });
  const valid = new Set(packet.spans.map((s) => s.id));
  const cited = [...new Set(draft.ledger.flatMap((l) => l.sources))].filter((id) => valid.has(id));
  if (!draft.ledger.length || !cited.length) fail("invalid_ledger", "the evidence ledger cites no valid evidence line");
  const bad = draft.ledger.flatMap((l) => l.sources).filter((id) => !valid.has(id));
  if (bad.length) fail("invalid_ledger", `ledger cites lines outside the evidence: ${[...new Set(bad)].join(", ")}`);
  const ev = factsOf(cited.length ? cited : [packet.anchorId], packet, profile);
  const provenConcepts = new Set(
    packet.proven.filter((e) => e.kind === "concept" && e.sources.some((s) => (cited.length ? cited : [packet.anchorId]).includes(s))).map((e) => e.value),
  );
  const provenTerms = packet.proven.map((e) => e.jdTerm).filter(Boolean);
  const text = draft.text;

  for (const n of numbersIn(text)) if (!inText(ev.text, n)) fail("unsupported_number", n);
  for (const tool of toolsIn(text)) if (!ev.tools.has(tool.toLowerCase()) && !inText(ev.text, tool)) fail("unsupported_tool", tool);
  for (const term of namedTerms(text)) {
    if (inText(ev.text, term) || provenTerms.some((p) => inText(p, term) || inText(term, p))) continue;
    if (toolsIn(term).length) continue; // reported above
    if (TITLE_TEST.test(term)) continue; // reported below
    // A wording of a concept family ("KPIs" for success metrics) is judged by the concept check below.
    if (conceptsIn(term).some((c) => ev.concepts.has(c.id) || provenConcepts.has(c.id))) continue;
    if (conceptFamily(bullet.concepts.find((c) => inText(c.term, term))?.id ?? "")) continue;
    fail("unsupported_term", term);
  }
  for (const c of bullet.concepts) {
    if (ev.concepts.has(c.id) || provenConcepts.has(c.id)) continue;
    // A generic word ("process", "data") is fine when its family is next to one the evidence shows.
    if (c.weak && relatedConcepts(c.id).some((r) => ev.concepts.has(r))) continue;
    fail("unsupported_concept", c.term);
  }
  for (const u of packet.unsupported) if (mentions(text, u)) fail("unsupported_term", u);
  for (const s of bullet.stakeholders) if (!ev.stakeholders.has(s.category)) fail("unsupported_stakeholder", s.as);
  for (const m of text.match(TITLE_PATTERN) ?? []) if (!inText(ev.text, m)) fail("specific_title", m);
  const leadVerb = bullet.actions.some((a) => actionFamily(a.family)?.managerial);
  if ((bullet.managerial && !ev.managerial) || (leadVerb && !ev.actions.has("lead")))
    fail("unsupported_management", "claims leading or managing people the evidence does not show");
  for (const a of bullet.actions) {
    if (actionFamily(a.family)?.managerial) continue; // handled above
    if (!ev.actions.has(a.family) && !packet.proven.some((p) => p.kind === "action" && p.value === a.family && p.sources.some((s) => cited.includes(s)))) {
      fail("unsupported_action", a.verb);
    }
  }
  // Verb-object pairing: what the bullet says was done to something must be said in one evidence line
  // ("Defined success metrics" + "Built a script" never makes "Developed KPIs").
  const citedIds = cited.length ? cited : [packet.anchorId];
  for (const clause of bullet.clauses) {
    const fam = actionOf(clause.verb)?.family;
    if (!fam || actionFamily(fam)?.managerial || !clause.objects.length) continue;
    const objFamilies = new Set(conceptsIn(clause.objects.join(" ")).map((c) => c.id));
    const objStems = new Set(clause.objects.flatMap(contentStems));
    const paired = citedIds.some((id) => {
      const d = profile.spans[id];
      if (!d) return false;
      const fams = new Set([...d.actions.map((a) => a.family), ...d.concepts.map((c) => CONCEPT_IMPLIES_ACTION[c.id]).filter(Boolean)]);
      if (!fams.has(fam)) return false;
      return d.concepts.some((c) => objFamilies.has(c.id)) || contentStems(d.core).some((s) => objStems.has(s));
    });
    if (!paired) fail("unsupported_action", `"${clause.verb} ${clause.objects[0]}" is not what any one evidence line says`);
  }
  if (OUTCOME_CLAIM.test(text) && !ev.outcome && !OUTCOME_CLAIM.test(ev.text)) fail("unsupported_outcome", "claims a result the evidence does not state");
  if (CREDENTIAL.test(text) && !CREDENTIAL.test(ev.text)) fail("unsupported_credential", text.match(CREDENTIAL)![0]);
  return f;
}

export function validateAlignment(t: RequirementTemplate, bullet: Decomposition): { failures: Failure[]; alignment: number } {
  const v = embed(bullet);
  const alignment = cosine(v, t.vector);
  const tActions = new Set(t.actions.map((a) => a.family));
  const actionOverlap = bullet.actions.some((a) => tActions.has(a.family) || (actionFamily(a.family)?.related ?? []).some((r) => tActions.has(r)));
  const tConcepts = new Set(t.concepts.map((c) => c.id));
  const conceptOverlap = bullet.concepts.some((c) => tConcepts.has(c.id) || (!c.weak && relatedConcepts(c.id).some((r) => tConcepts.has(r))));
  const toolOverlap = bullet.tools.some((x) => t.tools.some((y) => y.toLowerCase() === x.toLowerCase()));
  const core = conceptOverlap || toolOverlap || (actionOverlap && t.concepts.length === 0 && t.tools.length === 0);
  const failures: Failure[] = [];
  if (!core || alignment < 0.18) {
    failures.push({ validator: "alignment", code: "jd_mismatch", detail: `does not address: ${t.template}` });
  }
  return { failures, alignment };
}

/** The listing's own wordings for a supported term ("KPIs" and "success metrics" are one requirement). */
export function employerWordings(term: string, packet: EvidencePacket, t: RequirementTemplate): string[] {
  const el = packet.proven.find((e) => e.jdTerm === term);
  const family = el?.kind === "concept" ? conceptFamily(el.value) : undefined;
  return [...new Set([term, ...(family?.terms ?? []).filter((w) => w.length > 1 && mentions(t.sourceText, w))])];
}

/** Every employer wording of a supported term that appears in a text. */
export function employerTermsIn(text: string, packet: EvidencePacket, t: RequirementTemplate): string[] {
  return [...new Set(supportedTerms(packet).flatMap((x) => employerWordings(x, packet, t).filter((w) => mentions(text, w))))];
}

export function validateAts(draft: BulletDraft, packet: EvidencePacket, t: RequirementTemplate): { failures: Failure[]; matched: string[]; missing: string[] } {
  const terms = supportedTerms(packet);
  const used = (x: string) => employerWordings(x, packet, t).find((w) => mentions(draft.text, w));
  const matched = employerTermsIn(draft.text, packet, t);
  const missing = terms.filter((x) => !used(x));
  const required = highValueTerms(packet, t).filter((x) => !used(x));
  const failures: Failure[] = [];
  if (required.length) {
    failures.push({ validator: "ats", code: "missing_terminology", detail: `use the employer's wording where it fits the evidence: ${required.join(", ")}` });
  }
  return { failures, matched, missing: [...new Set([...required, ...missing])] };
}

export function validateQuality(
  draft: BulletDraft,
  packet: EvidencePacket,
  style: StyleContext,
  accepted: string[],
  matched: string[],
  t?: RequirementTemplate,
): Failure[] {
  const f: Failure[] = [];
  const fail = (code: Failure["code"], detail: string) => f.push({ validator: "quality", code, detail });
  const text = draft.text.trim();
  const wordsN = text.split(/\s+/).length;
  const maxChars = Math.min(260, Math.max(140, Math.round(style.avgChars * 1.6)));
  if (wordsN < 6) fail("too_short", `${wordsN} words`);
  if (wordsN > 34 || text.length > maxChars) fail("too_long", `${text.length} characters (limit ${maxChars})`);
  const first = text.split(/\s+/)[0]?.replace(/[^A-Za-z-]/g, "") ?? "";
  if (!isPastTenseVerb(first)) fail("no_action_verb", `starts with "${first}"`);
  const own = style.corpus.join(" \n ").toLowerCase();
  for (const phrase of FILLER_PHRASES) if (mentions(text, phrase) && !own.includes(phrase)) fail("filler", phrase);
  if (/[—–]/.test(text) || FIRST_PERSON.test(text) || /\.\s+[A-Z]/.test(text) || /[!?]/.test(text))
    fail("formatting", "one plain sentence, no first person, no dashes");
  const counts = new Map<string, number>();
  for (const s of contentStems(text)) counts.set(s, (counts.get(s) ?? 0) + 1);
  const repeated = [...counts.entries()].filter(([s, n]) => n >= 3 && s.length > 2).map(([s]) => s);
  const termRepeats = matched.filter(
    (m) => (text.toLowerCase().match(new RegExp(`\\b${m.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b`, "g")) ?? []).length > 1,
  );
  if (repeated.length || termRepeats.length) fail("keyword_repetition", [...repeated, ...termRepeats].join(", "));
  for (const a of accepted) if (jaccard(text, a) >= 0.7) fail("duplicate", "repeats another generated bullet");
  const own_ids = new Set(packet.spans.map((s) => s.id));
  for (const [id, line] of Object.entries(style.existing)) {
    if (own_ids.has(id)) continue;
    if (jaccard(text, line) >= 0.8) fail("duplicate", `repeats ${id}`);
  }
  const original = packet.spans.find((s) => s.id === packet.anchorId)?.text ?? "";
  const originalTerms = t ? employerTermsIn(original, packet, t) : matched.filter((m) => mentions(original, m));
  if (original && jaccard(text, original) >= 0.9 && !matched.some((m) => !originalTerms.includes(m))) fail("no_improvement", "same as the original line");
  return f;
}

/** Run all four validators. */
export function validateDraft(
  draft: BulletDraft,
  ctx: { template: RequirementTemplate; packet: EvidencePacket; profile: ExperienceProfile; style: StyleContext; accepted: string[] },
): ValidationReport {
  const bullet = decompose(draft.text, { mode: "resume" });
  const grounding = validateGrounding(draft, ctx.packet, ctx.profile, bullet);
  const { failures: alignmentFailures, alignment } = validateAlignment(ctx.template, bullet);
  const ats = validateAts(draft, ctx.packet, ctx.template);
  const quality = validateQuality(draft, ctx.packet, ctx.style, ctx.accepted, ats.matched, ctx.template);
  const failures = [...grounding, ...alignmentFailures, ...ats.failures, ...quality];
  return { pass: failures.length === 0, failures, matchedTerms: ats.matched, missingTerms: ats.missing, alignment };
}

/** Plain-language repair instructions for the next generation attempt. */
export function repairFeedback(report: ValidationReport, packet: EvidencePacket, template: RequirementTemplate): string[] {
  const out = new Set<string>();
  const removed = report.failures.filter((x) => x.validator === "grounding").map((x) => x.detail);
  if (removed.length) out.add(`Remove claims the evidence does not show: ${[...new Set(removed)].slice(0, 6).join("; ")}. Use only the evidence lines.`);
  if (report.failures.some((x) => x.code === "invalid_ledger"))
    out.add(`Cite evidence ids exactly as given (${packet.spans.map((s) => s.id).join(", ")}) in the ledger.`);
  if (report.failures.some((x) => x.code === "jd_mismatch"))
    out.add(`Frame the bullet around the requirement: "${template.template}", using only what the evidence shows.`);
  if (report.failures.some((x) => x.code === "missing_terminology"))
    out.add(`Use the employer's term "${report.missingTerms[0]}" where it describes what the evidence shows.`);
  for (const x of report.failures.filter((y) => y.validator === "quality")) {
    if (x.code === "too_long") out.add("Shorten to one line of about 20 words.");
    if (x.code === "too_short") out.add("Add the concrete object or result from the evidence.");
    if (x.code === "no_action_verb") out.add("Start with a past-tense action verb the evidence supports.");
    if (x.code === "filler") out.add(`Remove the filler word "${x.detail}".`);
    if (x.code === "keyword_repetition") out.add(`Do not repeat: ${x.detail}.`);
    if (x.code === "duplicate") out.add("Say something different from the other bullets.");
    if (x.code === "no_improvement") out.add("Either align the wording with the requirement or keep the original; do not return it unchanged.");
    if (x.code === "formatting") out.add("One plain sentence, no first person, no dashes.");
  }
  return [...out];
}
