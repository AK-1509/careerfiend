import { randomId, CareerFiendError, normalizeLabel, sha256, type InventorySkill } from "@careerfiend/shared";
import { fromJson, toJson } from "@careerfiend/db";
import {
  blankResume,
  extractPdfText,
  fromStructure,
  ingestResume,
  parseResumeLines,
  parseResumeSource,
  refreshEndorsements,
  ResumeSchema,
  skillToRow,
  type ParsedResume,
  type Resume,
  type ResumeSource,
} from "@careerfiend/profile";
import type { AppContext } from "./context";

/**
 * Where the résumé comes from (public edition): the person's own stored
 * résumé, built from an uploaded PDF and edited on the Profile page. Each save
 * is a new version ("v<N>"), which plays the role the resume repo's commit
 * played in the single-user edition: facts are pinned to it and drafts built on
 * an older version get a SOURCE_CHANGED warning.
 */
export const RESUME_SOURCE_PATH = "profile";

export async function resumeSourceConfigured(ctx: AppContext): Promise<boolean> {
  return (await ctx.db.resumeDraft.count()) > 0;
}

export async function loadResumeSource(ctx: AppContext): Promise<ResumeSource> {
  const row = await ctx.db.resumeDraft.findUnique({ where: { id: "me" } });
  if (!row) throw new CareerFiendError("FATAL_CONFIGURATION", "Add your résumé first: upload a PDF or fill out the Profile page.");
  return parseResumeSource({ repoPath: RESUME_SOURCE_PATH, commit: `v${row.version}`, rawText: row.json });
}

/** Current résumé version ("v<N>"), or null before the first save. */
export async function resumeRepoHead(ctx: AppContext): Promise<string | null> {
  const row = await ctx.db.resumeDraft.findUnique({ where: { id: "me" }, select: { version: true } });
  return row ? `v${row.version}` : null;
}

export async function getResume(ctx: AppContext): Promise<{ resume: Resume; version: number; origin: string; updatedAt: Date } | null> {
  const row = await ctx.db.resumeDraft.findUnique({ where: { id: "me" } });
  if (!row) return null;
  const parsed = ResumeSchema.safeParse(fromJson(row.json, null));
  if (!parsed.success) return null;
  return { resume: parsed.data, version: row.version, origin: row.origin, updatedAt: row.updatedAt };
}

export class ResumeValidationError extends CareerFiendError {
  constructor(readonly reasons: string[]) {
    super("VALIDATION_FAILED", reasons.join(" "));
  }
}

/**
 * Save a new résumé version (validated), re-extract its facts and bring the
 * skills inventory in line with it. Saving an unchanged résumé is a no-op.
 */
export async function saveResume(
  ctx: AppContext,
  input: unknown,
  origin: "upload" | "upload+model" | "profile",
): Promise<{ version: number; changed: boolean }> {
  const parsed = ResumeSchema.safeParse(input);
  if (!parsed.success) {
    throw new ResumeValidationError(parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "résumé"}: ${i.message}`));
  }
  const resume = parsed.data;
  const json = JSON.stringify(resume, null, 2);
  const row = await ctx.db.resumeDraft.findUnique({ where: { id: "me" } });
  if (row && row.json === json) return { version: row.version, changed: false };
  const version = (row?.version ?? 0) + 1;
  await ctx.db.resumeDraft.upsert({ where: { id: "me" }, create: { id: "me", json, version, origin }, update: { json, version, origin } });
  await ingestResume(ctx.db, parseResumeSource({ repoPath: RESUME_SOURCE_PATH, commit: `v${version}`, rawText: json }));
  await syncResumeSkills(ctx, resume);
  ctx.logger.info("resume.saved", { status: origin, count: version });
  return { version, changed: true };
}

/**
 * Skills named on the résumé are VERIFIED_FROM_SOURCE (evidence: the entries
 * that name them, else the skills line itself). A skill that left the résumé
 * goes back to UNVERIFIED. Skills from job listings and the person's own
 * confirm/reject decisions are never touched here.
 */
export async function syncResumeSkills(ctx: AppContext, resume: Resume): Promise<{ verified: number; unverified: number }> {
  const existing = await ctx.db.skill.findMany();
  const byNorm = new Map(existing.map((s) => [s.normalizedLabel, s]));
  const keep = new Set<string>();
  let verified = 0;
  for (const s of resume.skills) {
    const evidence = resume.experiences
      .filter((e) => e.endorsedSkills.includes(s.id))
      .map((e) => ({
        key: `experiences[${e.id}].endorsedSkills`,
        kind: e.type === "education" ? ("coursework" as const) : e.type === "project" ? ("project" as const) : ("work" as const),
      }));
    const skill: InventorySkill = {
      id: s.id,
      label: s.label,
      aliases: [],
      category: s.category,
      status: "VERIFIED_FROM_SOURCE",
      origin: "resume",
      inResumeRegistry: true,
      evidence: evidence.length ? evidence : [{ key: `skills[${s.id}]`, kind: "profile" }],
    };
    const found = byNorm.get(normalizeLabel(s.label)) ?? existing.find((x) => x.id === s.id);
    const row = skillToRow(skill);
    if (!found) {
      await ctx.db.skill.create({ data: row });
      await ctx.db.skillStatusEvent.create({
        data: { id: randomId("sse"), skillId: row.id, from: null, to: "VERIFIED_FROM_SOURCE", actor: "system:resume", reason: "Named on your résumé" },
      });
    } else {
      // A listing skill (or one you decided on) that your résumé now names becomes verified; keep its id.
      await ctx.db.skill.update({
        where: { id: found.id },
        data: { ...row, id: found.id, aliases: found.aliases, status: "VERIFIED_FROM_SOURCE", origin: "resume", inResumeRegistry: true },
      });
      if (found.status !== "VERIFIED_FROM_SOURCE") {
        await ctx.db.skillStatusEvent.create({
          data: {
            id: randomId("sse"),
            skillId: found.id,
            from: found.status,
            to: "VERIFIED_FROM_SOURCE",
            actor: "system:resume",
            reason: "Now named on your résumé",
          },
        });
      }
    }
    keep.add(found?.id ?? row.id);
    verified++;
  }
  let unverified = 0;
  for (const s of existing) {
    if (s.origin !== "resume" || keep.has(s.id) || s.status !== "VERIFIED_FROM_SOURCE") continue;
    await ctx.db.skill.update({ where: { id: s.id }, data: { status: "UNVERIFIED", inResumeRegistry: false, evidence: toJson([]) } });
    await ctx.db.skillStatusEvent.create({
      data: { id: randomId("sse"), skillId: s.id, from: s.status, to: "UNVERIFIED", actor: "system:resume", reason: "No longer on your résumé" },
    });
    unverified++;
  }
  return { verified, unverified };
}

/**
 * Change the current résumé (Profile page) and save it as a new version.
 * Endorsed skills are recomputed from the text after every edit.
 */
export async function editResume(ctx: AppContext, mutate: (r: Resume) => Resume | void): Promise<{ version: number; changed: boolean }> {
  const cur = await getResume(ctx);
  if (!cur) throw new CareerFiendError("VALIDATION_FAILED", "Add your résumé first: upload a PDF or start from a blank profile.");
  const draft = structuredClone(cur.resume);
  const next = mutate(draft) ?? draft;
  return saveResume(ctx, refreshEndorsements(next), "profile");
}

/* ------------------------------------------------------------ uploads */

export interface UploadResult {
  uploadId: string;
  version: number;
  method: "rules" | "rules+model";
  notes: string[];
  experiences: number;
  skills: number;
}

const PDF_MAGIC = "%PDF-";

/**
 * Read an uploaded résumé PDF, keep the file and its text, and make it the
 * current résumé. With a connected language model the text is also split by
 * the model; every value it returns must appear word for word in the PDF, and
 * the result with more entries wins.
 */
export async function uploadResumePdf(ctx: AppContext, file: { name: string; bytes: Uint8Array }): Promise<UploadResult> {
  const maxBytes = ctx.config.MAX_UPLOAD_MB * 1024 * 1024;
  if (!file.bytes.length) throw new CareerFiendError("VALIDATION_FAILED", "The file is empty.");
  if (file.bytes.length > maxBytes) throw new CareerFiendError("VALIDATION_FAILED", `The file is larger than ${ctx.config.MAX_UPLOAD_MB} MB.`);
  if (Buffer.from(file.bytes.slice(0, 5)).toString("latin1") !== PDF_MAGIC) throw new CareerFiendError("VALIDATION_FAILED", "That file is not a PDF.");
  let pdf;
  try {
    pdf = await extractPdfText(file.bytes);
  } catch (err) {
    throw new CareerFiendError("VALIDATION_FAILED", "The PDF could not be read (it may be damaged or password-protected).", { cause: err });
  }
  const id = randomId("upl");
  const fileName = file.name.replace(/[^\w .()-]/g, "_").slice(0, 120) || "resume.pdf";
  const sha = sha256(Buffer.from(file.bytes));
  if (pdf.text.replace(/\s/g, "").length < 40) {
    await ctx.db.resumeUpload.create({
      data: {
        id,
        fileName,
        sha256: sha,
        size: file.bytes.length,
        data: Buffer.from(file.bytes),
        text: pdf.text,
        status: "FAILED",
        notes: toJson(["No text found."]),
      },
    });
    throw new CareerFiendError(
      "VALIDATION_FAILED",
      "No text could be read from this PDF. It is probably a scanned image: export your résumé as a text PDF (from Word or Google Docs), or fill out the Profile page.",
    );
  }
  const fallbackEmail = ctx.account?.email;
  let result: ParsedResume = parseResumeLines(pdf, { fallbackEmail });
  let method: UploadResult["method"] = "rules";
  if (ctx.ai.available) {
    try {
      const structured = await ctx.ai.structureResume({ text: pdf.text });
      const fromModel = fromStructure(structured, pdf.text, { fallbackEmail });
      const score = (r: ParsedResume) => r.resume.experiences.length * 10 + r.resume.experiences.reduce((a, e) => a + e.responsibilities.length, 0);
      if (score(fromModel) >= score(result)) {
        result = fromModel;
        method = "rules+model";
      }
    } catch (err) {
      ctx.logger.warn("resume.model_parse_failed", { error: err });
      result.notes.push("Your language model could not read the résumé, so the built-in reader was used.");
    }
  }
  await ctx.db.resumeUpload.create({
    data: {
      id,
      fileName,
      sha256: sha,
      size: file.bytes.length,
      data: Buffer.from(file.bytes),
      text: pdf.text,
      status: "PARSED",
      notes: toJson(result.notes),
      method,
    },
  });
  const saved = await saveResume(ctx, result.resume, method === "rules" ? "upload" : "upload+model");
  return {
    uploadId: id,
    version: saved.version,
    method,
    notes: result.notes,
    experiences: result.resume.experiences.length,
    skills: result.resume.skills.length,
  };
}

export async function listUploads(ctx: AppContext) {
  return ctx.db.resumeUpload.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, size: true, status: true, notes: true, method: true, createdAt: true },
  });
}

/** Start from an empty résumé (name and email only) to fill in on the Profile page. */
export async function startBlankResume(ctx: AppContext, name: string): Promise<number> {
  if (await resumeSourceConfigured(ctx)) throw new CareerFiendError("VALIDATION_FAILED", "You already have a résumé. Edit it below.");
  const email = ctx.account?.email ?? "you@example.com";
  return (await saveResume(ctx, blankResume(name.trim() || "Your Name", email), "profile")).version;
}
