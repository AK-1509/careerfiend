import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { collapseWhitespace } from "@careerfiend/shared";

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "ul",
  "ol",
  "table",
  "tr",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "main",
]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "nav", "form", "button", "select", "input", "textarea"]);

/** HTML → plain text with headings and bullets on their own lines. */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  const out: string[] = [];
  let line = "";
  const flush = () => {
    const t = collapseWhitespace(line);
    if (t) out.push(t);
    line = "";
  };
  const walk = (node: AnyNode) => {
    if (node.type === "text") {
      line += (node as unknown as { data: string }).data;
      return;
    }
    if (node.type !== "tag") return;
    const el = node as unknown as { name: string; children: AnyNode[] };
    const tag = el.name.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === "li") {
      flush();
      line = "- ";
      el.children.forEach(walk);
      flush();
      return;
    }
    const isHeading = /^h[1-6]$/.test(tag);
    const isStrongLine = (tag === "strong" || tag === "b") && !line.trim();
    if (BLOCK_TAGS.has(tag) || isHeading) flush();
    el.children.forEach(walk);
    if (BLOCK_TAGS.has(tag) || isHeading) flush();
    else if (isStrongLine) {
      // "<p><strong>Requirements</strong></p>" → heading line
      const t = collapseWhitespace(line);
      if (t && t.length < 80) flush();
    }
  };
  const root = $("body").length ? $("body").get(0)! : $.root().get(0)!;
  (root as unknown as { children: AnyNode[] }).children.forEach(walk);
  flush();
  return out.join("\n");
}

export interface JsonLdJobPosting {
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string | string[];
  hiringOrganization?: { name?: string; sameAs?: string } | string;
  jobLocation?: unknown;
  jobLocationType?: string;
  applicantLocationRequirements?: unknown;
  baseSalary?: unknown;
  url?: string;
  directApply?: boolean;
  identifier?: unknown;
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function findJobPostingJsonLd($: cheerio.CheerioAPI): JsonLdJobPosting | null {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const s of scripts) {
    let data: unknown;
    try {
      data = JSON.parse($(s).text());
    } catch {
      continue;
    }
    const candidates: unknown[] = [];
    for (const d of asArray(data)) {
      candidates.push(d);
      const graph = (d as { "@graph"?: unknown })?.["@graph"];
      if (graph) candidates.push(...asArray(graph));
    }
    for (const c of candidates) {
      const type = (c as { "@type"?: unknown })?.["@type"];
      if (asArray(type as string | string[]).includes("JobPosting")) return c as JsonLdJobPosting;
    }
  }
  return null;
}

function addressText(loc: unknown): string | null {
  const a = (loc as { address?: unknown })?.address ?? loc;
  if (!a || typeof a !== "object") return typeof a === "string" ? a : null;
  const o = a as Record<string, unknown>;
  const parts = [
    o.addressLocality,
    o.addressRegion,
    o.addressCountry && typeof o.addressCountry === "object" ? (o.addressCountry as { name?: string }).name : o.addressCountry,
  ].filter((p): p is string => typeof p === "string" && !!p);
  return parts.length ? parts.join(", ") : null;
}

export function jsonLdLocations(jp: JsonLdJobPosting): string[] {
  return asArray(jp.jobLocation as unknown[])
    .map(addressText)
    .filter((x): x is string => !!x);
}

export function jsonLdApplicantCountries(jp: JsonLdJobPosting): string[] {
  return asArray(jp.applicantLocationRequirements as unknown[])
    .map((r) => {
      if (typeof r === "string") return r;
      const o = r as { name?: string; "@type"?: string };
      return o?.name ?? null;
    })
    .filter((x): x is string => !!x);
}

export function jsonLdSalary(jp: JsonLdJobPosting): string | null {
  const s = jp.baseSalary as { currency?: string; value?: { minValue?: number; maxValue?: number; value?: number; unitText?: string } } | undefined;
  if (!s?.value) return null;
  const v = s.value;
  const cur = s.currency ?? "";
  const unit = v.unitText ? `/${v.unitText.toLowerCase()}` : "";
  if (v.minValue !== undefined && v.maxValue !== undefined) return `${cur} ${v.minValue}–${v.maxValue}${unit}`.trim();
  if (v.value !== undefined) return `${cur} ${v.value}${unit}`.trim();
  return null;
}

export function jsonLdCompany(jp: JsonLdJobPosting): string | null {
  const h = jp.hiringOrganization;
  if (!h) return null;
  return typeof h === "string" ? h : (h.name ?? null);
}

export interface ApplyLink {
  url: string;
  text: string;
  external: boolean;
}

/**
 * Ordinary, user-visible "Apply" links. Returns absolute URLs; `external`
 * means the link leaves the listing's host (the employer/ATS target).
 */
export function findApplyLinks($: cheerio.CheerioAPI, baseUrl: string): ApplyLink[] {
  const base = new URL(baseUrl);
  const out: ApplyLink[] = [];
  $("a[href]").each((_, a) => {
    const el = $(a);
    const text = collapseWhitespace(el.text() || el.attr("aria-label") || "");
    if (!/\bapply\b/i.test(text)) return;
    if (/easy apply|indeed apply|apply with (linkedin|indeed)/i.test(text)) return;
    if (el.attr("hidden") !== undefined || /display:\s*none|visibility:\s*hidden/i.test(el.attr("style") ?? "")) return;
    const href = el.attr("href")!;
    if (href.startsWith("javascript:") || href.startsWith("#")) return;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(abs.protocol)) return;
    out.push({ url: abs.toString(), text, external: abs.hostname !== base.hostname });
  });
  return out;
}

export function canonicalUrl($: cheerio.CheerioAPI, pageUrl: string): string {
  const href = $('link[rel="canonical"]').attr("href") || $('meta[property="og:url"]').attr("content");
  if (href) {
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      /* fall through */
    }
  }
  const u = new URL(pageUrl);
  // Strip tracking parameters so the same listing de-duplicates.
  for (const p of [...u.searchParams.keys()]) if (/^(utm_|gh_src|lever-source|source|ref|trk|refid)/i.test(p)) u.searchParams.delete(p);
  u.hash = "";
  return u.toString();
}

/** Visible listing text: prefer <main>/<article>, drop chrome. */
export function visibleText($: cheerio.CheerioAPI): string {
  const main = $("main").first().html() ?? $("article").first().html() ?? $("body").html() ?? "";
  return htmlToText(main);
}

export { cheerio };
