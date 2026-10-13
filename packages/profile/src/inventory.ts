import { readFileSync, writeFileSync } from "node:fs";
import {
  CareerFiendError,
  InventorySkillSchema,
  SkillsInventoryFileSchema,
  normalizeLabel,
  type InventorySkill,
  type SkillStatus,
  type SkillsInventoryFile,
} from "@careerfiend/shared";
import { mentionsExcluded, resolveKey } from "./extract";
import type { Resume } from "./resume-schema";

export function loadInventoryFile(file: string): SkillsInventoryFile {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new CareerFiendError("FATAL_CONFIGURATION", `Cannot read skills inventory at ${file}.`, { cause: err });
  }
  const parsed = SkillsInventoryFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new CareerFiendError(
      "FATAL_CONFIGURATION",
      `skills-inventory.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const ids = new Set<string>();
  for (const s of parsed.data.skills) {
    if (ids.has(s.id)) throw new CareerFiendError("FATAL_CONFIGURATION", `Duplicate skill id "${s.id}" in skills-inventory.json.`);
    ids.add(s.id);
    const excluded = mentionsExcluded(`${s.id} ${s.label}`);
    if (excluded) throw new CareerFiendError("FATAL_CONFIGURATION", `Skill "${s.id}" references excluded item ${excluded}.`);
  }
  return parsed.data;
}

export function writeInventoryFile(file: string, inventory: SkillsInventoryFile): void {
  writeFileSync(file, JSON.stringify(inventory, null, 2) + "\n");
}

export interface EvidenceProblem {
  skillId: string;
  key: string;
  problem: string;
}

/** Every evidence key of a verified skill must resolve in the pinned resume.json. */
export function checkEvidence(inventory: SkillsInventoryFile, resume: Resume): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  for (const s of inventory.skills) {
    for (const e of s.evidence) {
      if (resolveKey(resume, e.key) === null) problems.push({ skillId: s.id, key: e.key, problem: "key does not resolve" });
    }
    if (s.status === "VERIFIED_FROM_SOURCE" && s.evidence.length === 0) {
      problems.push({ skillId: s.id, key: "", problem: "VERIFIED_FROM_SOURCE without evidence" });
    }
  }
  return problems;
}

/** Find an existing skill by normalized label or alias (D4 de-duplication). */
export function findSkillByLabel<T extends Pick<InventorySkill, "label" | "aliases">>(skills: T[], label: string): T | undefined {
  const n = normalizeLabel(label);
  if (!n) return undefined;
  return skills.find((s) => normalizeLabel(s.label) === n || s.aliases.some((a) => normalizeLabel(a) === n));
}

/* ----------------------------------------------------------- checklist (D4) */

export interface ChecklistLine {
  id: string;
  label: string;
  ticked: boolean;
  unsure: boolean;
  raw: string;
}

const LINE_RE = /^\s*-\s*\[( |x|X)\]\s*(.+?)\s*<!--\s*([a-z0-9-]+)\s*-->(.*)$/;

export function parseChecklist(markdown: string): ChecklistLine[] {
  const out: ChecklistLine[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    out.push({
      id: m[3]!,
      label: m[2]!.trim(),
      ticked: m[1] !== " ",
      unsure: /\?\s*$/.test(raw),
      raw,
    });
  }
  return out;
}

/** Status a checklist line maps to: ticked → CONFIRMED, `?` → UNVERIFIED, else REJECTED. */
export function checklistStatus(line: ChecklistLine): SkillStatus {
  if (line.unsure) return "UNVERIFIED";
  if (line.ticked) return "CONFIRMED_BY_USER";
  return "REJECTED_BY_USER";
}

/**
 * A checklist with no ticks and no `?` marks has almost certainly not been
 * reviewed. Importing it would reject every candidate, so refuse unless forced.
 */
export function looksUnreviewed(lines: ChecklistLine[]): boolean {
  return lines.length > 0 && lines.every((l) => !l.ticked && !l.unsure);
}

const GROUP_ORDER = ["Microsoft Office apps", "Adobe apps", "Other tools", "Workplace skills", "Domain skills", "From job listings"];
const GROUP_INTRO: Record<string, string> = {
  "Microsoft Office apps": "Your résumé may name Microsoft Office as a whole but not each app.",
  "Adobe apps": "Your résumé may name Adobe Creative Suite as a whole but not each app.",
  "From job listings": "Appended automatically when a listing required a skill that is not in the inventory. Not counted until you confirm.",
};

function groupOf(s: InventorySkill): string {
  if (s.origin === "job-description") return "From job listings";
  return s.confirmGroup ?? (s.category === "soft" ? "Workplace skills" : s.category === "domain" ? "Domain skills" : "Other tools");
}

/**
 * Render skills-to-confirm.md from the inventory. Candidates that are still
 * UNVERIFIED appear unticked (with `?` when the user marked them unsure);
 * confirmed ones stay ticked and rejected ones unticked, so re-importing an
 * unchanged file is idempotent.
 */
export function renderChecklist(skills: InventorySkill[], unsureIds: ReadonlySet<string> = new Set()): string {
  const candidates = skills.filter((s) => s.origin !== "resume" && s.status !== "VERIFIED_FROM_SOURCE");
  const groups = new Map<string, InventorySkill[]>();
  for (const s of candidates) {
    const g = groupOf(s);
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const lines: string[] = [
    "# Skills to confirm",
    "",
    "Tick every line that is true for you. Add `?` at the end of a line if you are not sure.",
    "",
    "On import, ticked lines become `CONFIRMED_BY_USER`. Lines with `?` stay `UNVERIFIED`. All other lines become `REJECTED_BY_USER`.",
    "",
    "Confirmed skills are used for matching and form answers only. They never add text to your résumé.",
  ];
  const ordered = [...groups.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const g of ordered) {
    lines.push("", `## ${g}`, "");
    if (GROUP_INTRO[g]) lines.push(GROUP_INTRO[g]!, "");
    for (const s of groups.get(g)!) {
      const mark = s.status === "CONFIRMED_BY_USER" ? "x" : " ";
      let basis = s.basis ?? "";
      const intro = GROUP_INTRO[g];
      if (intro && basis.startsWith(intro)) basis = basis.slice(intro.length).trim();
      // Keep a previous `?` so re-importing does not turn "not sure" into a rejection.
      const unsure = s.status === "UNVERIFIED" && unsureIds.has(s.id);
      lines.push(`- [${mark}] ${s.label} <!-- ${s.id} -->${basis ? ` — ${basis}` : ""}${unsure ? " ?" : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function validateSkill(input: unknown): InventorySkill {
  return InventorySkillSchema.parse(input);
}
