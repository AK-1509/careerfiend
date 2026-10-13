import { describe, expect, it } from "vitest";
import { NullProvider, type TransferProposal, type TransferRequest } from "@careerfiend/ai";
import { parseListingHtml, type Fetcher } from "@careerfiend/job-parser";
import { importInventory, loadInventoryFile } from "@careerfiend/profile";
import { createLogger, loadConfig } from "@careerfiend/shared";
import {
  backfillPostedJobs,
  bankBackfillPending,
  computeTransfers,
  createAppContext,
  enqueueUrls,
  githubRepos,
  ingestParsed,
  listBank,
  loadBank,
  setBankedSkillStatus,
  type AppContext,
} from "../src/index";
import { KIT_INVENTORY, makeResumeRepo, readResumeSource, storeResume, tempDir, testDbAsync } from "../../../tests/helpers";

function listing(company: string, sections: Record<string, string[]>) {
  const description = Object.entries(sections)
    .map(([h, items]) => `<h3>${h}</h3><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`)
    .join("");
  const ld = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Operations Analyst",
    hiringOrganization: { "@type": "Organization", name: company },
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Los Angeles", addressRegion: "CA", addressCountry: "US" } },
    description,
  };
  const html = `<!doctype html><html><head><title>Operations Analyst</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>Operations Analyst</h1></body></html>`;
  return parseListingHtml(html, `https://careers.example.com/${company.toLowerCase()}`, "page");
}

const POSTED = () =>
  listing("Northwind", {
    Requirements: [
      "Experience with Tableau and SQL",
      "Strong communication skills",
      "3+ years of experience with Looker",
      "Bachelor's degree in a quantitative field",
    ],
    Responsibilities: ["Build dashboards that track weekly operating metrics"],
  });
const LATER = () =>
  listing("Contoso", {
    Requirements: [
      "Proficiency in SQL",
      "Excellent verbal and written communication",
      "Create dashboards to track weekly operating metrics for regional managers",
      "Experience with Kubernetes",
    ],
  });

const REPOS = [
  {
    name: "DesignDNA",
    full_name: "example-dev/DesignDNA",
    html_url: "https://github.com/example-dev/DesignDNA",
    description: "Design system analysis tool",
    language: "Python",
    topics: ["sql", "dashboards"],
    fork: false,
    default_branch: "main",
  },
  {
    name: "someone-elses",
    full_name: "example-dev/someone-elses",
    html_url: "https://github.com/example-dev/someone-elses",
    description: "Tableau SQL",
    language: "SQL",
    fork: true,
  },
];
const README = "# DesignDNA\n\nBuilds **dashboards** that track weekly metrics, with a SQL store. ![badge](x.png)\n```\ncode here\n```";

function githubFake(calls: string[]): Fetcher {
  return async (url) => {
    calls.push(url);
    const body = url.includes("api.github.com") ? JSON.stringify(REPOS) : url.endsWith("DesignDNA/main/README.md") ? README : null;
    return { ok: body !== null, status: body === null ? 404 : 200, json: async () => JSON.parse(body ?? "null"), text: async () => body ?? "" };
  };
}

async function env(ai = new NullProvider()): Promise<{ c: AppContext; calls: string[] }> {
  const repo = makeResumeRepo();
  const config = loadConfig({
    root: tempDir("cf-bank-"),
    env: {
      GITHUB_USER: "example-dev",
      APP_ENCRYPTION_KEY_SOURCE: "env:CF_TEST_KEY",
      AI_PROVIDER: "none",
    },
  });
  const { db } = await testDbAsync();
  const calls: string[] = [];
  const c = createAppContext({ db, config, ai, logger: createLogger({ level: "error" }), fetchers: { github: githubFake(calls) } });
  await storeResume(db, readResumeSource(repo.dir));
  await importInventory(db, loadInventoryFile(KIT_INVENTORY));
  return { c, calls };
}

describe("skill bank (listings you post)", () => {
  it("pasted links are marked as yours", async () => {
    const { c } = await env();
    await enqueueUrls(c, "https://careers.example.com/job/1");
    const item = await c.db.workItem.findFirstOrThrow({ where: { kind: "INGEST_URL" } });
    expect(JSON.parse(item.payload)).toMatchObject({ endorse: true });
  });

  it("a posted listing fills the bank; a later listing uses it as TRANSFERABLE", async () => {
    const { c } = await env();
    const before = await ingestParsed(c, LATER(), {}); // a watchlist-style find: listed, no application
    expect(before.applicationId).toBeNull();

    const r = await ingestParsed(c, POSTED(), { endorse: true });
    expect(r.applicationId).not.toBeNull();
    const job = await c.db.job.findUniqueOrThrow({ where: { id: r.jobId } });
    expect(job.endorsed).toBe(true);
    const bank = await listBank(c);
    expect(bank.map((b) => b.label)).toEqual(
      expect.arrayContaining(["SQL", "Tableau", "Communication", "Looker", "Build dashboards that track weekly operating metrics"]),
    );
    expect(bank.some((b) => /Bachelor|years/.test(b.label))).toBe(false);
    expect(await c.db.workItem.count({ where: { kind: "TRANSFER_MATCH", status: "PENDING" } })).toBe(1);

    const later = await ingestParsed(c, listing("Contoso2", { Requirements: LATER().job.requirements.map((q) => q.text) }));
    expect(later.coverage).toBeGreaterThan(before.coverage);
    const rows = await c.db.requirementMatch.findMany({ where: { jobId: later.jobId } });
    expect(rows.filter((x) => x.status === "TRANSFERABLE").length).toBe(3);
    // Not banked: still a gap (or a confirm question, since the first read added it to the inventory as unverified).
    expect(rows.find((x) => x.text === "Experience with Kubernetes")!.status).not.toBe("TRANSFERABLE");
  });

  it("links banked skills to résumé facts and GitHub projects; removal stops them counting", async () => {
    const { c, calls } = await env();
    await ingestParsed(c, POSTED(), { endorse: true });
    const out = await computeTransfers(c);
    expect(out.entries).toBeGreaterThan(3);
    const bank = await listBank(c);
    const comm = bank.find((b) => b.label === "Communication")!;
    expect(comm.transfers.find((t) => t.type === "RESUME_FACT")!.text).toMatch(/Presented findings/);
    const sql = bank.find((b) => b.label === "SQL")!;
    expect(sql.transfers.map((t) => t.ref)).toContain("example-dev/DesignDNA");
    const duty = bank.find((b) => b.kind === "duty" && b.label.startsWith("Build dashboards"))!;
    expect(duty.transfers.map((t) => t.ref)).toContain("example-dev/DesignDNA");
    // Forks are never used.
    const refs = bank.flatMap((b) => b.transfers.map((t) => t.ref));
    expect(refs.some((x) => /someone-elses/.test(x))).toBe(false);
    expect(calls.filter((u) => u.includes("raw.githubusercontent.com")).every((u) => u.includes("DesignDNA"))).toBe(true);

    // Evidence flows into the matcher's entries.
    expect((await loadBank(c)).find((b) => b.label === "SQL")!.evidenceKeys).toContain("github:example-dev/DesignDNA");

    // Second call is served from the cache.
    const n = calls.length;
    await githubRepos(c);
    expect(calls.length).toBe(n);

    await setBankedSkillStatus(c, sql.id, "REMOVED");
    expect((await loadBank(c)).some((b) => b.label === "SQL")).toBe(false);
    // Posting another listing that asks for SQL does not bring it back.
    await ingestParsed(c, listing("Initech", { Requirements: ["Experience with SQL and Tableau"] }), { endorse: true });
    expect((await c.db.bankedSkill.findUniqueOrThrow({ where: { id: sql.id } })).status).toBe("REMOVED");
  });

  it("AI proposals are kept only for real entries and real evidence", async () => {
    class FakeAi extends NullProvider {
      override readonly available = true;
      seen: TransferRequest | null = null;
      override async proposeTransfers(req: TransferRequest): Promise<TransferProposal> {
        this.seen = req;
        const tableau = req.entries.find((e) => e.label === "Tableau")!;
        return {
          matches: [
            {
              bankId: tableau.id,
              ref: "experiences[data-co-analyst-intern].responsibilities[0]",
              strength: 0.8,
              rationale: "Analyzing data for models is the core of BI work.",
            },
            { bankId: tableau.id, ref: "experiences[invented].responsibilities[9]", strength: 0.99, rationale: "Made up." },
            { bankId: "bank_nope", ref: "experiences[data-co-analyst-intern].responsibilities[0]", strength: 0.9, rationale: "Unknown entry." },
            { bankId: tableau.id, ref: "experiences[sidequest-labs-founder].responsibilities[0]", strength: 0.3, rationale: "Weak." },
          ],
        };
      }
    }
    const ai = new FakeAi();
    const { c } = await env(ai);
    await ingestParsed(c, POSTED(), { endorse: true });
    await computeTransfers(c);
    const tableau = (await listBank(c)).find((b) => b.label === "Tableau")!;
    expect(tableau.transfers.map((t) => [t.ref, t.method])).toEqual([["experiences[data-co-analyst-intern].responsibilities[0]", "ai"]]);
  });
});

describe("skill bank backfill", () => {
  it("banks listings pasted before the bank existed, once", async () => {
    const { c } = await env();
    const r = await ingestParsed(c, POSTED(), {}); // read before the skill bank: not marked as yours
    const job = await c.db.job.findUniqueOrThrow({ where: { id: r.jobId } });
    await c.db.workItem.create({ data: { id: "wi_old", kind: "INGEST_URL", payload: JSON.stringify({ url: job.sourceUrl }), status: "DONE" } });
    expect(await bankBackfillPending(c)).toBe(true);
    const out = await backfillPostedJobs(c);
    expect(out.jobs).toBe(1);
    expect(out.added).toBeGreaterThan(3);
    expect((await c.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).endorsed).toBe(true);
    expect(await bankBackfillPending(c)).toBe(false);
  });
});

describe("transfer linking in bounded runs", () => {
  it("saves finished batches and queues the rest when time runs out", async () => {
    const { c } = await env();
    await ingestParsed(c, POSTED(), { endorse: true });
    const before = await c.db.bankedSkill.count({ where: { matchedAt: null } });
    const out = await computeTransfers(c, { deadline: Date.now() + 10_000 }); // under the 45 s needed for a batch
    expect(out).toMatchObject({ entries: 0, remaining: before });
    expect(await c.db.workItem.count({ where: { kind: "TRANSFER_MATCH", dedupeKey: "transfer:continue" } })).toBe(1);
    const rest = await computeTransfers(c, { deadline: Date.now() + 120_000 });
    expect(rest).toMatchObject({ entries: before, remaining: 0 });
    expect(await c.db.bankedSkill.count({ where: { matchedAt: null } })).toBe(0);
  });
});
