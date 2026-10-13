import { collapseWhitespace, stableId, type DegreeLevel, type Requirement, type RequirementCategory, type RequirementKind } from "@careerfiend/shared";

/** Heading text → category. Order matters: first match wins. */
const HEADING_RULES: { re: RegExp; category: RequirementCategory }[] = [
  { re: /(preferred|nice[- ]to[- ]have|bonus|plus(es)?\b|desired|pluses|ideal(ly)?|extra credit|good to have)/i, category: "preferred" },
  {
    re: /(requirement|qualification|what you('|’)ll (need|bring)|who you are|what we('|’)re looking for|must[- ]have|you (have|bring|should have)|skills|about you|experience|minimum|basic)/i,
    category: "required",
  },
  { re: /(responsibilit|what you('|’)ll do|the role|your role|duties|day[- ]to[- ]day|in this role|you will|key tasks|impact)/i, category: "responsibility" },
  {
    re: /(location|logistics|schedule|hours|travel|benefits|compensation|salary|pay|perks|work environment|physical|eeo|equal opportunity|about (us|the company)|why join)/i,
    category: "logistics",
  },
];

export function classifyHeading(heading: string): RequirementCategory | null {
  const h = heading.trim();
  if (!h || h.length > 80) return null;
  for (const r of HEADING_RULES) if (r.re.test(h)) return r.category;
  return null;
}

const DEGREE_PATTERNS: { re: RegExp; level: DegreeLevel }[] = [
  { re: /\b(ph\.?\s?d|doctorate|doctoral)\b/i, level: "doctorate" },
  { re: /\b(pharm\.?\s?d|m\.?d\.?|j\.?d\.?)\b/, level: "professional" },
  { re: /\b(master'?s?|m\.s\.|\bms\b|m\.sc|mba|m\.eng)\b/i, level: "master" },
  { re: /\b(bachelor'?s?|b\.s\.|\bbs\b|b\.a\.|\bba\b|b\.sc|undergraduate degree|4-year degree|four-year degree)\b/i, level: "bachelor" },
  { re: /\b(associate'?s? degree)\b/i, level: "associate" },
];

export function degreeLevelIn(text: string): DegreeLevel | undefined {
  // "Bachelor's or Master's" requires the lowest listed level.
  const found = DEGREE_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.level);
  if (!found.length) return undefined;
  const rank: DegreeLevel[] = ["none", "associate", "bachelor", "master", "professional", "doctorate"];
  return found.sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0];
}

const YEARS_RE = /(\d+(?:\.\d+)?)\s*\+?\s*(?:-|–|to)?\s*(?:\d+\s*)?\+?\s*(?:years?|yrs?)\b/i;

export function classifyItem(text: string): Pick<Requirement, "kind" | "years" | "degreeLevel" | "depth"> {
  const t = text;
  let kind: RequirementKind = "skill";
  let years: number | undefined;
  let degreeLevel: DegreeLevel | undefined;
  if (/\b(security clearance|secret clearance|top secret|ts\/sci|clearance required|active clearance)\b/i.test(t)) kind = "clearance";
  else if (
    /\b(licen[cs]e[ds]?|licensure|registered (nurse|pharmacist)|board[- ]certified|\bRN\b|\bPE\b license)\b/i.test(t) &&
    !/driver'?s licen[cs]e/i.test(t)
  ) {
    kind = "license";
  } else if (/\b(certification|certified|certificate)\b.*\b(required|must)\b|\b(required|must)\b.*\b(certification|certified)\b/i.test(t)) {
    kind = "certification";
  } else if ((degreeLevel = degreeLevelIn(t)) && /\b(degree|bachelor|master|ph\.?d|doctorate|b\.s|m\.s|bs\b|ms\b|ba\b|mba)\b/i.test(t)) {
    kind = "degree";
  } else if (YEARS_RE.test(t) && /\bexperience|\bexp\b/i.test(t)) {
    kind = "experience-years";
    years = Number(YEARS_RE.exec(t)![1]);
  } else if (
    /\b(relocat|on-?site|hybrid|remote|commute|travel up to|work authori[sz]ation|sponsorship|visa|shift|weekends|lift \d+|background check|drug (test|screen))\b/i.test(
      t,
    )
  ) {
    kind = "location";
  }
  if (kind !== "degree") degreeLevel = undefined;
  let depth: Requirement["depth"] = "unspecified";
  if (kind === "experience-years") depth = "years";
  else if (/\b(familiar(ity)?|exposure|coursework|academic|knowledge of|understanding of|awareness of|interest in)\b/i.test(t)) depth = "familiarity";
  else if (/\b(hands[- ]on|experience (with|in|using|of)|proficien|expert|expertise|demonstrated|proven|track record|working experience)\b/i.test(t))
    depth = "hands-on";
  return { kind, depth, ...(years !== undefined ? { years } : {}), ...(degreeLevel ? { degreeLevel } : {}) };
}

export interface TextBlock {
  heading: string | null;
  items: string[];
}

/**
 * Split plain description text (headings on their own lines, bullets as
 * "-", "•", "*" or numbered) into blocks.
 */
export function blocksFromText(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let current: TextBlock = { heading: null, items: [] };
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    if (!line) continue;
    const bullet = /^([-•*·▪◦●]|\d+[.)])\s+/.test(line);
    const clean = collapseWhitespace(line.replace(/^([-•*·▪◦●]|\d+[.)])\s+/, ""));
    const looksHeading =
      !bullet && clean.length <= 80 && (/:$/.test(clean) || (!/[.!?]$/.test(clean) && classifyHeading(clean) !== null && clean.split(" ").length <= 8));
    const inline = !bullet ? /^([^:]{2,40}):\s+(.+)$/.exec(clean) : null;
    if (inline && classifyHeading(inline[1]!) !== null) {
      // "Benefits: health, dental." → its own block.
      if (current.heading !== null || current.items.length) blocks.push(current);
      current = { heading: inline[1]!, items: [inline[2]!] };
      continue;
    }
    if (looksHeading) {
      if (current.heading !== null || current.items.length) blocks.push(current);
      current = { heading: clean.replace(/:$/, ""), items: [] };
    } else {
      current.items.push(clean);
    }
  }
  if (current.heading !== null || current.items.length) blocks.push(current);
  return blocks;
}

/** Items that are about the company, not the candidate. */
function isBoilerplate(item: string): boolean {
  return /\b(equal opportunity employer|we are an equal|reasonable accommodation|e-?verify|pay transparency|privacy (notice|policy))\b/i.test(item);
}

/**
 * Split a listing into required / preferred / responsibility / logistics /
 * unknown items. Deterministic; a model may later refine an "unknown"-heavy
 * split, but its output is validated against this page text.
 */
export function splitRequirements(blocks: TextBlock[], jobKey: string): Requirement[] {
  const out: Requirement[] = [];
  let n = 0;
  for (const block of blocks) {
    const headingCategory = block.heading ? classifyHeading(block.heading) : null;
    for (const raw of block.items) {
      const text = collapseWhitespace(raw);
      if (text.length < 3 || isBoilerplate(text)) continue;
      // Long prose paragraphs under no heading are description, not requirements.
      if (!headingCategory && text.length > 400) continue;
      let category: RequirementCategory = headingCategory ?? "unknown";
      if (category === "required" && /\b(preferred|a plus|nice to have|bonus|ideally)\b/i.test(text)) category = "preferred";
      if (category === "unknown" && /\b(required|must have|must be|minimum)\b/i.test(text)) category = "required";
      else if (category === "unknown" && /\b(preferred|a plus|nice to have|bonus)\b/i.test(text)) category = "preferred";
      const cls = classifyItem(text);
      if (cls.kind === "location" && category !== "preferred") category = category === "required" ? "required" : "logistics";
      out.push({ id: stableId("req", jobKey, String(n++), text), category, text, ...cls });
    }
  }
  return out;
}
