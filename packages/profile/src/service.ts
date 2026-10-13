import type { Db } from "@careerfiend/db";
import { fromJson, toJson } from "@careerfiend/db";
import {
  CareerFiendError,
  decrypt,
  encrypt,
  isEncrypted,
  normalizeLabel,
  randomId,
  stableId,
  type InventorySkill,
  type SkillStatus,
  type SkillsInventoryFile,
} from "@careerfiend/shared";
import { extractFacts, mentionsExcluded } from "./extract";
import { ANSWER_SPECS, parseAnswers } from "./answers";
import { checklistStatus, looksUnreviewed, parseChecklist } from "./inventory";
import type { ResumeSource } from "./source";

/* ------------------------------------------------------------ source (D1) */

export interface IngestResult {
  sourceDocumentId: string;
  version: number;
  created: boolean;
  factCount: number;
  commit: string;
}

/**
 * Store resume.json at a pinned commit as a SourceDocument version with its
 * facts. Idempotent: the same checksum never creates a second version.
 */
export async function ingestResume(db: Db, source: ResumeSource): Promise<IngestResult> {
  const facts = extractFacts(source.resume, source.checksum);
  for (const f of facts) {
    const term = mentionsExcluded(f.text);
    if (term) throw new CareerFiendError("VALIDATION_FAILED", `Refusing to store a fact that mentions excluded item ${term}.`);
  }
  const existing = await db.sourceDocument.findUnique({ where: { checksum: source.checksum } });
  const id = stableId("src", source.checksum);
  return db.$transaction(async (tx) => {
    let created = false;
    let version: number;
    if (existing) {
      version = existing.version;
    } else {
      const last = await tx.sourceDocument.findFirst({ orderBy: { version: "desc" } });
      version = (last?.version ?? 0) + 1;
      await tx.sourceDocument.create({
        data: {
          id,
          path: source.repoPath,
          commit: source.commit,
          fileSha256: source.fileSha256,
          checksum: source.checksum,
          version,
          extractionStatus: "EXTRACTED",
        },
      });
      await tx.experienceFact.createMany({
        data: facts.map((f) => ({
          id: f.id,
          sourceDocumentId: id,
          key: f.key,
          kind: f.kind,
          experienceId: f.experienceId,
          experienceType: f.experienceType,
          text: f.text,
          status: f.status,
          ordinal: f.ordinal,
        })),
      });
      created = true;
    }
    await tx.sourceDocument.updateMany({ where: { isCurrent: true, NOT: { id } }, data: { isCurrent: false } });
    await tx.sourceDocument.update({ where: { id }, data: { isCurrent: true } });
    const p = source.resume.profile;
    const contact = toJson({ name: p.name, email: p.email, location: p.location, links: p.links, headline: p.headline });
    await tx.userProfile.upsert({ where: { id: "me" }, create: { id: "me", contact }, update: { contact } });
    return { sourceDocumentId: id, version, created, factCount: facts.length, commit: source.commit };
  });
}

export async function currentSource(db: Db) {
  return db.sourceDocument.findFirst({ where: { isCurrent: true } });
}

export async function currentFacts(db: Db) {
  const src = await currentSource(db);
  if (!src) return [];
  return db.experienceFact.findMany({ where: { sourceDocumentId: src.id }, orderBy: { ordinal: "asc" } });
}

/* ------------------------------------------------------ skills inventory */

export function skillToRow(s: InventorySkill) {
  return {
    id: s.id,
    label: s.label,
    normalizedLabel: normalizeLabel(s.label),
    aliases: toJson(s.aliases),
    category: s.category,
    status: s.status,
    origin: s.origin,
    inResumeRegistry: s.inResumeRegistry,
    evidence: toJson(s.evidence),
    scope: s.scope ?? null,
    claimLimit: s.claimLimit ?? null,
    basis: s.basis ?? null,
    confirmGroup: s.confirmGroup ?? null,
    parent: s.parent ?? null,
    firstSeen: s.firstSeen ? toJson(s.firstSeen) : null,
    suggestedEvidence: s.suggestedEvidence ? toJson(s.suggestedEvidence) : null,
  };
}

type SkillRow = Awaited<ReturnType<Db["skill"]["findMany"]>>[number];

export function rowToSkill(r: SkillRow): InventorySkill {
  return {
    id: r.id,
    label: r.label,
    aliases: fromJson<string[]>(r.aliases, []),
    category: r.category as InventorySkill["category"],
    status: r.status as SkillStatus,
    origin: r.origin as InventorySkill["origin"],
    inResumeRegistry: r.inResumeRegistry,
    evidence: fromJson(r.evidence, []),
    ...(r.scope ? { scope: r.scope } : {}),
    ...(r.claimLimit ? { claimLimit: r.claimLimit } : {}),
    ...(r.basis ? { basis: r.basis } : {}),
    ...(r.confirmGroup ? { confirmGroup: r.confirmGroup } : {}),
    ...(r.parent ? { parent: r.parent } : {}),
    ...(r.firstSeen ? { firstSeen: fromJson(r.firstSeen, { jobId: "", requirement: "" }) } : {}),
    ...(r.suggestedEvidence ? { suggestedEvidence: fromJson<string[]>(r.suggestedEvidence, []) } : {}),
  };
}

export async function listSkills(db: Db): Promise<InventorySkill[]> {
  const rows = await db.skill.findMany({ orderBy: [{ origin: "asc" }, { label: "asc" }] });
  return rows.map(rowToSkill);
}

/**
 * Import skills-inventory.json. The file mirrors decisions, it never makes
 * them: CONFIRMED_BY_USER / REJECTED_BY_USER in the file are not applied
 * here (new skills start UNVERIFIED, existing ones keep their database
 * status) and are returned as `pendingUserDecisions`. They take effect only
 * through a user action: importing the ticked skills-to-confirm.md, or a
 * click in the dashboard. Non-user status changes (e.g. a new resume-backed
 * verification) are applied with an audit event.
 */
export async function importInventory(db: Db, inventory: SkillsInventoryFile): Promise<{ inserted: number; updated: number; pendingUserDecisions: string[] }> {
  let inserted = 0;
  let updated = 0;
  const pendingUserDecisions: string[] = [];
  const isUserStatus = (st: string) => st === "CONFIRMED_BY_USER" || st === "REJECTED_BY_USER";
  for (const s of inventory.skills) {
    const existing = await db.skill.findUnique({ where: { id: s.id } });
    const row = skillToRow(s);
    if (!existing) {
      const status = isUserStatus(s.status) ? "UNVERIFIED" : s.status;
      if (status !== s.status) pendingUserDecisions.push(s.id);
      await db.skill.create({ data: { ...row, status } });
      await db.skillStatusEvent.create({
        data: { id: randomId("sse"), skillId: s.id, from: null, to: status, actor: "system:inventory-import", reason: "Imported from skills-inventory.json" },
      });
      inserted++;
      continue;
    }
    let status = existing.status;
    if (s.status !== existing.status) {
      if (isUserStatus(s.status) || isUserStatus(existing.status)) {
        // Only a user action changes a user decision; report the difference instead.
        if (isUserStatus(s.status)) pendingUserDecisions.push(s.id);
      } else {
        status = s.status;
        await db.skillStatusEvent.create({
          data: {
            id: randomId("sse"),
            skillId: s.id,
            from: existing.status,
            to: s.status,
            actor: "system:inventory-import",
            reason: "Status changed in skills-inventory.json",
          },
        });
      }
    }
    await db.skill.update({ where: { id: s.id }, data: { ...row, status } });
    updated++;
  }
  return { inserted, updated, pendingUserDecisions };
}

export class SkillDecisionError extends Error {}

/**
 * The only way a skill changes status at runtime: an explicit user action.
 * VERIFIED_FROM_SOURCE skills come from resume.json and cannot be changed here.
 */
export async function decideSkill(
  db: Db,
  skillId: string,
  to: Extract<SkillStatus, "CONFIRMED_BY_USER" | "REJECTED_BY_USER" | "UNVERIFIED">,
  actor: `user:${string}`,
  reason: string,
): Promise<void> {
  if (!actor.startsWith("user:")) throw new SkillDecisionError("Only a user action may change a skill status.");
  const skill = await db.skill.findUnique({ where: { id: skillId } });
  if (!skill) throw new SkillDecisionError(`Unknown skill ${skillId}`);
  if (skill.status === "VERIFIED_FROM_SOURCE") throw new SkillDecisionError(`${skillId} is verified from your résumé; change your résumé instead.`);
  if (skill.status === to) return;
  await db.$transaction([
    db.skill.update({ where: { id: skillId }, data: { status: to } }),
    db.skillStatusEvent.create({ data: { id: randomId("sse"), skillId, from: skill.status, to, actor, reason } }),
  ]);
}

export interface ChecklistImportResult {
  confirmed: string[];
  rejected: string[];
  unsure: string[];
  unknown: string[];
  skippedVerified: string[];
}

export async function importChecklist(db: Db, markdown: string, opts: { force?: boolean } = {}): Promise<ChecklistImportResult> {
  const lines = parseChecklist(markdown);
  if (!opts.force && looksUnreviewed(lines)) {
    throw new CareerFiendError(
      "VALIDATION_FAILED",
      "skills-to-confirm.md has no ticks and no `?` marks, so it looks unreviewed. Importing would reject every candidate. Tick the file first, or pass --force.",
    );
  }
  const result: ChecklistImportResult = { confirmed: [], rejected: [], unsure: [], unknown: [], skippedVerified: [] };
  for (const line of lines) {
    const skill = await db.skill.findUnique({ where: { id: line.id } });
    if (!skill) {
      result.unknown.push(line.id);
      continue;
    }
    if (skill.status === "VERIFIED_FROM_SOURCE") {
      result.skippedVerified.push(line.id);
      continue;
    }
    const to = checklistStatus(line);
    if (to !== "UNVERIFIED" || skill.status !== "UNVERIFIED") {
      await decideSkill(db, line.id, to as "CONFIRMED_BY_USER" | "REJECTED_BY_USER" | "UNVERIFIED", "user:checklist", "skills-to-confirm.md import");
    }
    if (to === "UNVERIFIED") {
      // Record the `?` so a re-rendered checklist keeps it.
      await db.skillStatusEvent.create({
        data: { id: randomId("sse"), skillId: line.id, from: skill.status, to: "UNVERIFIED", actor: "user:checklist", reason: "Marked unsure (?)" },
      });
    }
    (to === "CONFIRMED_BY_USER" ? result.confirmed : to === "REJECTED_BY_USER" ? result.rejected : result.unsure).push(line.id);
  }
  return result;
}

/** Skills whose latest checklist event marked them unsure. */
export async function unsureSkillIds(db: Db): Promise<Set<string>> {
  const events = await db.skillStatusEvent.findMany({ where: { actor: "user:checklist" }, orderBy: { createdAt: "asc" } });
  const latest = new Map<string, string>();
  for (const e of events) latest.set(e.skillId, e.reason);
  return new Set([...latest].filter(([, reason]) => reason === "Marked unsure (?)").map(([id]) => id));
}

/* ------------------------------------------------------ profile values */

export async function importAnswers(db: Db, markdown: string, key: Buffer): Promise<{ confirmed: string[]; blank: string[] }> {
  const parsed = parseAnswers(markdown);
  const confirmed: string[] = [];
  const blank: string[] = [];
  for (const { spec, value } of parsed) {
    const existing = await db.profileValue.findUnique({ where: { key: spec.key } });
    if (value === null) {
      // Blank lines never erase an answer the user gave in the dashboard.
      if (!existing) {
        await db.profileValue.create({
          data: { key: spec.key, value: null, status: "UNVERIFIED", sensitive: spec.sensitive, source: "answers-later.md", label: spec.label },
        });
      }
      if (!existing || existing.status === "UNVERIFIED") blank.push(spec.key);
      continue;
    }
    const stored = spec.sensitive ? encrypt(value, key) : value;
    await db.profileValue.upsert({
      where: { key: spec.key },
      create: { key: spec.key, value: stored, status: "CONFIRMED_BY_USER", sensitive: spec.sensitive, source: "answers-later.md", label: spec.label },
      update: { value: stored, status: "CONFIRMED_BY_USER", sensitive: spec.sensitive, source: "answers-later.md", label: spec.label },
    });
    confirmed.push(spec.key);
  }
  return { confirmed, blank };
}

export interface ProfileValueView {
  key: string;
  label: string;
  value: string | null;
  status: string;
  sensitive: boolean;
  source: string;
}

export async function getProfileValues(db: Db, key: Buffer | null): Promise<ProfileValueView[]> {
  const rows = await db.profileValue.findMany({ orderBy: { key: "asc" } });
  const out: ProfileValueView[] = rows.map((r) => ({
    key: r.key,
    label: r.label,
    status: r.status,
    sensitive: r.sensitive,
    source: r.source,
    value: r.value && isEncrypted(r.value) ? (key ? decrypt(r.value, key) : "[encrypted]") : r.value,
  }));
  // Every known question is listed even before any import, so it can be answered on the Profile page.
  for (const spec of ANSWER_SPECS) {
    if (!out.some((v) => v.key === spec.key))
      out.push({ key: spec.key, label: spec.label, status: "UNVERIFIED", sensitive: spec.sensitive, source: "none", value: null });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** A usable (CONFIRMED_BY_USER) profile value, or null. UNVERIFIED values are never returned. */
export async function getUsableProfileValue(db: Db, valueKey: string, key: Buffer | null): Promise<string | null> {
  const r = await db.profileValue.findUnique({ where: { key: valueKey } });
  if (!r || r.status !== "CONFIRMED_BY_USER" || r.value === null) return null;
  if (isEncrypted(r.value)) return key ? decrypt(r.value, key) : null;
  return r.value;
}

export async function setProfileValue(
  db: Db,
  input: { key: string; label: string; value: string; sensitive: boolean; source: string },
  encKey: Buffer,
): Promise<void> {
  const stored = input.sensitive ? encrypt(input.value, encKey) : input.value;
  await db.profileValue.upsert({
    where: { key: input.key },
    create: { key: input.key, label: input.label, value: stored, status: "CONFIRMED_BY_USER", sensitive: input.sensitive, source: input.source },
    update: { value: stored, status: "CONFIRMED_BY_USER", sensitive: input.sensitive, source: input.source, label: input.label },
  });
}
