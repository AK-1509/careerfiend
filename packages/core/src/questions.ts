import { encrypt, type SemanticFieldType } from "@careerfiend/shared";
import { decideSkill, setProfileValue } from "@careerfiend/profile";
import { reusableKeyFor } from "@careerfiend/policy";
import type { AppContext } from "./context";
import { enqueue } from "./queue";
import { transition } from "./transitions";

export class QuestionError extends Error {}

/**
 * Answer an open question. FIELD answers feed the next preparation run (and,
 * when `reusable`, become a CONFIRMED_BY_USER profile rule). SKILL_CONFIRM
 * answers change the skill's status (a user action) and re-run matching.
 */
export async function answerQuestion(ctx: AppContext, questionId: string, answer: string, opts: { reusable?: boolean } = {}): Promise<{ requeued: boolean }> {
  const q = await ctx.db.userQuestion.findUniqueOrThrow({ where: { id: questionId } });
  const value = answer.trim();
  if (!value && q.kind !== "TAKEOVER") throw new QuestionError("An empty answer cannot be saved.");

  if (q.kind === "SKILL_CONFIRM") {
    // "Not sure" must never read as "no": unsure answers keep the skill UNVERIFIED.
    const unsure = /not sure|unsure|don'?t know|\?/i.test(value);
    const to = unsure ? "UNVERIFIED" : /^y/i.test(value) ? "CONFIRMED_BY_USER" : /^n/i.test(value) ? "REJECTED_BY_USER" : "UNVERIFIED";
    await decideSkill(ctx.db, q.fieldKey, to, "user:dashboard", `Answered near-miss question for application ${q.applicationId}`);
    await ctx.db.userQuestion.update({ where: { id: q.id }, data: { answer: value, answeredAt: ctx.now() } });
  } else if (q.kind === "FIELD") {
    await ctx.db.userQuestion.update({
      where: { id: q.id },
      data: { answer: q.sensitive ? encrypt(value, ctx.key()) : value, answeredAt: ctx.now(), reusable: !!opts.reusable },
    });
    if (opts.reusable) {
      const semanticType = (q.semanticType ?? "unknown") as SemanticFieldType;
      const label = q.question.split(":")[0] ?? q.question;
      await setProfileValue(
        ctx.db,
        { key: reusableKeyFor({ semanticType, label }), label, value, sensitive: q.sensitive, source: `dashboard (application ${q.applicationId})` },
        ctx.key(),
      );
    }
  } else {
    await ctx.db.userQuestion.update({ where: { id: q.id }, data: { answer: value || "resumed", answeredAt: ctx.now() } });
  }
  return { requeued: await maybeResume(ctx, q.applicationId) };
}

/** When nothing is left open, move the application back into preparation. */
export async function maybeResume(ctx: AppContext, applicationId: string): Promise<boolean> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } });
  if (app.state !== "NEEDS_INPUT") return false;
  const open = await ctx.db.userQuestion.findMany({ where: { applicationId, answeredAt: null } });
  if (open.length) return false;
  const takeover = app.takeoverRequested;
  await transition(ctx.db, applicationId, "FILLING", "user:dashboard", takeover ? "Resumed after takeover" : "All questions answered", {
    failureCategory: null,
    failureMessage: null,
    takeoverRequested: false,
  });
  await enqueue(ctx.db, "PREPARE", { applicationId, resumeTakeover: takeover }, { dedupeKey: `prepare:${applicationId}` });
  return true;
}

/** User finished a takeover in the visible browser. */
export async function resumeTakeover(ctx: AppContext, applicationId: string): Promise<boolean> {
  const q = await ctx.db.userQuestion.findUnique({ where: { applicationId_kind_fieldKey: { applicationId, kind: "TAKEOVER", fieldKey: "takeover" } } });
  if (q && !q.answeredAt) await ctx.db.userQuestion.update({ where: { id: q.id }, data: { answer: "resumed", answeredAt: ctx.now() } });
  return maybeResume(ctx, applicationId);
}
