import { NormalizedJobSchema, sha256, type NormalizedJob } from "@careerfiend/shared";
import {
  canonicalUrl,
  cheerio,
  findApplyLinks,
  findJobPostingJsonLd,
  htmlToText,
  jsonLdApplicantCountries,
  jsonLdCompany,
  jsonLdLocations,
  jsonLdSalary,
  visibleText,
} from "./html";
import { parseLocation } from "./location";
import { blocksFromText, splitRequirements } from "./requirements";
import type { AtsPosting } from "./ats";

export interface ParsedListing {
  job: NormalizedJob;
  /** Visible text captured from the page, kept as evidence. */
  pageText: string;
  contentHash: string;
  warnings: string[];
}

const EXPIRED_RE =
  /\b(no longer (accepting applications|available|open)|this (job|position|posting) (has been|is) (filled|closed|expired)|job (has )?expired|position (has been )?filled)\b/i;
const SUSPICIOUS_RE =
  /\b(wire transfer|pay (a|the) (fee|deposit)|processing fee|bank account (number|details)|social security number|ssn|gift cards?|telegram|whatsapp (only|interview)|check (deposit|cashing))\b/i;

function contentHashOf(job: Pick<NormalizedJob, "company" | "title" | "description" | "location">): string {
  return sha256(JSON.stringify([job.company, job.title, job.location.raw, job.description]));
}

function finish(job: NormalizedJob, pageText: string, extraWarnings: string[] = []): ParsedListing {
  const warnings = [...extraWarnings];
  const expiredByDate = job.validThrough ? new Date(job.validThrough).getTime() < Date.now() : false;
  if (EXPIRED_RE.test(pageText) || expiredByDate) job.expired = true;
  if (SUSPICIOUS_RE.test(pageText))
    warnings.push("SUSPICIOUS: the listing mentions fees, bank details, SSN, or off-platform chat. Verify the employer before continuing.");
  const parsed = NormalizedJobSchema.parse(job);
  return { job: parsed, pageText, contentHash: contentHashOf(parsed), warnings };
}

/** Parse an HTML job page (employer site, fixture, or a job board page). */
export function parseListingHtml(html: string, pageUrl: string, source: NormalizedJob["source"] = "page"): ParsedListing {
  const $ = cheerio.load(html);
  const jp = findJobPostingJsonLd($);
  const warnings: string[] = [];
  const canon = canonicalUrl($, pageUrl);
  const pageText = visibleText($);

  const title = (jp?.title ?? $("h1").first().text() ?? $('meta[property="og:title"]').attr("content") ?? "").trim();
  const company =
    (jp && jsonLdCompany(jp)) ||
    $('meta[property="og:site_name"]').attr("content")?.trim() ||
    $("[data-company]").first().attr("data-company") ||
    $(".company, [itemprop=hiringOrganization]").first().text().trim() ||
    new URL(pageUrl).hostname.replace(/^www\./, "");

  const descriptionHtml = jp?.description ?? $("main").html() ?? $("body").html() ?? "";
  const descriptionText = htmlToText(descriptionHtml);

  const jsonLocs = jp ? jsonLdLocations(jp) : [];
  const domLoc = $("[data-location], .location, [itemprop=jobLocation]").first().text().trim();
  const raw = jsonLocs.join(" / ") || domLoc || "";
  const location = parseLocation({
    raw: jp?.jobLocationType === "TELECOMMUTE" && !/remote/i.test(raw) ? `Remote${raw ? ` / ${raw}` : ""}` : raw,
    locations: jsonLocs.length ? jsonLocs : undefined,
    remoteHint: jp?.jobLocationType === "TELECOMMUTE",
    applicantCountries: jp ? jsonLdApplicantCountries(jp) : [],
    descriptionText,
  });

  const applyLinks = findApplyLinks($, pageUrl);
  const external = applyLinks.find((a) => a.external);
  const applyUrl = external?.url ?? applyLinks[0]?.url ?? null;
  if (!applyLinks.length) warnings.push("NO_APPLY_LINK: no ordinary Apply link was found on the listing page.");

  const blocks = blocksFromText(descriptionText);
  const requirements = splitRequirements(blocks, canon);

  const job: NormalizedJob = {
    sourceUrl: pageUrl,
    canonicalUrl: canon,
    applyUrl,
    company: company || "Unknown company",
    title: title || "Untitled role",
    location,
    compensation: jp ? jsonLdSalary(jp) : null,
    description: descriptionText || pageText,
    requirements,
    applicationInstructions: null,
    postedAt: jp?.datePosted ?? null,
    validThrough: jp?.validThrough ?? null,
    source,
    atsIdentifiers: {},
    expired: false,
  };
  if (!company) warnings.push("SUSPICIOUS: no hiring company is named on the listing.");
  return finish(job, pageText || descriptionText, warnings);
}

/** Normalize a posting from a public ATS API. */
export function parseAtsPosting(p: AtsPosting): ParsedListing {
  const descriptionText = htmlToText(p.descriptionHtml);
  const location = parseLocation({
    raw: p.locationRaw,
    remoteHint: p.remote,
    workplaceHint: p.workplaceHint,
    descriptionText,
  });
  const job: NormalizedJob = {
    sourceUrl: p.listingUrl,
    canonicalUrl: p.listingUrl,
    applyUrl: p.applyUrl,
    company: p.company,
    title: p.title,
    location,
    compensation: p.compensation,
    description: descriptionText,
    requirements: splitRequirements(blocksFromText(descriptionText), p.listingUrl),
    applicationInstructions: null,
    postedAt: p.postedAt,
    validThrough: null,
    source: p.ats,
    atsIdentifiers: { [p.ats]: `${p.board}/${p.id}` },
    expired: false,
  };
  return finish(job, descriptionText);
}
