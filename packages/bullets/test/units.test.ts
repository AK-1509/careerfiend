import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Resume } from "@careerfiend/profile";
import {
  actionOf,
  buildPacket,
  buildProfiles,
  buildTemplates,
  candidatesFor,
  conceptsIn,
  decompose,
  mergeModelDecomposition,
  selectBullets,
  stakeholdersIn,
  validateDraft,
  type BulletDraft,
  type ExperienceProfile,
  type RequirementTemplate,
} from "../src/index";
import { REPO_ROOT } from "../../../tests/helpers";
import { jobOf, resumeOf } from "./helpers";

const fixtureResume = JSON.parse(readFileSync(path.join(REPO_ROOT, "fixtures/resume/resume.json"), "utf8")) as Resume;

describe("requirement decomposition", () => {
  it("separates action, object, knowledge and stakeholders, and discards framing and seniority", () => {
    const d = decompose(
      "Worked cross-functionally with senior executives and engineers to develop product goals and establish KPIs based on competitive intelligence.",
      {
        mode: "requirement",
      },
    );
    expect(d.actions.map((a) => a.verb)).toEqual(["develop", "establish"]);
    expect(d.objects).toEqual(["product goals", "KPIs"]);
    expect(d.concepts.map((c) => c.id)).toEqual(expect.arrayContaining(["competitive_analysis", "product_goals", "metrics_kpi"]));
    expect(d.stakeholders.map((s) => s.category).sort()).toEqual(["engineering", "executive_leadership"]);
    const discarded = d.discarded.map((x) => x.text.toLowerCase());
    expect(discarded).toEqual(expect.arrayContaining(["senior", "worked cross-functionally"]));
  });

  it("removes employer names, locations, culture language and generic adjectives, but keeps the responsibility", () => {
    const d = decompose("Join our fast-paced team at Acme Health to build world-class dashboards for clinicians in San Francisco", {
      mode: "requirement",
      company: "Acme Health",
      locations: ["San Francisco"],
    });
    const reasons = Object.fromEntries(d.discarded.map((x) => [x.text, x.reason]));
    expect(reasons["Acme Health"]).toBe("company");
    expect(reasons["San Francisco"]).toBe("location");
    expect(d.discarded.some((x) => /fast-paced/i.test(x.text))).toBe(true);
    expect(d.actions.map((a) => a.verb)).toContain("build");
    expect(d.objects.join(" ")).toMatch(/dashboards/);
    expect(d.core).not.toMatch(/Acme|San Francisco|world-class/);
  });

  it("never strips a modifier that is part of a concept ('key performance indicators')", () => {
    const d = decompose("Track key performance indicators and strong data quality", { mode: "requirement" });
    expect(d.concepts.map((c) => c.id)).toContain("metrics_kpi");
    expect(d.discarded.map((x) => x.text)).toContain("strong");
  });

  it("reads noun-led skill requirements and records years as constraints only", () => {
    const d = decompose("3+ years of experience with SQL and Tableau", { mode: "requirement" });
    expect(d.frame).toBe("skill");
    expect(d.tools.sort()).toEqual(["SQL", "Tableau"]);
    expect(d.discarded.some((x) => x.reason === "constraint")).toBe(true);
  });

  it("does not take nouns for verbs ('software prototypes', 'dashboards and reports')", () => {
    expect(decompose("Test software prototypes with users", { mode: "requirement" }).actions.map((a) => a.verb)).toEqual(["test"]);
    expect(decompose("Developed dashboards and reports for the sales team.", { mode: "resume" }).actions.map((a) => a.verb)).toEqual(["develop"]);
    expect(decompose("Cleaned and analyzed data for Python-based models.", { mode: "resume" }).actions.map((a) => a.verb)).toEqual(["clean", "analyze"]);
  });
});

describe("vocabulary", () => {
  it("maps equivalent expressions to one concept family", () => {
    for (const t of ["KPI", "KPIs", "key performance indicators", "success metrics", "performance metrics"])
      expect(conceptsIn(t)[0]?.id, t).toBe("metrics_kpi");
    expect(conceptsIn("competitive intelligence")[0]!.id).toBe(conceptsIn("competitor analysis")[0]!.id);
    expect(conceptsIn("usability testing")[0]!.id).toBe(conceptsIn("user testing")[0]!.id);
  });

  it("groups action verbs into families while keeping the verb", () => {
    expect(new Set(["built", "developed", "created", "implemented"].map((v) => actionOf(v)!.family))).toEqual(new Set(["build"]));
    expect(actionOf("led")).toEqual({ family: "lead", base: "lead" });
    expect(actionOf("analysed")!.family).toBe("analyze");
  });

  it("generalizes specific titles into broad stakeholder categories", () => {
    const cat = (t: string) => stakeholdersIn(t)[0]?.category;
    for (const t of ["CEO", "COO", "VP of Sales", "senior leadership"]) expect(cat(t), t).toBe("executive_leadership");
    for (const t of ["CTO", "Engineering Director", "software engineers"]) expect(cat(t), t).toBe("engineering");
    for (const t of ["Product Manager", "Product Director"]) expect(cat(t), t).toBe("product");
    for (const t of ["UX Designer", "Design Lead"]) expect(cat(t), t).toBe("design");
    for (const t of ["Data Scientist", "Analytics Lead"]) expect(cat(t), t).toBe("data");
    expect(cat("investors")).toBe("investors");
    expect(cat("customers")).toBe("customers");
    // "user interviews" is research, not a stakeholder reference.
    expect(decompose("Ran user interviews with 15 participants", { mode: "resume" }).concepts.map((c) => c.id)).toContain("user_research");
  });
});

describe("templates", () => {
  const job = jobOf("Acme Health", [
    { text: "Develop product goals and success metrics using market trends and competitive intelligence with the product/UX team." },
    { text: "Bachelor's degree in a quantitative field", kind: "degree" },
    { text: "Must be able to work on-site in San Francisco", category: "logistics", kind: "location" },
    { text: "3+ years of experience with SQL", kind: "experience-years" },
  ]);
  it("templates transferable requirements only, with canonical wording and broad stakeholders", () => {
    const ts = buildTemplates(job);
    expect(ts.map((t) => t.requirementId).sort()).toEqual(["req0", "req3"]);
    const t0 = ts.find((t) => t.requirementId === "req0")!;
    expect(t0.template).toMatch(/^Develop product goals and success metrics using/);
    expect(t0.template).toMatch(/with product team and design team/);
    expect(ts.find((t) => t.requirementId === "req3")!.constraints[0]).toMatch(/3\+ years/);
  });

  it("merges a fast-model decomposition only where the words occur in the requirement", () => {
    const [t] = buildTemplates(jobOf("X", [{ text: "North-star narrative ownership across wellness journeys" }]));
    expect(t!.lowConfidence).toBe(true);
    const merged = mergeModelDecomposition(t!, {
      id: t!.requirementId,
      actions: ["own"],
      objects: ["north-star narrative", "revenue dashboards"],
      skills: ["SQL"],
      stakeholders: ["the CEO"],
      outcome: null,
      discard: [],
    });
    expect(merged.objects).toContain("north-star narrative");
    expect(merged.objects).not.toContain("revenue dashboards"); // not in the sentence
    expect(merged.tools).not.toContain("SQL");
    expect(merged.stakeholders).toEqual([]);
  });
});

describe("experience representation", () => {
  it("builds one profile per work/project entry with every attribute traced to its line", () => {
    const profiles = buildProfiles(fixtureResume);
    expect(profiles.map((p) => p.experienceId)).toEqual(["acme-bio-quality-intern", "data-co-analyst-intern", "sidequest-labs-founder"]); // no education
    const acme = profiles[0]!;
    expect(acme.metrics.find((m) => m.value === "12 batches")?.sources).toEqual(["experiences[acme-bio-quality-intern].responsibilities[0]"]);
    expect(acme.stakeholders.map((s) => s.family).sort()).toEqual(expect.arrayContaining(["cross_functional", "quality"]));
    const data = profiles[1]!;
    expect(data.tools.find((t) => t.value === "Python")!.sources).toContain("experiences[data-co-analyst-intern].responsibilities[0]");
    expect(data.stakeholders.find((s) => s.family === "executive_leadership")!.sources).toEqual(["experiences[data-co-analyst-intern].responsibilities[1]"]);
    expect(profiles[2]!.userExposure).toBe(true);
    for (const p of profiles)
      for (const a of [...p.actions, ...p.concepts, ...p.tools]) expect(a.sources.every((s) => p.evidence.some((e) => e.id === s))).toBe(true);
  });
});

describe("matching by meaning", () => {
  const profiles = buildProfiles(
    resumeOf([
      { id: "usability", bullets: ["Ran usability sessions with 15 participants on early mockups."] },
      { id: "docs", bullets: ["Wrote software documentation for the testing team."] },
    ]),
  );
  it("a prototype-testing requirement finds usability work over a keyword-overlap distractor", () => {
    const [t] = buildTemplates(jobOf("X", [{ text: "Test software prototypes with users" }]));
    const c = candidatesFor(t!, profiles, 2);
    expect(c[0]!.experienceId).toBe("usability");
    expect(c[0]!.dims.skill).toBeGreaterThan(0);
    const docs = c.find((x) => x.experienceId === "docs");
    if (docs) expect(docs.score).toBeLessThan(c[0]!.score);
  });

  it("KPIs match success metrics without sharing a word", () => {
    const p = buildProfiles(resumeOf([{ id: "metrics", bullets: ["Defined success metrics for the onboarding flow and reviewed them weekly."] }]));
    const [t] = buildTemplates(jobOf("X", [{ text: "Develop KPIs to track product performance" }]));
    expect(candidatesFor(t!, p, 1)[0]?.experienceId).toBe("metrics");
  });
});

/* ---------------------------------------------------------- evidence + validators */

function setup(reqText: string, bullets: string[]): { t: RequirementTemplate; p: ExperienceProfile; packet: NonNullable<ReturnType<typeof buildPacket>> } {
  const p = buildProfiles(resumeOf([{ id: "exp", bullets }]))[0]!;
  const t = buildTemplates(jobOf("Acme", [{ text: reqText }]))[0]!;
  const c = candidatesFor(t, [p], 1)[0]!;
  const packet = buildPacket(t, p, c)!;
  return { t, p, packet };
}

const style = (existing: Record<string, string> = {}) => ({ corpus: Object.values(existing), avgChars: 70, existing });
const draft = (text: string, sources = ["experiences[exp].responsibilities[0]"]): BulletDraft => ({
  pairId: "x",
  text,
  matchedTerms: [],
  ledger: [{ claim: text, sources }],
});

describe("relevant is not proven", () => {
  it("pricing analysis is relevant to 'develop pricing models using SQL', but proves neither: no bullet", () => {
    const p = buildProfiles(resumeOf([{ id: "exp", bullets: ["Analyzed product pricing and revenue trends."] }]))[0]!;
    const t = buildTemplates(jobOf("Acme", [{ text: "Develop pricing models using SQL" }]))[0]!;
    const c = candidatesFor(t, [p], 1)[0]!;
    expect(c.score).toBeGreaterThan(0.25); // relevant
    expect(buildPacket(t, p, c)).toBeNull(); // nothing provable
  });

  it("for 'analyze pricing trends using SQL' pricing is proven and SQL is on the unsupported list", () => {
    const { packet } = setup("Analyze pricing and revenue trends using SQL", ["Analyzed product pricing and revenue trends."]);
    expect(packet.proven.map((e) => e.value)).toEqual(expect.arrayContaining(["analyze", "pricing"]));
    expect(packet.unsupported).toContain("SQL");
  });

  it("an experience with nothing provable for the requirement yields no packet", () => {
    const p = buildProfiles(resumeOf([{ id: "exp", bullets: ["Organized volunteer events for the student magazine."] }]))[0]!;
    const t = buildTemplates(jobOf("Acme", [{ text: "Build machine learning models in Python" }]))[0]!;
    const c = {
      requirementId: t.requirementId,
      experienceId: "exp",
      spanIds: ["experiences[exp].responsibilities[0]"],
      retrieval: 0.2,
      score: 0.3,
      dims: { action: 0, object: 0, skill: 0, method: 0, stakeholder: 0, outcome: 0, industry: 0, semantic: 0.1 },
    };
    expect(buildPacket(t, p, c)).toBeNull();
  });
});

describe("validators", () => {
  const { t, p, packet } = setup("Analyze pricing and revenue trends using SQL", ["Analyzed product pricing and revenue trends for 3 product lines."]);
  const check = (text: string, sources?: string[]) => validateDraft(draft(text, sources), { template: t, packet, profile: p, style: style(), accepted: [] });
  const codes = (text: string, sources?: string[]) => check(text, sources).failures.map((f) => f.code);

  it("a near-copy of the original line is not an improvement", () => {
    expect(codes("Analyzed product pricing and revenue trends across 3 product lines.")).toEqual(["no_improvement"]);
  });
  it("rejects an unsupported tool (SQL)", () =>
    expect(codes("Developed SQL pricing models for 3 product lines.")).toEqual(expect.arrayContaining(["unsupported_tool"])));
  it("rejects a changed number", () => expect(codes("Analyzed product pricing and revenue trends for 5 product lines.")).toContain("unsupported_number"));
  it("rejects claims of managing people", () =>
    expect(codes("Led a team analyzing product pricing and revenue trends for 3 product lines.")).toContain("unsupported_management"));
  it("rejects stakeholders and titles the evidence never mentions", () => {
    expect(codes("Analyzed product pricing and revenue trends for 3 product lines with investors.")).toContain("unsupported_stakeholder");
    expect(codes("Analyzed product pricing for the CEO across 3 product lines.")).toEqual(expect.arrayContaining(["specific_title"]));
  });
  it("rejects outcomes and credentials the evidence does not state", () => {
    expect(codes("Analyzed product pricing for 3 product lines, increasing revenue.")).toContain("unsupported_outcome");
    expect(codes("Applied certified pricing analysis to 3 product lines.")).toContain("unsupported_credential");
  });
  it("rejects a ledger that cites lines outside the evidence", () =>
    expect(codes("Analyzed product pricing and revenue trends for 3 product lines.", ["experiences[other].responsibilities[0]"])).toContain("invalid_ledger"));
  it("rejects filler, missing action verbs, repetition and duplicates", () => {
    expect(codes("Leveraged product pricing and revenue trends analysis for 3 product lines.")).toContain("filler");
    expect(codes("Product pricing and revenue trends for 3 product lines.")).toContain("no_action_verb");
    expect(codes("Analyzed pricing, pricing trends and pricing revenue for 3 product lines.")).toContain("keyword_repetition");
    const dup = validateDraft(draft("Analyzed product pricing and revenue trends across 3 product lines."), {
      template: t,
      packet,
      profile: p,
      style: style(),
      accepted: ["Analyzed product pricing and revenue trends across 3 product lines."],
    });
    expect(dup.failures.map((f) => f.code)).toContain("duplicate");
  });
  it("rejects a bullet that does not address the requirement", () => {
    const other = setup("Analyze pricing and revenue trends using SQL", [
      "Analyzed product pricing and revenue trends.",
      "Organized volunteer events for the student magazine.",
    ]);
    const r = validateDraft(draft("Organized volunteer events for the student magazine.", ["experiences[exp].responsibilities[1]"]), {
      template: other.t,
      packet: { ...other.packet, spans: other.p.evidence },
      profile: other.p,
      style: style(),
      accepted: [],
    });
    expect(r.failures.map((f) => f.code)).toEqual(expect.arrayContaining(["jd_mismatch"]));
  });
  it("asks for the employer's term when the evidence supports it in other words", () => {
    const k = setup("Develop KPIs for the onboarding funnel", ["Defined success metrics for the onboarding flow."]);
    const r = validateDraft(draft("Defined measures for the onboarding flow and its stages."), {
      template: k.t,
      packet: k.packet,
      profile: k.p,
      style: style(),
      accepted: [],
    });
    expect(r.failures.map((f) => f.code)).toContain("missing_terminology");
    // A grounded bullet in the employer's wording passes every validator.
    const ok = validateDraft(draft("Defined KPIs for the onboarding flow."), { template: k.t, packet: k.packet, profile: k.p, style: style(), accepted: [] });
    expect(ok.failures).toEqual([]);
    expect(ok.matchedTerms).toContain("KPIs");
  });
});

describe("verb-object pairing", () => {
  it("never pairs a verb from one line with an object from another ('Defined metrics' + 'Built a script' is not 'Developed KPIs')", () => {
    const k = setup("Develop KPIs for the onboarding funnel", [
      "Defined success metrics for the onboarding flow.",
      "Built a Python script that cleaned weekly sales data.",
    ]);
    const both = k.p.evidence.filter((e) => e.kind === "bullet").map((e) => e.id);
    const packet = { ...k.packet, spans: k.p.evidence };
    const mixed = validateDraft(draft("Developed KPIs for the onboarding flow.", both), { template: k.t, packet, profile: k.p, style: style(), accepted: [] });
    expect(mixed.failures.map((f) => f.code)).toContain("unsupported_action");
    const honest = validateDraft(draft("Defined KPIs for the onboarding flow.", both), { template: k.t, packet, profile: k.p, style: style(), accepted: [] });
    expect(honest.failures.map((f) => f.code)).not.toContain("unsupported_action");
  });
});

describe("selection", () => {
  it("keeps the original line when the generated one is no better, and never reuses a line", () => {
    const k = setup("Develop KPIs for the onboarding funnel", ["Defined success metrics for the onboarding flow."]);
    const good = {
      draft: draft("Defined KPIs for the onboarding flow."),
      report: validateDraft(draft("Defined KPIs for the onboarding flow."), { template: k.t, packet: k.packet, profile: k.p, style: style(), accepted: [] }),
      packet: k.packet,
      template: k.t,
      attempts: 1,
    };
    const sel = selectBullets([good, { ...good, template: { ...k.t, requirementId: "other", importance: 0 } }]);
    expect(sel.bullets).toHaveLength(1);
    expect(sel.bullets[0]!.text).toBe("Defined KPIs for the onboarding flow.");
    expect(sel.keptOriginal[0]!.reason).toMatch(/already tailored/);
    const same = {
      ...good,
      draft: draft("Defined success metrics for the onboarding flow."),
      report: { ...good.report, matchedTerms: [] as string[], alignment: 0 },
    };
    expect(selectBullets([same]).bullets).toHaveLength(0);
  });
});
