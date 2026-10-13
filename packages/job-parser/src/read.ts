import { assertPublicUrl, CareerFiendError, fetchPublic } from "@careerfiend/shared";
import { atsRefFromUrl, DEFAULT_ATS_BASES, defaultFetcher, fetchAtsPosting, USER_AGENT, type AtsBases, type Fetcher } from "./ats";
import { cheerio, findApplyLinks } from "./html";
import { parseAtsPosting, parseListingHtml, type ParsedListing } from "./parse";
import { robotsAllows, sitePolicy } from "./site-policy";

/** Shown wherever links are pasted and whenever a LinkedIn or Indeed link is refused. */
export const JOB_BOARD_LINK_HELP =
  "LinkedIn and Indeed links don't work. Open the listing on LinkedIn or Indeed, follow it to the employer's application page (click Apply, or Apply on company site), and send that link instead.";

/** Returns rendered HTML for a URL (the worker passes a Playwright-backed one). */
export type HtmlFetcher = (url: string) => Promise<{ html: string; finalUrl: string; status: number }>;

/** Plain HTTP fetcher. Every hop is checked: a pasted link (or its redirect) may never reach a private address. */
export const plainHtmlFetcher: HtmlFetcher = (url) => fetchHtml(url, false);

async function fetchHtml(url: string, allowLocalhost: boolean): Promise<{ html: string; finalUrl: string; status: number }> {
  let res: Response;
  try {
    res = await fetchPublic(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" }, signal: AbortSignal.timeout(30_000) }, { allowLocalhost });
  } catch (err) {
    if (err instanceof CareerFiendError) throw err;
    throw new CareerFiendError("NETWORK_TRANSIENT", `Could not fetch ${url}`, { cause: err });
  }
  return { html: await res.text(), finalUrl: res.url || url, status: res.status };
}

export interface ReadDeps {
  html?: HtmlFetcher;
  json?: Fetcher;
  atsBases?: AtsBases;
  allowLocalhost?: boolean;
  /** Skip robots.txt (fixture tests only). */
  ignoreRobots?: boolean;
}

async function checkRobots(url: string, deps: ReadDeps): Promise<void> {
  if (deps.ignoreRobots) return;
  const u = new URL(url);
  try {
    const res = await fetchPublic(`${u.origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    if (!robotsAllows(await res.text(), u.pathname)) {
      throw new CareerFiendError("SITE_NOT_PERMITTED", `robots.txt at ${u.host} disallows ${u.pathname}.`);
    }
  } catch (err) {
    if (err instanceof CareerFiendError) throw err;
    /* robots.txt unreachable: proceed (it is advisory when absent) */
  }
}

/**
 * Read and normalize one listing URL.
 * - Hosted ATS URLs are read through the board's public API.
 * - LinkedIn and Indeed pages are never read (public edition): the person
 *   follows the listing to the employer's application page and pastes that.
 * - Any other address must resolve to the public internet.
 */
export async function readListing(url: string, deps: ReadDeps = {}, depth = 0): Promise<ParsedListing> {
  const policy = sitePolicy(url, { allowLocalhost: deps.allowLocalhost });
  if (!policy.readAllowed) throw new CareerFiendError("SITE_NOT_PERMITTED", policy.note);
  if (policy.followExternalApplyOnly) throw new CareerFiendError("SITE_NOT_PERMITTED", JOB_BOARD_LINK_HELP);

  const ref = atsRefFromUrl(url);
  if (ref) {
    const posting = await fetchAtsPosting(ref, deps.json ?? defaultFetcher, deps.atsBases ?? DEFAULT_ATS_BASES);
    const parsed = parseAtsPosting(posting);
    if (url !== parsed.job.sourceUrl) parsed.job.sourceUrl = url;
    return parsed;
  }

  // Not a known job board API: the address must be on the public internet.
  if (policy.kind !== "fixture") await assertPublicUrl(url, { allowLocalhost: deps.allowLocalhost });
  if (policy.kind !== "fixture") await checkRobots(url, deps);
  const page = await (deps.html ?? ((u: string) => fetchHtml(u, !!deps.allowLocalhost)))(url);
  if (page.status === 404 || page.status === 410) throw new CareerFiendError("PAGE_CHANGED", `Listing returned HTTP ${page.status} (expired or moved).`);
  if (page.status >= 500) throw new CareerFiendError("NETWORK_TRANSIENT", `Listing returned HTTP ${page.status}.`);

  if (policy.followExternalApplyOnly) {
    if (depth > 0) throw new CareerFiendError("SITE_NOT_PERMITTED", "Apply link points back to a job board.");
    const $ = cheerio.load(page.html);
    const external = findApplyLinks($, page.finalUrl).find((a) => a.external && !sitePolicy(a.url).followExternalApplyOnly);
    if (!external) {
      throw new CareerFiendError(
        "SITE_NOT_PERMITTED",
        `This ${policy.kind} listing has no external Apply link (Easy Apply only). Apply manually on ${policy.kind}.`,
      );
    }
    const target = await readListing(external.url, deps, depth + 1);
    target.job.sourceUrl = url;
    return target;
  }

  const parsed = parseListingHtml(page.html, page.finalUrl, policy.kind === "fixture" ? "fixture" : "page");
  parsed.job.sourceUrl = url;
  return parsed;
}
