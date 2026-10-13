import { stableId, type NormalizedJob } from "@careerfiend/shared";
import { fromJson, toJson } from "@careerfiend/db";
import { CATEGORY_WEIGHT, mentions, type JobKeyword, type RequirementResult } from "@careerfiend/matcher";
import { isExcludedExperience, type ResumeSource } from "@careerfiend/profile";
import {
  PROFILE_VERSION,
  buildProfiles,
  enrichProfiles,
  generateJobSpecificBullets,
  type ExperienceProfile,
  type GeneratedBulletSet,
  type SpanExtraction,
} from "@careerfiend/bullets";
import type { AppContext } from "./context";

/**
 * Job-specific bullets in the résumé-curation flow (prepare -> generateDocuments).
 * Consumes what the platform already produces: the parsed listing and its
 * requirement analysis, and the résumé facts pinned by commit. Experience
 * profiles are cached per résumé version; nothing here writes to resume.json
 * or to the stored facts: the bullets are a presentation layer for one job.
 */

const KEEP_CACHE_ROWS = 3;

/** Structured experience profiles for this résumé version (built once, then read from the cache). */
export async function experienceProfiles(ctx: AppContext, src: ResumeSource): Promise<ExperienceProfile[]> {
  const where = { checksum_version: { checksum: src.checksum, version: PROFILE_VERSION } };
  const cached = await ctx.db.experienceProfileCache.findUnique({ where });
  if (cached) return fromJson<ExperienceProfile[]>(cached.payload, []);

  const started = Date.now();
  let profiles = buildProfiles(src.resume);
  let method = "rules";
  if (ctx.ai.available && profiles.length) {
    try {
      // One batched fast-model pass over every line; fragments are kept only where they occur in their own line.
      const spans = profiles.flatMap((p) => p.evidence.filter((e) => e.kind !== "skills").map((e) => ({ id: e.id, text: e.text })));
      const out = await ctx.ai.extractExperience({ spans });
      profiles = enrichProfiles(profiles, out.spans as SpanExtraction[]);
      method = "rules+model";
    } catch (err) {
      ctx.logger.warn("bullets.profiles_model_failed", { error: err });
    }
  }
  await ctx.db.experienceProfileCache.upsert({
    where,
    create: { id: stableId("xp", src.checksum, String(PROFILE_VERSION)), checksum: src.checksum, version: PROFILE_VERSION, method, payload: toJson(profiles) },
    update: { method, payload: toJson(profiles) },
  });
  const old = await ctx.db.experienceProfileCache.findMany({ orderBy: { createdAt: "desc" }, skip: KEEP_CACHE_ROWS, select: { id: true } });
  if (old.length) await ctx.db.experienceProfileCache.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  ctx.logger.info("bullets.profiles", { count: profiles.length, durationMs: Date.now() - started, status: method });
  return profiles;
}

/**
 * Importance per requirement from the existing job analysis: the matcher's
 * category weight, whether it is part of the keyword match, and how many of
 * the listing's weighted ATS keywords it names.
 */
export function requirementImportance(job: NormalizedJob, results: RequirementResult[], keywords: JobKeyword[]): Record<string, number> {
  const byId = new Map(results.map((r) => [r.requirement.id, r]));
  const out: Record<string, number> = {};
  for (const req of job.requirements) {
    const r = byId.get(req.id);
    const kw = keywords.filter((k) => k.weight >= 2 && k.forms.some((f) => mentions(req.text, f))).length;
    out[req.id] = (CATEGORY_WEIGHT[req.category] ?? 0.5) + (r?.countsTowardCoverage ? 0.5 : 0) + Math.min(2, kw) * 0.5;
  }
  return out;
}

/** Every résumé line the bullets could replace or duplicate (work and project entries). */
export function resumeLines(src: ResumeSource): Record<string, string> {
  return Object.fromEntries(
    src.resume.experiences
      .filter((e) => !isExcludedExperience(e) && e.type !== "education")
      .flatMap((e) => e.responsibilities.map((t, i) => [`experiences[${e.id}].responsibilities[${i}]`, t] as const)),
  );
}

export async function jobSpecificBullets(
  ctx: AppContext,
  input: { job: NormalizedJob; src: ResumeSource; results: RequirementResult[]; keywords: JobKeyword[] },
): Promise<GeneratedBulletSet> {
  const profiles = await experienceProfiles(ctx, input.src);
  return generateJobSpecificBullets({ job: input.job, importance: requirementImportance(input.job, input.results, input.keywords) }, profiles, {
    ai: ctx.ai,
    logger: ctx.logger,
    existing: resumeLines(input.src),
    budgetMs: 90_000,
  });
}
