import { assertPublicUrl, CareerFiendError, collapseWhitespace, type NormalizedJob, type SemanticFieldType } from "@careerfiend/shared";
import { fromJson, toJson } from "@careerfiend/db";
import { sitePolicy } from "@careerfiend/job-parser";
import {
  acceptDraft,
  classifyField,
  fieldKeyFor,
  isSensitive,
  proposeValue,
  type FieldDescriptor,
  type FieldInput,
  type ProfileContext,
} from "@careerfiend/policy";
import { currentFacts } from "@careerfiend/profile";
import type { AppContext } from "./context";
import { readStoredFile } from "./files";
import { buildProfileContext, type DocumentRefs } from "./profile-context";
import type { PageProvider } from "./prepare";
import { loadResumeSource } from "./resume-source";

/**
 * Answer sheet (public edition). CareerFiend does not fill application forms
 * for you; instead it reads the form's questions (opening the page, never
 * typing, selecting or clicking) and lists an answer for each one to copy and
 * paste. Answers come from the same policy that filled forms in the
 * single-user edition: your résumé, your saved answers on the Profile page, the
 * tailored cover letter, and, for open questions, a draft by your language
 * model that must cite your résumé lines. Answers are computed when shown, so
 * they follow your latest profile; only the questions and the model drafts are
 * stored (never sensitive answers).
 */

export interface SheetQuestion extends FieldInput {
  /** form: read from the application form; common: a usual question (the form could not be read); asked: you added it. */
  origin: "form" | "common" | "asked";
}

export interface AnswerSheetStore {
  source?: "form" | "common";
  /** Why the form's own questions could not be read, if they could not. */
  note?: string | null;
  readAt?: string;
  formUrl?: string | null;
  questions?: SheetQuestion[];
  /** Model drafts for open questions, by fieldKey (cited résumé keys in provenance). */
  drafts?: Record<string, { answer: string; provenance: string[] }>;
}

export interface SheetRow {
  fieldKey: string;
  question: string;
  origin: SheetQuestion["origin"];
  required: boolean;
  options: string[];
  /** The text to copy, or null when only you can answer it. */
  answer: string | null;
  /** Where the answer comes from, in plain words. */
  from: string | null;
  /** What to do when there is no answer, or a caution about the one given. */
  note: string | null;
  sensitive: boolean;
}

export interface AnswerSheetView {
  source: "form" | "common";
  note: string | null;
  formUrl: string | null;
  rows: SheetRow[];
}

/** Questions most application forms ask; shown when the form itself could not be read. */
const COMMON: { label: string; control: string }[] = [
  { label: "First name", control: "text" },
  { label: "Last name", control: "text" },
  { label: "Email", control: "email" },
  { label: "Phone", control: "tel" },
  { label: "LinkedIn profile", control: "url" },
  { label: "Website or portfolio", control: "url" },
  { label: "Current location (city)", control: "text" },
  { label: "Current company", control: "text" },
  { label: "Current title", control: "text" },
  { label: "School", control: "text" },
  { label: "Degree", control: "text" },
  { label: "Resume/CV", control: "file" },
  { label: "Cover letter", control: "textarea" },
  { label: "Why are you interested in this role?", control: "textarea" },
  { label: "Tell us about a relevant project or accomplishment.", control: "textarea" },
  { label: "Are you legally authorized to work in the United States?", control: "radio" },
  { label: "Will you now or in the future require visa sponsorship?", control: "radio" },
  { label: "What are your salary expectations?", control: "text" },
  { label: "When can you start?", control: "text" },
];

function toQuestion(label: string, control: string, origin: SheetQuestion["origin"], extra: Partial<FieldInput> = {}): SheetQuestion {
  const semanticType: SemanticFieldType = classifyField({
    label,
    context: "",
    name: "",
    autocomplete: "",
    inputType: control,
    control: control as FieldDescriptor["control"],
    options: extra.options ?? [],
  });
  return {
    fieldKey: extra.fieldKey ?? fieldKeyFor(label, control),
    label,
    context: extra.context ?? "",
    semanticType,
    control,
    required: extra.required ?? false,
    options: extra.options ?? [],
    origin,
  };
}

export function commonQuestions(): SheetQuestion[] {
  return COMMON.map((q) => toQuestion(q.label, q.control, "common"));
}

async function readStore(ctx: AppContext, applicationId: string): Promise<AnswerSheetStore> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId }, select: { answerSheet: true } });
  return fromJson<AnswerSheetStore>(app.answerSheet, {});
}

async function writeStore(ctx: AppContext, applicationId: string, store: AnswerSheetStore): Promise<void> {
  await ctx.db.application.update({ where: { id: applicationId }, data: { answerSheet: toJson(store) } });
}

const MAX_DRAFTS = 6;

/** A model draft for one open question, kept only if it cites real résumé lines and invents no numbers. */
async function draftAnswer(ctx: AppContext, q: FieldInput, job: { company: string; title: string }): Promise<{ answer: string; provenance: string[] } | null> {
  if (!ctx.ai.available) return null;
  const facts = (await currentFacts(ctx.db)).filter((f) => f.kind === "responsibility" || f.kind === "summary");
  const factText = new Map(facts.map((f) => [f.key, f.text]));
  try {
    const draft = await ctx.ai.draftFreeResponse({
      question: `${q.label} ${q.context}`.trim(),
      company: job.company,
      title: job.title,
      facts: facts.slice(0, 40).map((x) => ({ key: x.key, text: x.text })),
      maxWords: 150,
    });
    const p = acceptDraft(q, draft, new Set(factText.keys()), factText);
    return p.reviewState === "FILLED" && p.value ? { answer: p.value, provenance: p.provenance } : null;
  } catch (err) {
    if (err instanceof CareerFiendError && err.retryable) throw err;
    ctx.logger.warn("answers.draft_failed", { error: err });
    return null;
  }
}

const OPEN_TYPES: SemanticFieldType[] = ["custom_free_response", "unknown"];

/**
 * Worker side, after the documents are built: read the application form's
 * questions (or fall back to the usual ones) and draft the open ones. Never
 * fails the application: any problem leaves the usual questions.
 */
export async function buildAnswerSheet(ctx: AppContext, applicationId: string, job: NormalizedJob, pages: PageProvider | null): Promise<AnswerSheetStore> {
  const prior = await readStore(ctx, applicationId);
  let questions: SheetQuestion[] = commonQuestions();
  let source: "form" | "common" = "common";
  let note: string | null = null;
  const target = job.applyUrl ?? null;
  const allowLocalhost = ctx.config.ALLOW_LOCALHOST_TARGETS === "true";
  const policy = target ? sitePolicy(target, { allowLocalhost }) : null;
  if (!target) note = "The listing has no application link, so its form could not be read.";
  else if (!policy?.automationAllowed) note = `The application form could not be read here (${policy?.note ?? "site not supported"}).`;
  else if (!pages) note = "The application form was not read.";
  else {
    try {
      if (policy.kind !== "fixture") await assertPublicUrl(target, { allowLocalhost });
      const { readApplicationForm } = await import("@careerfiend/form-engine");
      const { ATS_HOSTS } = await import("./prepare");
      const { page } = await pages.page(applicationId);
      const host = new URL(target).hostname;
      const reading = await readApplicationForm(page, {
        targetUrl: target,
        allowedHosts: [host, ...ATS_HOSTS, ...(allowLocalhost ? ["localhost", "127.0.0.1"] : [])],
      });
      await pages.release(applicationId, false);
      const read = reading.fields.filter((f) => f.control !== "hidden" && f.semanticType !== "consent" && f.semanticType !== "signature");
      if (reading.blocked) note = `The application form could not be read: ${reading.blocked} Here are the usual questions instead.`;
      else if (!read.length)
        note = "No questions were found on the application page (it may need a sign-in or a click first). Here are the usual questions instead.";
      else {
        questions = read.map((f) => ({
          fieldKey: f.fieldKey,
          label: f.label,
          context: f.context,
          semanticType: f.semanticType,
          control: f.control,
          required: f.required,
          options: f.options,
          origin: "form" as const,
        }));
        source = "form";
      }
    } catch (err) {
      await pages.release(applicationId, false).catch(() => undefined);
      ctx.logger.warn("answers.read_failed", { error: err });
      note = "The application form could not be read (the page did not load). Here are the usual questions instead.";
    }
  }
  const asked = (prior.questions ?? []).filter((q) => q.origin === "asked");
  questions = [...questions, ...asked.filter((a) => !questions.some((q) => q.fieldKey === a.fieldKey))];
  const drafts: NonNullable<AnswerSheetStore["drafts"]> = {};
  for (const q of questions.filter((x) => OPEN_TYPES.includes(x.semanticType)).slice(0, MAX_DRAFTS)) {
    const d = prior.drafts?.[q.fieldKey] ?? (await draftAnswer(ctx, q, job));
    if (d) drafts[q.fieldKey] = d;
  }
  const store: AnswerSheetStore = { source, note, readAt: ctx.now().toISOString(), formUrl: target, questions, drafts };
  await writeStore(ctx, applicationId, store);
  ctx.logger.info("answers.built", { applicationId, count: questions.length, status: source });
  return store;
}

/** Add a question you saw on the form (multi-page forms, or a form that could not be read) and get its answer. */
export async function askQuestion(ctx: AppContext, applicationId: string, text: string): Promise<SheetQuestion> {
  const label = collapseWhitespace(text).slice(0, 500);
  if (!label) throw new CareerFiendError("VALIDATION_FAILED", "Paste the question from the form.");
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId }, include: { job: true } });
  const store = fromJson<AnswerSheetStore>(app.answerSheet, {});
  const q = toQuestion(label, label.length > 60 || /\?$/.test(label) ? "textarea" : "text", "asked");
  const questions = store.questions?.length ? [...store.questions] : commonQuestions();
  if (!questions.some((x) => x.fieldKey === q.fieldKey)) questions.push(q);
  const drafts = { ...(store.drafts ?? {}) };
  if (OPEN_TYPES.includes(q.semanticType) && !drafts[q.fieldKey]) {
    const d = await draftAnswer(ctx, q, { company: app.job.company, title: app.job.title });
    if (d) drafts[q.fieldKey] = d;
  }
  await writeStore(ctx, applicationId, { ...store, source: store.source ?? "common", questions, drafts });
  return q;
}

/** Remove a question you added. */
export async function removeAskedQuestion(ctx: AppContext, applicationId: string, fieldKey: string): Promise<void> {
  const store = await readStore(ctx, applicationId);
  const questions = (store.questions ?? []).filter((q) => !(q.origin === "asked" && q.fieldKey === fieldKey));
  const drafts = { ...(store.drafts ?? {}) };
  delete drafts[fieldKey];
  await writeStore(ctx, applicationId, { ...store, questions, drafts });
}

async function documentRefs(ctx: AppContext, applicationId: string): Promise<DocumentRefs> {
  const docs = await ctx.db.generatedDocument.findMany({ where: { applicationId }, orderBy: { revisionNumber: "desc" } });
  const pick = (type: string, format: string) => docs.find((d) => d.type === type && d.format === format) ?? null;
  const resume = pick("resume", "pdf");
  const letter = pick("cover_letter", "pdf");
  const letterTxt = pick("cover_letter", "txt");
  const text = letterTxt ? ((await readStoredFile(ctx, letterTxt.path))?.toString("utf8") ?? null) : null;
  return {
    resumePath: resume?.path ?? null,
    resumeSha256: resume?.sha256 ?? null,
    coverLetterPath: letter?.path ?? null,
    coverLetterSha256: letter?.sha256 ?? null,
    coverLetterText: text?.trim() || null,
  };
}

const FROM: Record<string, string> = {
  resume: "From your résumé",
  profile: "From your saved answers (Profile page)",
  "user-answer": "Your answer",
  document: "Your tailored document",
  skills: "From your verified skills",
  "ai-draft": "Drafted by your language model from your résumé lines: read it and make it yours",
};

/** The sheet as shown: every question with an answer to copy, or what to do. */
export async function answerSheetView(ctx: AppContext, applicationId: string): Promise<AnswerSheetView> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId }, include: { job: true } });
  const store = fromJson<AnswerSheetStore>(app.answerSheet, {});
  const questions = store.questions?.length ? store.questions : commonQuestions();
  let pctx: ProfileContext | null = null;
  try {
    const src = await loadResumeSource(ctx);
    pctx = await buildProfileContext(
      ctx,
      src.resume,
      applicationId,
      { company: app.job.company, title: app.job.title, sourceUrl: app.job.sourceUrl },
      await documentRefs(ctx, applicationId),
    );
  } catch {
    pctx = null;
  }
  const rows: SheetRow[] = questions.map((q) => {
    const sensitive = isSensitive(q.semanticType);
    const base = { fieldKey: q.fieldKey, question: q.label, origin: q.origin, required: q.required, options: q.options, sensitive };
    if (!pctx) return { ...base, answer: null, from: null, note: "Add your résumé first." };
    if (q.semanticType === "resume_upload")
      return { ...base, answer: null, from: "Your tailored document", note: "Upload the tailored résumé PDF (download it on this page)." };
    if (q.semanticType === "cover_letter_upload")
      return { ...base, answer: null, from: "Your tailored document", note: "Upload the tailored cover letter PDF (download it on this page)." };
    const draft = store.drafts?.[q.fieldKey];
    const p = proposeValue(q, pctx);
    if (p.reviewState === "FILLED" && p.value !== null) {
      return { ...base, answer: p.value, from: FROM[p.source] ?? null, note: p.note };
    }
    if (draft) return { ...base, answer: draft.answer, from: FROM["ai-draft"]!, note: null };
    const needs = OPEN_TYPES.includes(q.semanticType)
      ? ctx.ai.available
        ? "Your résumé lines don't answer this one; write it yourself."
        : "Connect a language model (Settings) to get a draft, or write it yourself."
      : (p.question ?? "Only you can answer this one.");
    return {
      ...base,
      answer: null,
      from: null,
      note: sensitive ? `${needs} Save a standing answer on the Profile page (Saved answers) to have it here next time.` : needs,
    };
  });
  return { source: store.source ?? "common", note: store.note ?? null, formUrl: store.formUrl ?? app.job.applyUrl ?? null, rows };
}
