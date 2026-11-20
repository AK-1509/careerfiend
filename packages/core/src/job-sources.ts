import { CareerFiendError, decrypt, encrypt, normalizeLabel, randomId, sha256 } from "@careerfiend/shared";
import { fromJson, toJson, type Db } from "@careerfiend/db";
import { ATS_KINDS, DEFAULT_ATS_BASES, fetchBoard, USER_AGENT, type AtsKind, type Fetcher } from "@careerfiend/job-parser";
import type { AppContext } from "./context";
import { ingestParsed } from "./ingest";
import { enqueue } from "./queue";
import { scheduleDemandRefresh } from "./demand";
import { parseLead } from "./lead-postings";
import { enqueueUrls, describeEnqueue } from "./settings";

/**
 * Job search (persistent vigilance). A saved search names a job title (and
 * other titles that count); the worker keeps looking for it across every
 * source whose terms allow automated search, and lists new matches as leads.
 * Nothing is applied to until the person chooses a lead.
 *
 * Sources, and the terms each one asks us to keep (checked November 2026):
 *  - Job-search services with public APIs: Remotive, Himalayas, Jobicy, Remote OK,
 *    Arbeitnow (no key). Each asks for credit and a link back to its own listing,
 *    and to apply through that listing, so leads link there and CareerFiend never
 *    opens those pages itself. Remotive also asks for at most 4 requests a day and
 *    forbids showing its jobs behind a sign-up, so it is fetched as one feed at most
 *    4 times a day, and only in the desktop app or a self-hosted copy.
 *  - Services that need a key: Adzuna, USAJOBS, Jooble. Each person uses their own
 *    free key (stored encrypted), since these terms are per key and per person.
 *  - Company job boards (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee,
 *    Workable, Personio): the public career-site feeds of the companies on the
 *    person's watchlist, filtered by title.
 *  - Never: LinkedIn, Indeed, Glassdoor, Handshake and other sites that forbid
 *    automated access.
 *
 * Every request goes through `politeFetch`: one cache and one per-host pace in the
 * shared accounts database, so a source is asked once per cache period however
 * many people search for the same thing, and a 429 or 503 pauses that host for
 * everyone (Retry-After honored, else exponential back-off).
 */

export type ServiceId = "remotive" | "himalayas" | "jobicy" | "remoteok" | "arbeitnow" | "adzuna" | "usajobs" | "jooble";
export type SourceId = ServiceId | "boards";
export type KeyedSource = "adzuna" | "usajobs" | "jooble";

export interface SourceInfo {
  id: SourceId;
  label: string;
  /** What it covers, in plain words. */
  covers: string;
  site: string;
  /** The terms we keep, in one line (shown on the Job search page). */
  terms: string;
  key?: KeyedSource;
  /** False when its terms rule out a public website (offered only in the desktop app or a self-hosted copy). */
  hosted: boolean;
}

export const JOB_SOURCES: SourceInfo[] = [
  {
    id: "boards",
    label: "Company job boards",
    covers: "Every company on your Watchlist: Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Workable and Personio career sites",
    site: "",
    terms: "The companies' public career-site feeds, checked at most every 3 hours.",
    hosted: true,
  },
  {
    id: "himalayas",
    label: "Himalayas",
    covers: "Remote jobs worldwide",
    site: "https://himalayas.app",
    terms: "Credited with a link to each listing; apply through Himalayas; expired jobs are dropped.",
    hosted: true,
  },
  {
    id: "jobicy",
    label: "Jobicy",
    covers: "Remote jobs worldwide",
    site: "https://jobicy.com",
    terms: "Credited with a direct link; apply buttons go to the Jobicy listing.",
    hosted: true,
  },
  {
    id: "remoteok",
    label: "Remote OK",
    covers: "Remote jobs worldwide",
    site: "https://remoteok.com",
    terms: "Credited as Remote OK with a followed link to each listing.",
    hosted: true,
  },
  {
    id: "arbeitnow",
    label: "Arbeitnow",
    covers: "Jobs in Europe (many in Germany), remote and on-site",
    site: "https://www.arbeitnow.com",
    terms: "Linked back to Arbeitnow; its two feed pages are read at most every 6 hours.",
    hosted: true,
  },
  {
    id: "remotive",
    label: "Remotive",
    covers: "Remote jobs worldwide (shown 24 hours after posting)",
    site: "https://remotive.com",
    terms:
      "Credited with a link to each listing; read at most 4 times a day; only in the desktop app or your own copy (its terms rule out showing jobs behind a sign-up).",
    hosted: false,
  },
  {
    id: "adzuna",
    label: "Adzuna",
    covers: "Jobs from thousands of sites in the US, UK, Canada, Australia, Germany, France, India and more",
    site: "https://www.adzuna.com",
    terms: "Your own free key; results credited to Adzuna with a link. Search results carry a summary: open the listing to tailor.",
    key: "adzuna",
    hosted: true,
  },
  {
    id: "usajobs",
    label: "USAJOBS",
    covers: "US federal government jobs",
    site: "https://www.usajobs.gov",
    terms: "Your own free key from developer.usajobs.gov, sent with the email you registered (their API requires both). Apply on USAJOBS.",
    key: "usajobs",
    hosted: true,
  },
  {
    id: "jooble",
    label: "Jooble",
    covers: "Jobs from many sites in many countries",
    site: "https://jooble.org",
    terms: "Your own free key from jooble.org/api/about. Results carry a summary: open the listing to tailor.",
    key: "jooble",
    hosted: true,
  },
];

export function sourceInfo(id: string): SourceInfo | undefined {
  return JOB_SOURCES.find((s) => s.id === id);
}

/** Sources this deployment may use (Remotive is not offered on a public website). */
export function availableSources(ctx: AppContext): SourceInfo[] {
  return JOB_SOURCES.filter((s) => s.hosted || ctx.config.CAREERFIEND_MODE !== "hosted");
}

/* ------------------------------------------------------------- source keys */

export interface SourceKeys {
  adzuna?: { appId: string; appKey: string; country: string };
  usajobs?: { key: string; email: string };
  jooble?: { key: string };
}

const KEYS = "sources.keys";

export async function getSourceKeys(ctx: AppContext): Promise<SourceKeys> {
  const row = await ctx.db.setting.findUnique({ where: { key: KEYS } });
  if (!row) return {};
  try {
    return JSON.parse(decrypt(row.value, ctx.key())) as SourceKeys;
  } catch {
    return {};
  }
}

/** Which keys are set (never the keys themselves). */
export async function sourceKeyStatus(ctx: AppContext): Promise<Record<KeyedSource, string | null>> {
  const k = await getSourceKeys(ctx);
  return {
    adzuna: k.adzuna ? `app ${k.adzuna.appId}, country ${k.adzuna.country}` : null,
    usajobs: k.usajobs ? `key …${k.usajobs.key.slice(-4)}, ${k.usajobs.email}` : null,
    jooble: k.jooble ? `key …${k.jooble.key.slice(-4)}` : null,
  };
}

const ADZUNA_COUNTRIES = ["at", "au", "be", "br", "ca", "ch", "de", "es", "fr", "gb", "in", "it", "mx", "nl", "nz", "pl", "sg", "us", "za"];

/** Save (or with empty fields, remove) one source's key. */
export async function setSourceKey(ctx: AppContext, source: KeyedSource, fields: Record<string, string>): Promise<string> {
  const keys = await getSourceKeys(ctx);
  const f = (k: string) => (fields[k] ?? "").trim();
  const token = (v: string, what: string) => {
    if (!/^[A-Za-z0-9._~+/=-]{4,200}$/.test(v)) throw new CareerFiendError("VALIDATION_FAILED", `That ${what} contains characters keys never use.`);
    return v;
  };
  if (source === "adzuna") {
    if (!f("appId") && !f("appKey")) delete keys.adzuna;
    else {
      const country = (f("country") || "us").toLowerCase();
      if (!ADZUNA_COUNTRIES.includes(country))
        throw new CareerFiendError("VALIDATION_FAILED", `Adzuna country must be one of: ${ADZUNA_COUNTRIES.join(", ")}.`);
      keys.adzuna = { appId: token(f("appId"), "app id"), appKey: token(f("appKey"), "app key"), country };
    }
  } else if (source === "usajobs") {
    if (!f("key") && !f("email")) delete keys.usajobs;
    else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f("email")))
        throw new CareerFiendError("VALIDATION_FAILED", "Enter the email you registered the USAJOBS key with.");
      keys.usajobs = { key: token(f("key"), "key"), email: f("email") };
    }
  } else if (!f("key")) delete keys.jooble;
  else keys.jooble = { key: token(f("key"), "key") };
  const value = encrypt(JSON.stringify(keys), ctx.key());
  await ctx.db.setting.upsert({ where: { key: KEYS }, create: { key: KEYS, value }, update: { value } });
  return keys[source] ? `${sourceInfo(source)!.label} key saved.` : `${sourceInfo(source)!.label} key removed.`;
}

/* ------------------------------------------------------- polite fetching */

export interface PoliteRequest {
  /** Pace bucket, normally the host. */
  host: string;
  url: string;
  init?: RequestInit;
  /** Cache key (never contains a secret). */
  cacheKey: string;
  ttlMs: number;
  /** Least time between two requests to this host, for everyone. */
  hostIntervalMs: number;
}

export type PoliteResult = { ok: true; body: string; status: number; fromCache: boolean } | { ok: false; note: string };

const MAX_WAIT_MS = 15_000;
const MAX_BODY = 12 * 1024 * 1024;

function sharedDb(ctx: AppContext): Db {
  return ctx.shared ?? ctx.db;
}

function retryAfterMs(res: Response, failures: number): number {
  const h = res.headers.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 60_000), 24 * 3600_000);
    const at = Date.parse(h);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 60_000), 24 * 3600_000);
  }
  return Math.min(5 * 60_000 * 2 ** failures, 24 * 3600_000);
}

/**
 * Fetch through the shared cache and per-host pace. Returns a fresh cached
 * body without any request; when the host is paused or was asked too recently,
 * returns the last body it has (however old) or says why it waited.
 */
export async function politeFetch(ctx: AppContext, req: PoliteRequest): Promise<PoliteResult> {
  const db = sharedDb(ctx);
  const now = ctx.now();
  const cached = await db.sourceCache.findUnique({ where: { key: req.cacheKey } });
  if (cached && cached.expiresAt > now && cached.status < 400) return { ok: true, body: cached.body, status: cached.status, fromCache: true };
  const stale = (note: string): PoliteResult =>
    cached && cached.status < 400 ? { ok: true, body: cached.body, status: cached.status, fromCache: true } : { ok: false, note };

  // Claim the next request slot for this host (compare-and-swap, so parallel runs never both go).
  for (let attempt = 0; ; attempt++) {
    const t = ctx.now();
    const row = await db.sourceThrottle.findUnique({ where: { host: req.host } });
    if (row?.blockedUntil && row.blockedUntil > t)
      return stale(`paused until ${row.blockedUntil.toISOString().slice(0, 16).replace("T", " ")} UTC (${row.reason ?? "rate limit"})`);
    const next = new Date(t.getTime() + req.hostIntervalMs);
    let claimed = false;
    if (!row) {
      try {
        await db.sourceThrottle.create({ data: { host: req.host, nextAt: next } });
        claimed = true;
      } catch {
        claimed = false;
      }
    } else if (row.nextAt <= t) {
      claimed = (await db.sourceThrottle.updateMany({ where: { host: req.host, nextAt: row.nextAt }, data: { nextAt: next } })).count === 1;
    }
    if (claimed) break;
    const wait = (row?.nextAt.getTime() ?? t.getTime()) - t.getTime();
    if (attempt >= 3 || wait > MAX_WAIT_MS) return stale("waiting for this source's next allowed request");
    await new Promise((r) => setTimeout(r, Math.max(wait, 250)));
  }

  const http = ctx.fetchers?.http ?? fetch;
  let res: Response;
  try {
    res = await http(req.url, {
      ...req.init,
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...(req.init?.headers as Record<string, string> | undefined) },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    ctx.logger.warn("sources.fetch_failed", { host: req.host, error: err });
    return stale("could not be reached");
  }
  if (res.status === 429 || res.status === 503) {
    const row = await db.sourceThrottle.findUnique({ where: { host: req.host } });
    const failures = (row?.failures ?? 0) + 1;
    const until = new Date(ctx.now().getTime() + retryAfterMs(res, failures - 1));
    await db.sourceThrottle.update({ where: { host: req.host }, data: { blockedUntil: until, failures, reason: `HTTP ${res.status}` } });
    await res.body?.cancel();
    ctx.logger.warn("sources.rate_limited", { host: req.host, status: String(res.status) });
    return stale(`asked us to slow down (HTTP ${res.status}); paused until ${until.toISOString().slice(0, 16).replace("T", " ")} UTC`);
  }
  const body = await res.text();
  if (!res.ok) return stale(`answered HTTP ${res.status}`);
  if (body.length > MAX_BODY) return stale("answered with more data than expected");
  await db.sourceThrottle.update({ where: { host: req.host }, data: { failures: 0, blockedUntil: null, reason: null } }).catch(() => undefined);
  const expiresAt = new Date(ctx.now().getTime() + req.ttlMs);
  await db.sourceCache.upsert({
    where: { key: req.cacheKey },
    create: { key: req.cacheKey, body, status: res.status, expiresAt },
    update: { body, status: res.status, fetchedAt: ctx.now(), expiresAt },
  });
  return { ok: true, body, status: res.status, fromCache: false };
}

/** A job-parser Fetcher (company boards) that goes through the shared cache and pace. */
function politeFetcher(ctx: AppContext, ttlMs: number): Fetcher {
  return async (url) => {
    const host = new URL(url).hostname;
    const r = await politeFetch(ctx, { host, url, cacheKey: `board:${url}`, ttlMs, hostIntervalMs: 2_000 });
    if (!r.ok) throw new CareerFiendError("NETWORK_TRANSIENT", r.note);
    return { ok: true, status: r.status, json: async () => JSON.parse(r.body) as unknown, text: async () => r.body };
  };
}

/* ------------------------------------------------------------ postings */

export interface FoundPosting {
  source: string;
  externalId: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  url: string;
  applyUrl: string | null;
  description: string;
  descriptionComplete: boolean;
  postedAt: Date | null;
  compensation: string | null;
}

const H6 = 6 * 3600_000;
const H12 = 12 * 3600_000;

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const date = (v: unknown): Date | null => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string" && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

const salary = (min: unknown, max: unknown, unit = ""): string | null => {
  const a = typeof min === "number" && min > 0 ? Math.round(min).toLocaleString("en-US") : "";
  const b = typeof max === "number" && max > 0 ? Math.round(max).toLocaleString("en-US") : "";
  if (!a && !b) return null;
  return `${a && b ? `${a}–${b}` : a || b}${unit ? ` ${unit}` : ""}`;
};

function parseJson<T>(r: PoliteResult): T | null {
  if (!r.ok) return null;
  try {
    return JSON.parse(r.body) as T;
  } catch {
    return null;
  }
}

interface SearchQuery {
  titles: string[];
  location: string;
}

interface ServiceResult {
  postings: FoundPosting[];
  note: string | null;
}

type ServiceRunner = (ctx: AppContext, q: SearchQuery, keys: SourceKeys) => Promise<ServiceResult>;

const enc = encodeURIComponent;
const notes = (rs: PoliteResult[]) => [...new Set(rs.filter((r): r is { ok: false; note: string } => !r.ok).map((r) => r.note))].join("; ") || null;

const SERVICES: Record<ServiceId, ServiceRunner> = {
  async remotive(ctx) {
    // Its terms: at most 4 requests a day, so one whole-feed request every 6 hours, filtered here.
    const r = await politeFetch(ctx, {
      host: "remotive.com",
      url: "https://remotive.com/api/remote-jobs",
      cacheKey: "remotive:all",
      ttlMs: H6,
      hostIntervalMs: H6,
    });
    const data = parseJson<{ jobs?: Record<string, unknown>[] }>(r);
    const postings = (data?.jobs ?? []).map((j) => ({
      source: "remotive",
      externalId: String(j.id),
      title: String(j.title ?? ""),
      company: String(j.company_name ?? ""),
      location: String(j.candidate_required_location ?? "Remote"),
      remote: true,
      url: String(j.url ?? ""),
      applyUrl: null,
      description: String(j.description ?? ""),
      descriptionComplete: true,
      postedAt: date(j.publication_date),
      compensation: (j.salary as string) || null,
    }));
    return { postings, note: notes([r]) };
  },

  async himalayas(ctx, q) {
    const rs: PoliteResult[] = [];
    const postings: FoundPosting[] = [];
    for (const t of q.titles) {
      const url = `https://himalayas.app/jobs/api/search?q=${enc(t)}&page=1`;
      const r = await politeFetch(ctx, { host: "himalayas.app", url, cacheKey: `himalayas:${normalizeLabel(t)}`, ttlMs: H6, hostIntervalMs: 10_000 });
      rs.push(r);
      for (const j of parseJson<{ jobs?: Record<string, unknown>[] }>(r)?.jobs ?? []) {
        const expiry = date(j.expiryDate);
        if (expiry && expiry < ctx.now()) continue; // its terms: drop expired jobs
        postings.push({
          source: "himalayas",
          externalId: String(j.guid ?? j.applicationLink),
          title: String(j.title ?? ""),
          company: String(j.companyName ?? ""),
          location: ((j.locationRestrictions as string[] | undefined) ?? []).join(", ") || "Remote (anywhere)",
          remote: true,
          url: String(j.applicationLink ?? j.guid ?? ""),
          applyUrl: null,
          description: String(j.description ?? ""),
          descriptionComplete: true,
          postedAt: date(j.pubDate),
          compensation: salary(j.minSalary, j.maxSalary, String(j.currency ?? "")),
        });
      }
    }
    return { postings, note: notes(rs) };
  },

  async jobicy(ctx, q) {
    const rs: PoliteResult[] = [];
    const postings: FoundPosting[] = [];
    for (const t of q.titles) {
      const url = `https://jobicy.com/api/v2/remote-jobs?count=50&tag=${enc(t)}`;
      const r = await politeFetch(ctx, { host: "jobicy.com", url, cacheKey: `jobicy:${normalizeLabel(t)}`, ttlMs: H6, hostIntervalMs: 60_000 });
      rs.push(r);
      for (const j of parseJson<{ jobs?: Record<string, unknown>[] }>(r)?.jobs ?? []) {
        postings.push({
          source: "jobicy",
          externalId: String(j.id),
          title: decodeEntities(String(j.jobTitle ?? "")),
          company: String(j.companyName ?? ""),
          location: String(j.jobGeo ?? "Remote"),
          remote: true,
          url: String(j.url ?? ""),
          applyUrl: null,
          description: String(j.jobDescription ?? ""),
          descriptionComplete: true,
          postedAt: date(j.pubDate),
          compensation: salary(j.annualSalaryMin, j.annualSalaryMax, String(j.salaryCurrency ?? "")),
        });
      }
    }
    return { postings, note: notes(rs) };
  },

  async remoteok(ctx) {
    const r = await politeFetch(ctx, { host: "remoteok.com", url: "https://remoteok.com/api", cacheKey: "remoteok:all", ttlMs: H6, hostIntervalMs: 60_000 });
    const data = parseJson<Record<string, unknown>[]>(r) ?? [];
    const postings = data
      .filter((j) => j.id && j.position)
      .map((j) => ({
        source: "remoteok",
        externalId: String(j.id),
        title: String(j.position),
        company: String(j.company ?? ""),
        location: String(j.location || "Remote"),
        remote: true,
        url: String(j.url ?? ""),
        applyUrl: null,
        description: String(j.description ?? ""),
        descriptionComplete: true,
        postedAt: date(j.date ?? j.epoch),
        compensation: salary(j.salary_min, j.salary_max, "USD"),
      }));
    return { postings, note: notes([r]) };
  },

  async arbeitnow(ctx) {
    const rs: PoliteResult[] = [];
    const postings: FoundPosting[] = [];
    for (const page of [1, 2]) {
      const url = `https://www.arbeitnow.com/api/job-board-api?page=${page}`;
      const r = await politeFetch(ctx, { host: "www.arbeitnow.com", url, cacheKey: `arbeitnow:${page}`, ttlMs: H6, hostIntervalMs: 10_000 });
      rs.push(r);
      for (const j of parseJson<{ data?: Record<string, unknown>[] }>(r)?.data ?? []) {
        postings.push({
          source: "arbeitnow",
          externalId: String(j.slug),
          title: String(j.title ?? ""),
          company: String(j.company_name ?? ""),
          location: String(j.location ?? ""),
          remote: !!j.remote,
          url: String(j.url ?? ""),
          applyUrl: null,
          description: decodeEntities(String(j.description ?? "")),
          descriptionComplete: true,
          postedAt: date(j.created_at),
          compensation: null,
        });
      }
    }
    return { postings, note: notes(rs) };
  },

  async adzuna(ctx, q, keys) {
    const k = keys.adzuna;
    if (!k) return { postings: [], note: "add your free Adzuna key" };
    const rs: PoliteResult[] = [];
    const postings: FoundPosting[] = [];
    const who = sha256(`${ctx.account?.id ?? "local"}:${k.appId}`).slice(0, 12);
    for (const t of q.titles) {
      const where = q.location ? `&where=${enc(q.location)}` : "";
      const url = `https://api.adzuna.com/v1/api/jobs/${k.country}/search/1?app_id=${enc(k.appId)}&app_key=${enc(k.appKey)}&results_per_page=50&what=${enc(t)}${where}&content-type=application/json`;
      const r = await politeFetch(ctx, {
        host: "api.adzuna.com",
        url,
        cacheKey: `adzuna:${who}:${k.country}:${normalizeLabel(t)}:${normalizeLabel(q.location)}`,
        ttlMs: H12,
        hostIntervalMs: 3_000,
      });
      rs.push(r);
      for (const j of parseJson<{ results?: Record<string, unknown>[] }>(r)?.results ?? []) {
        postings.push({
          source: "adzuna",
          externalId: String(j.id),
          title: stripTags(String(j.title ?? "")),
          company: String((j.company as { display_name?: string } | undefined)?.display_name ?? ""),
          location: String((j.location as { display_name?: string } | undefined)?.display_name ?? ""),
          remote: /remote/i.test(String(j.title ?? "") + String(j.description ?? "")),
          url: String(j.redirect_url ?? ""),
          applyUrl: null,
          description: stripTags(String(j.description ?? "")),
          descriptionComplete: false,
          postedAt: date(j.created),
          compensation: salary(j.salary_min, j.salary_max),
        });
      }
    }
    return { postings, note: notes(rs) };
  },

  async usajobs(ctx, q, keys) {
    const k = keys.usajobs;
    if (!k) return { postings: [], note: "add your free USAJOBS key" };
    const rs: PoliteResult[] = [];
    const postings: FoundPosting[] = [];
    const who = sha256(`${ctx.account?.id ?? "local"}:${k.email}`).slice(0, 12);
    for (const t of q.titles) {
      const where = q.location ? `&LocationName=${enc(q.location)}` : "";
      const url = `https://data.usajobs.gov/api/search?Keyword=${enc(t)}&ResultsPerPage=100${where}`;
      const r = await politeFetch(ctx, {
        host: "data.usajobs.gov",
        url,
        init: { headers: { "User-Agent": k.email, "Authorization-Key": k.key, Host: "data.usajobs.gov" } },
        cacheKey: `usajobs:${who}:${normalizeLabel(t)}:${normalizeLabel(q.location)}`,
        ttlMs: H12,
        hostIntervalMs: 3_000,
      });
      rs.push(r);
      type Item = { MatchedObjectId?: string; MatchedObjectDescriptor?: Record<string, unknown> };
      const items = parseJson<{ SearchResult?: { SearchResultItems?: Item[] } }>(r)?.SearchResult?.SearchResultItems ?? [];
      for (const it of items) {
        const d = it.MatchedObjectDescriptor ?? {};
        const details = ((d.UserArea as { Details?: Record<string, unknown> } | undefined)?.Details ?? {}) as Record<string, unknown>;
        const duties = Array.isArray(details.MajorDuties) ? (details.MajorDuties as string[]) : [];
        const pay = ((d.PositionRemuneration as Record<string, unknown>[] | undefined) ?? [])[0];
        postings.push({
          source: "usajobs",
          externalId: String(it.MatchedObjectId ?? d.PositionID ?? d.PositionURI),
          title: String(d.PositionTitle ?? ""),
          company: String(d.OrganizationName ?? d.DepartmentName ?? ""),
          location: String(d.PositionLocationDisplay ?? ""),
          remote: /remote|telework/i.test(String(d.PositionLocationDisplay ?? "")),
          url: String(d.PositionURI ?? ""),
          applyUrl: null,
          description: [
            details.JobSummary ? `<h3>Summary</h3><p>${details.JobSummary}</p>` : "",
            duties.length ? `<h3>Major duties</h3><ul>${duties.map((x) => `<li>${x}</li>`).join("")}</ul>` : "",
            d.QualificationSummary ? `<h3>Qualifications</h3><p>${d.QualificationSummary}</p>` : "",
          ].join(""),
          descriptionComplete: !!(details.JobSummary || duties.length || d.QualificationSummary),
          postedAt: date(d.PublicationStartDate),
          compensation: pay ? salary(Number(pay.MinimumRange), Number(pay.MaximumRange), String(pay.Description ?? "")) : null,
        });
      }
    }
    return { postings, note: notes(rs) };
  },

  async jooble(ctx, q, keys) {
    const k = keys.jooble;
    if (!k) return { postings: [], note: "add your free Jooble key" };
    const rs: PoliteResult[] = [];
    const postings: FoundPosting[] = [];
    const who = sha256(`${ctx.account?.id ?? "local"}:${k.key}`).slice(0, 12);
    for (const t of q.titles) {
      const r = await politeFetch(ctx, {
        host: "jooble.org",
        url: `https://jooble.org/api/${enc(k.key)}`,
        init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keywords: t, location: q.location, page: "1" }) },
        cacheKey: `jooble:${who}:${normalizeLabel(t)}:${normalizeLabel(q.location)}`,
        ttlMs: H12,
        hostIntervalMs: 3_000,
      });
      rs.push(r);
      for (const j of parseJson<{ jobs?: Record<string, unknown>[] }>(r)?.jobs ?? []) {
        postings.push({
          source: "jooble",
          externalId: String(j.id ?? j.link),
          title: stripTags(String(j.title ?? "")),
          company: String(j.company ?? ""),
          location: String(j.location ?? ""),
          remote: /remote/i.test(String(j.location ?? "") + String(j.type ?? "")),
          url: String(j.link ?? ""),
          applyUrl: null,
          description: stripTags(String(j.snippet ?? "")),
          descriptionComplete: false,
          postedAt: date(j.updated),
          compensation: (j.salary as string) || null,
        });
      }
    }
    return { postings, note: notes(rs) };
  },
};

/** The watchlist's company boards (public career-site feeds), through the shared cache. */
async function boardPostings(ctx: AppContext): Promise<ServiceResult> {
  const companies = await ctx.db.watchlistCompany.findMany({ where: { enabled: true } });
  if (!companies.length) return { postings: [], note: "add companies on the Watchlist page" };
  const fetcher = politeFetcher(ctx, 3 * 3600_000);
  const postings: FoundPosting[] = [];
  const problems: string[] = [];
  for (const c of companies) {
    try {
      const list = await fetchBoard(c.ats as AtsKind, c.boardSlug, fetcher, ctx.fetchers?.atsBases ?? DEFAULT_ATS_BASES);
      for (const p of list) {
        postings.push({
          source: c.ats,
          externalId: `${c.boardSlug}/${p.id}`,
          title: p.title,
          company: c.name || p.company,
          location: p.locationRaw,
          remote: p.remote,
          url: p.listingUrl,
          applyUrl: p.applyUrl,
          description: p.descriptionHtml,
          descriptionComplete: p.descriptionHtml.trim().length > 0,
          postedAt: date(p.postedAt),
          compensation: p.compensation,
        });
      }
    } catch (err) {
      problems.push(`${c.name}: ${(err as Error).message}`);
    }
  }
  return { postings, note: problems.length ? problems.slice(0, 3).join("; ") : null };
}

/* ------------------------------------------------------------- matching */

/** Lowercase words without accents or punctuation ("Data Analyst (m/w/d)" → data, analyst, m, w, d). */
const tokens = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);
const has = (set: Set<string>, w: string) => set.has(w) || set.has(`${w}s`) || (w.endsWith("s") && set.has(w.slice(0, -1)));

/** A title matches when every word of one wanted title is in it (any order), and no excluded phrase is. */
export function titleMatches(title: string, wanted: string[], exclude: string[]): boolean {
  const words = new Set(tokens(title));
  if (exclude.some((e) => tokens(e).length > 0 && tokens(e).every((w) => has(words, w)))) return false;
  return wanted.some((t) => tokens(t).length > 0 && tokens(t).every((w) => has(words, w)));
}

/** Remote postings always count unless the search is remote-only; otherwise the location must mention a wanted place. */
export function locationMatches(p: Pick<FoundPosting, "location" | "remote">, location: string, remoteOnly: boolean): boolean {
  const remote = p.remote || /\bremote\b/i.test(p.location);
  if (remoteOnly) return remote;
  const wanted = location
    .split(/,|\bor\b|;/i)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length || remote) return true;
  const loc = p.location.toLowerCase();
  return wanted.some((w) => loc.includes(w));
}

/* -------------------------------------------------------- saved searches */

export interface SavedSearchInput {
  name?: string;
  titles: string[];
  location?: string;
  remoteOnly?: boolean;
  exclude?: string[];
  sources: string[];
}

function cleanList(xs: string[], max: number): string[] {
  const out: string[] = [];
  for (const x of xs.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean)) {
    if (x.length > 80) throw new CareerFiendError("VALIDATION_FAILED", `"${x.slice(0, 40)}…" is too long for a job title.`);
    if (!out.some((o) => o.toLowerCase() === x.toLowerCase())) out.push(x);
  }
  return out.slice(0, max);
}

export async function saveSearch(ctx: AppContext, input: SavedSearchInput, id?: string): Promise<string> {
  const titles = cleanList(input.titles, 5);
  if (!titles.length) throw new CareerFiendError("VALIDATION_FAILED", "Enter the job title to look for.");
  const allowed = new Set(availableSources(ctx).map((s) => s.id as string));
  const sources = [...new Set(input.sources)].filter((s) => allowed.has(s));
  if (!sources.length) throw new CareerFiendError("VALIDATION_FAILED", "Choose at least one source.");
  const data = {
    name: (input.name ?? "").trim().slice(0, 80) || titles[0]!,
    titles: toJson(titles),
    location: (input.location ?? "").trim().slice(0, 120),
    remoteOnly: !!input.remoteOnly,
    exclude: toJson(cleanList(input.exclude ?? [], 20)),
    sources: toJson(sources),
  };
  const searchId = id ?? randomId("srch");
  if (id) await ctx.db.savedSearch.update({ where: { id }, data });
  else await ctx.db.savedSearch.create({ data: { id: searchId, ...data } });
  await requestSearchRun(ctx);
  return searchId;
}

export async function setSearchEnabled(ctx: AppContext, id: string, enabled: boolean): Promise<void> {
  await ctx.db.savedSearch.update({ where: { id }, data: { enabled } });
  if (enabled) await requestSearchRun(ctx);
}

export async function deleteSearch(ctx: AppContext, id: string): Promise<void> {
  await ctx.db.savedSearch.delete({ where: { id } });
}

/** Ask the worker to run the searches now (each source still answers from its cache when it is fresh). */
export async function requestSearchRun(ctx: AppContext): Promise<void> {
  await enqueue(ctx.db, "SEARCH_POLL", {}, { dedupeKey: "searches:now" });
}

export interface SourceRunStatus {
  at: string;
  /** Postings the source returned (before matching), so a 0 can be told apart from a source that answered nothing. */
  scanned?: number;
  /** Postings that matched the title (and location). */
  matched: number;
  added: number;
  note: string | null;
  /** Written as a run goes, so the page can show a check in progress. Missing on statuses saved before this existed: done. */
  state?: "waiting" | "checking" | "done";
}

/** A run that stopped mid-check (the app was closed) is not shown as running for ever. */
const STALE_CHECK_MS = 10 * 60_000;

/** Where a saved search's current check stands, from its stored status. */
export function searchProgress(
  s: { enabled: boolean; lastRunAt: Date | null; sources: string; status: string },
  now: Date,
): { running: boolean; done: number; total: number; current: string | null } {
  const status = fromJson<Record<string, SourceRunStatus>>(s.status, {});
  const entries = Object.entries(status);
  const live = entries.filter(([, st]) => st.state === "waiting" || st.state === "checking");
  const fresh = live.some(([, st]) => now.getTime() - new Date(st.at).getTime() < STALE_CHECK_MS);
  const total = entries.length || fromJson<string[]>(s.sources, []).length;
  if (live.length && fresh) {
    const current = entries.find(([, st]) => st.state === "checking")?.[0] ?? null;
    return { running: true, done: entries.filter(([, st]) => (st.state ?? "done") === "done").length, total, current };
  }
  // Saved but not yet picked up by the worker.
  if (s.enabled && !s.lastRunAt && !entries.length) return { running: true, done: 0, total, current: null };
  return { running: false, done: total, total, current: null };
}

const MAX_NEW_PER_SOURCE = 100;

/**
 * Run every enabled saved search: ask each chosen source (through the shared
 * cache and pace), keep postings whose title and location match, and add the
 * new ones as leads. A posting already found (same source and id, or the same
 * company and title from another source) is not added twice.
 */
export async function runSavedSearches(ctx: AppContext, opts: { deadline?: number } = {}): Promise<{ searches: number; added: number }> {
  const searches = await ctx.db.savedSearch.findMany({ where: { enabled: true }, orderBy: { lastRunAt: { sort: "asc", nulls: "first" } } });
  if (!searches.length) return { searches: 0, added: 0 };
  const keys = await getSourceKeys(ctx);
  const allowed = new Set(availableSources(ctx).map((s) => s.id as string));
  // One answer per source per run, shared by every search that asks it the same thing.
  const memo = new Map<string, Promise<ServiceResult>>();
  let added = 0;
  let ran = 0;
  for (const s of searches) {
    if (opts.deadline && Date.now() > opts.deadline - 20_000) break;
    const titles = fromJson<string[]>(s.titles, []);
    const exclude = fromJson<string[]>(s.exclude, []);
    const chosen = fromJson<string[]>(s.sources, []).filter((x) => allowed.has(x));
    const status: Record<string, SourceRunStatus> = {};
    // Progress is saved after every step, so the Job search page can show the check as it goes.
    const save = () => ctx.db.savedSearch.update({ where: { id: s.id }, data: { status: toJson(status) } }).catch(() => undefined);
    for (const source of chosen) status[source] = { at: ctx.now().toISOString(), matched: 0, added: 0, note: null, state: "waiting" };
    await save();
    for (const source of chosen) {
      status[source] = { ...status[source]!, at: ctx.now().toISOString(), state: "checking" };
      await save();
      const q: SearchQuery = { titles, location: s.location };
      const memoKey = source === "boards" ? "boards" : `${source}:${titles.join("|")}:${s.location}`;
      let result: ServiceResult;
      try {
        if (!memo.has(memoKey)) memo.set(memoKey, source === "boards" ? boardPostings(ctx) : SERVICES[source as ServiceId](ctx, q, keys));
        result = await memo.get(memoKey)!;
      } catch (err) {
        status[source] = { at: ctx.now().toISOString(), matched: 0, added: 0, note: (err as Error).message.slice(0, 200), state: "done" };
        await save();
        continue;
      }
      const matches = result.postings.filter((p) => p.title && p.url && titleMatches(p.title, titles, exclude) && locationMatches(p, s.location, s.remoteOnly));
      let n = 0;
      for (const p of matches) {
        if (n >= MAX_NEW_PER_SOURCE) break;
        if (await addLead(ctx, s.id, p)) n++;
      }
      added += n;
      status[source] = {
        at: ctx.now().toISOString(),
        scanned: result.postings.length,
        matched: matches.length,
        added: n,
        note: result.note,
        state: "done",
      };
      await save();
    }
    await ctx.db.savedSearch.update({ where: { id: s.id }, data: { status: toJson(status), lastRunAt: ctx.now() } });
    ran++;
  }
  // Housekeeping: drop cached answers that expired more than a day ago.
  await sharedDb(ctx)
    .sourceCache.deleteMany({ where: { expiresAt: { lt: new Date(ctx.now().getTime() - 24 * 3600_000) } } })
    .catch(() => undefined);
  // New postings change which skills are asked for most: rebuild that list soon.
  if (added) await scheduleDemandRefresh(ctx);
  ctx.logger.info("searches.run", { count: added, status: `${ran} searches` });
  return { searches: ran, added };
}

const sameJobKey = (company: string, title: string) => `${normalizeLabel(company)}|${normalizeLabel(title)}`;

async function addLead(ctx: AppContext, searchId: string, p: FoundPosting): Promise<boolean> {
  if (await ctx.db.lead.findUnique({ where: { source_externalId: { source: p.source, externalId: p.externalId } } })) return false;
  // The same job listed by another source: keep the first one found.
  const key = sameJobKey(p.company, p.title);
  const twins = await ctx.db.lead
    .findMany({ where: { company: { equals: p.company, mode: "insensitive" } }, select: { company: true, title: true } })
    .catch(() => []);
  if (twins.some((t) => sameJobKey(t.company, t.title) === key)) return false;
  try {
    await ctx.db.lead.create({
      data: {
        id: randomId("lead"),
        searchId,
        source: p.source,
        externalId: p.externalId.slice(0, 500),
        title: p.title.slice(0, 300),
        company: p.company.slice(0, 200),
        location: p.location.slice(0, 300),
        remote: p.remote,
        url: p.url,
        applyUrl: p.applyUrl,
        description: p.description.slice(0, 200_000),
        descriptionComplete: p.descriptionComplete,
        postedAt: p.postedAt,
        compensation: p.compensation?.slice(0, 120) ?? null,
      },
    });
    return true;
  } catch {
    return false; // found by a parallel run
  }
}

/* ---------------------------------------------------------------- leads */

const BOARD_IDS = new Set(ATS_KINDS.map((k) => k.id as string));

/** Where a lead came from, for credit and link-back. */
export function leadSourceLabel(source: string): string {
  return sourceInfo(source)?.label ?? ATS_KINDS.find((k) => k.id === source)?.label ?? source;
}

/** What "Tailor" can do for a lead: from its own text, by reading its company page, or only after you paste the application link. */
export function leadAction(lead: { source: string; descriptionComplete: boolean }): "tailor" | "read-page" | "paste-link" {
  if (lead.descriptionComplete) return "tailor";
  return BOARD_IDS.has(lead.source) ? "read-page" : "paste-link";
}

/**
 * Start an application from a lead. With the full description, it is tailored
 * from that text (job-search services link back to their own listing, where
 * you apply; CareerFiend never opens those pages itself). A company-board lead
 * without one is read from the company's page. Others need the application link.
 */
export async function tailorLead(ctx: AppContext, leadId: string, pastedUrl?: string): Promise<string> {
  const lead = await ctx.db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const action = pastedUrl ? "paste-link" : leadAction(lead);
  if (action === "paste-link") {
    if (!pastedUrl) throw new CareerFiendError("VALIDATION_FAILED", "Open the listing, follow it to the employer's application page, and paste that link.");
    const r = await enqueueUrls(ctx, pastedUrl);
    if (!r.queued && !r.alreadyQueued.length) throw new CareerFiendError("VALIDATION_FAILED", describeEnqueue(r));
    await ctx.db.lead.update({ where: { id: leadId }, data: { status: "TAILORED" } });
    return describeEnqueue(r);
  }
  if (action === "read-page") {
    const r = await enqueueUrls(ctx, lead.url);
    await ctx.db.lead.update({ where: { id: leadId }, data: { status: "TAILORED" } });
    return describeEnqueue(r);
  }
  const board = BOARD_IDS.has(lead.source);
  const parsed = parseLead(lead);
  parsed.job.atsIdentifiers = { [lead.source]: lead.externalId };
  if (!board) {
    // Apply through the service's own listing (its terms); CareerFiend never opens it to read the form.
    parsed.job.applyUrl = null;
    parsed.warnings.push(`APPLY_VIA_SOURCE: Apply through ${leadSourceLabel(lead.source)}'s listing: ${lead.url}`);
  }
  const r = await ingestParsed(ctx, parsed, { endorse: true, source: board ? (lead.source as AtsKind) : "search" });
  await ctx.db.lead.update({ where: { id: leadId }, data: { status: "TAILORED", jobId: r.jobId } });
  return `Tailoring your résumé and cover letter for ${lead.title} at ${lead.company}. It appears under Ready to apply when done.`;
}

export async function setLeadStatus(ctx: AppContext, leadId: string, status: "SEEN" | "DISMISSED" | "NEW"): Promise<void> {
  await ctx.db.lead.update({ where: { id: leadId }, data: { status } });
}

export async function listLeads(ctx: AppContext, opts: { searchId?: string; status?: string[]; take?: number } = {}) {
  return ctx.db.lead.findMany({
    where: { ...(opts.searchId ? { searchId: opts.searchId } : {}), ...(opts.status ? { status: { in: opts.status } } : {}) },
    orderBy: [{ foundAt: "desc" }],
    take: opts.take ?? 200,
    select: {
      id: true,
      searchId: true,
      source: true,
      title: true,
      company: true,
      location: true,
      remote: true,
      url: true,
      descriptionComplete: true,
      postedAt: true,
      compensation: true,
      status: true,
      jobId: true,
      foundAt: true,
    },
  });
}
