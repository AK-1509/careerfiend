import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseListingHtml } from "@careerfiend/job-parser";
import { loadInventoryFile } from "@careerfiend/profile";
import type { InventorySkill } from "@careerfiend/shared";
import { canSatisfy, matchJob, skillsMentioned, unknownSkillCandidates } from "../src/index";
import { KIT_INVENTORY, REPO_ROOT } from "../../../tests/helpers";

const skills = (): InventorySkill[] => structuredClone(loadInventoryFile(KIT_INVENTORY).skills);
const job = (name: string) =>
  parseListingHtml(readFileSync(path.join(REPO_ROOT, "fixtures/listings", name), "utf8"), `http://localhost:4545/listings/${name}`, "fixture").job;
const opts = { degreeLevel: "bachelor" as const };

describe("no qualification decisions (you decide where to apply)", () => {
  it("the analysis has no decision, skip reason, blocker or threshold", () => {
    for (const name of [
      "senior-title-entry-description.html",
      "entry-title-senior-description.html",
      "near-miss.html",
      "out-of-region.html",
      "remote-uk.html",
      "expired.html",
    ]) {
      const m = matchJob(job(name), skills(), opts) as unknown as Record<string, unknown>;
      for (const key of ["decision", "skipReason", "blockers", "confirmQuestions"]) expect(m, `${name}: ${key}`).not.toHaveProperty(key);
      expect((m.results as { status: string }[]).map((r) => r.status)).not.toContain("BLOCKER");
    }
  });

  it("a degree above yours is a neutral note on the requirement, not a gate", () => {
    const m = matchJob(job("entry-title-senior-description.html"), skills(), opts);
    const degree = m.results.find((r) => r.requirement.kind === "degree")!;
    expect(degree.status).toBe("GAP");
    expect(degree.note).toMatch(/résumé shows bachelor/);
    expect(m.warnings.map((w) => w.code)).not.toContain("EXPERIENCE_GAP");
  });

  it("the title plays no part in the analysis", () => {
    const a = job("senior-title-entry-description.html");
    const before = matchJob(a, skills(), opts).coverage;
    a.title = "Principal Staff Director";
    expect(matchJob(a, skills(), opts).coverage).toBe(before);
  });
});

describe("evidence for tailoring", () => {
  it("names unknown skills so they can be banked and tailored toward", () => {
    const m = matchJob(job("unknown-skill.html"), skills(), opts);
    expect(m.newSkills.map((n) => n.label)).toEqual(["Veeva Vault"]);
    expect(m.gaps).toContain("Experience with Veeva Vault QualityDocs");
  });

  it("UNVERIFIED and REJECTED skills never count as shown; confirmed ones do", () => {
    const m = matchJob(job("near-miss.html"), skills(), opts);
    expect(m.results.filter((r) => r.status === "NEEDS_CONFIRM").length).toBeGreaterThan(0);
    const confirmed = skills().map((s) => (["microsoft-excel", "microsoft-powerpoint"].includes(s.id) ? { ...s, status: "CONFIRMED_BY_USER" as const } : s));
    expect(matchJob(job("near-miss.html"), confirmed, opts).coverage).toBeGreaterThan(m.coverage);
    const rejected = skills().map((s) => (s.status === "UNVERIFIED" ? { ...s, status: "REJECTED_BY_USER" as const } : s));
    expect(matchJob(job("near-miss.html"), rejected, opts).results.map((r) => r.status)).not.toContain("NEEDS_CONFIRM");
  });

  it("coursework-only skills satisfy familiarity, never hands-on or years", () => {
    const r = skills().find((s) => s.id === "r")!;
    expect(canSatisfy(r, { depth: "familiarity", kind: "skill" }).usable).toBe(true);
    expect(canSatisfy(r, { depth: "hands-on", kind: "skill" }).usable).toBe(false);
    expect(canSatisfy(r, { depth: "years", kind: "experience-years" }).usable).toBe(false);
    expect(canSatisfy(r, { depth: "unspecified", kind: "skill" }).usable).toBe(false);
  });

  it("low-confidence model mappings are ignored", () => {
    const j = job("near-miss.html");
    const excel = j.requirements.find((r) => r.text === "Advanced Microsoft Excel")!;
    const m = matchJob(j, skills(), { ...opts, aiMappings: [{ requirementId: excel.id, skillIds: ["python"], confidence: 0.4 }] });
    expect(m.results.find((r) => r.requirement.id === excel.id)?.status).toBe("NEEDS_CONFIRM");
  });

  it("detects skills conservatively", () => {
    const all = skills();
    expect(skillsMentioned("R&D experience", all).map((s) => s.id)).not.toContain("r");
    expect(skillsMentioned("Programming in R, Python", all).map((s) => s.id)).toEqual(expect.arrayContaining(["r", "python"]));
    expect(skillsMentioned("Microsoft Excel", all).map((s) => s.id)).toEqual(["microsoft-excel"]);
    expect(unknownSkillCandidates("Strong communication skills", all)).toEqual([]);
    expect(unknownSkillCandidates("Experience with Tableau or Power BI", all).sort()).toEqual(["Power BI", "Tableau"]);
  });
});
