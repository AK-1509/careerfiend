import { CareerFiendError } from "@careerfiend/shared";

/**
 * Public, documented job-board endpoints (D6). Read-only listing data; no
 * authentication, no private APIs. Base URLs are injectable for fixture tests.
 * Terms notes: docs/site-support.md.
 */

export type AtsKind = "greenhouse" | "lever" | "ashby";

export interface AtsBases {
  greenhouse: string;
  lever: string;
  ashby: string;
}

export const DEFAULT_ATS_BASES: AtsBases = {
  greenhouse: "https://boards-api.greenhouse.io/v1/boards",
  lever: "https://api.lever.co/v0/postings",
  ashby: "https://api.ashbyhq.com/posting-api/job-board",
};

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
  if (ats === "greenhouse") return greenhouseBoard(board, fetcher, bases);
  if (ats === "lever") return leverBoard(board, fetcher, bases);
  return ashbyBoard(board, fetcher, bases);
}
