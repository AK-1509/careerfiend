import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CareerFiendError, sha256 } from "@careerfiend/shared";
import { isExcludedExperience, resumeStringCorpus, type Resume } from "@careerfiend/profile";
import { contentTokens, rankBullets, rankSkillLabels, type RequirementResult } from "@careerfiend/matcher";
import { buildLines, checkVerbatim, initialSelection, resumePlainText, trimOnce, lineText, type Line, type ResumeSelection } from "./resume";
import { docxText, pdfText, renderLetterDocx, renderLetterPdf, renderResumeDocx, renderResumePdf, unsupportedChars } from "./render";
import type { CoverLetter } from "./cover-letter";

export const RESUME_TEMPLATE_VERSION = "resume-tailored-v3";
export const LETTER_TEMPLATE_VERSION = "letter-4part-v1";

export interface ResumeBuild {
  lines: Line[];
  selection: ResumeSelection;
  pdf: Buffer;
  docx: Buffer;
  text: string;
  pages: number;
  matchReport: MatchReportRow[];
  /** kind: content (verbatim), tailored (reworded; original kept) or keyword (Skills line). */
  provenance: { line: string; key: string | null; kind: string; original?: string }[];
  warnings: { code: string; message: string; blocking: boolean }[];
}

export interface MatchReportRow {
  requirementId: string;
  category: string;
  requirement: string;
  status: string;
  skills: string[];
  bullet: string | null;
  bulletKey: string | null;
  note: string;
}

/** Build the one-page résumé for a job (D2 as amended): selected, reordered, and tailored where a rewrite passed the source check. */
export async function buildResume(input: {
  resume: Resume;
  rawText: string;
  results: RequirementResult[];
  jobText: string;
  pageLimit: number;
  skillLabels?: Map<string, string>;
  /** Validated job-specific bullets by the key of the line they replace (@careerfiend/bullets). */
  tailored?: Record<string, string>;
  /** Lines folded into a job-specific bullet: left out of this résumé (resume.json is unchanged). */
  absorbed?: string[];
  /** Ranking bonus by line key (job-specific bullets lead and survive trimming first). */
  priority?: Record<string, number>;
  /** Listing keywords you hold or banked, for the Skills line. */
  keywords?: { label: string; key: string }[];
}): Promise<ResumeBuild> {
  const { resume } = input;
  const absorbed = new Set(input.absorbed ?? []);
  const bullets = resume.experiences
    .filter((e) => !isExcludedExperience(e))
    .flatMap((e) => e.responsibilities.map((text, i) => ({ key: `experiences[${e.id}].responsibilities[${i}]`, experienceId: e.id, text })))
    .filter((b) => !absorbed.has(b.key));
  const ranked = rankBullets(bullets, input.results, input.jobText)
    .map((b) => ({ ...b, score: b.score + (input.priority?.[b.key] ?? 0) }))
    .sort((a, b) => b.score - a.score);
  const rankedSkills = rankSkillLabels(resume.skills, input.results, input.jobText);
  const selection = initialSelection(resume, ranked, rankedSkills, isExcludedExperience);
  selection.tailored = { ...(input.tailored ?? {}) };
  for (const key of absorbed) selection.dropped.push({ key, reason: "folded into a job-specific bullet" });
  const have = new Set(resume.skills.map((s) => s.label.toLowerCase()));
  selection.keywords = (input.keywords ?? []).filter((k) => !have.has(k.label.toLowerCase()));

  // The trimming order is deterministic, so binary-search the number of
  // removals: the fewest trims that fit the page limit (about log2(n) renders).
  const withTrims = (k: number): ResumeSelection => {
    const sel = structuredClone(selection);
    for (let i = 0; i < k; i++) if (!trimOnce(sel)) break;
    return sel;
  };
  let maxTrims = 0;
  for (const probe = structuredClone(selection); trimOnce(probe);) maxTrims++;
  const render = async (sel: ResumeSelection) => {
    const l = buildLines(resume, sel);
    return { sel, lines: l, pdf: await renderResumePdf(l) };
  };
  let best = await render(selection);
  if (best.pdf.pages > input.pageLimit) {
    let lo = 1;
    let hi = maxTrims;
    let fit: Awaited<ReturnType<typeof render>> | null = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const attempt = await render(withTrims(mid));
      if (attempt.pdf.pages <= input.pageLimit) {
        fit = attempt;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    best = fit ?? (await render(withTrims(maxTrims)));
  }
  Object.assign(selection, best.sel);
  const lines = best.lines;
  const pdf = best.pdf;
  const warnings: ResumeBuild["warnings"] = [];
  if (pdf.pages > input.pageLimit) {
    warnings.push({
      code: "PAGE_LIMIT_EXCEEDED",
      message: `Résumé is ${pdf.pages} pages after trimming everything allowed (limit ${input.pageLimit}).`,
      blocking: true,
    });
  }

  const problems = checkVerbatim(lines, resumeStringCorpus(input.rawText), resume, {
    tailored: selection.tailored,
    keywords: new Set(selection.keywords.map((k) => `${k.key}|${k.label}`)),
  });
  if (problems.length) {
    throw new CareerFiendError("DOCUMENT_GENERATION_FAILED", `Résumé failed the verbatim check: ${problems.map((p) => `${p.span} (${p.problem})`).join("; ")}`);
  }
  const bad = unsupportedChars(lines.map(lineText).join("\n"));
  if (bad.length)
    warnings.push({ code: "PDF_GLYPHS", message: `Characters the PDF font cannot show: ${bad.join(" ")}. Check the PDF preview.`, blocking: false });

  const text = resumePlainText(lines);
  const docx = await renderResumeDocx(lines);

  // Verify outputs open and contain the expected text.
  const docxBody = await docxText(docx);
  const pdfBody = await pdfText(pdf.buffer);
  const normalize = (s: string) => s.replace(/\s+/g, " ");
  const firstBullet = lines.find((l) => l.style === "bullet");
  for (const [name, body] of [
    ["DOCX", docxBody],
    ["PDF", pdfBody.text],
  ] as const) {
    if (!normalize(body).includes(normalize(resume.profile.name)))
      throw new CareerFiendError("DOCUMENT_GENERATION_FAILED", `${name} does not contain the name.`);
    if (firstBullet && name === "DOCX" && !normalize(body).includes(normalize(lineText(firstBullet)))) {
      throw new CareerFiendError("DOCUMENT_GENERATION_FAILED", `${name} is missing résumé text.`);
    }
  }
  if (pdfBody.pages !== pdf.pages) throw new CareerFiendError("DOCUMENT_GENERATION_FAILED", "PDF page count mismatch after re-reading.");

  const included = new Set(lines.flatMap((l) => l.spans.filter((s) => s.key).map((s) => s.key!)));
  const includedBullets = ranked.filter((b) => included.has(b.key));
  const matchReport: MatchReportRow[] = input.results
    .filter((r) => r.status !== "NOT_APPLICABLE" || r.requirement.category === "logistics")
    .map((r) => {
      let best = includedBullets.find((b) => r.evidenceKeys.includes(b.key)) ?? null;
      if (!best && (r.status === "COVERED" || r.status === "TRANSFERABLE")) {
        const reqTokens = contentTokens(r.requirement.text);
        best =
          includedBullets
            .map((b) => ({ b, overlap: [...contentTokens(b.text)].filter((t) => reqTokens.has(t)).length }))
            .filter((x) => x.overlap > 0)
            .sort((a, b) => b.overlap - a.overlap)[0]?.b ?? null;
      }
      return {
        requirementId: r.requirement.id,
        category: r.requirement.category,
        requirement: r.requirement.text,
        status: r.status,
        skills: r.skillIds.map((id) => input.skillLabels?.get(id) ?? id),
        bullet: best ? (selection.tailored[best.key] ?? best.text) : null,
        bulletKey: best?.key ?? null,
        note: r.note,
      };
    });

  return {
    lines,
    selection,
    pdf: pdf.buffer,
    docx,
    text,
    pages: pdf.pages,
    matchReport,
    provenance: lines.map((l) => {
      const span = l.spans.find((s) => s.kind === "content" || s.kind === "tailored" || s.kind === "keyword");
      const kind = l.spans.some((s) => s.kind === "tailored") ? "tailored" : l.spans.some((s) => s.kind === "keyword") ? "keyword" : "content";
      return { line: lineText(l), key: span?.key ?? null, kind, ...(span?.original ? { original: span.original } : {}) };
    }),
    warnings,
  };
}

export interface LetterBuild {
  pdf: Buffer;
  docx: Buffer;
  text: string;
}

export async function buildLetterFiles(letter: CoverLetter, header: string[]): Promise<LetterBuild> {
  const pdf = await renderLetterPdf(letter.paragraphs, header);
  const docx = await renderLetterDocx(letter.paragraphs, header);
  const text = [...header, "", ...letter.paragraphs.flatMap((p) => [p, ""])].join("\n");
  const body = await docxText(docx);
  if (letter.paragraphs[0] && !body.includes(letter.paragraphs[0].slice(0, 40))) {
    throw new CareerFiendError("DOCUMENT_GENERATION_FAILED", "Cover-letter DOCX is missing its text.");
  }
  return { pdf: pdf.buffer, docx, text };
}

export interface WrittenFile {
  type: "resume" | "cover_letter";
  format: "pdf" | "docx" | "txt";
  path: string;
  sha256: string;
}

/** Write generated files under private/output/<applicationId>/r<revision>/. */
export function writeDocuments(
  dir: string,
  files: { type: WrittenFile["type"]; format: WrittenFile["format"]; name: string; data: Buffer | string }[],
): WrittenFile[] {
  mkdirSync(dir, { recursive: true });
  return files.map((f) => {
    const p = path.join(dir, f.name);
    writeFileSync(p, f.data);
    return { type: f.type, format: f.format, path: p, sha256: sha256(typeof f.data === "string" ? Buffer.from(f.data) : f.data) };
  });
}
