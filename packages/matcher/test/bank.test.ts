import { describe, expect, it } from "vitest";
import { parseListingHtml } from "@careerfiend/job-parser";
import { loadInventoryFile } from "@careerfiend/profile";
import { normalizeLabel, type InventorySkill } from "@careerfiend/shared";
import { harvestJob, isFactualText, matchJob, transferScore, type BankEntry } from "../src/index";
import { KIT_INVENTORY } from "../../../tests/helpers";

const skills = (): InventorySkill[] => structuredClone(loadInventoryFile(KIT_INVENTORY).skills);
const opts = { degreeLevel: "bachelor" as const };

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
  return parseListingHtml(html, `http://localhost:4545/${company.toLowerCase()}.html`, "fixture").job;
}

const posted = () =>
  listing("Northwind", {
    Requirements: [
      "Experience with Tableau and SQL",
      "Strong communication skills",
      "3+ years of experience with Looker",
      "Bachelor's degree in a quantitative field",
      "Must be authorized to work in the United States",
    ],
    Responsibilities: ["Build dashboards that track weekly operating metrics"],
  });

const later = () =>
  listing("Contoso", {
    Requirements: [
      "Proficiency in SQL",
      "Excellent verbal and written communication",
      "Create dashboards to track weekly operating metrics for regional managers",
      "Experience with Kubernetes",
    ],
  });

function toBank(items: ReturnType<typeof harvestJob>, evidence: Record<string, string[]> = {}): BankEntry[] {
  return items.map((i, n) => ({ id: `b${n}`, kind: i.kind, label: i.label, category: i.category, evidenceKeys: evidence[i.label] ?? [] }));
}

describe("skill bank harvest", () => {
  it("banks skills, competencies and duties, never checkable facts", () => {
    const items = harvestJob(posted(), skills());
    const labels = items.filter((i) => i.kind === "skill").map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(["Tableau", "SQL", "Communication", "Looker"]));
    const duties = items.filter((i) => i.kind === "duty").map((i) => i.label);
    expect(duties).toContain("Build dashboards that track weekly operating metrics");
    // A line that only names tools is banked as those tools, not as a duty.
    expect(duties).not.toContain("Experience with Tableau and SQL");
    // Years, degree and work authorization lines are never banked, as skills or as duties.
    for (const i of items) {
      expect(i.requirement).not.toMatch(/Bachelor|authorized/);
      if (i.kind === "duty") expect(i.label).not.toMatch(/years/);
    }
  });

  it("recognizes checkable facts", () => {
    for (const t of [
      "3+ years of Python",
      "Bachelor's degree",
      "Active security clearance",
      "PMP certification",
      "GPA of 3.5",
      "Willing to relocate",
      "US citizenship",
    ]) {
      expect(isFactualText(t), t).toBe(true);
    }
    for (const t of ["Strong communication skills", "Experience with SQL", "Build dashboards for leadership"]) expect(isFactualText(t), t).toBe(false);
  });

  it("skips skills you rejected", () => {
    const s = skills();
    s.push({ ...s.find((x) => x.status === "UNVERIFIED")!, id: "tableau", label: "Tableau", aliases: [], status: "REJECTED_BY_USER" });
    expect(harvestJob(posted(), s).map((i) => normalizeLabel(i.label))).not.toContain("tableau");
  });
});

describe("TRANSFERABLE matching", () => {
  it("banked skills and duties cover a later listing worded differently", () => {
    const bank = toBank(harvestJob(posted(), skills()), { SQL: ["experiences[data-co-analyst-intern].responsibilities[0]"] });
    const without = matchJob(later(), skills(), opts);
    const withBank = matchJob(later(), skills(), { ...opts, bank });
    const status = (text: string) => withBank.results.find((r) => r.requirement.text.startsWith(text))!.status;
    expect(status("Proficiency in SQL")).toBe("TRANSFERABLE");
    expect(status("Excellent verbal")).toBe("TRANSFERABLE");
    expect(status("Create dashboards")).toBe("TRANSFERABLE");
    expect(status("Experience with Kubernetes")).toBe("GAP");
    expect(withBank.coverage).toBeGreaterThan(without.coverage);
    const sql = withBank.results.find((r) => r.requirement.text === "Proficiency in SQL")!;
    expect(sql.evidenceKeys).toContain("experiences[data-co-analyst-intern].responsibilities[0]");
    expect(sql.note).toMatch(/Transferable/);
  });

  it("a skill you rejected is never made transferable", () => {
    const s = skills();
    s.push({ ...s.find((x) => x.status === "UNVERIFIED")!, id: "sql", label: "SQL", aliases: [], status: "REJECTED_BY_USER" });
    const bank = toBank(harvestJob(posted(), skills()));
    const m = matchJob(later(), s, { ...opts, bank });
    expect(m.results.find((r) => r.requirement.text === "Proficiency in SQL")!.status).toBe("GAP");
  });
});

describe("transfer scoring", () => {
  const fact = (text: string) => ({ type: "RESUME_FACT" as const, ref: "k", text });
  it("named, same competency, shared terms, or nothing", () => {
    expect(transferScore({ kind: "skill", label: "Python" }, fact("Cleaned and analyzed data for Python-based models."))?.method).toBe("direct");
    const rel = transferScore({ kind: "skill", label: "Communication" }, fact("Presented findings to leadership with 95% forecast accuracy."));
    expect(rel?.method).toBe("related");
    expect(rel!.score).toBeGreaterThanOrEqual(0.5);
    const duty = transferScore(
      { kind: "duty", label: "Prepare and review batch records under GMP" },
      fact("Prepared and reviewed batch-manufacturing records."),
    );
    expect(duty?.method).toBe("overlap");
    expect(transferScore({ kind: "skill", label: "Kubernetes" }, fact("Ran user interviews with 15 participants."))).toBeNull();
  });
});
