import { CareerFiendError } from "@careerfiend/shared";

/**
 * Public, documented job-board endpoints. Read-only listing data; no
 * authentication, no private APIs. Base URLs are injectable for fixture tests.
 * Terms notes: docs/site-support.md.
 */

export type AtsKind = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "recruitee" | "workable" | "personio";

export const ATS_KINDS: { id: AtsKind; label: string; slugHelp: string }[] = [
  { id: "greenhouse", label: "Greenhouse", slugHelp: "boards.greenhouse.io/<slug>" },
  { id: "lever", label: "Lever", slugHelp: "jobs.lever.co/<slug>" },
  { id: "ashby", label: "Ashby", slugHelp: "jobs.ashbyhq.com/<slug>" },
  { id: "smartrecruiters", label: "SmartRecruiters", slugHelp: "jobs.smartrecruiters.com/<slug>" },
  { id: "recruitee", label: "Recruitee", slugHelp: "<slug>.recruitee.com" },
  { id: "workable", label: "Workable", slugHelp: "apply.workable.com/<slug>" },
  { id: "personio", label: "Personio", slugHelp: "<slug>.jobs.personio.de" },
];

export interface AtsBases {
  greenhouse: string;
  lever: string;
  ashby: string;
  smartrecruiters?: string;
  /** "{slug}" is replaced by the company's board name. */
  recruitee?: string;
  workable?: string;
  personio?: string;
}

export const DEFAULT_ATS_BASES: AtsBases = {
  greenhouse: "https://boards-api.greenhouse.io/v1/boards",
  lever: "https://api.lever.co/v0/postings",
  ashby: "https://api.ashbyhq.com/posting-api/job-board",
  smartrecruiters: "https://api.smartrecruiters.com/v1/companies",
  recruitee: "https://{slug}.recruitee.com/api",
  workable: "https://apply.workable.com/api/v1/widget/accounts",
  personio: "https://{slug}.jobs.personio.de",
};

/** A company board slug as typed into the watchlist: letters, digits, dot, dash and underscore. */
export const BOARD_SLUG_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export interface AtsPosting {
  ats: AtsKind;
  board: string;
  id: string;
  title: string;
  company: string;
  locationRaw: string;
  workplaceHint: string | null;
  remote: boolean;
  descriptionHtml: string;
  listingUrl: string;
  applyUrl: string;
  postedAt: string | null;
  compensation: string | null;
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export const USER_AGENT = "CareerFiend/0.1 (job-application assistant; reads public postings; low volume)";

export const defaultFetcher: Fetcher = (url) => fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });

async function getJson(fetcher: Fetcher, url: string): Promise<unknown> {
  let res;
  try {
    res = await fetcher(url);
  } catch (err) {
    throw new CareerFiendError("NETWORK_TRANSIENT", `Request failed: ${url}`, { cause: err });
  }
  if (res.status === 404) throw new CareerFiendError("PAGE_CHANGED", `Not found: ${url}`);
  if (res.status >= 500 || res.status === 429) throw new CareerFiendError("NETWORK_TRANSIENT", `HTTP ${res.status}: ${url}`);
  if (!res.ok) throw new CareerFiendError("PAGE_CHANGED", `HTTP ${res.status}: ${url}`);
  return res.json();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/* -------------------------------------------------------------- greenhouse */

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  content?: string;
  updated_at?: string;
  first_published?: string;
  company_name?: string;
}

function ghToPosting(board: string, j: GhJob): AtsPosting {
  const loc = j.location?.name ?? "";
  return {
    ats: "greenhouse",
    board,
    id: String(j.id),
    title: j.title,
    company: j.company_name ?? board,
    locationRaw: loc,
    workplaceHint: null,
    remote: /remote/i.test(loc),
    descriptionHtml: decodeEntities(j.content ?? ""),
    listingUrl: j.absolute_url,
    applyUrl: j.absolute_url,
    postedAt: j.first_published ?? j.updated_at ?? null,
    compensation: null,
  };
}

export async function greenhouseBoard(board: string, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting[]> {
  const data = (await getJson(fetcher, `${bases.greenhouse}/${encodeURIComponent(board)}/jobs?content=true`)) as { jobs?: GhJob[] };
  return (data.jobs ?? []).map((j) => ghToPosting(board, j));
}

export async function greenhouseJob(board: string, id: string, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting> {
  const j = (await getJson(fetcher, `${bases.greenhouse}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`)) as GhJob;
  return ghToPosting(board, j);
}

/* ------------------------------------------------------------------- lever */

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl: string;
  categories?: { location?: string; allLocations?: string[]; commitment?: string; team?: string };
  workplaceType?: string;
  description?: string;
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additional?: string;
  createdAt?: number;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

function leverToPosting(board: string, p: LeverPosting): AtsPosting {
  const lists = (p.lists ?? []).map((l) => `<h3>${l.text}</h3><ul>${l.content}</ul>`).join("");
  const loc = p.categories?.allLocations?.join(" / ") || p.categories?.location || "";
  const sr = p.salaryRange;
  return {
    ats: "lever",
    board,
    id: p.id,
    title: p.text,
    company: board,
    locationRaw: loc,
    workplaceHint: p.workplaceType ?? null,
    remote: p.workplaceType === "remote" || /remote/i.test(loc),
    descriptionHtml: `${p.description ?? ""}${lists}${p.additional ?? ""}`,
    listingUrl: p.hostedUrl,
    applyUrl: p.applyUrl,
    postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    compensation: sr && sr.min !== undefined ? `${sr.currency ?? ""} ${sr.min}–${sr.max ?? ""} ${sr.interval ?? ""}`.trim() : null,
  };
}

export async function leverBoard(board: string, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting[]> {
  const data = (await getJson(fetcher, `${bases.lever}/${encodeURIComponent(board)}?mode=json`)) as LeverPosting[];
  return (Array.isArray(data) ? data : []).map((p) => leverToPosting(board, p));
}

export async function leverJob(board: string, id: string, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting> {
  const p = (await getJson(fetcher, `${bases.lever}/${encodeURIComponent(board)}/${encodeURIComponent(id)}?mode=json`)) as LeverPosting;
  return leverToPosting(board, p);
}

/* ------------------------------------------------------------------- ashby */

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  isRemote?: boolean;
  workplaceType?: string;
  descriptionHtml?: string;
  jobUrl: string;
  applyUrl: string;
  publishedAt?: string;
  compensation?: { compensationTierSummary?: string };
}

function ashbyToPosting(board: string, j: AshbyJob): AtsPosting {
  const locs = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean) as string[];
  return {
    ats: "ashby",
    board,
    id: j.id,
    title: j.title,
    company: board,
    locationRaw: locs.join(" / "),
    workplaceHint: j.workplaceType ?? (j.isRemote ? "Remote" : null),
    remote: !!j.isRemote || /remote/i.test(j.workplaceType ?? ""),
    descriptionHtml: j.descriptionHtml ?? "",
    listingUrl: j.jobUrl,
    applyUrl: j.applyUrl,
    postedAt: j.publishedAt ?? null,
    compensation: j.compensation?.compensationTierSummary ?? null,
  };
}

export async function ashbyBoard(board: string, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting[]> {
  const data = (await getJson(fetcher, `${bases.ashby}/${encodeURIComponent(board)}?includeCompensation=true`)) as { jobs?: AshbyJob[] };
  return (data.jobs ?? []).map((j) => ashbyToPosting(board, j));
}

/* ------------------------------------------------- more public company boards
 * Company careers-site feeds the vendors publish for exactly this purpose
 * (career pages, widgets, job-board syndication). Read-only, no keys. Each
 * returns what the list endpoint carries; some carry no description (the
 * posting's own page is read when you choose it).
 */

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const slugUrl = (base: string, slug: string) => base.replace("{slug}", encodeURIComponent(slug));

interface SrPosting {
  id?: string;
  name?: string;
  releasedDate?: string;
  company?: { name?: string; identifier?: string };
  location?: { city?: string; region?: string; country?: string; remote?: boolean; fullLocation?: string };
}

export async function smartRecruitersBoard(board: string, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting[]> {
  const base = bases.smartrecruiters ?? DEFAULT_ATS_BASES.smartrecruiters!;
  const data = (await getJson(fetcher, `${base}/${encodeURIComponent(board)}/postings?limit=100`)) as { content?: SrPosting[] };
  return (data.content ?? [])
    .filter((p) => p.id && p.name)
    .map((p) => {
      const loc = p.location?.fullLocation ?? [p.location?.city, p.location?.region, p.location?.country?.toUpperCase()].filter(Boolean).join(", ");
      const url = `https://jobs.smartrecruiters.com/${encodeURIComponent(board)}/${encodeURIComponent(p.id!)}`;
      return {
        ats: "smartrecruiters" as const,
        board,
        id: p.id!,
        title: p.name!,
        company: p.company?.name ?? board,
        locationRaw: loc,
        workplaceHint: p.location?.remote ? "Remote" : null,
        remote: !!p.location?.remote,
        descriptionHtml: "",
        listingUrl: url,
        applyUrl: url,
        postedAt: p.releasedDate ?? null,
        compensation: null,
      };
    });
}

interface RecruiteeOffer {
  id?: number;
  slug?: string;
  title?: string;
  description?: string;
  requirements?: string;
  location?: string;
  remote?: boolean;
  careers_url?: string;
  careers_apply_url?: string;
  published_at?: string;
  company_name?: string;
}

export async function recruiteeBoard(board: string, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting[]> {
  const base = slugUrl(bases.recruitee ?? DEFAULT_ATS_BASES.recruitee!, board);
  const data = (await getJson(fetcher, `${base}/offers/`)) as { offers?: RecruiteeOffer[] };
  return (data.offers ?? [])
    .filter((o) => o.title && (o.careers_url || o.slug))
    .map((o) => {
      const url = o.careers_url ?? `https://${board}.recruitee.com/o/${o.slug}`;
      return {
        ats: "recruitee" as const,
        board,
        id: str(o.id ?? o.slug),
        title: o.title!,
        company: o.company_name ?? board,
        locationRaw: o.location ?? "",
        workplaceHint: o.remote ? "Remote" : null,
        remote: !!o.remote || /remote/i.test(o.location ?? ""),
        descriptionHtml: [o.description, o.requirements].filter(Boolean).join("\n"),
        listingUrl: url,
        applyUrl: o.careers_apply_url ?? url,
        postedAt: o.published_at ?? null,
        compensation: null,
      };
    });
}

interface WorkableJob {
  title?: string;
  shortcode?: string;
  url?: string;
  application_url?: string;
  shortlink?: string;
  telecommuting?: boolean;
  city?: string;
  state?: string;
  country?: string;
  description?: string;
  published_on?: string;
  created_at?: string;
}

export async function workableBoard(board: string, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting[]> {
  const base = bases.workable ?? DEFAULT_ATS_BASES.workable!;
  const data = (await getJson(fetcher, `${base}/${encodeURIComponent(board)}?details=true`)) as { name?: string; jobs?: WorkableJob[] };
  return (data.jobs ?? [])
    .filter((j) => j.title && (j.url || j.shortcode))
    .map((j) => {
      const url = j.url ?? `https://apply.workable.com/${encodeURIComponent(board)}/j/${j.shortcode}/`;
      return {
        ats: "workable" as const,
        board,
        id: j.shortcode ?? url,
        title: j.title!,
        company: data.name ?? board,
        locationRaw: [j.city, j.state, j.country].filter(Boolean).join(", "),
        workplaceHint: j.telecommuting ? "Remote" : null,
        remote: !!j.telecommuting,
        descriptionHtml: j.description ?? "",
        listingUrl: url,
        applyUrl: j.application_url ?? url,
        postedAt: j.published_on ?? j.created_at ?? null,
        compensation: null,
      };
    });
}

export async function personioBoard(board: string, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting[]> {
  const base = slugUrl(bases.personio ?? DEFAULT_ATS_BASES.personio!, board);
  let res;
  try {
    res = await fetcher(`${base}/xml?language=en`);
  } catch (err) {
    throw new CareerFiendError("NETWORK_TRANSIENT", `Request failed: ${base}/xml`, { cause: err });
  }
  if (res.status === 429 || res.status >= 500) throw new CareerFiendError("NETWORK_TRANSIENT", `HTTP ${res.status}: ${base}/xml`);
  if (!res.ok) throw new CareerFiendError("PAGE_CHANGED", `HTTP ${res.status}: ${base}/xml`);
  const { load } = await import("cheerio");
  const $ = load(await res.text(), { xml: true });
  const out: AtsPosting[] = [];
  $("position").each((_, el) => {
    const p = $(el);
    const id = p.children("id").first().text().trim();
    const title = p.children("name").first().text().trim();
    if (!id || !title) return;
    const office = p.children("office").first().text().trim();
    const parts: string[] = [];
    p.find("jobDescription").each((__, d) => {
      const name = $(d).children("name").text().trim();
      const value = $(d).children("value").text();
      parts.push(name ? `<h3>${name}</h3>${value}` : value);
    });
    const url = `${base}/job/${encodeURIComponent(id)}`;
    out.push({
      ats: "personio",
      board,
      id,
      title,
      company: p.children("subcompany").first().text().trim() || board,
      locationRaw: office,
      workplaceHint: null,
      remote: /remote/i.test(office),
      descriptionHtml: parts.join("\n"),
      listingUrl: url,
      applyUrl: url,
      postedAt: p.children("createdAt").first().text().trim() || null,
      compensation: null,
    });
  });
  return out;
}

/* ------------------------------------------------------------ url routing */

export interface AtsRef {
  ats: AtsKind;
  board: string;
  id: string;
}

/** Recognize hosted ATS listing URLs so the public API can be used instead of scraping. */
export function atsRefFromUrl(url: string): AtsRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(u.hostname)) {
    const i = parts.indexOf("jobs");
    if (i > 0 && parts[i + 1]) return { ats: "greenhouse", board: parts[i - 1]!, id: parts[i + 1]! };
    const gh = u.searchParams.get("gh_jid");
    const board = u.searchParams.get("for");
    if (gh && board) return { ats: "greenhouse", board, id: gh };
  }
  if (u.hostname === "jobs.lever.co" && parts.length >= 2) return { ats: "lever", board: parts[0]!, id: parts[1]! };
  if (u.hostname === "jobs.ashbyhq.com" && parts.length >= 2) return { ats: "ashby", board: parts[0]!, id: parts[1]! };
  return null;
}

export async function fetchAtsPosting(ref: AtsRef, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting> {
  if (ref.ats === "greenhouse") return greenhouseJob(ref.board, ref.id, fetcher, bases);
  if (ref.ats === "lever") return leverJob(ref.board, ref.id, fetcher, bases);
  const all = await ashbyBoard(ref.board, fetcher, bases);
  const found = all.find((j) => j.id === ref.id);
  if (!found) throw new CareerFiendError("PAGE_CHANGED", `Ashby job ${ref.id} not found on board ${ref.board} (expired?).`);
  return found;
}

export async function fetchBoard(ats: AtsKind, board: string, fetcher: Fetcher = defaultFetcher, bases: AtsBases = DEFAULT_ATS_BASES): Promise<AtsPosting[]> {
  switch (ats) {
    case "greenhouse":
      return greenhouseBoard(board, fetcher, bases);
    case "lever":
      return leverBoard(board, fetcher, bases);
    case "ashby":
      return ashbyBoard(board, fetcher, bases);
    case "smartrecruiters":
      return smartRecruitersBoard(board, fetcher, bases);
    case "recruitee":
      return recruiteeBoard(board, fetcher, bases);
    case "workable":
      return workableBoard(board, fetcher, bases);
    case "personio":
      return personioBoard(board, fetcher, bases);
  }
}
