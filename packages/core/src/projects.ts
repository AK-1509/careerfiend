import { CareerFiendError, normalizeLabel, randomId, type NormalizedJob } from "@careerfiend/shared";
import { fromJson, toJson } from "@careerfiend/db";
import { isExcludedExperience } from "@careerfiend/profile";
import type { ProjectExperience, ProjectIdea, ProjectJobInput, ProjectMapping } from "@careerfiend/ai";
import type { AppContext } from "./context";
import { demandGaps } from "./demand";
import { loadResumeSource } from "./resume-source";
import { githubRepos } from "./skill-bank";

/**
 * Project Recommendations: small tools you could vibecode (build quickly with AI
 * coding help) that make a task many of your queued jobs ask for easier.
 *   1. mapping   - the model finds the tasks the listings share and matches each to
 *                  one real experience (work, project or public repo) that gives you
 *                  an angle on it. Private: it steers the ideas and is never shown.
 *   2. synthesis - the model writes one-line tool ideas from that mapping.
 *   3. validate  - code keeps only ideas that name several queued jobs and their real
 *                  requirements, come from a real experience without naming it, fit in
 *                  one sentence, define any jargon in parentheses, and are new.
 *                  Too few survivors: one repair round with feedback.
 * The two model steps run in separate invocations (each fits a serverless time limit).
 */

export const MIN_IDEAS = 5;
export const REFRESH_LIMIT = 3;
export const REFRESH_WINDOW_MS = 5 * 3600_000;
const MAX_JOBS = 12;
const MAX_REQUIREMENTS = 20;
/** A phase not finished after this long is considered abandoned (the function was killed). */
const STALE_MS = 6 * 60_000;
const MAX_ATTEMPTS = 3;

export class ProjectIdeasError extends Error {}

export type ProjectRunStatus = "PENDING" | "RESEARCHING" | "RESEARCHED" | "SYNTHESIZING" | "DONE" | "FAILED";

export interface ProjectRunView {
  id: string;
  trigger: string;
  status: ProjectRunStatus;
  createdAt: Date;
  finishedAt: Date | null;
  error: string | null;
  jobs: ProjectJobInput[];
  ideas: ProjectIdea[];
}

/** Why ideas cannot be generated with the current AI settings, or null when they can. */
export function projectsUnavailableReason(ctx: AppContext): string | null {
  if (ctx.ai.available) return null;
  return "Project Recommendations need a language model. Connect the model of your choice in Settings.";
}

const MAX_REPOS = 8;

/** Your real experience the ideas may draw an angle from: work and projects from the résumé, plus public GitHub repos. */
export async function projectExperiences(ctx: AppContext): Promise<ProjectExperience[]> {
  const out: ProjectExperience[] = [];
  try {
    const { resume } = await loadResumeSource(ctx);
    for (const e of resume.experiences) {
      if ((e.type !== "work" && e.type !== "project") || isExcludedExperience(e)) continue;
      const lines = [e.summary, ...e.responsibilities].map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      out.push({ ref: `experiences[${e.id}]`, kind: e.type, name: e.organization ? `${e.title} at ${e.organization}` : e.title, lines });
    }
  } catch (err) {
    ctx.logger.warn("projects.resume_unavailable", { error: err });
  }
  try {
    for (const r of (await githubRepos(ctx)).slice(0, MAX_REPOS)) {
      const lines = [r.description, r.readme.slice(0, 400)].map((l) => l.trim()).filter(Boolean);
      if (lines.length) out.push({ ref: `github:${r.ref}`, kind: "github", name: r.name, lines });
    }
  } catch (err) {
    ctx.logger.warn("github.repos_failed", { error: err });
  }
  return out;
}

/** Ideas written before the switch to one-line tools have no pitch; they are not shown or counted. */
function isCurrentIdea(i: unknown): i is ProjectIdea {
  return !!i && typeof (i as ProjectIdea).pitch === "string" && typeof (i as ProjectIdea).title === "string";
}

/** The jobs ideas are drawn from: active applications first, then the most recent other listings read. */
export async function projectQueue(ctx: AppContext): Promise<ProjectJobInput[]> {
  const active = await ctx.db.application.findMany({
    where: { state: { notIn: ["REJECTED", "CLOSED"] } },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    include: { job: true },
    take: MAX_JOBS,
  });
  const seen = new Set(active.map((a) => a.job.id));
  const rest =
    active.length >= MAX_JOBS
      ? []
      : await ctx.db.job.findMany({
          where: { id: { notIn: [...seen] } },
          orderBy: { createdAt: "desc" },
          take: MAX_JOBS - active.length,
        });
  return [...active.map((a) => a.job), ...rest].map((j) => {
    const job = fromJson<NormalizedJob | null>(j.normalized, null);
    const requirements = (job?.requirements ?? [])
      .filter((r) => ["required", "preferred", "responsibility"].includes(r.category))
      .slice(0, MAX_REQUIREMENTS)
      .map((r) => ({ id: r.id, text: r.text.slice(0, 300), category: r.category }));
    return { id: j.id, company: j.company, title: j.title, requirements };
  });
}

function view(r: {
  id: string;
  trigger: string;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  error: string | null;
  jobs: string;
  ideas: string;
}): ProjectRunView {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status as ProjectRunStatus,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    error: r.error,
    jobs: fromJson<ProjectJobInput[]>(r.jobs, []),
    ideas: fromJson<unknown[]>(r.ideas, []).filter(isCurrentIdea),
  };
}

const ACTIVE: ProjectRunStatus[] = ["PENDING", "RESEARCHING", "RESEARCHED", "SYNTHESIZING"];

/** Refreshes used in the rolling window (failed runs do not count). */
export async function refreshQuota(ctx: AppContext): Promise<{ used: number; remaining: number; limit: number; nextAt: Date | null }> {
  const since = new Date(ctx.now().getTime() - REFRESH_WINDOW_MS);
  const runs = await ctx.db.projectIdeaRun.findMany({
    where: { trigger: "refresh", status: { not: "FAILED" }, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const remaining = Math.max(0, REFRESH_LIMIT - runs.length);
  return {
    used: runs.length,
    remaining,
    limit: REFRESH_LIMIT,
    nextAt: remaining === 0 && runs[0] ? new Date(runs[0].createdAt.getTime() + REFRESH_WINDOW_MS) : null,
  };
}

/**
 * Start a run. "initial" is allowed only while no ideas exist yet; "refresh" counts
 * toward the limit of 3 per rolling 5 hours. One run at a time.
 */
export async function requestProjectIdeas(ctx: AppContext, trigger: "initial" | "refresh"): Promise<string> {
  if (!ctx.ai.available) {
    throw new ProjectIdeasError(projectsUnavailableReason(ctx) ?? "Project Recommendations is unavailable.");
  }
  const jobs = await projectQueue(ctx);
  if (!jobs.length) throw new ProjectIdeasError("Add some jobs to the queue first: ideas are built from their requirements.");
  return ctx.db.$transaction(async (tx) => {
    if (await tx.projectIdeaRun.findFirst({ where: { status: { in: ACTIVE } } })) {
      throw new ProjectIdeasError("Ideas are already being generated. Wait for that run to finish.");
    }
    const hasIdeas = (await tx.projectIdeaRun.findMany({ where: { status: "DONE" }, select: { ideas: true } })).some((r) =>
      fromJson<unknown[]>(r.ideas, []).some(isCurrentIdea),
    );
    if (trigger === "initial" && hasIdeas) throw new ProjectIdeasError("Ideas already exist; use Refresh for new ones.");
    if (trigger === "refresh") {
      const since = new Date(ctx.now().getTime() - REFRESH_WINDOW_MS);
      const used = await tx.projectIdeaRun.count({ where: { trigger: "refresh", status: { not: "FAILED" }, createdAt: { gte: since } } });
      if (used >= REFRESH_LIMIT) throw new ProjectIdeasError(`You have used all ${REFRESH_LIMIT} refreshes for the last 5 hours.`);
    }
    const id = randomId("pir");
    await tx.projectIdeaRun.create({ data: { id, trigger, status: "PENDING", jobs: toJson(jobs), createdAt: ctx.now() } });
    ctx.logger.info("projects.requested", { status: trigger });
    return id;
  });
}

export async function latestProjectRuns(
  ctx: AppContext,
): Promise<{ current: ProjectRunView | null; active: ProjectRunView | null; earlier: ProjectRunView[] }> {
  const rows = await ctx.db.projectIdeaRun.findMany({ orderBy: { createdAt: "desc" }, take: 10 });
  const views = rows.map(view);
  const active = views.find((v) => ACTIVE.includes(v.status)) ?? null;
  const done = views.filter((v) => v.status === "DONE" && v.ideas.length > 0);
  const lastFailed = views[0]?.status === "FAILED" ? views[0] : null;
  return { current: done[0] ?? null, active: active ?? lastFailed, earlier: done.slice(1, 4) };
}

async function earlierTitles(ctx: AppContext, exceptId: string): Promise<string[]> {
  const rows = await ctx.db.projectIdeaRun.findMany({ where: { status: "DONE", id: { not: exceptId } }, select: { ideas: true } });
  return rows.flatMap((r) =>
    fromJson<unknown[]>(r.ideas, [])
      .filter(isCurrentIdea)
      .map((i) => i.title),
  );
}

/** Writing rule from the research method: no em dashes. */
const clean = (s: string) =>
  s
    .replace(/\s*—\s*/g, ", ")
    .replace(/–/g, "-")
    .trim();

/** Terms an outsider would not know: the first use needs its meaning in parentheses. */
export const JARGON = [
  "null hypothesis",
  "p-value",
  "statistical significance",
  "confidence interval",
  "regression",
  "Bayesian",
  "Monte Carlo",
  "cohort",
  "embedding",
  "vector database",
  "semantic search",
  "knowledge graph",
  "ontology",
  "heuristic",
  "orchestration",
  "agentic",
  "fine-tun",
  "clustering",
  "distance matrix",
  "multidimensional scaling",
  "dimensionality reduction",
  "sentiment analysis",
  "schema",
  "LLM",
  "RAG",
  "NLP",
  "ETL",
  "KPI",
  "OKR",
  "TAM",
  "ICP",
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isAcronym = (t: string) => /^[A-Z]{2,}$/.test(t);

/** Jargon used without a parenthetical meaning right after its first use. */
export function undefinedJargon(text: string): string[] {
  const out: string[] = [];
  for (const term of JARGON) {
    const flags = isAcronym(term) ? "g" : "gi";
    const word = new RegExp(`\\b${esc(term)}\\w*`, flags);
    const first = word.exec(text);
    if (!first) continue;
    const after = text.slice(first.index + first[0].length);
    if (!/^s?\s*\(/.test(after)) out.push(term);
  }
  return out;
}

const COMMON = new Set(
  "the and for with from into your this that university college school institute center centre company group labs inc llc ltd corp project projects tool tools platform app data research analysis health science sciences technology technologies solutions systems services lab intern internship analyst associate founder cofounder engineer manager developer lead assistant member president officer researcher consultant fellow volunteer".split(
    " ",
  ),
);

/**
 * Names that would give away which experience inspired an idea: the organization
 * (work), the project's own name and organization (project), the repo name (GitHub).
 * A work title such as "Quality Intern" is not private: it is a job, not a name.
 */
export function privateTerms(e: ProjectExperience): string[] {
  const org = e.name.split(" at ").slice(1).join(" at ");
  const name = e.kind === "work" ? org || e.name : e.name.replace(" at ", " ");
  const words = name
    .replace(/[-_./]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase())
    .filter((w) => w.length >= 4 && !COMMON.has(w));
  // The whole name too, so "Data Co" is caught even though each word is common.
  const phrase = (e.kind === "github" ? e.name : org || e.name)
    .replace(/[-_./]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (phrase.includes(" ") && phrase.length >= 5) words.push(phrase);
  return [...new Set(words)];
}

/** Words outside parentheses: the one-line limit is about the sentence, not the definitions. */
function wordsOutsideParens(s: string): number {
  return s
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function sentences(s: string): number {
  return s
    .replace(/\([^)]*\)/g, " ")
    .split(/[.!?](?:\s+|$)/)
    .filter((x) => x.trim()).length;
}

/** Keep ideas that fit the rules (see the header); report why others were dropped. */
export function validateIdeas(
  ideas: ProjectIdea[],
  jobs: ProjectJobInput[],
  experiences: ProjectExperience[],
  avoid: string[],
): { kept: ProjectIdea[]; problems: string[] } {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const expByRef = new Map(experiences.map((e) => [e.ref, e]));
  const taken = new Set(avoid.map(normalizeLabel));
  const minJobs = Math.min(2, jobs.length);
  const kept: ProjectIdea[] = [];
  const problems: string[] = [];
  for (const raw of ideas) {
    const idea: ProjectIdea = {
      ...raw,
      title: clean(raw.title),
      pitch: clean(raw.pitch),
      task: clean(raw.task),
      howItHelps: clean(raw.howItHelps),
      basedOn: { experienceRef: raw.basedOn?.experienceRef ?? "", link: clean(raw.basedOn?.link ?? "") },
    };
    const why: string[] = [];
    const reqOwner = new Map(
      [...new Set(raw.jobIds)].filter((id) => jobById.has(id)).flatMap((id) => jobById.get(id)!.requirements.map((r) => [r.id, id] as const)),
    );
    const requirementIds = [...new Set(raw.requirementIds)].filter((id) => reqOwner.has(id));
    const jobIds = [...new Set(requirementIds.map((id) => reqOwner.get(id)!))];
    if (jobIds.length < minJobs) why.push(`it ties to ${jobIds.length} queued job(s) through their requirement ids (needs ${minJobs})`);
    const exp = expByRef.get(idea.basedOn.experienceRef);
    if (!exp) why.push("basedOn does not name an experience from the list");
    const visible = [idea.title, idea.pitch, idea.task, idea.howItHelps].join(" \n ");
    const leaks = exp ? privateTerms(exp).filter((t) => new RegExp(`\\b${esc(t)}\\b`, "i").test(visible)) : [];
    if (leaks.length) why.push(`it names the experience behind it (${leaks.join(", ")}); keep that private`);
    if (!idea.pitch || wordsOutsideParens(idea.pitch) > 30 || sentences(idea.pitch) > 1) why.push("the pitch is not one sentence of at most 30 words");
    if (idea.title.split(/\s+/).length > 7) why.push("the title is longer than 6 words");
    const jargon = undefinedJargon([idea.pitch, idea.howItHelps].join(" \n "));
    if (jargon.length) why.push(`define in parentheses after first use: ${jargon.join(", ")}`);
    const titleJargon = undefinedJargon(idea.title).filter((t) => new RegExp(`\\b${esc(t)}`, isAcronym(t) ? "" : "i").test(idea.title));
    if (titleJargon.length) why.push(`the title uses jargon (${titleJargon.join(", ")})`);
    if (taken.has(normalizeLabel(idea.title))) why.push("it repeats an earlier idea");
    if (why.length) {
      problems.push(`"${idea.title}": ${why.join("; ")}.`);
      continue;
    }
    taken.add(normalizeLabel(idea.title));
    kept.push({ ...idea, jobIds, requirementIds });
  }
  return { kept, problems };
}

/** Keep mapped tasks whose requirement ids and experience are real. */
export function validateMapping(
  mapping: ProjectMapping,
  jobs: ProjectJobInput[],
  experiences: ProjectExperience[],
): { asks: ProjectMapping["asks"]; problems: string[] } {
  const reqIds = new Set(jobs.flatMap((j) => j.requirements.map((r) => r.id)));
  const refs = new Set(experiences.map((e) => e.ref));
  const asks: ProjectMapping["asks"] = [];
  const problems: string[] = [];
  for (const a of mapping.asks) {
    const ids = [...new Set(a.requirementIds)].filter((id) => reqIds.has(id));
    if (!ids.length) problems.push(`"${a.ask}": no requirement id from the jobs.`);
    else if (!refs.has(a.experienceRef)) problems.push(`"${a.ask}": experienceRef ${a.experienceRef} is not in the list.`);
    else asks.push({ ask: clean(a.ask), requirementIds: ids, experienceRef: a.experienceRef, insight: clean(a.insight) });
  }
  return { asks, problems };
}

const MIN_ASKS = 3;

/** Claim the next phase of work (compare-and-swap on status), including abandoned phases. */
async function claim(ctx: AppContext): Promise<{ id: string; phase: "research" | "synthesis" } | null> {
  const stale = new Date(ctx.now().getTime() - STALE_MS);
  const candidates = await ctx.db.projectIdeaRun.findMany({
    where: {
      OR: [{ status: { in: ["PENDING", "RESEARCHED"] } }, { status: { in: ["RESEARCHING", "SYNTHESIZING"] }, updatedAt: { lt: stale } }],
    },
    orderBy: { createdAt: "asc" },
    take: 3,
  });
  for (const c of candidates) {
    if (c.attempts >= MAX_ATTEMPTS) {
      await ctx.db.projectIdeaRun.updateMany({
        where: { id: c.id, status: c.status },
        data: { status: "FAILED", error: "Generation stopped after repeated interruptions. Try again.", finishedAt: ctx.now() },
      });
      continue;
    }
    const research = c.status === "PENDING" || c.status === "RESEARCHING";
    const next = research ? "RESEARCHING" : "SYNTHESIZING";
    const won = await ctx.db.projectIdeaRun.updateMany({
      where: { id: c.id, status: c.status, updatedAt: c.updatedAt },
      data: { status: next, attempts: { increment: 1 } },
    });
    if (won.count === 1) return { id: c.id, phase: research ? "research" : "synthesis" };
  }
  return null;
}

/**
 * Run one phase of the oldest pending run. Returns whether more work is waiting
 * (the caller starts another invocation for it).
 */
export async function advanceProjectRun(ctx: AppContext): Promise<{ ran: boolean; more: boolean }> {
  const job = await claim(ctx);
  if (!job) return { ran: false, more: false };
  const run = await ctx.db.projectIdeaRun.findUniqueOrThrow({ where: { id: job.id } });
  const jobs = fromJson<ProjectJobInput[]>(run.jobs, []);
  const [avoid, focus] = await Promise.all([earlierTitles(ctx, run.id), demandGaps(ctx)]);
  try {
    if (job.phase === "research") {
      const experiences = await projectExperiences(ctx);
      if (!experiences.length) throw new CareerFiendError("VALIDATION_FAILED", "No work or project experience found in your résumé to base ideas on.");
      let checked = validateMapping(await ctx.ai.mapProjectAsks({ jobs, experiences, focus, avoid }), jobs, experiences);
      if (checked.asks.length < MIN_ASKS) {
        const again = validateMapping(await ctx.ai.mapProjectAsks({ jobs, experiences, focus, avoid, feedback: checked.problems }), jobs, experiences);
        if (again.asks.length > checked.asks.length) checked = again;
      }
      if (checked.asks.length < MIN_ASKS) {
        throw new CareerFiendError("VALIDATION_FAILED", `Could not find ${MIN_ASKS} tasks your jobs share. ${checked.problems.slice(0, 2).join(" ")}`);
      }
      await ctx.db.projectIdeaRun.update({
        where: { id: run.id },
        data: { status: "RESEARCHED", research: toJson({ mapping: { asks: checked.asks }, experiences }), sources: "[]", attempts: 0 },
      });
      ctx.logger.info("projects.mapped", { count: checked.asks.length });
      return { ran: true, more: true };
    }
    const brief = fromJson<{ mapping: ProjectMapping; experiences: ProjectExperience[] }>(run.research ?? "", { mapping: { asks: [] }, experiences: [] });
    const base = { jobs, experiences: brief.experiences, focus, avoid, mapping: brief.mapping, minimum: MIN_IDEAS };
    let result = validateIdeas(await ctx.ai.synthesizeProjectIdeas(base), jobs, brief.experiences, avoid);
    if (result.kept.length < MIN_IDEAS) {
      const ideas = await ctx.ai.synthesizeProjectIdeas({ ...base, avoid: [...avoid, ...result.kept.map((i) => i.title)], feedback: result.problems });
      const second = validateIdeas(ideas, jobs, brief.experiences, [...avoid, ...result.kept.map((i) => i.title)]);
      result = { kept: [...result.kept, ...second.kept], problems: second.problems };
    }
    if (result.kept.length < MIN_IDEAS) {
      throw new CareerFiendError(
        "VALIDATION_FAILED",
        `Only ${result.kept.length} ideas passed the checks (need ${MIN_IDEAS}). ${result.problems.slice(0, 3).join(" ")}`,
      );
    }
    await ctx.db.projectIdeaRun.update({ where: { id: run.id }, data: { status: "DONE", ideas: toJson(result.kept), finishedAt: ctx.now(), error: null } });
    ctx.logger.info("projects.done", { count: result.kept.length });
    return { ran: true, more: false };
  } catch (err) {
    const retryable = err instanceof CareerFiendError && err.retryable;
    const message = (err as Error).message.split("\n")[0]!;
    if (retryable && run.attempts + 1 < MAX_ATTEMPTS) {
      // Put the phase back so the next invocation retries it.
      await ctx.db.projectIdeaRun.update({ where: { id: run.id }, data: { status: job.phase === "research" ? "PENDING" : "RESEARCHED", error: message } });
      return { ran: true, more: true };
    }
    await ctx.db.projectIdeaRun.update({ where: { id: run.id }, data: { status: "FAILED", error: message, finishedAt: ctx.now() } });
    ctx.logger.warn("projects.failed", { status: job.phase, message });
    return { ran: true, more: false };
  }
}
