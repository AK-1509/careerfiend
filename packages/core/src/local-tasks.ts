import { ingestResume } from "@careerfiend/profile";
import type { AppContext } from "./context";
import { loadResumeSource, resumeRepoHead, resumeSourceConfigured } from "./resume-source";
import { enqueue } from "./queue";

/**
 * Profile maintenance tasks. In the single-user edition these needed the
 * worker's computer (a git checkout, private files); in the public edition the
 * résumé lives in the database, so only re-extracting its facts is left.
 */
export type LocalTask = "reingest-resume";

export interface LocalTaskResult {
  task: LocalTask;
  ok: boolean;
  message: string;
  at: string;
}

const LAST_RESULT = "localTask.last";
const RESUME_HEAD = "resume.head";

export async function runLocalTask(ctx: AppContext, task: LocalTask): Promise<string> {
  switch (task) {
    case "reingest-resume": {
      const r = await ingestResume(ctx.db, await loadResumeSource(ctx));
      await recordResumeHead(ctx);
      return r.created ? `Résumé ${r.commit} read (${r.factCount} facts).` : `Already current (résumé ${r.commit}).`;
    }
  }
}

export async function requestLocalTask(ctx: AppContext, task: LocalTask): Promise<string> {
  const message = await runLocalTask(ctx, task);
  await putSetting(ctx, LAST_RESULT, JSON.stringify({ task, ok: true, message, at: ctx.now().toISOString() } satisfies LocalTaskResult));
  return message;
}

export async function queueLocalTask(ctx: AppContext, task: LocalTask): Promise<void> {
  await enqueue(ctx.db, "LOCAL_TASK", { task }, { dedupeKey: `local:${task}:${ctx.now().getTime()}` });
}

/** Worker side: run a queued task and keep its result for the dashboard. */
export async function performLocalTask(ctx: AppContext, task: LocalTask): Promise<LocalTaskResult> {
  let result: LocalTaskResult;
  try {
    result = { task, ok: true, message: await runLocalTask(ctx, task), at: ctx.now().toISOString() };
  } catch (err) {
    const reasons = (err as { reasons?: string[] }).reasons;
    result = { task, ok: false, message: reasons?.length ? reasons.join(" ") : (err as Error).message, at: ctx.now().toISOString() };
  }
  await putSetting(ctx, LAST_RESULT, JSON.stringify(result));
  return result;
}

/** Worker start: extract the facts of a saved résumé that has none yet. */
export async function importProfileIfEmpty(ctx: AppContext): Promise<LocalTaskResult | null> {
  if (!(await resumeSourceConfigured(ctx)) || (await ctx.db.sourceDocument.count()) > 0) return null;
  return performLocalTask(ctx, "reingest-resume");
}

export async function lastLocalTask(ctx: AppContext): Promise<LocalTaskResult | null> {
  const v = await getSetting(ctx, LAST_RESULT);
  return v ? (JSON.parse(v) as LocalTaskResult) : null;
}

/** Remember the current résumé version. */
export async function recordResumeHead(ctx: AppContext): Promise<string | null> {
  const head = await resumeRepoHead(ctx);
  if (head && head !== (await getSetting(ctx, RESUME_HEAD))) await putSetting(ctx, RESUME_HEAD, head);
  return head;
}

/** The current résumé version ("v<N>"). */
export async function resumeHead(ctx: AppContext): Promise<string | null> {
  return (await resumeRepoHead(ctx)) ?? getSetting(ctx, RESUME_HEAD);
}

async function getSetting(ctx: AppContext, key: string): Promise<string | null> {
  return (await ctx.db.setting.findUnique({ where: { key } }))?.value ?? null;
}
async function putSetting(ctx: AppContext, key: string, value: string): Promise<void> {
  await ctx.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}
