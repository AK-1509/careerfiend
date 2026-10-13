import {
  collapseWhitespace,
  normalizeLabel,
  randomId,
  stableId,
  type DegreeLevel,
  type InventorySkill,
  type NormalizedJob,
  type Requirement,
} from "@careerfiend/shared";
import { fromJson, toJson } from "@careerfiend/db";
import { readListing, sitePolicy, type ParsedListing } from "@careerfiend/job-parser";
import { matchJob, type AiMapping, type MatchResult } from "@careerfiend/matcher";
import { currentSource, findSkillByLabel, listSkills, skillToRow, type Resume } from "@careerfiend/profile";
import type { AppContext } from "./context";
import { loadResumeSource } from "./resume-source";
import { enqueue } from "./queue";
import { backfillPostedJobs, bankBackfillPending, bankFromJob, loadBank } from "./skill-bank";
import { scheduleDemandRefresh } from "./demand";
import { transition } from "./transitions";

export interface IngestResult {
  jobId: string;
  /** Set when you chose the listing (pasted link): its application was started. */
  applicationId: string | null;
  /** Keyword match for tailoring (information only). */
  coverage: number;
  duplicate: boolean;
  newSkills: string[];
}

/* ------------------------------------------------------------- profile */

function degreeLevelOf(title: string): DegreeLevel {
  if (/ph\.?\s?d|doctor/i.test(title)) return "doctorate";
  if (/master|m\.s\.|mba/i.test(title)) return "master";
  if (/bachelor|b\.s\.|b\.a\./i.test(title)) return "bachelor";
  if (/associate/i.test(title)) return "associate";
  return "none";
}

const RANK: DegreeLevel[] = ["none", "associate", "bachelor", "master", "professional", "doctorate"];

/** Highest degree completed by now, from the résumé's education entries (for degree lines in listings). */
export function degreeLevelFrom(resume: Resume, now: Date): DegreeLevel {
  const month = now.toISOString().slice(0, 7);
  let level: DegreeLevel = "none";
  for (const e of resume.experiences.filter((x) => x.type === "education")) {
    const done = !!e.endDate && e.endDate <= month;
    const l = degreeLevelOf(e.title);
    if (done && RANK.indexOf(l) > RANK.indexOf(level)) level = l;
  }
  return level;
}

export async function loadDegreeLevel(ctx: AppContext): Promise<{ degreeLevel: DegreeLevel; resume: Resume; commit: string }> {
  const src = await loadResumeSource(ctx);
  return { degreeLevel: degreeLevelFrom(src.resume, ctx.now()), resume: src.resume, commit: src.commit };
}

/* ---------------------------------------------------------- AI proposals */

/** Model-proposed requirement split, kept only where every item is verbatim page text. */
async function aiSplitIfNeeded(ctx: AppContext, parsed: ParsedListing): Promise<void> {
  const counted = parsed.job.requirements.filter((r) => r.category === "required" || r.category === "preferred");
  if (!ctx.ai.available || counted.length > 0) return;
  try {
    const split = await ctx.ai.splitRequirements({ pageText: parsed.pageText.slice(0, 20_000) });
    const page = collapseWhitespace(parsed.pageText).toLowerCase();
    const items = split.items.filter((i) => page.includes(collapseWhitespace(i.text).toLowerCase()));
    if (!items.length) return;
    const { classifyItem } = await import("@careerfiend/job-parser");
    parsed.job.requirements = items.map(
      (i, n) =>
        ({
          id: stableId("req", parsed.job.canonicalUrl, `ai${n}`, i.text),
          category: i.category,
          text: collapseWhitespace(i.text),
          ...classifyItem(i.text),
        }) as Requirement,
    );
  } catch (err) {
    ctx.logger.warn("ai.split_failed", { error: err });
  }
}

async function aiMappings(
  ctx: AppContext,
  job: NormalizedJob,
  skills: InventorySkill[],
): Promise<{ mappings: AiMapping[]; labels: { requirementId: string; label: string }[] }> {
  if (!ctx.ai.available) return { mappings: [], labels: [] };
  const reqs = job.requirements.filter((r) => r.category === "required" || r.category === "preferred").map((r) => ({ id: r.id, text: r.text }));
  if (!reqs.length) return { mappings: [], labels: [] };
  try {
    const out = await ctx.ai.proposeMappings({ requirements: reqs, skills: skills.map((s) => ({ id: s.id, label: s.label, aliases: s.aliases })) });
    const ids = new Set(skills.map((s) => s.id));
    const reqById = new Map(reqs.map((r) => [r.id, r.text]));
    return {
      mappings: out.mappings.filter((m) => reqById.has(m.requirementId)).map((m) => ({ ...m, skillIds: m.skillIds.filter((id) => ids.has(id)) })),
      // A proposed label must literally appear in its requirement (the model may not invent skills).
      labels: out.newSkillLabels.filter(
        (l) => reqById.has(l.requirementId) && normalizeLabel(reqById.get(l.requirementId)!).includes(normalizeLabel(l.label)) && l.label.length <= 60,
      ),
    };
  } catch (err) {
    ctx.logger.warn("ai.mapping_failed", { error: err });
    return { mappings: [], labels: [] };
  }
}

/* ---------------------------------------------------------- auto-append */

/** D4: append unknown required skills as UNVERIFIED (de-duplicated). Never counted until confirmed. */
export async function appendUnknownSkills(ctx: AppContext, jobId: string, items: { label: string; requirement: string }[]): Promise<string[]> {
  const appended: string[] = [];
  for (const item of items) {
    const all = await listSkills(ctx.db);
    const existing = findSkillByLabel(all, item.label);
    if (existing) {
      if (existing.origin === "job-description") {
        const n = Number(/Required by (\d+) listing/.exec(existing.basis ?? "")?.[1] ?? 1) + 1;
        await ctx.db.skill.update({ where: { id: existing.id }, data: { basis: `Required by ${n} listings. No resume evidence found.` } });
      }
      continue;
    }
    let id = normalizeLabel(item.label)
      ? item.label
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[^a-z0-9+#]+/g, "-")
          .replace(/^-|-$/g, "")
      : `skill-${Date.now()}`;
    if (await ctx.db.skill.findUnique({ where: { id } })) id = `${id}-${stableId("s", item.label).slice(2, 8)}`;
    const skill: InventorySkill = {
      id,
      label: item.label,
      aliases: [],
      category: "tool",
      status: "UNVERIFIED",
      origin: "job-description",
      inResumeRegistry: false,
      evidence: [],
      firstSeen: { jobId, requirement: item.requirement },
      suggestedEvidence: [],
      basis: "Required by 1 listing. No resume evidence found.",
    };
    await ctx.db.skill.create({ data: skillToRow(skill) });
    await ctx.db.skillStatusEvent.create({
      data: { id: randomId("sse"), skillId: id, from: null, to: "UNVERIFIED", actor: "system:job-description", reason: `Required by job ${jobId}` },
    });
    appended.push(id);
  }
  return appended;
}

/* --------------------------------------------------------------- ingest */

export async function storeMatch(ctx: AppContext, jobId: string, m: MatchResult): Promise<void> {
  await ctx.db.requirementMatch.deleteMany({ where: { jobId } });
  await ctx.db.requirementMatch.createMany({
    data: m.results.map((r) => ({
      id: stableId("rm", jobId, r.requirement.id),
      jobId,
      requirementId: r.requirement.id,
      category: r.requirement.category,
      kind: r.requirement.kind,
      text: r.requirement.text,
      skillIds: toJson([...r.skillIds, ...r.unverifiedSkillIds]),
      evidenceKeys: toJson(r.evidenceKeys),
      confidence: r.confidence,
      status: r.status,
      note: r.note,
    })),
  });
}

export interface IngestOptions {
  source?: NormalizedJob["source"];
  /** You chose this listing (a pasted link): bank its skills and start its application. */
  endorse?: boolean;
}

export async function ingestUrl(ctx: AppContext, url: string, opts: IngestOptions = {}): Promise<IngestResult> {
  const parsed = await readListing(url, {
    html: ctx.fetchers?.html,
    json: ctx.fetchers?.json,
    atsBases: ctx.fetchers?.atsBases,
    ignoreRobots: ctx.fetchers?.ignoreRobots,
    allowLocalhost: ctx.config.ALLOW_LOCALHOST_TARGETS === "true",
  });
  return ingestParsed(ctx, parsed, opts);
}

export async function ingestParsed(ctx: AppContext, parsed: ParsedListing, opts: IngestOptions = {}): Promise<IngestResult> {
  const job = parsed.job;
  if (opts.source) job.source = opts.source;
  const existing =
    (await ctx.db.job.findUnique({ where: { canonicalUrl: job.canonicalUrl } })) ??
    (await ctx.db.job.findFirst({ where: { contentHash: parsed.contentHash } }));
  if (existing) {
    // Pasting a listing CareerFiend already knows (a watchlist find, an older read) starts its application.
    if (opts.endorse && !existing.endorsed) {
      const stored = fromJson<NormalizedJob | null>(existing.normalized, null);
      if (stored) await bankFromJob(ctx, existing.id, stored, await listSkills(ctx.db));
      await ctx.db.job.update({ where: { id: existing.id }, data: { endorsed: true } });
    }
    const applicationId = opts.endorse
      ? await startApplication(ctx, existing.id, "Listing you added")
      : ((await ctx.db.application.findFirst({ where: { jobId: existing.id }, orderBy: { createdAt: "desc" } }))?.id ?? null);
    return { jobId: existing.id, applicationId, duplicate: true, newSkills: [], coverage: existing.coverage ?? 0 };
  }

  await aiSplitIfNeeded(ctx, parsed);
  const jobId = stableId("job", job.canonicalUrl);
  const skills = await listSkills(ctx.db);
  const { degreeLevel } = await loadDegreeLevel(ctx);
  const ai = await aiMappings(ctx, job, skills);
  const endorsed = !!opts.endorse;
  // A listing you chose feeds the skill bank first, so its skills carry over to later applications.
  const banked = endorsed ? await bankFromJob(ctx, jobId, job, skills, ai.labels) : null;
  const m = matchJob(job, skills, { degreeLevel, aiMappings: ai.mappings, bank: await loadBank(ctx) });

  // Facts for your review only; none of them stops the application.
  const warnings = [...parsed.warnings.map((w) => ({ code: w.split(":")[0]!, message: w })), ...m.warnings];
  if (job.expired) warnings.push({ code: "LISTING_MAY_BE_CLOSED", message: "The page says this posting may be closed or expired." });
  const sameRole = await ctx.db.job.findMany({ where: { company: job.company } });
  for (const j of sameRole) {
    if (normalizeLabel(j.title) !== normalizeLabel(job.title)) continue;
    const a = await ctx.db.application.findFirst({
      where: { jobId: j.id, state: { in: ["SUBMITTED", "CONFIRMATION_RECEIVED", "RESPONDED", "INTERVIEW", "OFFER", "SUBMITTING", "SUBMISSION_UNCERTAIN"] } },
    });
    if (a) {
      warnings.push({ code: "ALREADY_APPLIED", message: `You already applied to ${job.company} for ${job.title}.` });
      break;
    }
  }
  const policy = sitePolicy(job.applyUrl ?? job.canonicalUrl, { allowLocalhost: ctx.config.ALLOW_LOCALHOST_TARGETS === "true" });
  if (!policy.automationAllowed && policy.kind !== "fixture") warnings.push({ code: "SITE_NOT_PERMITTED", message: policy.note });

  await ctx.db.job.create({
    data: {
      id: jobId,
      sourceUrl: job.sourceUrl,
      canonicalUrl: job.canonicalUrl,
      applyUrl: job.applyUrl,
      company: job.company,
      title: job.title,
      location: job.location.raw,
      compensation: job.compensation,
      normalized: toJson(job),
      description: job.description,
      snapshotPath: null,
      contentHash: parsed.contentHash,
      source: job.source,
      endorsed,
      coverage: m.coverage,
      gaps: toJson(m.gaps),
      warnings: toJson(warnings),
    },
  });
  await storeMatch(ctx, jobId, m);
  const newSkills = await appendUnknownSkills(ctx, jobId, [
    ...m.newSkills,
    ...ai.labels.map((l) => ({ label: l.label, requirement: job.requirements.find((r) => r.id === l.requirementId)?.text ?? l.label })),
  ]);
  const applicationId = endorsed ? await startApplication(ctx, jobId, "Listing you added", commit(ctx)) : null;
  ctx.logger.info("job.ingested", { jobId, status: applicationId ? "application started" : "found", count: m.results.length });
  if (banked) ctx.logger.info("bank.harvested", { jobId, count: banked.added });
  return { jobId, applicationId, duplicate: false, newSkills, coverage: m.coverage };
}

function commit(ctx: AppContext): Promise<string | null> {
  return currentSourceCommit(ctx);
}

/**
 * Start (or return) the application for a job you chose. This is the only
 * way an application is created, and it is always your action: a pasted
 * link, or Apply on a watchlist find. Nothing here judges fit.
 */
export async function startApplication(ctx: AppContext, jobId: string, reason: string, sourceCommit?: Promise<string | null>): Promise<string> {
  const open = await ctx.db.application.findFirst({ where: { jobId, state: { notIn: ["CLOSED"] } }, orderBy: { createdAt: "desc" } });
  if (open) return open.id;
  await scheduleDemandRefresh(ctx); // a new job you chose: refresh the skills-to-demonstrate list soon
  const applicationId = randomId("app");
  await ctx.db.application.create({ data: { id: applicationId, jobId, state: "QUEUED", sourceCommit: (await (sourceCommit ?? commit(ctx))) ?? null } });
  await ctx.db.statusEvent.create({ data: { id: randomId("se"), applicationId, from: null, to: "QUEUED", actor: "user:dashboard", reason } });
  await enqueue(ctx.db, "PREPARE", { applicationId }, { dedupeKey: `prepare:${applicationId}` });
  return applicationId;
}

/** Apply to a job CareerFiend found (watchlist): your decision, from the Jobs page. */
export async function applyToJob(ctx: AppContext, jobId: string): Promise<string> {
  const job = await ctx.db.job.findUniqueOrThrow({ where: { id: jobId } });
  if (!job.endorsed) {
    const stored = fromJson<NormalizedJob | null>(job.normalized, null);
    if (stored) await bankFromJob(ctx, job.id, stored, await listSkills(ctx.db));
    await ctx.db.job.update({ where: { id: jobId }, data: { endorsed: true } });
  }
  await startApplication(ctx, jobId, "You pressed Apply");
  return `Started your application to ${job.company} (${job.title}). The worker fills it next.`;
}

/**
 * One time, after qualification checks were removed: every listing you added
 * that was skipped, held as a near-miss or closed below a coverage threshold
 * gets its application started. Watchlist finds you never chose are left alone.
 */
export async function releaseHeldApplications(ctx: AppContext): Promise<{ started: number; resumed: number }> {
  const KEY = "release.qualification.v1";
  if (await ctx.db.setting.findUnique({ where: { key: KEY } })) return { started: 0, resumed: 0 };
  if (await bankBackfillPending(ctx)) await backfillPostedJobs(ctx); // marks the listings you pasted earlier
  let resumed = 0;
  const held = await ctx.db.application.findMany({ where: { state: "NEEDS_INPUT", questions: { some: { kind: "SKILL_CONFIRM" } } } });
  for (const app of held) {
    await ctx.db.userQuestion.deleteMany({ where: { applicationId: app.id, kind: "SKILL_CONFIRM" } });
    const open = await ctx.db.userQuestion.count({ where: { applicationId: app.id, answeredAt: null } });
    if (open) continue;
    await transition(ctx.db, app.id, "GENERATING_DOCUMENTS", "system:release", "Qualification checks removed: preparing", {
      failureCategory: null,
      failureMessage: null,
    });
    await enqueue(ctx.db, "PREPARE", { applicationId: app.id }, { dedupeKey: `prepare:${app.id}` });
    resumed++;
  }
  let started = 0;
  for (const job of await ctx.db.job.findMany({ where: { endorsed: true } })) {
    if (await ctx.db.application.findFirst({ where: { jobId: job.id, state: { notIn: ["CLOSED"] } } })) continue;
    await startApplication(ctx, job.id, "Qualification checks removed: starting the application you added");
    started++;
  }
  await ctx.db.setting.create({ data: { key: KEY, value: ctx.now().toISOString() } });
  if (started || resumed) ctx.logger.info("release.done", { count: started + resumed });
  return { started, resumed };
}

export async function currentSourceCommit(ctx: AppContext): Promise<string | null> {
  return (await currentSource(ctx.db))?.commit ?? null;
}
