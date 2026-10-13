import { describe, expect, it } from "vitest";
import { NullProvider, type DemandMap, type DemandRequest } from "@careerfiend/ai";
import { parseListingHtml } from "@careerfiend/job-parser";
import { importInventory, loadInventoryFile } from "@careerfiend/profile";
import { createLogger, loadConfig } from "@careerfiend/shared";
import { createAppContext, demandGaps, demandJobs, demandView, generateDemandMap, ingestParsed, type AppContext } from "../src/index";
import { KIT_INVENTORY, makeResumeRepo, readResumeSource, storeResume, tempDir, testDbAsync } from "../../../tests/helpers";

function listing(company: string, requirements: string[]) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Quality Analyst",
    hiringOrganization: { "@type": "Organization", name: company },
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Los Angeles", addressRegion: "CA", addressCountry: "US" } },
    description: `<h3>Requirements</h3><ul>${requirements.map((r) => `<li>${r}</li>`).join("")}</ul>`,
  };
  const html = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;
  return parseListingHtml(html, `https://careers.example.com/${company.toLowerCase()}`, "page");
}

async function env(ai = new NullProvider()): Promise<AppContext> {
  const repo = makeResumeRepo();
  const config = loadConfig({
    root: tempDir("cf-demand-"),
    env: { APP_ENCRYPTION_KEY_SOURCE: "env:CF_TEST_KEY", AI_PROVIDER: "none" },
  });
  const { db } = await testDbAsync();
  const c = createAppContext({ db, config, ai, logger: createLogger({ level: "error" }) });
  await storeResume(db, readResumeSource(repo.dir));
  await importInventory(db, loadInventoryFile(KIT_INVENTORY));
  return c;
}

async function addJobs(c: AppContext) {
  await ingestParsed(c, listing("Acme", ["Experience with CAPA investigations", "Hands-on GMP batch record review", "Bachelor's degree in biology"]), {
    endorse: true,
  });
  await ingestParsed(c, listing("Beacon", ["Lead CAPA and deviation investigations", "Experience with Tableau"]), { endorse: true });
  await ingestParsed(c, listing("Cobalt", ["Experience with Tableau dashboards"]), {}); // a watchlist find: not yours, not counted
}

/** Stand-in for the model: groups by real requirement ids, plus items that must be dropped. */
class DemandAi extends NullProvider {
  override readonly available = true;
  seen: DemandRequest | null = null;
  override async mapDemand(req: DemandRequest): Promise<DemandMap> {
    this.seen = req;
    const id = (text: RegExp) => req.jobs.flatMap((j) => j.requirements).find((r) => text.test(r.text))!.id;
    return {
      items: [
        {
          name: "CAPA investigations",
          kind: "process",
          keywords: ["CAPA"],
          requirementIds: [id(/CAPA investigations/), id(/CAPA and deviation/)],
          whyItMatters: "Both teams run quality investigations.",
        },
        {
          name: "GMP batch record review",
          kind: "process",
          keywords: ["batch record", "GMP"],
          requirementIds: [id(/batch record/)],
          whyItMatters: "Release depends on it.",
        },
        { name: "Tableau", kind: "tool", keywords: ["Tableau"], requirementIds: [id(/Tableau/), "req_invented"], whyItMatters: "Reporting." },
        { name: "Bachelor's degree", kind: "domain", keywords: [], requirementIds: [id(/CAPA investigations/)], whyItMatters: "x" },
        { name: "Invented skill", kind: "skill", keywords: [], requirementIds: ["req_nope"], whyItMatters: "x" },
      ],
    };
  }
}

describe("skills to demonstrate", () => {
  it("aggregates the jobs you added, keeps only items citing real requirements, and checks your résumé", async () => {
    const ai = new DemandAi();
    const c = await env(ai);
    await addJobs(c);
    expect((await demandJobs(c)).map((j) => j.company).sort()).toEqual(["Acme", "Beacon"]);
    const out = await generateDemandMap(c);
    expect(out).toMatchObject({ jobs: 2, method: "ai" });
    // Degrees and other checkable facts are not even sent to the model.
    expect(ai.seen!.jobs.flatMap((j) => j.requirements).some((r) => /Bachelor/.test(r.text))).toBe(false);

    const view = (await demandView(c))!;
    expect(view.items.map((i) => i.name)).toEqual(["CAPA investigations", "GMP batch record review", "Tableau"]);
    const capa = view.items[0]!;
    expect(capa.jobIds.length).toBe(2);
    expect(capa.status).toBe("not_shown");
    // The fixture résumé says "Performed QA testing on 12 batches under GMP protocols."
    expect(view.items.find((i) => i.name === "GMP batch record review")!.status).toBe("shown");
    expect(view.items.find((i) => i.name === "Tableau")!.requirementIds).not.toContain("req_invented");
    expect(await demandGaps(c)).toEqual(["CAPA investigations", "Tableau"]);
    expect(view.newJobs).toBe(0);

    await ingestParsed(c, listing("Delta", ["Experience with SQL"]), { endorse: true });
    expect((await demandView(c))!.newJobs).toBe(1);
    // Adding a job schedules a delayed automatic rebuild (one per burst).
    expect(await c.db.workItem.count({ where: { kind: "DEMAND_MAP", dedupeKey: "demand:auto" } })).toBe(1);
  });

  it("without an AI provider, falls back to listing keywords counted across jobs", async () => {
    const c = await env();
    await addJobs(c);
    const out = await generateDemandMap(c);
    expect(out.method).toBe("keywords");
    const view = (await demandView(c))!;
    const tableau = view.items.find((i) => i.name === "Tableau")!;
    expect(tableau.jobIds.length).toBe(1); // Cobalt was not added by you
  });
});
