import { containsTerm, escapeRegExp, isUsableStatus, normalizeLabel, type EvidenceKind, type InventorySkill, type Requirement } from "@careerfiend/shared";

/**
 * Extra surface forms used only for *detecting* a skill in listing text.
 * They never change a skill's status or add text anywhere.
 */
export const IMPLICIT_ALIASES: Record<string, string[]> = {
  "microsoft-office-365": ["Microsoft Office", "MS Office Suite", "Office Suite"],
  "microsoft-excel": ["Excel", "MS Excel", "spreadsheets"],
  "microsoft-word": ["MS Word"],
  "microsoft-powerpoint": ["PowerPoint", "MS PowerPoint"],
  "microsoft-outlook": ["Outlook"],
  "microsoft-teams": ["MS Teams"],
  "microsoft-sharepoint": ["SharePoint"],
  "microsoft-onenote": ["OneNote"],
  "microsoft-onedrive": ["OneDrive"],
  "microsoft-visio": ["Visio"],
  "microsoft-access": ["MS Access"],
  "adobe-photoshop": ["Photoshop"],
  "adobe-illustrator": ["Illustrator"],
  "adobe-indesign": ["InDesign"],
  "adobe-premiere-pro": ["Premiere Pro", "Premiere"],
  "adobe-after-effects": ["After Effects"],
  "adobe-lightroom": ["Lightroom"],
  "adobe-acrobat-pro": ["Acrobat"],
  "google-workspace-docs-sheets-slides": ["Google Workspace", "G Suite", "GSuite"],
  "generative-ai-tools-claude-chatgpt": ["ChatGPT", "generative AI tools"],
  "good-documentation-practices-gdp": ["Good Documentation Practices", "GDP"],
  "sop-adherence": ["SOPs", "standard operating procedures", "SOP"],
  "cross-functional-collaboration": ["cross-functional teams", "cross-functionally", "cross functional"],
  "stakeholder-management": ["stakeholders"],
  "quality-assurance": ["quality assurance"],
  gmp: ["GxP"],
  "data-analysis": ["analyze data", "data analytics", "analytical skills"],
  presentations: ["presentation skills", "present findings"],
  "written-communication": ["written communication", "writing skills"],
  "project-management": ["project management", "manage projects"],
  "organization-and-prioritization": ["organizational skills", "prioritize", "prioritization"],
  "attention-to-detail": ["detail-oriented", "detail oriented", "attention to detail"],
  "problem-solving": ["problem-solving", "problem solving", "solve problems"],
  teamwork: ["team player", "collaborative team"],
  "time-management": ["time management", "manage multiple deadlines", "meet deadlines"],
  "public-speaking": ["public speaking"],
  "user-research": ["user research", "customer research"],
  "competitive-analysis": ["competitive analysis", "competitor analysis"],
  "financial-modeling": ["financial models", "financial modelling"],
  "machine-learning": ["machine-learning"],
  "statistical-analysis": ["statistical methods", "statistical analyses"],
};

/** Surface forms for a skill: label, label without a parenthetical, aliases, implicit aliases. */
export function surfaceForms(skill: Pick<InventorySkill, "id" | "label" | "aliases">): string[] {
  const forms = new Set<string>([skill.label, ...skill.aliases, ...(IMPLICIT_ALIASES[skill.id] ?? [])]);
  const base = skill.label.replace(/\s*\(.*\)\s*$/, "").trim();
  if (base && base !== skill.label) forms.add(base);
  return [...forms].filter((f) => f.trim().length > 0);
}

/** Term detection with extra care for one- and two-letter labels such as "R". */
export function mentions(text: string, form: string): boolean {
  if (form.length <= 2) {
    const re = new RegExp(`(^|[\\s,(/])${escapeRegExp(form)}(?=$|[\\s,)/.;:])`);
    return re.test(text) && !new RegExp(`${escapeRegExp(form)}\\s*&`).test(text);
  }
  return containsTerm(text, form);
}

export function skillsMentioned<T extends Pick<InventorySkill, "id" | "label" | "aliases">>(text: string, skills: T[]): T[] {
  const found = skills.filter((s) => surfaceForms(s).some((f) => mentions(text, f)));
  // Prefer the most specific: drop a skill whose every matched form is contained in another matched skill's form.
  return found.filter(
    (s) =>
      !found.some(
        (o) =>
          o.id !== s.id &&
          surfaceForms(s)
            .filter((f) => mentions(text, f))
            .every((f) => surfaceForms(o).some((of) => of.length > f.length && mentions(text, of) && of.toLowerCase().includes(f.toLowerCase()))),
      ),
  );
}

export interface SkillUse {
  usable: boolean;
  reason: string;
}

const COURSEWORK_KINDS: EvidenceKind[] = ["coursework", "thesis"];

/**
 * Deterministic policy (D4): status, scope and claim limit decide whether a
 * skill may satisfy a requirement. The model never decides this.
 */
export function canSatisfy(skill: InventorySkill, req: Pick<Requirement, "depth" | "kind">): SkillUse {
  if (!isUsableStatus(skill.status)) return { usable: false, reason: `${skill.label} is ${skill.status}` };
  if (skill.status === "VERIFIED_FROM_SOURCE") {
    const kinds = new Set(skill.evidence.map((e) => e.kind));
    const courseworkOnly = kinds.size > 0 && [...kinds].every((k) => COURSEWORK_KINDS.includes(k));
    if (courseworkOnly && req.depth !== "familiarity") {
      return { usable: false, reason: `${skill.label}: coursework/thesis only; satisfies familiarity or coursework requirements, not ${req.depth}` };
    }
    if (skill.category === "language" && /proficien|fluent|native|level/i.test(skill.claimLimit ?? "") && req.kind === "skill") {
      // Naming the language is verified; proficiency questions are handled as form fields (NEEDS_INPUT).
      return { usable: true, reason: `${skill.label} (proficiency unstated)` };
    }
  }
  return { usable: true, reason: skill.status === "CONFIRMED_BY_USER" ? `${skill.label} (confirmed by you)` : `${skill.label} (resume)` };
}

/* ---------------------------------------------------- unknown skill labels */

const TRIGGERS =
  /\b(?:experience (?:with|in|using)|hands-on (?:experience )?(?:with|in)|proficien(?:cy|t) (?:in|with)|knowledge of|familiarity with|expertise in|skilled in|working knowledge of|fluency in|competency in|using|such as|including)\s+(.+?)(?:[.;:]|$)/gi;

const KNOWN_TOOLS = [
  "Veeva Vault",
  "Veeva",
  "SAP",
  "LIMS",
  "TrackWise",
  "MasterControl",
  "Tableau",
  "Power BI",
  "Looker",
  "Salesforce",
  "HubSpot",
  "SQL",
  "JMP",
  "Minitab",
  "SAS",
  "MATLAB",
  "HPLC",
  "ELISA",
  "qPCR",
  "PCR",
  "Western blot",
  "flow cytometry",
  "cell culture",
  "Jira",
  "Asana",
  "Smartsheet",
  "Notion",
  "Airtable",
  "JavaScript",
  "TypeScript",
  "React",
  "Java",
  "C++",
  "AWS",
  "GCP",
  "Snowflake",
  "dbt",
  "Spotfire",
  "Benchling",
  "ServiceNow",
  "Workday",
  "NetSuite",
  "QuickBooks",
  "Marketo",
  "Google Analytics",
  "Mailchimp",
  "Sketch",
  "Webflow",
  "WordPress",
  "Six Sigma",
  "Lean Six Sigma",
  "21 CFR Part 11",
  "ICH guidelines",
  "CAPA",
  "deviation management",
  "change control",
];

const STOP = new Set(
  "a an the and or of in with for to on at by strong excellent good solid basic advanced proven demonstrated relevant related similar various other tools tool software platforms platform systems system environment experience knowledge skills skill ability understanding working hands-on familiarity etc e.g. i.e. including such as using our your their".split(
    " ",
  ),
);

function cleanCandidate(phrase: string): string | null {
  let p = phrase
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  p = p
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+(?:tools?|software|platforms?|systems?|preferred|required|a plus|is a plus|or similar|or equivalent)$/i, "");
  const words = p.split(" ").filter(Boolean);
  if (!words.length || words.length > 4) return null;
  if (words.every((w) => STOP.has(w.toLowerCase()))) return null;
  // Tool-like: contains a capital letter, digit or symbol beyond the first char, or is an acronym.
  const toolish =
    words.some((w, i) => /[A-Z]/.test(i === 0 ? w.slice(1) : w) || /[A-Z]{2,}|\d|\+|#|\//.test(w)) || (/^[A-Z]/.test(words[0]!) && words.length <= 3);
  if (!toolish) return null;
  return words.filter((w, i) => !(i === words.length - 1 && STOP.has(w.toLowerCase()))).join(" ");
}

/**
 * Candidate skill labels in a requirement that the inventory does not know.
 * Deterministic: trigger phrases and a known-tools list. The AI provider,
 * when configured, may propose cleaner labels; either way the result is
 * appended as UNVERIFIED and never counted until the user confirms.
 */
export function unknownSkillCandidates<T extends Pick<InventorySkill, "id" | "label" | "aliases">>(text: string, skills: T[]): string[] {
  const out = new Map<string, string>();
  const known = (label: string) => {
    const n = normalizeLabel(label);
    return skills.some((s) =>
      surfaceForms(s).some((f) => normalizeLabel(f) === n || (n.length > 3 && normalizeLabel(f).length > 3 && n.includes(normalizeLabel(f)))),
    );
  };
  // Longest first, so "Veeva Vault" wins over "Veeva".
  for (const tool of [...KNOWN_TOOLS].sort((a, b) => b.length - a.length)) {
    const n = normalizeLabel(tool);
    if (!mentions(text, tool) || known(tool) || [...out.keys()].some((k) => k.includes(n))) continue;
    out.set(n, tool);
  }
  for (const m of text.matchAll(TRIGGERS)) {
    for (const part of m[1]!.split(/,|\bor\b|\band\b|\//i)) {
      const c = cleanCandidate(part);
      if (!c || known(c)) continue;
      const n = normalizeLabel(c);
      // Skip a candidate that merely extends a known tool already captured ("Veeva Vault QualityDocs" vs "Veeva Vault").
      if ([...out.keys()].some((k) => n.startsWith(k) || k.startsWith(n))) continue;
      out.set(n, c);
    }
  }
  return [...out.values()];
}
