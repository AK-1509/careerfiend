import { randomId } from "@careerfiend/shared";
import { DEFAULT_ATS_BASES, defaultFetcher, fetchBoard, parseAtsPosting, type AtsKind } from "@careerfiend/job-parser";
import type { AppContext } from "./context";
import { ingestParsed } from "./ingest";

/**
 * Authorized discovery (D6): a company watchlist read through public ATS
 * job-board endpoints. New postings are listed on the Jobs page for you to
 * look at; none is applied to until you press Apply. Nothing is filtered out
 * or judged: known listings are only de-duplicated by canonical URL.
 */

export async function addWatchlistCompany(ctx: AppContext, input: { ats: AtsKind; boardSlug: string; name: string }): Promise<string> {
  const id = randomId("wl");
  await ctx.db.watchlistCompany.upsert({
    where: { ats_boardSlug: { ats: input.ats, boardSlug: input.boardSlug } },
    create: { id, ats: input.ats, boardSlug: input.boardSlug.trim(), name: input.name.trim() || input.boardSlug },
    update: { name: input.name.trim() || input.boardSlug, enabled: true },
  });
  return id;
}

export async function pollWatchlist(ctx: AppContext): Promise<{ companies: number; seen: number; ingested: number }> {
  const companies = await ctx.db.watchlistCompany.findMany({ where: { enabled: true } });
  let seen = 0;
  let ingested = 0;
  for (const c of companies) {
    let postings;
    try {
      postings = await fetchBoard(c.ats as AtsKind, c.boardSlug, ctx.fetchers?.json ?? defaultFetcher, ctx.fetchers?.atsBases ?? DEFAULT_ATS_BASES);
    } catch (err) {
      ctx.logger.warn("watchlist.fetch_failed", { host: c.ats, error: err });
      continue;
    }
    for (const p of postings) {
      seen++;
      if (await ctx.db.job.findUnique({ where: { canonicalUrl: p.listingUrl } })) continue;
      const parsed = parseAtsPosting({ ...p, company: c.name });
      await ingestParsed(ctx, parsed, { source: c.ats as AtsKind });
      ingested++;
    }
    await ctx.db.watchlistCompany.update({ where: { id: c.id }, data: { lastPolledAt: ctx.now() } });
  }
  return { companies: companies.length, seen, ingested };
}
