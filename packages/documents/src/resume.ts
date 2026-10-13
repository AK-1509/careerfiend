import type { Experience, Resume } from "@careerfiend/profile";
import type { RankedBullet } from "@careerfiend/matcher";

/**
 * Tailored résumé (D2 as amended 2026-10-04). Built from resume.json: a subset
 * of entries and bullets, reordered by relevance to the listing, with two
 * ATS aids that are traced to their source:
 *
 *   content  — copied verbatim from a resume.json string value
 *   tailored — a bullet reworded toward the listing's language; it keeps the
 *              original's key, and passed the source check (same numbers, no
 *              new tools beyond your skills, length bound)
 *   keyword  — a skill you hold or banked, added to the Skills line because
 *              the listing names it (key skill:<id> or bank:<id>)
 *   date     — an entry's startDate/endDate rendered as "May 2024" / "Present"
 *   label    — a fixed template label (section headings)
 *   sep      — separators (" · ", " – ", ", ")
 * The check verifies every content span against the pinned file, every
 * tailored span against its validated rewrite, every keyword against the
 * allowed list, and every date span against its entry's own dates.
 */

export type SpanKind = "content" | "tailored" | "keyword" | "date" | "label" | "sep";
export interface Span {
  text: string;
  kind: SpanKind;
  /** Provenance key for content, tailored and keyword spans. */
  key?: string;
  /** For tailored spans: the bullet as written in resume.json. */
  original?: string;
}
export type LineStyle = "name" | "headline" | "contact" | "section" | "entryTitle" | "entryMeta" | "bullet" | "list";
export interface Line {
  style: LineStyle;
  spans: Span[];
  /** Right-aligned spans (dates on the title line). */
  right?: Span[];
}

export const SECTION_LABELS = ["Education", "Experience", "Projects", "Skills", "Languages"] as const;
export const SEPARATORS = [" · ", " – ", ", "] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatMonth(ym: string | null): string {
  if (ym === null) return "Present";
  if (!ym) return "";
  const [y, m] = ym.split("-");
  return m ? `${MONTHS[Number(m) - 1]} ${y}` : y!;
}

/** Date range of an entry: "May 2024 – Present", "2020 – 2024", or just the one date that is known. */
function dateSpans(base: string, start: string, end: string | null): Span[] {
  const s = formatMonth(start);
  const e = formatMonth(end);
  if (s && e)
    return [
      { text: s, kind: "date", key: `${base}.startDate` },
      { text: " – ", kind: "sep" },
      { text: e, kind: "date", key: `${base}.endDate` },
    ];
  if (s) return [{ text: s, kind: "date", key: `${base}.startDate` }];
  if (e) return [{ text: e, kind: "date", key: `${base}.endDate` }];
  return [];
}

export interface SelectedEntry {
  experience: Experience;
  bullets: RankedBullet[];
  score: number;
}

export interface ResumeSelection {
  education: SelectedEntry[];
  experience: SelectedEntry[];
  projects: SelectedEntry[];
  skills: { id: string; label: string }[];
  /** Listing keywords you hold or banked, added after your résumé skills (ATS). */
  keywords: { label: string; key: string }[];
  /** Validated rewrites by bullet key. */
  tailored: Record<string, string>;
  languages: string[];
  dropped: { key: string; reason: string }[];
}

export function lineText(line: Line): string {
  const left = line.spans.map((s) => s.text).join("");
  const right = line.right?.map((s) => s.text).join("") ?? "";
  return right ? `${left}  ${right}` : left;
}

export function buildLines(resume: Resume, sel: ResumeSelection): Line[] {
  const p = resume.profile;
  const lines: Line[] = [];
  lines.push({ style: "name", spans: [{ text: p.name, kind: "content", key: "profile.name" }] });
  if (p.headline) lines.push({ style: "headline", spans: [{ text: p.headline, kind: "content", key: "profile.headline" }] });
  const contact: Span[] = [
    ...(p.location
      ? [
          { text: p.location, kind: "content" as const, key: "profile.location" },
          { text: " · ", kind: "sep" as const },
        ]
      : []),
    { text: p.email, kind: "content", key: "profile.email" },
  ];
  p.links.forEach((l, i) => contact.push({ text: " · ", kind: "sep" }, { text: l.url, kind: "content", key: `profile.links[${i}]` }));
  lines.push({ style: "contact", spans: contact });

  const section = (label: (typeof SECTION_LABELS)[number], entries: SelectedEntry[]) => {
    if (!entries.length) return;
    lines.push({ style: "section", spans: [{ text: label, kind: "label" }] });
    for (const e of entries) {
      const x = e.experience;
      const base = `experiences[${x.id}]`;
      lines.push({
        style: "entryTitle",
        spans: [{ text: x.title, kind: "content", key: `${base}.title` }],
        right: dateSpans(base, x.startDate, x.endDate),
      });
      const meta: Span[] = [];
      if (x.organization) meta.push({ text: x.organization, kind: "content", key: `${base}.organization` });
      if (x.location) {
        if (meta.length) meta.push({ text: " · ", kind: "sep" });
        meta.push({ text: x.location, kind: "content", key: `${base}.location` });
      }
      if (meta.length) lines.push({ style: "entryMeta", spans: meta });
      for (const b of e.bullets) {
        const t = sel.tailored[b.key];
        lines.push({
          style: "bullet",
          spans: [t ? { text: t, kind: "tailored", key: b.key, original: b.text } : { text: b.text, kind: "content", key: b.key }],
        });
      }
    }
  };
  section("Education", sel.education);
  // Experience and Projects: the more relevant section goes first.
  const expScore = sel.experience.reduce((a, e) => Math.max(a, e.score), 0);
  const projScore = sel.projects.reduce((a, e) => Math.max(a, e.score), 0);
  if (projScore > expScore) {
    section("Projects", sel.projects);
    section("Experience", sel.experience);
  } else {
    section("Experience", sel.experience);
    section("Projects", sel.projects);
  }
  if (sel.skills.length || sel.keywords.length) {
    lines.push({ style: "section", spans: [{ text: "Skills", kind: "label" }] });
    const spans: Span[] = [];
    const items: Span[] = [
      ...sel.skills.map((s) => ({ text: s.label, kind: "content" as const, key: `skills[${s.id}]` })),
      ...sel.keywords.map((k) => ({ text: k.label, kind: "keyword" as const, key: k.key })),
    ];
    items.forEach((item, i) => {
      if (i) spans.push({ text: " · ", kind: "sep" });
      spans.push(item);
    });
    lines.push({ style: "list", spans });
  }
  if (sel.languages.length) {
    lines.push({ style: "section", spans: [{ text: "Languages", kind: "label" }] });
    const spans: Span[] = [];
    sel.languages.forEach((l, i) => {
      if (i) spans.push({ text: ", ", kind: "sep" });
      spans.push({ text: l, kind: "content", key: "languages" });
    });
    lines.push({ style: "list", spans });
  }
  return lines;
}

/**
 * Initial selection: every non-excluded entry, bullets ordered by relevance,
 * entries ordered by relevance within their section.
 */
export function initialSelection(
  resume: Resume,
  ranked: RankedBullet[],
  rankedSkills: { id: string; label: string }[],
  isExcluded: (e: Experience) => boolean,
): ResumeSelection {
  const byExp = new Map<string, RankedBullet[]>();
  for (const b of ranked) byExp.set(b.experienceId, [...(byExp.get(b.experienceId) ?? []), b]);
  const entries = resume.experiences
    .filter((e) => !isExcluded(e))
    .map((e, index) => {
      const bullets = byExp.get(e.id) ?? [];
      const scores = bullets.map((b) => b.score).sort((a, b) => b - a);
      const score = (scores[0] ?? 0) + 0.25 * scores.slice(1).reduce((a, s) => a + Math.max(s, 0), 0) - index * 1e-6;
      return { experience: e, bullets, score };
    });
  const pick = (type: Experience["type"]) => entries.filter((e) => e.experience.type === type).sort((a, b) => b.score - a.score);
  return {
    education: entries.filter((e) => e.experience.type === "education"), // resume order, never reordered or dropped
    experience: pick("work"),
    projects: pick("project"),
    skills: rankedSkills.map((s) => ({ id: s.id, label: s.label })),
    keywords: [],
    tailored: {},
    languages: [...resume.languages],
    dropped: [],
  };
}

/**
 * One trimming step toward the page limit (D2): drop the lowest-ranked
 * bullet first (keeping at least one per entry), then the lowest-ranked
 * entry. Education is never dropped. Returns false when nothing can go.
 */
export function trimOnce(sel: ResumeSelection): boolean {
  const pools = [...sel.experience, ...sel.projects];
  let worst: { entry: SelectedEntry; bullet: RankedBullet } | null = null;
  for (const entry of pools) {
    if (entry.bullets.length <= 1) continue;
    const b = entry.bullets[entry.bullets.length - 1]!;
    if (!worst || b.score < worst.bullet.score) worst = { entry, bullet: b };
  }
  if (worst) {
    worst.entry.bullets = worst.entry.bullets.slice(0, -1);
    sel.dropped.push({ key: worst.bullet.key, reason: "page limit: lowest-ranked bullet" });
    return true;
  }
  const lists: SelectedEntry[][] = [sel.experience, sel.projects];
  let worstEntry: { list: SelectedEntry[]; entry: SelectedEntry } | null = null;
  for (const list of lists) {
    for (const entry of list) if (!worstEntry || entry.score < worstEntry.entry.score) worstEntry = { list, entry };
  }
  if (worstEntry && sel.experience.length + sel.projects.length > 1) {
    worstEntry.list.splice(worstEntry.list.indexOf(worstEntry.entry), 1);
    sel.dropped.push({ key: `experiences[${worstEntry.entry.experience.id}]`, reason: "page limit: lowest-ranked entry" });
    return true;
  }
  return false;
}

/* ----------------------------------------------------- verbatim checking */

export interface VerbatimProblem {
  line: string;
  span: string;
  problem: string;
}

/**
 * D2 regression check: every content span is an exact substring of a string
 * value in the pinned resume.json; every tailored span is the validated
 * rewrite for its key; every keyword is on the allowed list; every date span
 * is its own entry's date; labels and separators come from fixed allowlists.
 */
export function checkVerbatim(
  lines: Line[],
  corpus: string[],
  resume: Resume,
  allowed: { tailored?: Record<string, string>; keywords?: Set<string> } = {},
): VerbatimProblem[] {
  const problems: VerbatimProblem[] = [];
  const dates = new Map<string, string>();
  for (const e of resume.experiences) {
    dates.set(`experiences[${e.id}].startDate`, formatMonth(e.startDate));
    dates.set(`experiences[${e.id}].endDate`, formatMonth(e.endDate));
  }
  for (const line of lines) {
    for (const span of [...line.spans, ...(line.right ?? [])]) {
      const fail = (problem: string) => problems.push({ line: lineText(line), span: span.text, problem });
      if (span.kind === "content") {
        if (!corpus.some((s) => s.includes(span.text))) fail("content not found verbatim in your résumé");
      } else if (span.kind === "tailored") {
        if (!span.key || allowed.tailored?.[span.key] !== span.text) fail("tailored bullet is not the validated rewrite for its key");
      } else if (span.kind === "keyword") {
        if (!span.key || !allowed.keywords?.has(`${span.key}|${span.text}`)) fail("keyword not on the allowed list");
      } else if (span.kind === "date") {
        if (!span.key || dates.get(span.key) !== span.text) fail("date does not match its entry");
      } else if (span.kind === "label") {
        if (!(SECTION_LABELS as readonly string[]).includes(span.text)) fail("label not in allowlist");
      } else if (!(SEPARATORS as readonly string[]).includes(span.text)) {
        fail("separator not in allowlist");
      }
    }
  }
  return problems;
}

export function resumePlainText(lines: Line[]): string {
  return (
    lines
      .map((l) => (l.style === "bullet" ? `- ${lineText(l)}` : l.style === "section" ? `\n${lineText(l).toUpperCase()}` : lineText(l)))
      .join("\n")
      .trim() + "\n"
  );
}
