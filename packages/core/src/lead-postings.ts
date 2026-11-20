import { ATS_KINDS, parseAtsPosting, type AtsKind, type ParsedListing } from "@careerfiend/job-parser";
import type { ProjectJobInput } from "@careerfiend/ai";
import type { AppContext } from "./context";

/**
 * Leads (postings a saved search found) read as listings. "Tailor my résumé"
 * builds an application from one; Skills to demonstrate and Project
 * Recommendations count what hundreds of them ask for, without turning each
 * one into an application.
 */

const BOARD_IDS = new Set(ATS_KINDS.map((k) => k.id as string));

/** Leads are told apart from your jobs by this id prefix. */
export const LEAD_ID_PREFIX = "lead:";

export interface LeadRow {
  id: string;
  source: string;
  externalId: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  url: string;
  applyUrl: string | null;
  description: string;
  postedAt: Date | null;
  compensation: string | null;
}

/** A lead's description, parsed exactly as a listing read from its page would be. */
export function parseLead(lead: LeadRow): ParsedListing {
  const board = BOARD_IDS.has(lead.source);
  return parseAtsPosting({
    ats: (board ? lead.source : "greenhouse") as AtsKind,
    board: lead.source,
    id: lead.externalId,
    title: lead.title,
    company: lead.company,
    locationRaw: lead.location,
    workplaceHint: lead.remote ? "Remote" : null,
    remote: lead.remote,
    descriptionHtml: lead.description,
    listingUrl: lead.url,
    applyUrl: lead.applyUrl ?? lead.url,
    postedAt: lead.postedAt?.toISOString() ?? null,
    compensation: lead.compensation,
  });
}

/**
 * The leads you have not dismissed or already tailored (those are jobs now),
 * with a full description, newest first, as requirement lists.
 */
export async function leadJobInputs(
  ctx: AppContext,
  opts: { limit: number; maxRequirements: number; maxText: number; skipKinds?: Set<string> },
): Promise<ProjectJobInput[]> {
  const rows = await ctx.db.lead.findMany({
    where: { status: { in: ["NEW", "SEEN"] }, descriptionComplete: true, jobId: null },
    orderBy: { foundAt: "desc" },
    take: opts.limit,
  });
  const out: ProjectJobInput[] = [];
  for (const lead of rows) {
    let requirements: ProjectJobInput["requirements"];
    try {
      requirements = parseLead(lead)
        .job.requirements.filter((r) => ["required", "preferred", "responsibility"].includes(r.category) && !opts.skipKinds?.has(r.kind))
        .slice(0, opts.maxRequirements)
        .map((r) => ({ id: `${LEAD_ID_PREFIX}${lead.id}:${r.id}`, text: r.text.slice(0, opts.maxText), category: r.category }));
    } catch {
      continue; // a description that cannot be read is left out
    }
    if (requirements.length) out.push({ id: `${LEAD_ID_PREFIX}${lead.id}`, company: lead.company, title: lead.title, requirements });
  }
  return out;
}
