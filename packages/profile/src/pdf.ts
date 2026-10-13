import { collapseWhitespace } from "@careerfiend/shared";
import { ResumeSchema, type ExperienceType, type Resume, type SkillCategory } from "./resume-schema";

/**
 * Résumé PDF → resume.json (public edition).
 *
 * 1. Text extraction: pdf.js (via unpdf, no native code) positions every text
 *    run; runs are grouped into lines by baseline and joined left to right
 *    (a wide gap becomes two spaces, the usual column break before a date).
 * 2. Rules: headings split the sections, bullets and their wrapped lines become
 *    responsibilities, the lines above them become the entry header (title,
 *    organization, location, dates).
 * 3. Optional model pass (`fromStructure`): a connected language model splits
 *    the text; every value it returns must appear in the PDF text, otherwise
 *    it is dropped. The rules result is used when the model is unavailable or
 *    finds less.
 *
 * Every text value is copied from the PDF: nothing is reworded. The person
 * reviews and corrects the result on the Profile page.
 */

export interface PdfLine {
  text: string;
  x: number;
  y: number;
  /** Font size (text height) */
  size: number;
  page: number;
}

export interface PdfText {
  lines: PdfLine[];
  text: string;
  pages: number;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** Extract positioned lines from a PDF. Throws when the file is not a readable PDF. */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const lines: PdfLine[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter((i) => typeof i.str === "string" && i.str.length > 0 && i.transform);
    const rows: { y: number; items: TextItem[] }[] = [];
    for (const it of items) {
      const y = it.transform[5]!;
      const row = rows.find((r) => Math.abs(r.y - y) < 2.5);
      if (row) row.items.push(it);
      else rows.push({ y, items: [it] });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.items.sort((a, b) => a.transform[4]! - b.transform[4]!);
      let text = "";
      let end = -Infinity;
      let size = 0;
      for (const it of row.items) {
        const x = it.transform[4]!;
        const h = it.height || Math.abs(it.transform[3]!) || 10;
        size = Math.max(size, h);
        if (text && !it.str.startsWith(" ") && !text.endsWith(" ")) {
          const gap = x - end;
          if (gap > h * 1.2) text += "  ";
          else if (gap > h * 0.15) text += " ";
        }
        text += it.str;
        end = x + it.width;
      }
      const clean = text.replace(/\s+$/, "").replace(/^\s+/, "");
      if (!clean.trim()) continue;
      lines.push({ text: clean, x: row.items[0]!.transform[4]!, y: row.y, size, page: p });
    }
  }
  await pdf.cleanup?.().catch?.(() => undefined);
  return { lines, text: lines.map((l) => l.text).join("\n"), pages: pdf.numPages };
}

/* ------------------------------------------------------------ drafts */

export interface DraftExperience {
  type: ExperienceType;
  title: string;
  organization: string;
  location: string;
  start: string;
  end: string | null;
  url?: string;
  bullets: string[];
}

/** Intermediate result of the rules or the model, before ids and the skills registry are built. */
export interface ResumeDraftInput {
  name: string;
  headline: string;
  location: string;
  email: string;
  links: { label: string; url: string }[];
  experiences: DraftExperience[];
  skills: { label: string; category: SkillCategory }[];
  languages: string[];
}

export interface ParsedResume {
  resume: Resume;
  /** What to check on the Profile page. */
  notes: string[];
}

/* ------------------------------------------------------------- dates */

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};
const MONTH_WORD =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const ONE_DATE = `(?:(?:spring|summer|fall|autumn|winter)\\s+\\d{4}|${MONTH_WORD}\\s*,?\\s*\\d{4}|\\d{1,2}\\s*/\\s*\\d{4}|\\d{4})`;
const NOW = "(?:present|current|now|today|ongoing)";
const RANGE_RE = new RegExp(`(${ONE_DATE})\\s*(?:–|—|-|to|until)\\s*(${ONE_DATE}|${NOW})`, "i");
const SINGLE_RE = new RegExp(`(?:expected\\s+|graduat(?:ed|ion|ing)\\s*:?\\s*|anticipated\\s+)?(${ONE_DATE})(?![\\d])`, "i");

/** "Jan 2023" → "2023-01", "05/2022" → "2022-05", "2021" → "2021", "Present" → null. */
export function parseResumeDate(raw: string): string | null | undefined {
  const t = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!t) return undefined;
  if (new RegExp(`^${NOW}$`, "i").test(t)) return null;
  let m = /^(\d{1,2})\s*\/\s*(\d{4})$/.exec(t);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${m[2]}-${m[1]!.padStart(2, "0")}`;
  m = /^([a-z]+)\.?\s*,?\s*(\d{4})$/.exec(t);
  if (m) {
    const season: Record<string, string> = { spring: "03", summer: "06", fall: "09", autumn: "09", winter: "12" };
    const mm = MONTHS[m[1]!.slice(0, 3)] ?? season[m[1]!];
    if (mm) return `${m[2]}-${mm}`;
  }
  m = /^(\d{4})$/.exec(t);
  if (m && Number(m[1]) > 1950 && Number(m[1]) < 2100) return m[1]!;
  return undefined;
}

/** Pull a date range (or a single date) out of a header line. */
function takeDates(line: string): { rest: string; start?: string; end?: string | null; single?: string } {
  const r = RANGE_RE.exec(line);
  if (r) {
    const start = parseResumeDate(r[1]!);
    const end = parseResumeDate(r[2]!);
    if (start !== undefined && start !== null && end !== undefined) return { rest: strip(line, r.index, r[0].length), start, end };
  }
  const s = SINGLE_RE.exec(line);
  if (s) {
    const d = parseResumeDate(s[1]!);
    if (d) return { rest: strip(line, s.index, s[0].length), single: d };
  }
  return { rest: line };
}

function strip(line: string, at: number, len: number): string {
  return `${line.slice(0, at)}  ${line.slice(at + len)}`.replace(/[|,·•–—-]\s*$/, "").trim();
}

/* ------------------------------------------------------------ sections */

type Section = "header" | "summary" | ExperienceType | "skills" | "languages" | "other";

const HEADINGS: [RegExp, Section][] = [
  [/^(professional |career )?(summary|profile|objective|about( me)?)$/, "summary"],
  [
    /^((professional|work|relevant|industry|research|leadership|volunteer(ing)?|teaching|additional|other)( and \w+)? )?(experience|experiences|employment( history)?|work history|positions)$/,
    "work",
  ],
  [/^(internships?|leadership|volunteering|activities|extracurriculars?|leadership (&|and) activities|campus involvement|involvement)$/, "work"],
  [/^((personal|selected|academic|key|technical|relevant|side) )?projects?$/, "project"],
  [/^(education( (&|and) (training|certifications))?|academic background|academics)$/, "education"],
  [
    /^((technical|core|key|relevant) )?(skills|competencies|expertise|technologies|tools)( (&|and) (interests|tools|technologies|languages|certifications))?$/,
    "skills",
  ],
  [/^(spoken )?languages$/, "languages"],
  [
    /^(certifications?|certificates|awards|honors|honors (&|and) awards|awards (&|and) honors|publications|interests|hobbies|references|achievements|courses|coursework)$/,
    "other",
  ],
];

function headingOf(line: PdfLine): Section | null {
  const t = line.text
    .trim()
    .replace(/[:：]$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (t.length > 45) return null;
  for (const [re, section] of HEADINGS) if (re.test(t)) return section;
  return null;
}

const BULLET_RE = /^\s*([•▪●◦‣►✓➢∙·*–-]|•|||o(?=\s))\s*/;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
const URL_RE = /\b((?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s|,·•]*)?)/gi;
const LOCATION_RE = /^([A-Z][A-Za-z.'-]+(?:\s[A-Z][A-Za-z.'-]+)*),\s*([A-Z]{2}|[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)*)$/;

const TITLE_WORDS =
  /\b(analyst|engineer|intern|internship|manager|associate|assistant|developer|designer|coordinator|specialist|consultant|director|lead|leader|researcher|scientist|officer|representative|volunteer|founder|co-founder|president|vice president|fellow|teacher|tutor|mentor|technician|administrator|architect|strategist|editor|writer|advisor|ambassador|chair|member|captain|head|owner|clerk|cashier|server|programmer|instructor|trainee|apprentice|partner|accountant|auditor|nurse|recruiter|producer)\b/i;
const DEGREE_WORDS =
  /\b(bachelor|master|associate'?s? degree|b\.?\s?s\.?|b\.?\s?a\.?|b\.?\s?sc|m\.?\s?s\.?|m\.?\s?a\.?|m\.?\s?sc|mba|ph\.?\s?d|doctor|diploma|certificate|minor|major|degree|high school|ged|b\.?\s?eng|m\.?\s?eng|bfa|mfa|jd|md)\b/i;
const SCHOOL_WORDS = /\b(university|college|school|institute|academy|polytechnic|universidad|université|universität)\b/i;

function looksLikeLocation(s: string): boolean {
  const t = s.trim();
  return LOCATION_RE.test(t) || /^(remote|hybrid|on-?site)\b/i.test(t);
}

function splitSegments(s: string): string[] {
  return s
    .split(/\s{2,}|\s[|·•]\s|\s[–—]\s|\s-\s|\t/)
    .map((x) => x.trim().replace(/^[|,·•–—-]\s*|\s*[|,·•–—-]$/g, ""))
    .filter(Boolean);
}

/* --------------------------------------------------------------- rules */

/** Rule-based parse of extracted lines. Always returns a valid résumé (possibly sparse) plus what to check. */
export function parseResumeLines(pdf: PdfText, opts: { fallbackEmail?: string; fallbackName?: string } = {}): ParsedResume {
  const notes: string[] = [];
  const lines = pdf.lines;

  // Split into sections.
  const sections: { kind: Section; lines: PdfLine[] }[] = [{ kind: "header", lines: [] }];
  for (const l of lines) {
    const h = headingOf(l);
    if (h) sections.push({ kind: h, lines: [] });
    else sections[sections.length - 1]!.lines.push(l);
  }
  if (sections.length === 1) notes.push("No section headings (Experience, Education, Projects, Skills) were found. Add your entries on the Profile page.");

  // Header: name, headline, contact.
  const header = sections[0]!.lines;
  const draft: ResumeDraftInput = { name: "", headline: "", location: "", email: "", links: [], experiences: [], skills: [], languages: [] };
  const nameLine = [...header.slice(0, 4)].sort((a, b) => b.size - a.size)[0];
  if (nameLine && !EMAIL_RE.test(nameLine.text) && nameLine.text.length <= 60) draft.name = splitSegments(nameLine.text)[0] ?? nameLine.text.trim();
  for (const l of header) {
    if (l === nameLine) continue;
    const email = EMAIL_RE.exec(l.text)?.[0];
    if (email && !draft.email) draft.email = email;
    const contactish = !!email || PHONE_RE.test(l.text) || /linkedin|github|https?:|\|/.test(l.text);
    if (contactish) {
      for (const seg of splitSegments(l.text.replace(/\s*[|·•]\s*/g, "  "))) {
        if (EMAIL_RE.test(seg) || PHONE_RE.test(seg)) continue;
        if (!draft.location && looksLikeLocation(seg)) draft.location = seg;
      }
      for (const m of l.text.replace(new RegExp(EMAIL_RE.source, "gi"), " ").matchAll(URL_RE)) {
        const raw = m[1]!;
        const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        try {
          const host = new URL(url).hostname.replace(/^www\./, "");
          const label = /linkedin/.test(host) ? "LinkedIn" : /github/.test(host) ? "GitHub" : /gitlab/.test(host) ? "GitLab" : "Website";
          if (!draft.links.some((x) => x.url === url)) draft.links.push({ label, url });
        } catch {
          /* not a URL after all */
        }
      }
    } else if (!draft.headline && l.text.length <= 160) draft.headline = l.text.trim();
    else if (!draft.location && looksLikeLocation(l.text)) draft.location = l.text.trim();
  }

  for (const sec of sections.slice(1)) {
    if (sec.kind === "summary") {
      const text = sec.lines.map((l) => l.text.trim()).join(" ");
      if (!draft.headline && text.length <= 200) draft.headline = text;
      else if (text) notes.push("Your summary was not copied: the résumé builder uses a one-line headline. Add one on the Profile page if you want it.");
    } else if (sec.kind === "work" || sec.kind === "project" || sec.kind === "education") {
      draft.experiences.push(...parseEntries(sec.kind, sec.lines));
    } else if (sec.kind === "skills") {
      parseSkills(sec.lines, draft);
    } else if (sec.kind === "languages") {
      for (const l of sec.lines) for (const lang of l.text.split(/[,;|•·]/)) if (lang.trim()) draft.languages.push(lang.trim());
    }
  }

  if (!draft.email) {
    if (opts.fallbackEmail) {
      draft.email = opts.fallbackEmail;
      notes.push("No email address was found on the résumé; your sign-in email is used. Change it on the Profile page if needed.");
    }
  }
  if (!draft.name) {
    draft.name = opts.fallbackName ?? "Your Name";
    notes.push("Your name could not be read. Enter it on the Profile page.");
  }
  if (!draft.experiences.length) notes.push("No experience, project or education entries were found. Add them on the Profile page.");
  const undated = draft.experiences.filter((e) => !e.start && e.end === "").length;
  if (undated) notes.push(`${undated} entr${undated === 1 ? "y has" : "ies have"} no dates. Add them on the Profile page if the résumé shows them.`);
  if (draft.experiences.some((e) => e.type === "work"))
    notes.push("Check that each job's title and organization landed in the right fields: résumés order them differently.");
  return { resume: draftToResume(draft), notes };
}

function parseEntries(type: ExperienceType, lines: PdfLine[]): DraftExperience[] {
  const out: DraftExperience[] = [];
  let header: PdfLine[] = [];
  let bullets: string[] = [];
  let bulletX = -1;
  const flush = () => {
    if (!header.length && !bullets.length) return;
    if (!header.length && out.length) {
      out[out.length - 1]!.bullets.push(...bullets);
    } else out.push(buildEntry(type, header, bullets));
    header = [];
    bullets = [];
    bulletX = -1;
  };
  for (const l of lines) {
    const b = BULLET_RE.exec(l.text);
    if (b && l.text.slice(b[0].length).trim()) {
      bullets.push(l.text.slice(b[0].length).trim());
      bulletX = l.x;
      continue;
    }
    const t = l.text.trim();
    if (bullets.length) {
      // A wrapped bullet: indented past the bullet, or starting in lower case.
      if (l.x > bulletX + 2 || /^[a-z(]/.test(t)) {
        bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${t}`;
        continue;
      }
      // Education often lists plain lines ("Relevant coursework: ...") under the degree.
      if (type === "education" && !takeDates(t).start && !takeDates(t).single && !SCHOOL_WORDS.test(t) && !DEGREE_WORDS.test(t)) {
        bullets.push(t);
        continue;
      }
      flush();
    }
    // Long plain lines under a header are descriptions, not more header.
    if (header.length >= 2 && (t.length > 90 || header.length >= 3) && !takeDates(t).start && !takeDates(t).single) {
      bullets.push(t);
      bulletX = l.x - 3;
      continue;
    }
    header.push(l);
  }
  flush();
  return out;
}

function buildEntry(type: ExperienceType, header: PdfLine[], bullets: string[]): DraftExperience {
  let start = "";
  let end: string | null = "";
  const segments: string[] = [];
  for (const l of header) {
    const d = takeDates(l.text);
    if (d.start !== undefined && !start) {
      start = d.start;
      end = d.end === undefined ? "" : d.end;
    } else if (d.single && !start && end === "") {
      if (type === "education") end = d.single;
      else start = d.single;
    }
    segments.push(...splitSegments(d.rest));
  }
  let location = "";
  const rest: string[] = [];
  for (const seg of segments) {
    // "Company, City, ST": peel a trailing location off a segment.
    const m = /^(.*?),\s*([A-Z][A-Za-z.'-]+(?:\s[A-Z][A-Za-z.'-]+)*,\s*[A-Z]{2})$/.exec(seg);
    if (!location && looksLikeLocation(seg)) location = seg;
    else if (!location && m) {
      location = m[2]!;
      rest.push(m[1]!);
    } else rest.push(seg);
  }
  let title = "";
  let organization = "";
  if (type === "education") {
    title = rest.find((s) => DEGREE_WORDS.test(s)) ?? "";
    organization = rest.find((s) => s !== title && SCHOOL_WORDS.test(s)) ?? "";
    const others = rest.filter((s) => s !== title && s !== organization);
    if (!title) title = others.shift() ?? organization;
    if (!organization && title !== others[0]) organization = others.shift() ?? "";
    // Extra segments like "Minor in Statistics" or "GPA: 3.8" stay as lines.
    bullets = [...others, ...bullets];
  } else if (type === "project") {
    title = rest[0] ?? "";
    organization = "";
    if (rest.length > 1) bullets = [...rest.slice(1), ...bullets];
  } else {
    const a = rest[0] ?? "";
    const b = rest[1] ?? "";
    if (b && !TITLE_WORDS.test(a) && TITLE_WORDS.test(b)) {
      title = b;
      organization = a;
    } else {
      title = a;
      organization = b;
    }
    if (rest.length > 2) bullets = [...rest.slice(2), ...bullets];
  }
  if (!title) title = organization || "Untitled entry";
  return { type, title, organization: organization === title ? "" : organization, location, start, end, bullets };
}

function parseSkills(lines: PdfLine[], draft: ResumeDraftInput): void {
  const text = lines.map((l) => l.text.replace(BULLET_RE, "").trim()).join("\n");
  for (const raw of text.split("\n")) {
    let line = raw;
    let category: SkillCategory = "technical";
    const pre = /^([A-Za-z &/-]{2,40}):\s*(.*)$/.exec(line);
    if (pre) {
      const label = pre[1]!.toLowerCase();
      line = pre[2]!;
      if (/^(spoken )?languages?$/.test(label.trim())) {
        for (const l of line.split(/[,;|•·]/)) if (l.trim()) draft.languages.push(l.trim());
        continue;
      }
      if (/soft|interpersonal|personal|people/.test(label)) category = "soft";
      else if (/domain|industry|knowledge|business|regulat/.test(label)) category = "domain";
    }
    for (const part of line.split(/[,;|•·]/)) {
      const label = part.trim().replace(/\.$/, "");
      if (label && label.length <= 50 && !draft.skills.some((s) => s.label.toLowerCase() === label.toLowerCase())) draft.skills.push({ label, category });
    }
  }
}

/* ------------------------------------------------------- model output */

/** Text normalized for "does this value appear in the PDF" checks. */
function norm(s: string): string {
  return collapseWhitespace(s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")).toLowerCase();
}

export interface StructuredResumeInput {
  name: string;
  headline: string;
  location: string;
  email: string;
  links: { label: string; url: string }[];
  experiences: { type: ExperienceType; title: string; organization: string; location: string; start: string; end: string; url: string; bullets: string[] }[];
  skills: { label: string; category: SkillCategory }[];
  languages: string[];
}

/**
 * Keep only what the model copied from the PDF text. Values that do not appear
 * in the text (after whitespace and dash normalization) are dropped and counted.
 */
export function fromStructure(s: StructuredResumeInput, pdfText: string, opts: { fallbackEmail?: string } = {}): ParsedResume & { dropped: number } {
  const corpus = norm(pdfText);
  // Wrapped lines join with a space; hyphenation breaks are allowed too.
  const corpusJoined = norm(pdfText.replace(/-\n/g, ""));
  let dropped = 0;
  const ok = (v: string) => {
    const t = v.trim();
    if (!t) return "";
    const n = norm(t);
    if (corpus.includes(n) || corpusJoined.includes(n)) return t;
    dropped++;
    return "";
  };
  const date = (v: string, kind: "start" | "end"): string | null => {
    if (!v.trim()) return "";
    if (!ok(v)) return "";
    const d = parseResumeDate(v.replace(/^(expected|anticipated)\s+/i, ""));
    if (d === undefined) return "";
    if (d === null) return kind === "end" ? null : "";
    return d;
  };
  const draft: ResumeDraftInput = {
    name: ok(s.name),
    headline: ok(s.headline),
    location: ok(s.location),
    email: EMAIL_RE.test(s.email) && ok(s.email) ? s.email.trim() : (opts.fallbackEmail ?? ""),
    links: s.links
      .filter((l) => ok(l.url.replace(/^https?:\/\//, "")))
      .map((l) => ({ label: l.label.trim() || "Website", url: /^https?:\/\//i.test(l.url) ? l.url.trim() : `https://${l.url.trim()}` })),
    experiences: s.experiences
      .map((e) => ({
        type: e.type,
        title: ok(e.title),
        organization: ok(e.organization),
        location: ok(e.location),
        start: (date(e.start, "start") as string) ?? "",
        end: date(e.end, "end"),
        ...(e.url && ok(e.url.replace(/^https?:\/\//, "")) ? { url: /^https?:\/\//i.test(e.url) ? e.url.trim() : `https://${e.url.trim()}` } : {}),
        bullets: e.bullets.map((b) => ok(b.replace(BULLET_RE, ""))).filter(Boolean),
      }))
      .filter((e) => e.title || e.organization)
      .map((e) => ({ ...e, title: e.title || e.organization, organization: e.title ? e.organization : "" })),
    skills: s.skills.filter((k) => ok(k.label) && k.label.length <= 50),
    languages: s.languages.filter((l) => ok(l)),
  };
  const notes: string[] = [];
  if (dropped)
    notes.push(
      `${dropped} value${dropped === 1 ? " was" : "s were"} left out because ${dropped === 1 ? "it does" : "they do"} not appear word for word in your PDF.`,
    );
  if (!draft.name) {
    draft.name = "Your Name";
    notes.push("Your name could not be read. Enter it on the Profile page.");
  }
  return { resume: draftToResume(draft), notes, dropped };
}

/* ---------------------------------------------------------- building */

export function slugify(text: string, fallback = "item"): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || fallback;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/**
 * Build a schema-valid résumé from a draft: ids from the text, a skills
 * registry, and each skill endorsed by the entries whose lines name it (that is
 * what makes a skill "verified from your résumé" later).
 */
export function draftToResume(d: ResumeDraftInput): Resume {
  const skillIds = new Set<string>();
  const skills = d.skills.map((s) => ({ id: uniqueId(slugify(s.label, "skill"), skillIds), label: s.label.trim(), category: s.category }));
  const expIds = new Set<string>();
  const languages: string[] = [];
  for (const l of d.languages) if (l.trim() && !languages.some((x) => x.toLowerCase() === l.trim().toLowerCase())) languages.push(l.trim());
  const experiences = d.experiences.map((e) => {
    const endorsed = endorsementsFor(skills, [e.title, ...e.bullets]);
    const start = e.start && /^\d{4}(-\d{2})?$/.test(e.start) ? e.start : "";
    let end = e.end === null ? null : e.end && /^\d{4}(-\d{2})?$/.test(e.end) ? e.end : "";
    if (start && end && end.slice(0, 4) < start.slice(0, 4)) end = "";
    return {
      id: uniqueId(slugify(`${e.organization} ${e.title}`, e.type), expIds),
      type: e.type,
      title: e.title.trim(),
      organization: e.organization.trim(),
      location: e.location.trim(),
      ...(e.url && /^https?:\/\//.test(e.url) ? { url: e.url } : {}),
      startDate: start,
      endDate: end,
      summary: "",
      responsibilities: e.bullets.map((b) => b.trim()).filter(Boolean),
      endorsedSkills: endorsed,
      gallery: [],
      thumbnailId: null,
    };
  });
  const candidate = {
    profile: {
      name: d.name.trim(),
      headline: d.headline.trim(),
      location: d.location.trim(),
      email: d.email.trim(),
      links: d.links.filter((l) => {
        try {
          new URL(l.url);
          return true;
        } catch {
          return false;
        }
      }),
    },
    skills,
    languages,
    experiences,
  };
  const parsed = ResumeSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  // Last resort: drop the fields that failed rather than lose the whole résumé.
  const bad = new Set(parsed.error.issues.map((i) => i.path.join(".")));
  if ([...bad].some((p) => p.startsWith("profile.email"))) candidate.profile.email = "you@example.com";
  candidate.profile.links = candidate.profile.links.filter((_, i) => ![...bad].some((p) => p.startsWith(`profile.links.${i}`)));
  return ResumeSchema.parse(candidate);
}

/** Skill ids whose label appears (as a whole word) in an entry's lines: the entry backs that skill. */
export function endorsementsFor(skills: { id: string; label: string }[], lines: string[]): string[] {
  const text = norm(lines.join(" "));
  return skills.filter((s) => new RegExp(`(^|[^a-z0-9+#])${escapeRe(norm(s.label))}($|[^a-z0-9+#])`).test(text)).map((s) => s.id);
}

/** Recompute every entry's endorsed skills from the text (after an edit on the Profile page). */
export function refreshEndorsements(resume: Resume): Resume {
  return {
    ...resume,
    experiences: resume.experiences.map((e) => ({ ...e, endorsedSkills: endorsementsFor(resume.skills, [e.title, e.summary, ...e.responsibilities]) })),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** An empty résumé to fill in by hand on the Profile page. */
export function blankResume(name: string, email: string): Resume {
  return draftToResume({ name, headline: "", location: "", email, links: [], experiences: [], skills: [], languages: [] });
}
