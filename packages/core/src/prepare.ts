import path from "node:path";
import type { Page } from "playwright";
import {
  CareerFiendError,
  encrypt,
  randomId,
  stableId,
  type ApplicationState,
  normalizeLabel,
  type FormFieldManifest,
  type InventorySkill,
  type NormalizedJob,
  type Warning,
} from "@careerfiend/shared";
import { fromJson, toJson } from "@careerfiend/db";
import { sitePolicy } from "@careerfiend/job-parser";
import { jobKeywords, keywordCoverage, matchJob, rankBullets, type BankEntry, type JobKeyword, type RequirementResult } from "@careerfiend/matcher";
import { currentFacts, ingestResume, isExcludedExperience, listSkills, type ResumeSource } from "@careerfiend/profile";
import {
  buildLetterFiles,
  buildResume,
  generateCoverLetter,
  writeDocuments,
  LETTER_TEMPLATE_VERSION,
  RESUME_TEMPLATE_VERSION,
  type CoverLetter,
  type FallbackBullet,
} from "@careerfiend/documents";
import { acceptDraft, ALWAYS_REVIEW_TYPES, isSensitive, proposeValue, reusableKeyFor, type Proposal } from "@careerfiend/policy";
// The form engine (Playwright) loads only when a worker fills a form, never in a hosted dashboard.
import type { InspectedField, PrepareResult } from "@careerfiend/form-engine";
import type { AppContext } from "./context";
import { localFile, materialize, storeDir, storeFiles } from "./files";
import { loadResumeSource } from "./resume-source";
import { degreeLevelFrom } from "./ingest";
import { githubFactsFor, loadBank } from "./skill-bank";
import { jobSpecificBullets } from "./bullets";
import type { GeneratedBulletSet } from "@careerfiend/bullets";
import { buildProfileContext, type DocumentRefs } from "./profile-context";
import { createRevision, type RevisionAnswer, type RevisionPayload } from "./revision";
import { ensureState, transition } from "./transitions";
import { buildAnswerSheet } from "./answer-sheet";

/** Supplies a browser page per application; keeps it open during a takeover. */
export interface PageProvider {
  page(applicationId: string): Promise<{ page: Page; reused: boolean }>;
  release(applicationId: string, keepOpen: boolean): Promise<void>;
}

export const ATS_HOSTS = ["greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "workday.com", "smartrecruiters.com", "icims.com", "jobvite.com"];

export interface DocumentSet {
  draftNumber: number;
  dir: string;
  resumePdf: { path: string; sha256: string };
  letterPdf: { path: string; sha256: string };
  letter: CoverLetter;
  documents: RevisionPayload["documents"];
  warnings: Warning[];
}

function outputDir(ctx: AppContext, applicationId: string, n: number): string {
  return path.join(ctx.config.paths.outputDir, applicationId, `r${n}`);
}

async function nextDraftNumber(ctx: AppContext, applicationId: string): Promise<number> {
  const last = await ctx.db.applicationRevision.findFirst({ where: { applicationId }, orderBy: { number: "desc" } });
  return (last?.number ?? 0) + 1;
}

/** Keep the resume source current (D1): a new HEAD becomes a new SourceDocument version. */
export async function syncSource(ctx: AppContext): Promise<ResumeSource> {
  const src = await loadResumeSource(ctx);
  await ingestResume(ctx.db, src);
  return src;
}

/* ------------------------------------------------------------ documents */

/**
 * ATS tailoring (D2 as amended): what the AI does with the job description.
 * It never judges fit; it shapes your résumé toward the listing:
 *  - Skills line: listing keywords you hold (verified/confirmed) or banked,
 *    in the listing's wording, after your résumé skills.
 *  - Bullets: job-specific bullets from @careerfiend/bullets (canonical
 *    requirement templates, evidence-matched experience, grounded generation,
 *    four validators). Each replaces the résumé line it was built from; lines
 *    it folds in are left out of this résumé. resume.json is never changed.
 */
async function tailorForAts(
  ctx: AppContext,
  input: { job: NormalizedJob; src: ResumeSource; skills: InventorySkill[]; bank: BankEntry[]; results: RequirementResult[] },
): Promise<{
  keywords: JobKeyword[];
  skillsLine: { label: string; key: string }[];
  tailored: Record<string, string>;
  absorbed: string[];
  priority: Record<string, number>;
  generated: GeneratedBulletSet | null;
}> {
  const { job, skills, bank } = input;
  const resume = input.src.resume;
  const keywords = jobKeywords(job, skills, bank);
  const usable = skills.filter((s) => s.status === "VERIFIED_FROM_SOURCE" || s.status === "CONFIRMED_BY_USER");
  const banked = bank.filter((b) => b.kind === "skill");
  const norm = (t: string) => normalizeLabel(t);
  const resumeSkills = new Set(resume.skills.map((s) => norm(s.label)));

  // Skills line: keywords the listing names that you hold or banked, tools before competencies, at most 10.
  const tools: { label: string; key: string }[] = [];
  const competencies: { label: string; key: string }[] = [];
  for (const k of keywords) {
    const forms = new Set(k.forms.map(norm));
    if ([...forms].some((f) => resumeSkills.has(f))) continue;
    const held = usable.find((s) => forms.has(norm(s.label)) || s.aliases.some((a) => forms.has(norm(a))));
    const b = held ? null : banked.find((x) => forms.has(norm(x.label)));
    if (held) (held.category === "soft" ? competencies : tools).push({ label: k.label, key: `skill:${held.id}` });
    else if (b) (b.category === "competency" ? competencies : tools).push({ label: k.label, key: `bank:${b.id}` });
  }
  const skillsLine = [...tools, ...competencies].slice(0, 10);

  // Job-specific bullets. A failure here never blocks the application: the original lines stay.
  let generated: GeneratedBulletSet | null = null;
  try {
    generated = await jobSpecificBullets(ctx, { job, src: input.src, results: input.results, keywords });
  } catch (err) {
    ctx.logger.warn("bullets.failed", { error: err });
  }
  const bullets = generated?.bullets ?? [];
  return {
    keywords,
    skillsLine,
    tailored: Object.fromEntries(bullets.map((b) => [b.anchorId, b.text])),
    absorbed: bullets.flatMap((b) => b.absorbedIds),
    priority: Object.fromEntries(bullets.map((b) => [b.anchorId, 2 + 2 * b.relevanceScore])),
    generated,
  };
}

export async function generateDocuments(ctx: AppContext, applicationId: string, opts: { reuse?: boolean } = {}): Promise<DocumentSet> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId }, include: { job: true } });
  const job = fromJson<NormalizedJob>(app.job.normalized, null as unknown as NormalizedJob);
  const n = await nextDraftNumber(ctx, applicationId);
  const dir = outputDir(ctx, applicationId, n);

  if (opts.reuse) {
    const rows = await ctx.db.generatedDocument.findMany({ where: { applicationId, revisionNumber: n } });
    const r = rows.find((d) => d.type === "resume" && d.format === "pdf");
    const l = rows.find((d) => d.type === "cover_letter" && d.format === "pdf");
    // Fetch from the database any file this machine does not have (made elsewhere or cleaned up).
    const present = r && l ? (await Promise.all(rows.map((d) => materialize(ctx, d.path)))).every(Boolean) : false;
    if (r && l && present) {
      const letterMeta = fromJson<{ letter: CoverLetter; warnings: Warning[] }>(l.provenance, {
        letter: { paragraphs: [], sentences: [], wordCount: 0, generator: "fallback", problems: [] },
        warnings: [],
      });
      return {
        draftNumber: n,
        dir,
        resumePdf: { path: localFile(ctx, r.path), sha256: r.sha256 },
        letterPdf: { path: localFile(ctx, l.path), sha256: l.sha256 },
        letter: letterMeta.letter,
        documents: rows.map((d) => ({
          type: d.type as "resume" | "cover_letter",
          format: d.format as "pdf" | "docx" | "txt",
          path: localFile(ctx, d.path),
          sha256: d.sha256,
        })),
        warnings: [...fromJson<{ warnings: Warning[] }>(r.provenance, { warnings: [] }).warnings, ...letterMeta.warnings],
      };
    }
  }

  const src = await syncSource(ctx);
  const skills = await listSkills(ctx.db);
  const bank = await loadBank(ctx);
  const m = matchJob(job, skills, { degreeLevel: degreeLevelFrom(src.resume, ctx.now()), bank });
  const skillLabels = new Map(skills.map((s) => [s.id, s.label]));
  const ats = await tailorForAts(ctx, { job, src, skills, bank, results: m.results });
  const build = await buildResume({
    resume: src.resume,
    rawText: src.rawText,
    results: m.results,
    jobText: job.description,
    pageLimit: ctx.config.RESUME_PAGE_LIMIT,
    skillLabels,
    tailored: ats.tailored,
    absorbed: ats.absorbed,
    priority: ats.priority,
    keywords: ats.skillsLine,
  });
  const atsReport = keywordCoverage(ats.keywords, build.text);

  // Cover-letter facts (D3): resume.json facts + CONFIRMED_BY_USER skills only.
  const facts = (await currentFacts(ctx.db)).filter((f) => f.kind === "responsibility" || f.kind === "summary" || f.kind === "experience");
  const confirmed = skills.filter((s) => s.status === "CONFIRMED_BY_USER").map((s) => ({ key: `skill:${s.id}`, text: `Confirmed skill: ${s.label}` }));
  const bullets = src.resume.experiences
    .filter((e) => !isExcludedExperience(e))
    .flatMap((e) => e.responsibilities.map((text, i) => ({ key: `experiences[${e.id}].responsibilities[${i}]`, experienceId: e.id, text })));
  const ranked = rankBullets(bullets, m.results, job.description);
  const topExperienceIds = [...new Set(ranked.slice(0, 10).map((b) => b.experienceId))];
  // Résumé lines and GitHub projects that back this listing's transferable items (skill bank).
  const transferKeys = new Set(m.results.filter((r) => r.status === "TRANSFERABLE").flatMap((r) => r.evidenceKeys));
  const relevantFacts = facts.filter(
    (f) =>
      (f.experienceId && topExperienceIds.includes(f.experienceId) && !/\.(startDate|endDate|location|url|endorsedSkills)$/.test(f.key)) ||
      (transferKeys.has(f.key) && f.kind !== "experience"),
  );
  const githubFacts = await githubFactsFor(ctx, [...transferKeys]);
  const expById = new Map(src.resume.experiences.map((e) => [e.id, e]));
  const fallbackBullets: FallbackBullet[] = ranked
    .filter((b) => expById.get(b.experienceId)?.type !== "education")
    .slice(0, 8)
    .map((b) => {
      const e = expById.get(b.experienceId)!;
      return {
        key: b.key,
        text: b.text,
        experienceId: e.id,
        experienceType: e.type,
        title: e.title,
        titleKey: `experiences[${e.id}].title`,
        organization: e.organization,
        organizationKey: e.organization ? `experiences[${e.id}].organization` : null,
      };
    });
  const jobExcerpt = [
    job.requirements
      .filter((r) => r.category !== "logistics")
      .map((r) => `- ${r.text}`)
      .join("\n"),
    job.description.slice(0, 1500),
  ].join("\n\n");
  let letter: CoverLetter;
  try {
    letter = await generateCoverLetter(ctx.ai, {
      company: job.company,
      title: job.title,
      jobExcerpt,
      facts: [...relevantFacts.map((f) => ({ key: f.key, text: f.text })), ...confirmed, ...githubFacts],
      fallbackBullets,
    });
  } catch (err) {
    if (err instanceof CareerFiendError && err.retryable) throw err;
    ctx.logger.warn("letter.ai_failed", { applicationId, error: err });
    const allowed = new Map([...facts.map((f) => [f.key, f.text] as const)]);
    const { fallbackLetter } = await import("@careerfiend/documents");
    letter = fallbackLetter(job, fallbackBullets, allowed);
  }
  const header = [src.resume.profile.name, src.resume.profile.email, src.resume.profile.location, "", `${job.company}`, `Re: ${job.title}`];
  const letterFiles = await buildLetterFiles(letter, header);

  const letterWarnings: Warning[] = [];
  if (letter.problems.length) {
    letterWarnings.push({
      code: "COVER_LETTER_INVALID",
      message: `Cover letter failed validation: ${letter.problems.join(" ")} Edit it before approving.`,
      blocking: true,
      acknowledged: false,
    });
  }
  if (letter.generator === "fallback") {
    letterWarnings.push({
      code: "COVER_LETTER_FALLBACK",
      message: "No AI provider is configured, so the letter was assembled from your two most relevant bullets. Edit it for voice before approving.",
      blocking: false,
      acknowledged: false,
    });
  }
  const resumeWarnings: Warning[] = build.warnings.map((w) => ({ ...w, acknowledged: false }));

  const written = writeDocuments(dir, [
    { type: "resume", format: "pdf", name: "resume.pdf", data: build.pdf },
    { type: "resume", format: "docx", name: "resume.docx", data: build.docx },
    { type: "resume", format: "txt", name: "resume.txt", data: build.text },
    { type: "cover_letter", format: "pdf", name: "cover-letter.pdf", data: letterFiles.pdf },
    { type: "cover_letter", format: "docx", name: "cover-letter.docx", data: letterFiles.docx },
    { type: "cover_letter", format: "txt", name: "cover-letter.txt", data: letterFiles.text },
  ]);
  await storeFiles(
    ctx,
    applicationId,
    written.map((w) => w.path),
  );
  await ctx.db.generatedDocument.deleteMany({ where: { applicationId, revisionNumber: n } });
  for (const w of written) {
    const provenance =
      w.type === "resume"
        ? toJson({
            sourceCommit: src.commit,
            lines: build.provenance,
            matchReport: build.matchReport,
            ats: {
              keywords: atsReport,
              tailoredBullets: Object.keys(build.selection.tailored).length,
              rejectedRewrites: ats.generated?.metrics.discarded ?? 0,
              skillsAdded: build.selection.keywords.map((k) => k.label),
            },
            // Internal: every job-specific bullet with its requirement, evidence ledger and scores.
            generatedBullets: ats.generated
              ? {
                  bullets: ats.generated.bullets,
                  rejected: ats.generated.rejected,
                  templates: ats.generated.templates,
                  metrics: { ...ats.generated.metrics, modelCalls: ats.generated.metrics.modelCalls.length },
                }
              : null,
            dropped: build.selection.dropped,
            pages: build.pages,
            warnings: resumeWarnings,
          })
        : toJson({ letter, warnings: letterWarnings });
    await ctx.db.generatedDocument.create({
      data: {
        id: randomId("doc"),
        applicationId,
        revisionNumber: n,
        type: w.type,
        format: w.format,
        path: w.path,
        sha256: w.sha256,
        templateVersion: w.type === "resume" ? RESUME_TEMPLATE_VERSION : LETTER_TEMPLATE_VERSION,
        provenance,
      },
    });
  }
  await ctx.db.application.update({ where: { id: applicationId }, data: { sourceCommit: src.commit } });
  const pdf = (t: string) => written.find((w) => w.type === t && w.format === "pdf")!;
  return {
    draftNumber: n,
    dir,
    resumePdf: { path: pdf("resume").path, sha256: pdf("resume").sha256 },
    letterPdf: { path: pdf("cover_letter").path, sha256: pdf("cover_letter").sha256 },
    letter,
    documents: written.map((w) => ({ type: w.type, format: w.format, path: w.path, sha256: w.sha256 })),
    warnings: [...resumeWarnings, ...letterWarnings],
  };
}

/**
 * REGENERATE_DOCUMENTS: rebuild one application's résumé and cover letter in
 * place (apply-yourself, submitted, closed...). The state, any revision and
 * anything already submitted stay as they are.
 */
export async function regenerateDocuments(ctx: AppContext, applicationId: string): Promise<void> {
  const app = await ctx.db.application.findUnique({ where: { id: applicationId } });
  if (!app) return;
  if (["QUEUED", "READING_JOB", "GENERATING_DOCUMENTS", "FILLING", "SUBMITTING"].includes(app.state)) return; // preparation is rebuilding them anyway
  await generateDocuments(ctx, applicationId);
  ctx.logger.info("documents.regenerated", { applicationId });
}

/* -------------------------------------------------------------- prepare */

function jobWarnings(raw: string): Warning[] {
  return fromJson<{ code: string; message: string }[]>(raw, [])
    .filter((w) => w.code !== "SITE_NOT_PERMITTED")
    .map((w) => ({ code: w.code, message: w.message, blocking: w.code === "SUSPICIOUS" || w.code === "ALREADY_APPLIED", acknowledged: false }));
}

export interface PrepareOutcomeSummary {
  state: ApplicationState;
  category: string | null;
  message: string;
}

export async function prepare(
  ctx: AppContext,
  applicationId: string,
  pages: PageProvider,
  opts: { resumeTakeover?: boolean } = {},
): Promise<PrepareOutcomeSummary> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId }, include: { job: true } });
  const state = app.state as ApplicationState;
  if (!["QUEUED", "READING_JOB", "GENERATING_DOCUMENTS", "FILLING"].includes(state)) {
    return { state, category: null, message: `Nothing to prepare in state ${state}.` };
  }
  const actor = "worker:prepare" as const;
  const job = fromJson<NormalizedJob>(app.job.normalized, null as unknown as NormalizedJob);
  try {
    if (state === "QUEUED") await transition(ctx.db, applicationId, "READING_JOB", actor, "Reading job");
    if (state === "QUEUED" || state === "READING_JOB") {
      if (job.expired) {
        await transition(ctx.db, applicationId, "MANUAL", actor, "Listing expired", {
          failureCategory: "PAGE_CHANGED",
          failureMessage: "The listing is expired.",
        });
        return { state: "MANUAL", category: "PAGE_CHANGED", message: "Listing expired." };
      }
      await transition(ctx.db, applicationId, "GENERATING_DOCUMENTS", actor, "Generating résumé and cover letter");
    }
    // Re-entering at FILLING (answers given, takeover done) reuses this draft's documents.
    const reuse = (await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } })).state === "FILLING";
    const docs = await generateDocuments(ctx, applicationId, { reuse });
    await ensureState(ctx.db, applicationId, "FILLING", actor, "Filling the application");

    // Public edition (FORM_FILLING=off): the job is done once the documents are tailored; you apply yourself.
    if (ctx.config.FORM_FILLING !== "on") {
      // Read the form's questions (never filling it) so the answers are ready to copy and paste.
      await buildAnswerSheet(ctx, applicationId, job, pages).catch((err) => ctx.logger.warn("answers.failed", { error: err }));
      const msg = "Your tailored résumé, cover letter and form answers are ready. Apply on the employer's site, then mark it submitted.";
      await transition(ctx.db, applicationId, "MANUAL", actor, msg, { failureCategory: "DOCUMENTS_READY", failureMessage: msg });
      return { state: "MANUAL", category: "DOCUMENTS_READY", message: msg };
    }
    const target = job.applyUrl;
    const policy = target ? sitePolicy(target, { allowLocalhost: ctx.config.ALLOW_LOCALHOST_TARGETS === "true" }) : null;
    if (!target || !policy || !policy.automationAllowed) {
      const msg = !target
        ? "The listing has no application link. Documents are ready for a manual application."
        : `${policy!.note} Documents are ready for a manual application.`;
      await transition(ctx.db, applicationId, "MANUAL", actor, msg, { failureCategory: "SITE_NOT_PERMITTED", failureMessage: msg });
      return { state: "MANUAL", category: "SITE_NOT_PERMITTED", message: msg };
    }

    const src = await loadResumeSource(ctx);
    const docRefs: DocumentRefs = {
      resumePath: docs.resumePdf.path,
      resumeSha256: docs.resumePdf.sha256,
      coverLetterPath: docs.letterPdf.path,
      coverLetterSha256: docs.letterPdf.sha256,
      coverLetterText: docs.letter.paragraphs.join("\n\n"),
    };
    const pctx = await buildProfileContext(ctx, src.resume, applicationId, { company: job.company, title: job.title, sourceUrl: job.sourceUrl }, docRefs);
    const facts = (await currentFacts(ctx.db)).filter((f) => f.kind === "responsibility" || f.kind === "summary");
    const factText = new Map(facts.map((f) => [f.key, f.text]));
    const proposer = async (f: InspectedField): Promise<Proposal> => {
      const base = proposeValue(f, pctx);
      if (f.semanticType !== "custom_free_response" || base.reviewState === "FILLED" || !ctx.ai.available) return base;
      try {
        const draft = await ctx.ai.draftFreeResponse({
          question: `${f.label} ${f.context}`.trim(),
          company: job.company,
          title: job.title,
          facts: facts.slice(0, 40).map((x) => ({ key: x.key, text: x.text })),
          maxWords: 150,
        });
        return acceptDraft(f, draft, new Set(factText.keys()), factText);
      } catch (err) {
        if (err instanceof CareerFiendError && err.retryable) throw err;
        return base;
      }
    };

    const { page, reused } = await pages.page(applicationId);
    const host = new URL(target).hostname;
    const { prepareApplication: runEngine } = await import("@careerfiend/form-engine");
    const result = await runEngine(
      page,
      {
        targetUrl: target,
        outputDir: docs.dir,
        allowedHosts: [host, ...ATS_HOSTS, ...(ctx.config.ALLOW_LOCALHOST_TARGETS === "true" ? ["localhost", "127.0.0.1"] : [])],
      },
      proposer,
      !!opts.resumeTakeover && reused,
    );
    return await recordOutcome(ctx, applicationId, job, app.job.contentHash, src.commit, docs, result, pages, app.job.warnings);
  } catch (err) {
    await pages.release(applicationId, false).catch(() => undefined);
    if (err instanceof CareerFiendError && !err.retryable) {
      const cur = (await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } })).state as ApplicationState;
      if (cur !== "MANUAL")
        await transition(ctx.db, applicationId, "MANUAL", actor, err.message, { failureCategory: err.category, failureMessage: err.message });
      return { state: "MANUAL", category: err.category, message: err.message };
    }
    throw err;
  }
}

async function recordOutcome(
  ctx: AppContext,
  applicationId: string,
  job: NormalizedJob,
  jobContentHash: string,
  sourceCommit: string,
  docs: DocumentSet,
  result: PrepareResult,
  pages: PageProvider,
  jobWarningsRaw: string,
): Promise<PrepareOutcomeSummary> {
  const actor = "worker:prepare" as const;
  const key = ctx.key();
  await storeDir(ctx, applicationId, path.join(docs.dir, "steps"));
  // Field manifest rows for this draft.
  await ctx.db.formField.deleteMany({ where: { applicationId, revisionNumber: docs.draftNumber } });
  // Real forms can repeat a field key on one step (same name twice): number the repeats.
  const seenKeys = new Map<string, number>();
  for (const f of result.fields) {
    const slot = `${f.step}:${f.fieldKey}`;
    const n = seenKeys.get(slot) ?? 0;
    seenKeys.set(slot, n + 1);
    await ctx.db.formField.create({
      data: {
        id: stableId("ff", applicationId, String(docs.draftNumber), f.fieldKey, String(f.step), ...(n ? [`#${n}`] : [])),
        applicationId,
        revisionNumber: docs.draftNumber,
        step: f.step,
        fieldKey: f.fieldKey,
        label: f.label,
        control: f.control,
        semanticType: f.semanticType,
        required: f.required,
        options: toJson(f.options),
        proposedValue: f.proposedValue && f.sensitive ? encrypt(f.proposedValue, key) : f.proposedValue,
        confidence: f.confidence,
        source: f.source,
        provenance: toJson(f.provenance),
        sensitive: f.sensitive,
        reviewState: f.reviewState,
        validationMessage: f.validationMessage,
        note: f.note,
      },
    });
  }

  if (result.outcome === "READY") {
    const answers: RevisionAnswer[] = result.fields
      .filter((f) => f.control !== "file")
      .map((f) => ({
        fieldKey: f.fieldKey,
        label: f.label,
        step: f.step,
        semanticType: f.semanticType,
        control: f.control,
        required: f.required,
        value: f.reviewState === "FILLED" ? f.proposedValue : null,
        sensitive: f.sensitive,
        source: f.source,
        provenance: f.provenance,
        confidence: f.confidence,
        note: f.note,
      }));
    const uploads = result.fields
      .filter((f) => f.control === "file" && f.reviewState === "FILLED" && f.proposedValue)
      .map((f) => ({
        fieldKey: f.fieldKey,
        path: f.proposedValue!,
        sha256: f.proposedValue === docs.resumePdf.path ? docs.resumePdf.sha256 : docs.letterPdf.sha256,
      }));
    const warnings: Warning[] = [...jobWarnings(jobWarningsRaw), ...docs.warnings];
    if (result.fields.some((f) => f.source === "ai-draft"))
      warnings.push({
        code: "AI_DRAFTED_ANSWERS",
        message: "Some free-text answers were drafted by AI from cited facts. Read them before approving.",
        blocking: false,
        acknowledged: false,
      });
    if (result.fields.some((f) => ALWAYS_REVIEW_TYPES.includes(f.semanticType) && f.proposedValue))
      warnings.push({
        code: "LEGAL_ATTESTATION",
        message: "This application includes a signature, attestation or consent. Read each one before approving.",
        blocking: false,
        acknowledged: false,
      });
    const unique = warnings.filter((w, i) => warnings.findIndex((x) => x.code === w.code) === i);
    const payload: RevisionPayload = {
      version: 1,
      targetUrl: job.applyUrl!,
      finalSubmitLabel: result.finalSubmitLabel,
      jobId: (await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } })).jobId,
      jobContentHash,
      sourceCommit,
      documents: docs.documents,
      answers,
      uploads,
      coverLetter: { paragraphs: docs.letter.paragraphs, generator: docs.letter.generator },
    };
    const rev = await createRevision(ctx.db, applicationId, payload, unique, "Prepared by worker", key);
    await transition(ctx.db, applicationId, "READY_FOR_REVIEW", actor, `Revision ${rev.number} staged. ${result.message}`, {
      failureCategory: null,
      failureMessage: null,
      takeoverRequested: false,
    });
    await pages.release(applicationId, false);
    return { state: "READY_FOR_REVIEW", category: null, message: result.message };
  }

  if (result.outcome === "NEEDS_INPUT") {
    for (const q of result.questions) {
      const existing = await ctx.db.userQuestion.findUnique({ where: { applicationId_kind_fieldKey: { applicationId, kind: "FIELD", fieldKey: q.fieldKey } } });
      const field = result.fields.find((f) => f.fieldKey === q.fieldKey);
      const context = [
        field?.validationMessage ? `The site said: ${field.validationMessage}` : "",
        `Semantic type: ${q.semanticType}`,
        isSensitive(q.semanticType) ? "Sensitive: never answered without your explicit input." : "",
        `Reusable key: ${reusableKeyFor({ semanticType: q.semanticType, label: q.label })}`,
      ]
        .filter(Boolean)
        .join(" ");
      if (existing) {
        // A rejected value (validation error) must be answered again.
        await ctx.db.userQuestion.update({
          where: { id: existing.id },
          data: {
            question: q.question,
            context,
            options: toJson(q.options),
            sensitive: q.sensitive,
            ...(field?.validationMessage ? { answer: null, answeredAt: null } : {}),
          },
        });
      } else {
        await ctx.db.userQuestion.create({
          data: {
            id: randomId("uq"),
            applicationId,
            kind: "FIELD",
            fieldKey: q.fieldKey,
            semanticType: q.semanticType,
            question: q.question,
            context,
            options: toJson(q.options),
            sensitive: q.sensitive,
          },
        });
      }
    }
    await transition(ctx.db, applicationId, "NEEDS_INPUT", actor, result.message, { failureCategory: result.category, failureMessage: result.message });
    await pages.release(applicationId, false);
    return { state: "NEEDS_INPUT", category: result.category, message: result.message };
  }

  if (result.outcome === "PAUSED" && ctx.config.CAREERFIEND_MODE === "hosted") {
    // The cloud browser is invisible, so nobody can solve a CAPTCHA or sign in there: stop with the documents ready.
    const message = `${result.message} The cloud worker cannot get past this page. Your résumé and cover letter are ready below: apply at ${result.finalUrl} yourself, then mark the outcome.`;
    await transition(ctx.db, applicationId, "MANUAL", actor, message, { failureCategory: result.category, failureMessage: message });
    await pages.release(applicationId, false);
    return { state: "MANUAL", category: result.category, message };
  }

  if (result.outcome === "PAUSED") {
    const existing = await ctx.db.userQuestion.findUnique({
      where: { applicationId_kind_fieldKey: { applicationId, kind: "TAKEOVER", fieldKey: "takeover" } },
    });
    const data = { question: result.message, context: `${result.category}: ${result.finalUrl}`, answer: null, answeredAt: null };
    if (existing) await ctx.db.userQuestion.update({ where: { id: existing.id }, data });
    else await ctx.db.userQuestion.create({ data: { id: randomId("uq"), applicationId, kind: "TAKEOVER", fieldKey: "takeover", ...data } });
    await transition(ctx.db, applicationId, "NEEDS_INPUT", actor, result.message, {
      failureCategory: result.category,
      failureMessage: result.message,
      takeoverRequested: true,
    });
    // Keep the page open so the user can act in the visible browser.
    await pages.release(applicationId, true);
    return { state: "NEEDS_INPUT", category: result.category, message: result.message };
  }

  await transition(ctx.db, applicationId, "MANUAL", actor, result.message, { failureCategory: result.category, failureMessage: result.message });
  await pages.release(applicationId, false);
  return { state: "MANUAL", category: result.category, message: result.message };
}

export function manifestFromRows(
  rows: {
    step: number;
    fieldKey: string;
    label: string;
    control: string;
    semanticType: string;
    required: boolean;
    options: string;
    proposedValue: string | null;
    confidence: number;
    source: string;
    provenance: string;
    sensitive: boolean;
    reviewState: string;
    validationMessage: string | null;
    note: string | null;
  }[],
): FormFieldManifest[] {
  return rows.map((r) => ({
    step: r.step,
    fieldKey: r.fieldKey,
    label: r.label,
    control: r.control as FormFieldManifest["control"],
    semanticType: r.semanticType as FormFieldManifest["semanticType"],
    required: r.required,
    options: fromJson<string[]>(r.options, []),
    proposedValue: r.proposedValue,
    confidence: r.confidence,
    source: r.source as FormFieldManifest["source"],
    provenance: fromJson<string[]>(r.provenance, []),
    sensitive: r.sensitive,
    reviewState: r.reviewState as FormFieldManifest["reviewState"],
    validationMessage: r.validationMessage,
    note: r.note,
  }));
}
