import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InventorySkill } from "@careerfiend/shared";
import { loadInventoryFile, resumeStringCorpus } from "@careerfiend/profile";
import { parseListingHtml } from "@careerfiend/job-parser";
import { jobKeywords, keywordCoverage, matchJob } from "@careerfiend/matcher";
import { buildResume, checkVerbatim, pdfText } from "../src/index";
import { KIT_INVENTORY, makeResumeRepo, readResumeSource, REPO_ROOT } from "../../../tests/helpers";

const skills = (): InventorySkill[] => structuredClone(loadInventoryFile(KIT_INVENTORY).skills);
const job = (name: string) =>
  parseListingHtml(readFileSync(path.join(REPO_ROOT, "fixtures/listings", name), "utf8"), `http://localhost:4545/listings/${name}`, "fixture").job;

describe("tailored résumé build", () => {
  it("uses job-specific bullets and listing keywords, traced to their source; forged spans fail the check", async () => {
    const src = readResumeSource(makeResumeRepo().dir);
    const j = job("senior-title-entry-description.html");
    const m = matchJob(j, skills(), { degreeLevel: "bachelor" });
    const key = "experiences[acme-bio-quality-intern].responsibilities[0]";
    const rewrite = "Executed quality assurance testing on 12 batches in line with GMP protocols.";
    const build = await buildResume({
      resume: src.resume,
      rawText: src.rawText,
      results: m.results,
      jobText: j.description,
      pageLimit: 1,
      tailored: { [key]: rewrite },
      keywords: [{ label: "Batch record review", key: "bank:bank_x" }],
    });
    expect(build.text).toContain(rewrite);
    expect(build.text).toContain("Batch record review");
    const line = build.provenance.find((p) => p.line === rewrite)!;
    expect(line).toMatchObject({ kind: "tailored", key, original: "Performed QA testing on 12 batches under GMP protocols." });
    expect((await pdfText(build.pdf)).text).toContain("Batch record review");
    // Without the allow-list, the same lines fail the check.
    expect(checkVerbatim(build.lines, resumeStringCorpus(src.rawText), src.resume).length).toBe(2);
  });

  it("the ATS check reports which listing keywords the résumé shows", () => {
    const j = job("near-miss.html");
    const kws = jobKeywords(j, skills());
    expect(kws.map((k) => k.label)).toEqual(expect.arrayContaining(["Microsoft Excel", "Microsoft PowerPoint"]));
    const report = keywordCoverage(kws, "Skills: Microsoft Excel, stakeholder management");
    expect(report.find((k) => k.label === "Microsoft Excel")!.found).toBe(true);
    expect(report.find((k) => k.label === "Microsoft PowerPoint")!.found).toBe(false);
  });
});
