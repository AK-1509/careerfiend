import { collapseWhitespace, type NormalizedJob, type Requirement } from "@careerfiend/shared";
import type { ActionRef, ConceptRef, Decomposition, Discarded, RequirementTemplate, StakeholderRef } from "./types";
import {
  verbForms,
  LOW_VALUE_PHRASES,
  LOW_VALUE_WORDS,
  SENIORITY,
  STOP,
  actionFamily,
  actionOf,
  conceptsIn,
  contentStems,
  stakeholderCategory,
  stakeholdersIn,
  toolsIn,
} from "./vocabulary";
import { embed } from "./semantic";

/**
 * Requirement normalization: turns one job-description sentence into a
 * canonical template (action, objects, skills/methods, stakeholders, outcome,
 * context, constraints) and records what was discarded and why. The same
 * decomposition, without the job-description cleanup, is applied to résumé
 * lines so both sides are compared in the same terms.
 *
 * Deterministic first; a fast model call is made only for templates whose
 * rule-based parse is low-confidence (see mergeModelDecomposition), and its
 * output is accepted only where it is literally grounded in the source text.
 */

export const LOW_CONFIDENCE = 0.6;

const FRAME_DUTY =
  /^(?:you will|you'll|you are expected to|we are looking for (?:someone|a person|an individual) (?:who can|to)|the ideal candidate will|responsible for|ability to|able to|must be able to|will be expected to|help (?:us )?|be able to|expected to|duties include|responsibilities include)\s+/i;
const FRAME_SKILL =
  /^(?:(?:\d+\+?\s*(?:-\s*\d+\s*)?(?:years?|yrs?)\s*(?:of\s+)?(?:professional\s+|relevant\s+|industry\s+)?)?(?:hands-on\s+|working\s+|strong\s+|solid\s+|deep\s+|proven\s+|demonstrated\s+|excellent\s+|some\s+|prior\s+|basic\s+|advanced\s+)?(?:experience|proficiency|expertise|familiarity|knowledge|skills?|background|fluency|competency|comfort|understanding|exposure)\s+(?:with|in|of|using|across|working with|on)\s+|(?:proficient|skilled|experienced|fluent|comfortable|familiar)\s+(?:with|in|using)\s+|(?:knowledge|understanding|command)\s+of\s+)/i;
const YEARS = /\b\d+\+?\s*(?:-\s*\d+\s*)?(?:years?|yrs?)\b(?:\s+of\s+(?:professional\s+|relevant\s+)?experience)?/gi;
const DETERMINERS = /^(?:a|an|the|our|their|its|his|her|your|my|this|that|these|those|all|any|each|new|existing)\s+/i;
const BOUNDARY_WORDS = new Set([
  "using",
  "with",
  "via",
  "through",
  "leveraging",
  "to",
  "by",
  "for",
  "across",
  "including",
  "such",
  "into",
  "from",
  "on",
  "in",
  "within",
  "among",
  "alongside",
  "based",
  "informed",
  "while",
  "under",
  "at",
  "per",
  "which",
  "that",
  "who",
  "resulting",
  "leading",
  "producing",
]);
const OUTCOME_RE =
  /(?:\bto\s+(?:improve|increase|reduce|drive|ensure|enable|support|grow|accelerate|inform|deliver|achieve|boost|lower|cut|guide|shape)\b[^,.;]*|,\s*(?:improving|increasing|reducing|resulting in|leading to|cutting|saving|boosting|achieving|producing|enabling|informing)\b[^,.;]*|\bresulting in\b[^,.;]*|\bleading to\b[^,.;]*)/i;
const CONTEXT_RE =
  /\b(?:for|within|in)\s+((?:a|an|the)?\s*[a-z][a-z\s-]{2,40}?(?:market|industry|space|sector|setting|environment|domain|context|organization|startup|company|lab|program|team))\b/i;
const MANAGERIAL_RE =
  /\b(?:manag(?:e|ed|es|ing)\s+(?:a\s+|the\s+|an?\s+)?(?:\w+\s+)?(?:team|staff|group|people|direct reports|interns|volunteers|analysts|engineers|designers)|(?:led|lead|leads|leading)\s+(?:a\s+|the\s+)?(?:\w+\s+)?(?:team|group|staff)\b|supervis(?:e|ed|es|ing)|direct reports|people management|team management|hir(?:e|ed|es|ing)\s+(?:and\s+\w+\s+)?(?:\w+\s+)?(?:staff|team|engineers|analysts|interns)|mentor(?:ed|ing|s)?\s+(?:a\s+)?(?:team|junior|interns|analysts|engineers|designers)|team of \d+|\bmanaging\s+(?:a\s+)?team)\b/i;
const METRIC_RE =
  /(\$\s?\d[\d,.]*\s?(?:k|m|b|million|billion)?|\d[\d,.]*\s?%|\d[\d,.]*\+?|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|dozens|hundreds|thousands)\b)(\s+(?!(?:and|or|to|of|under|on|for|with|in|across|by|from|at|into|per|via)\b)[A-Za-z][A-Za-z-]*){0,3}/g;

export interface DecomposeContext {
  mode: "requirement" | "resume";
  /** Employer name and other employer-specific names to drop (requirement mode). */
  company?: string;
  /** Location words to drop (requirement mode). */
  locations?: string[];
}

function words(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z0-9+#/&'-]*(?:\.[A-Za-z0-9]+)*|\d[\d,.%+]*|[,;:.()]/g) ?? []).map((w) => w.replace(/[.,]+$/, "") || w);
}

function clean(text: string): string {
  return collapseWhitespace(text)
    .replace(/^[-•*·▪◦‣\s]+/, "")
    .replace(/\s+([,;:.])/g, "$1")
    .trim();
}

function escapeRe(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Protected spans: concept and tool wordings are never treated as low-value words ("key performance indicators"). */
function protectedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const terms = [...conceptsIn(text).map((c) => c.term), ...toolsIn(text)];
  for (const t of terms) {
    const re = new RegExp(`(^|[^A-Za-z0-9])(${escapeRe(t)})(?=$|[^A-Za-z0-9+#])`, "gi");
    for (const m of text.matchAll(re)) {
      const start = (m.index ?? 0) + m[1]!.length;
      ranges.push([start, start + m[2]!.length]);
    }
  }
  return ranges;
}

function removeLowValue(text: string, discarded: Discarded[]): string {
  let out = text;
  for (const phrase of [...LOW_VALUE_PHRASES].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(phrase)}(?=$|[^A-Za-z0-9])`, "gi");
    if (re.test(out)) {
      discarded.push({ text: phrase, reason: "low_value" });
      out = out.replace(re, "$1 ");
    }
  }
  out = out.replace(SENIORITY, (m) => {
    discarded.push({ text: m.trim(), reason: "seniority" });
    return "";
  });
  const keep = protectedRanges(out);
  out = out.replace(/\b[A-Za-z-]+\b/g, (w, offset: number) => {
    if (!LOW_VALUE_WORDS.has(w.toLowerCase())) return w;
    if (keep.some(([s, e]) => offset >= s && offset < e)) return w;
    discarded.push({ text: w, reason: "low_value" });
    return "";
  });
  return clean(out.replace(/\s{2,}/g, " ").replace(/\(\s*\)/g, ""));
}

function removeEmployerSpecific(text: string, dctx: DecomposeContext, discarded: Discarded[]): string {
  let out = text;
  const names = [dctx.company, ...(dctx.company ? [`${dctx.company}'s`] : [])].filter((n): n is string => !!n && n.length > 1);
  for (const n of names.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(n)}(?=$|[^A-Za-z0-9])`, "gi");
    if (re.test(out)) {
      discarded.push({ text: n, reason: "company" });
      out = out.replace(re, "$1 ");
    }
  }
  for (const loc of (dctx.locations ?? []).filter((l) => l.length > 2)) {
    const re = new RegExp(`\\b(?:in|at|from|across|based in)?\\s*${escapeRe(loc)}\\b`, "gi");
    if (re.test(out)) {
      discarded.push({ text: loc, reason: "location" });
      out = out.replace(re, " ");
    }
  }
  // Employer-internal names: "Project Phoenix", "the Atlas platform" (capitalized names that are not known vocabulary).
  out = out.replace(/\b(?:Project|Program|Initiative|Team)\s+[A-Z][a-zA-Z]+\b/g, (m) => {
    discarded.push({ text: m, reason: "company" });
    return "the project";
  });
  out = out.replace(/\b(?:our|their)\s+(?=[a-z])/gi, (m) => {
    discarded.push({ text: m.trim(), reason: "company" });
    return "";
  });
  return clean(out);
}

/** Concept and tool wordings are masked while people are detected ("user interviews" is research, not a stakeholder). */
function maskVocabulary(text: string): { masked: string; restore: (s: string) => string } {
  // Only wordings that contain a people word need protecting; "UX team" and "data scientists" stay people.
  const PEOPLE = /\b(users?|customers?|clients?|patients?|partners?|partnerships?|investors?|stakeholders?|participants?|leadership|executives?|founders?)\b/i;
  const terms = [...new Set(conceptsIn(text).map((c) => c.term))].filter((t) => PEOPLE.test(t)).sort((a, b) => b.length - a.length);
  const saved: string[] = [];
  let masked = text;
  for (const t of terms) {
    masked = masked.replace(new RegExp(`(^|[^A-Za-z0-9])(${escapeRe(t)})(?=$|[^A-Za-z0-9+#])`, "gi"), (_m, pre: string, term: string) => {
      saved.push(term);
      return `${pre}\u27e6${saved.length - 1}\u27e7`;
    });
  }
  return { masked, restore: (s) => s.replace(/\u27e6(\d+)\u27e7/g, (_m, i: string) => saved[Number(i)] ?? "") };
}

function removeStakeholderPhrases(text: string, phrases: string[]): string {
  let out = text;
  for (const p of [...phrases].sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRe(p)}(?=$|[^A-Za-z0-9])`, "gi"), "$1");
  // Dangling "with and", "with ,".
  return clean(out.replace(/\b(with|alongside|across|and|to)\s+(?=(and|,|\.|$))/gi, " ").replace(/\s{2,}/g, " "));
}

function formOf(word: string, base: string): "past" | "gerund" | "third" | "base" {
  const w = word.toLowerCase();
  const f = verbForms(base);
  if (w === f.past && w !== f.base) return "past";
  if (w === f.gerund) return "gerund";
  if (w === f.third && w !== f.base) return "third";
  return "base";
}

/** Action verbs in verb position, in order. Coordinated verbs must share the tense of the verb before them ("Developed dashboards and reports": "reports" is a noun). */
function findActions(text: string): { actions: ActionRef[]; positions: number[]; tokens: string[] } {
  const tokens = words(text);
  const actions: ActionRef[] = [];
  const positions: number[] = [];
  let lastVerbAt = -10;
  let lastForm: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i]!;
    const a = actionOf(w);
    if (!a) continue;
    const prev = (tokens[i - 1] ?? "").toLowerCase();
    const prev2 = (tokens[i - 2] ?? "").toLowerCase();
    const atStart = i === 0 || [",", ";", ":", "("].includes(prev);
    const afterTo = prev === "to";
    const startedWithVerb = i >= 2 && (i - 2 === 0 || [",", ";", ":"].includes(tokens[i - 3] ?? "")) && /ed$/i.test(prev2);
    const coordinated = (prev === "and" || prev === "or" || prev === "/" || prev === ",") && (i - lastVerbAt <= 8 || startedWithVerb);
    const determined = /^(a|an|the|our|their|its|this|that|of|for|in|on|with)$/.test(prev) || (/^(of|for|in)$/.test(prev2) && /^[a-z]+$/.test(prev));
    const gerund = /ing$/i.test(w);
    const verbPosition = atStart || afterTo || coordinated || ((prev === "by" || prev === "while") && gerund);
    if (determined) continue;
    // Outside verb position a verb-like word is a noun or modifier ("software prototypes", "user research").
    if (!verbPosition) continue;
    const form = formOf(w, a.base);
    if (coordinated && !atStart && !afterTo) {
      const prior: string | null = lastForm ?? (startedWithVerb ? "past" : null);
      if (prior && prior !== form) continue;
    }
    lastForm = form;
    actions.push({ verb: a.base, family: a.family });
    positions.push(i);
    lastVerbAt = i;
  }
  return { actions, positions, tokens };
}

/** Object noun phrases after each verb, until a boundary word, the next verb or punctuation (one list per verb). */
function findObjects(tokens: string[], positions: number[]): string[][] {
  const perVerb: string[][] = [];
  positions.forEach((p, n) => {
    const objects: string[] = [];
    perVerb.push(objects);
    const end = positions[n + 1] ?? tokens.length;
    const phrase: string[] = [];
    for (let i = p + 1; i < end; i++) {
      const t = tokens[i]!;
      const low = t.toLowerCase();
      if ([",", ";", ":", ".", "("].includes(t)) break;
      if (BOUNDARY_WORDS.has(low) && phrase.length) break;
      if (low === "and" && actionOf(tokens[i + 1] ?? "") && i + 1 === positions[n + 1]) break;
      phrase.push(t);
    }
    let text = phrase.join(" ").replace(DETERMINERS, "").trim();
    text = text.replace(/^(?:and|or)\s+/i, "").replace(/\s+(?:and|or)$/i, "");
    if (!text) return;
    for (const part of text.split(/\s*,\s*|\s+and\s+(?=[a-z])/i)) {
      const o = part.replace(DETERMINERS, "").trim();
      const content = contentStems(o);
      if (content.length && o.split(/\s+/).length <= 7 && !objects.includes(o)) objects.push(o);
    }
  });
  return perVerb;
}

function findMetrics(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(METRIC_RE)) {
    const s = m[0].trim();
    if (/^\d{4}$/.test(s)) continue; // years
    if (/^\d+\+?\s*(?:years?|yrs?)/i.test(s)) continue;
    out.push(s.replace(/[.,]$/, ""));
  }
  return out;
}

/** Decompose one sentence. Requirement mode also removes framing, culture and employer language. */
export function decompose(source: string, dctx: DecomposeContext): Decomposition {
  const discarded: Discarded[] = [];
  let text = clean(source);
  let frame: Decomposition["frame"] = "duty";
  const constraints: string[] = [];

  if (dctx.mode === "requirement") {
    for (const m of text.matchAll(YEARS)) constraints.push(m[0]);
    text = removeEmployerSpecific(text, dctx, discarded);
    const duty = FRAME_DUTY.exec(text);
    if (duty) {
      discarded.push({ text: duty[0].trim(), reason: "framing" });
      text = text.slice(duty[0].length);
    }
    const skill = FRAME_SKILL.exec(text);
    if (skill) {
      discarded.push({ text: skill[0].trim(), reason: "framing" });
      text = text.slice(skill[0].length);
      frame = "skill";
    }
    text = text.replace(YEARS, (m) => {
      discarded.push({ text: m, reason: "constraint" });
      return "";
    });
    text = removeLowValue(text, discarded);
  }

  // "product/UX team" -> "product team and UX team"
  text = text.replace(/\b([A-Za-z]+)\/([A-Za-z]+)\s+(teams?)\b/g, "$1 $3 and $2 $3");
  const { masked, restore } = maskVocabulary(text);
  // People someone manages are reports, not stakeholders ("manage a team of analysts").
  const stakeholderHits = stakeholdersIn(masked).filter(
    (h) =>
      !new RegExp(
        `(?:team of\\s*\\d*\\s*|manag\\w*\\s+(?:a\\s+|the\\s+)?(?:team of\\s*\\d*\\s*)?|supervis\\w*\\s+(?:a\\s+|the\\s+)?|mentor\\w*\\s+)${escapeRe(h.as)}`,
        "i",
      ).test(masked),
  );
  const stakeholders: StakeholderRef[] = stakeholderHits.map((h) => ({ category: h.category, as: h.as }));
  if (dctx.mode === "requirement") {
    for (const h of stakeholderHits) {
      const cat = stakeholderCategory(h.category);
      if (cat && h.as.toLowerCase() !== cat.phrase) discarded.push({ text: h.as, reason: "title" });
    }
  }
  const withoutPeople = restore(
    removeStakeholderPhrases(
      masked,
      stakeholderHits.flatMap((h) => h.all),
    ),
  );

  const found = findActions(withoutPeople);
  const { tokens } = found;
  let { actions, positions } = found;
  // "Work with X to develop Y": the collaboration frame is not the responsibility; the purpose verbs are.
  if (actions.length > 1 && actions[0]!.family === "collaborate") {
    const between = tokens.slice(positions[0]! + 1, positions[1]!).map((t) => t.toLowerCase());
    if (between.includes("to") || between.length <= 4) {
      discarded.push({ text: tokens[positions[0]!]!, reason: "framing" });
      actions = actions.slice(1);
      positions = positions.slice(1);
    }
  }
  const perVerb = findObjects(tokens, positions.length ? positions : frame === "skill" ? [-1] : []);
  const clauses = positions.map((pos, n) => ({
    verb: actions[n]!.verb,
    objects: perVerb[n] ?? [],
    joiner: n === 0 ? null : (tokens[pos - 1] ?? "").toLowerCase() === "to" ? ("to" as const) : ("and" as const),
  }));
  const objects = [...new Set(perVerb.flat())];

  const concepts: ConceptRef[] = conceptsIn(withoutPeople).map((c) => ({ id: c.id, label: c.label, domain: c.domain, term: c.term, weak: c.weak }));
  const tools = toolsIn(withoutPeople);
  // "to deliver X" is a clause of its own when "deliver" is one of the actions, not an outcome.
  const outcomeRaw = OUTCOME_RE.exec(withoutPeople)?.[0]?.replace(/^,\s*/, "").trim() ?? null;
  const outcomeVerb = outcomeRaw?.match(/^to\s+(\w+)/i)?.[1];
  const outcome = outcomeRaw && outcomeVerb && actions.some((a) => a.verb === actionOf(outcomeVerb)?.base) ? null : outcomeRaw;
  const context = CONTEXT_RE.exec(withoutPeople)?.[1]?.trim() ?? null;
  const metrics = findMetrics(source);
  const managerial =
    MANAGERIAL_RE.test(source) &&
    !(
      dctx.mode === "requirement" && /\b(?:project|program|product|process|timeline|vendor|budget|stakeholder)s?\b/i.test(MANAGERIAL_RE.exec(source)?.[0] ?? "")
    );

  return {
    actions: dedupeActions(actions),
    clauses,
    objects,
    concepts,
    tools,
    stakeholders,
    outcome,
    context,
    metrics,
    managerial,
    frame,
    discarded:
      dctx.mode === "requirement" ? [...discarded, ...constraints.map((c) => ({ text: c, reason: "constraint" as const }))].filter(uniqueDiscard()) : [],
    core: withoutPeople,
  };
}

function dedupeActions(actions: ActionRef[]): ActionRef[] {
  const seen = new Set<string>();
  return actions.filter((a) => (seen.has(a.verb) ? false : (seen.add(a.verb), true)));
}

function uniqueDiscard() {
  const seen = new Set<string>();
  return (d: Discarded) => {
    const k = `${d.reason}:${d.text.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
}

/* ------------------------------------------------------------- templates */

const CATEGORY_WEIGHT: Record<string, number> = { required: 3, preferred: 2, responsibility: 1.5, unknown: 1 };
const TEMPLATE_KINDS = new Set(["skill", "experience-years", "other"]);
const TEMPLATE_CATEGORIES = new Set(["required", "preferred", "responsibility"]);

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Canonical wording of a decomposition, e.g. "Develop product goals and KPIs using competitive intelligence with leadership". */
export function templateText(d: Decomposition): string {
  const verbs = d.actions.slice(0, 3).map((a) => a.verb);
  const objectText = list(d.objects.slice(0, 3));
  const clauseText = d.clauses
    .slice(0, 3)
    .map((c, i) => `${i === 0 ? cap(c.verb) : `${c.joiner ?? "and"} ${c.verb}`}${c.objects.length ? ` ${list(c.objects.slice(0, 3))}` : ""}`)
    .join(" ");
  const objectStems = new Set(contentStems(objectText));
  const notInObjects = (term: string) => !contentStems(term).every((s) => objectStems.has(s));
  const using = [...d.tools.filter(notInObjects), ...d.concepts.filter((c) => !c.weak && notInObjects(c.term)).map((c) => c.term)].slice(0, 4);
  const people = [...new Set(d.stakeholders.map((s) => stakeholderCategory(s.category)?.phrase).filter((p): p is string => !!p))];
  const parts: string[] = [];
  if (d.clauses.length) parts.push(clauseText);
  else {
    parts.push(verbs.length ? cap(list(verbs)) : "Use");
    if (objectText) parts.push(objectText);
  }
  if (using.length) parts.push(`${objectText ? "using " : ""}${list(using)}`);
  if (people.length) parts.push(`with ${list(people)}`);
  if (d.outcome) parts.push(d.outcome.replace(/^(resulting in|leading to)/i, "to achieve"));
  return clean(parts.join(" ").replace(/\s+/g, " "));
}

function dominantDomain(d: Decomposition): string {
  const counts = new Map<string, number>();
  for (const c of d.concepts) counts.set(c.domain, (counts.get(c.domain) ?? 0) + (c.weak ? 0.5 : 1));
  if (d.tools.length) counts.set("technical", (counts.get("technical") ?? 0) + d.tools.length);
  const families = d.actions.map((a) => a.family);
  if (families.includes("design")) counts.set("design", (counts.get("design") ?? 0) + 0.5);
  if (families.includes("research")) counts.set("research", (counts.get("research") ?? 0) + 0.5);
  if (families.includes("analyze")) counts.set("analytics", (counts.get("analytics") ?? 0) + 0.5);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "general";
}

function confidenceOf(d: Decomposition, text: string): number {
  let c = 1;
  const hasCore = d.actions.length > 0 || d.concepts.some((x) => !x.weak) || d.tools.length > 0;
  if (!hasCore) c -= 0.45;
  if (d.frame === "duty" && !d.actions.length) c -= 0.25;
  if (d.frame === "duty" && d.actions.length && !d.objects.length) c -= 0.2;
  const n = text.split(/\s+/).length;
  if (n > 32) c -= 0.15;
  if (d.actions.length > 3) c -= 0.1;
  if (d.concepts.length && d.concepts.every((x) => x.weak) && !d.tools.length) c -= 0.15;
  return Math.max(0, Math.round(c * 100) / 100);
}

export interface TemplateOptions {
  /** Importance from the platform's job analysis (requirement id -> weight); defaults from category and order. */
  importance?: Record<string, number>;
}

/** Canonical templates for the listing's transferable requirements (degrees, licenses, clearance and logistics are never templated). */
/** A template is usable once it has something to match: an action, an object, a concept or a tool. */
export function hasSubstance(t: Pick<Decomposition, "actions" | "objects" | "concepts" | "tools">): boolean {
  return t.actions.length > 0 || t.objects.length > 0 || t.concepts.length > 0 || t.tools.length > 0;
}

export function buildTemplates(job: Pick<NormalizedJob, "company" | "location" | "requirements">, opts: TemplateOptions = {}): RequirementTemplate[] {
  const locations = [...job.location.locations, ...job.location.raw.split(/[,;|/]/)]
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && !/remote|hybrid|on-?site/i.test(l));
  const out: RequirementTemplate[] = [];
  job.requirements.forEach((req: Requirement, index) => {
    if (!TEMPLATE_CATEGORIES.has(req.category) || !TEMPLATE_KINDS.has(req.kind)) return;
    const d = decompose(req.text, { mode: "requirement", company: job.company, locations });
    const hasContent = d.actions.length || d.concepts.length || d.tools.length || d.objects.length;
    // Nothing the rules can read, but real words: keep it (low confidence) for the model to decompose.
    if (!hasContent && contentStems(d.core).length < 3) return;
    const constraints = d.discarded.filter((x) => x.reason === "constraint").map((x) => x.text);
    const confidence = confidenceOf(d, req.text);
    const base = opts.importance?.[req.id] ?? CATEGORY_WEIGHT[req.category] ?? 1;
    const importance = Math.round((base + Math.min(1, 0.25 * (d.concepts.filter((c) => !c.weak).length + d.tools.length)) - index * 0.01) * 100) / 100;
    out.push({
      ...d,
      requirementId: req.id,
      category: req.category,
      kind: req.kind,
      sourceText: req.text,
      template: templateText(d),
      importance,
      domain: dominantDomain(d),
      confidence,
      lowConfidence: confidence < LOW_CONFIDENCE,
      constraints,
      method: "rules",
      vector: embed(d),
    });
  });
  return out.sort((a, b) => b.importance - a.importance);
}

/* ------------------------------------------------- model decomposition merge */

export interface ModelDecomposition {
  id: string;
  actions: string[];
  objects: string[];
  skills: string[];
  stakeholders: string[];
  outcome: string | null;
  discard: string[];
}

const normalizeForSearch = (s: string) => collapseWhitespace(s.toLowerCase().replace(/[^a-z0-9+#/&%$.' -]/g, " "));

/** True when every word of `fragment` occurs in `source` (model output must be grounded in the sentence). */
export function groundedIn(fragment: string, source: string): boolean {
  const src = normalizeForSearch(source);
  const f = normalizeForSearch(fragment);
  if (!f) return false;
  if (src.includes(f)) return true;
  const ws = f.split(" ").filter((w) => w && !STOP.has(w));
  return ws.length > 0 && ws.every((w) => src.includes(w));
}

/**
 * Merge a fast-model decomposition into a low-confidence template. Every
 * extracted fragment must occur in the requirement text; stakeholders are
 * generalized into categories (titles never survive); unknown verbs are dropped.
 */
export function mergeModelDecomposition(t: RequirementTemplate, m: ModelDecomposition): RequirementTemplate {
  const source = t.sourceText;
  const actions = [...t.actions];
  for (const v of m.actions) {
    const word = v.trim().split(/\s+/)[0] ?? "";
    const a = actionOf(word);
    if (!a || actions.some((x) => x.verb === a.base)) continue;
    const appears = groundedIn(word, source) || words(source).some((w) => actionOf(w)?.base === a.base);
    if (appears && actionFamily(a.family)) actions.push({ verb: a.base, family: a.family });
  }
  const objects = [...t.objects];
  for (const o of m.objects)
    if (groundedIn(o, source) && !objects.some((x) => x.toLowerCase() === o.toLowerCase()) && contentStems(o).length) objects.push(o.trim());
  const concepts = [...t.concepts];
  const tools = [...t.tools];
  for (const s of m.skills) {
    if (!groundedIn(s, source)) continue;
    for (const c of conceptsIn(s))
      if (!concepts.some((x) => x.id === c.id)) concepts.push({ id: c.id, label: c.label, domain: c.domain, term: c.term, weak: c.weak });
    for (const tool of toolsIn(s)) if (!tools.includes(tool)) tools.push(tool);
  }
  const stakeholders = [...t.stakeholders];
  for (const s of m.stakeholders) {
    if (!groundedIn(s, source)) continue;
    for (const h of stakeholdersIn(s)) if (!stakeholders.some((x) => x.category === h.category)) stakeholders.push({ category: h.category, as: h.as });
  }
  const outcome = t.outcome ?? (m.outcome && groundedIn(m.outcome, source) ? m.outcome : null);
  const merged: Decomposition = {
    ...t,
    actions,
    objects: objects.slice(0, 6),
    concepts,
    tools,
    stakeholders,
    outcome,
    discarded: [...t.discarded, ...m.discard.filter((d) => groundedIn(d, source)).map((d) => ({ text: d, reason: "low_value" as const }))],
  };
  const improved = actions.length > t.actions.length || objects.length > t.objects.length || concepts.length > t.concepts.length;
  const confidence = improved ? Math.max(t.confidence, 0.75) : t.confidence;
  return {
    ...t,
    ...merged,
    template: templateText(merged),
    confidence,
    lowConfidence: confidence < LOW_CONFIDENCE,
    domain: dominantDomain(merged),
    method: improved ? "model" : t.method,
    vector: embed(merged),
  };
}
