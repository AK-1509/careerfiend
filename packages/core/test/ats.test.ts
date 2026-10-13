import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDocuments, ingestUrl } from "../src/index";
import { ScriptedBulletModel } from "../../bullets/test/fake-model";
import { makeTestEnv, type TestEnv } from "../../../tests/context";

const ANCHOR = "experiences[acme-bio-quality-intern].responsibilities[1]";
const ORIGINAL = "Prepared and reviewed batch-manufacturing records.";

/** Honest rewrite for the batch-record line; an overreaching one (SQL, investors, managing people) for everything else. */
const model = new ScriptedBulletModel((item) => {
  const ev = item.evidence.find((e) => e.id === ANCHOR);
  if (ev)
    return { text: "Reviewed and prepared batch records for completeness.", ledger: [{ claim: "reviewed and prepared batch records", sources: [ANCHOR] }] };
  return {
    text: `Managed a team of analysts using SQL for investors on ${item.evidence[0]!.text.toLowerCase()}`,
    ledger: [{ claim: "x", sources: [item.evidence[0]!.id] }],
  };
});

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv({ ai: model });
}, 120_000);
afterAll(async () => env?.close());

type Provenance = {
  lines: { line: string; kind: string; key: string | null; original?: string }[];
  dropped: { key: string; reason: string }[];
  ats: { tailoredBullets: number; rejectedRewrites: number; keywords: { label: string; found: boolean }[] };
  generatedBullets: {
    bullets: {
      anchorId: string;
      text: string;
      evidenceIds: string[];
      ledger: { claim: string; sources: string[] }[];
      groundingStatus: string;
      requirementId: string;
    }[];
    rejected: { reason: string }[];
    metrics: { llmCalls: number; templates: number };
  } | null;
};

describe("job-specific bullets in résumé curation", () => {
  it("replaces the line a validated bullet came from, keeps its ledger, and never ships overreach", async () => {
    const factsBefore = await env.ctx.db.experienceFact.findMany({ orderBy: { id: "asc" } });
    const r = await ingestUrl(env.ctx, `${env.server.url}/listings/senior-title-entry-description.html`, { endorse: true });
    await generateDocuments(env.ctx, r.applicationId!);
    const row = await env.ctx.db.generatedDocument.findFirstOrThrow({ where: { applicationId: r.applicationId!, type: "resume", format: "txt" } });
    const prov = JSON.parse(row.provenance) as Provenance;
    const lines = prov.lines.map((l) => l.line);

    const tailored = prov.lines.find((l) => l.line === "Reviewed and prepared batch records for completeness.")!;
    expect(tailored).toMatchObject({ kind: "tailored", key: ANCHOR, original: ORIGINAL });
    expect(lines).not.toContain(ORIGINAL);
    const g = prov.generatedBullets!.bullets.find((b) => b.anchorId === ANCHOR)!;
    expect(g.groundingStatus).toBe("verified");
    expect(g.ledger[0]!.sources).toEqual([ANCHOR]);
    expect(prov.ats.tailoredBullets).toBe(prov.generatedBullets!.bullets.length);

    // Overreaching drafts were repaired or discarded, never shipped.
    const all = lines.join("\n");
    expect(all).not.toMatch(/\bSQL\b|investor|team of analysts/i);
    expect(prov.generatedBullets!.rejected.some((x) => /failed validation/.test(x.reason))).toBe(true);

    // Stored résumé facts are untouched: the bullets are a presentation layer for this job.
    expect(await env.ctx.db.experienceFact.findMany({ orderBy: { id: "asc" } })).toEqual(factsBefore);
  });

  it("builds experience profiles once per résumé version and reuses them", async () => {
    const extractCalls = () => model.calls.filter((c) => c.method === "extract").length;
    const before = extractCalls();
    expect(before).toBe(1);
    const r = await ingestUrl(env.ctx, `${env.server.url}/listings/unknown-skill.html`, { endorse: true });
    await generateDocuments(env.ctx, r.applicationId!);
    expect(extractCalls()).toBe(before);
    expect(await env.ctx.db.experienceProfileCache.count()).toBe(1);
  });
});
