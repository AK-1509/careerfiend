import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NullProvider } from "@careerfiend/ai";
import type { Resume } from "@careerfiend/profile";
import { buildProfiles, generateJobSpecificBullets } from "../src/index";
import { ScriptedBulletModel, type GenItem } from "./fake-model";
import { jobOf, resumeOf } from "./helpers";
import { REPO_ROOT } from "../../../tests/helpers";

const resume = JSON.parse(readFileSync(path.join(REPO_ROOT, "fixtures/resume/resume.json"), "utf8")) as Resume;
const profiles = buildProfiles(resume);
const existing = Object.fromEntries(
  resume.experiences.filter((e) => e.type !== "education").flatMap((e) => e.responsibilities.map((t, i) => [`experiences[${e.id}].responsibilities[${i}]`, t])),
);

const job = jobOf("Northwind Health", [
  { text: "Partner with the VP of Product and data scientists to develop KPIs and success metrics for new features using SQL." },
  { text: "Conduct user research and usability testing with customers to identify pain points." },
  { text: "Present findings and recommendations to senior executives and investors.", category: "preferred" },
  { text: "Manage a team of analysts to deliver quality assurance testing under GMP." },
  { text: "Bachelor's degree in a related field", kind: "degree" },
  { text: "Experience with Tableau" },
]);

const has = (item: GenItem, re: RegExp) => re.test(item.requirement) || item.evidence.some((e) => re.test(e.text));

/** First answers overreach the way a model might; repaired answers stick to the evidence. */
function writer(item: GenItem, attempt: number) {
  const ev = item.evidence[0]!.id;
  if (/user research/i.test(item.requirement)) {
    return attempt === 1
      ? {
          text: "Conducted user research with 15 participants to identify pain points for customers.",
          ledger: [{ claim: "user research with 15 participants", sources: [ev] }],
        }
      : {
          text: "Conducted user research with 15 participants and synthesized findings.",
          ledger: [{ claim: "user research with 15 participants", sources: [ev] }],
        };
  }
  if (/quality assurance testing/i.test(item.requirement)) {
    return attempt === 1
      ? { text: "Managed a team of analysts delivering quality assurance testing on 12 batches under GMP.", ledger: [{ claim: "QA testing", sources: [ev] }] }
      : {
          text: "Performed quality assurance testing on 12 batches under GMP protocols.",
          ledger: [{ claim: "QA testing on 12 batches under GMP", sources: [ev] }],
        };
  }
  if (/investors/i.test(item.requirement) || has(item, /Presented findings/)) {
    return attempt === 1
      ? { text: "Presented findings and recommendations to executives and investors with 95% forecast accuracy." }
      : { text: "Presented findings to leadership with 95% forecast accuracy on the models." };
  }
  if (/KPIs|SQL/i.test(item.requirement)) {
    return { text: "Developed KPIs in SQL with the VP of Product and data scientists." };
  }
  return null;
}

describe("job-specific bullets, end to end (scripted model)", () => {
  it("produces grounded bullets, repairs overreaching drafts and never ships an unsupported claim", async () => {
    const model = new ScriptedBulletModel(writer);
    const set = await generateJobSpecificBullets({ job }, profiles, { ai: model, existing });
    const texts = set.bullets.map((b) => b.text);

    expect(texts).toContain("Conducted user research with 15 participants and synthesized findings.");
    expect(texts).toContain("Performed quality assurance testing on 12 batches under GMP protocols.");
    for (const t of texts) {
      expect(t).not.toMatch(/\bSQL\b/);
      expect(t).not.toMatch(/investor/i);
      expect(t).not.toMatch(/managed a team|team of analysts/i);
      expect(t).not.toMatch(/\bVP\b|vice president|data scientists|\bCEO\b/i);
      expect(t).not.toMatch(/pain points/i);
      expect(t).not.toMatch(/Tableau/);
    }
    // Every bullet keeps an evidence ledger into the résumé and replaces the line it came from.
    for (const b of set.bullets) {
      expect(b.groundingStatus).toBe("verified");
      expect(b.evidenceIds.length).toBeGreaterThan(0);
      expect(b.evidenceIds.every((id) => id.startsWith(`experiences[${b.experienceId}]`))).toBe(true);
      expect(existing[b.anchorId]).toBe(b.originalText);
      expect(b.ledger.length).toBeGreaterThan(0);
    }
    const qa = set.bullets.find((b) => b.text.startsWith("Performed quality"))!;
    expect(qa.attempts).toBe(2);
    expect(qa.matchedTerms).toEqual(expect.arrayContaining(["quality assurance"]));
    // The degree requirement is never templated; Tableau finds no evidence.
    expect(set.templates.map((t) => t.requirementId)).not.toContain("req4");
    expect(set.rejected.some((r) => r.requirementId === "req5")).toBe(true);
    // Overreach was caught by grounding.
    expect(set.metrics.unsupportedClaimsBlocked).toBeGreaterThanOrEqual(2);
    // Model calls are batched: one rerank, at most three generation rounds; no per-bullet calls.
    expect(model.calls.filter((c) => c.method === "rerank")).toHaveLength(1);
    expect(model.calls.filter((c) => c.method === "generate").length).toBeLessThanOrEqual(3);
    expect(set.metrics.llmCalls).toBe(model.calls.length);
    // The generator is told what it may not say.
    const first = model.generateRequests[0]!;
    const qaItem = first.items.find((i) => /quality assurance/i.test(i.requirement))!;
    expect(qaItem.avoidTerms).toEqual(expect.arrayContaining(["managed a team"]));
    expect(qaItem.stakeholders.join(" ")).not.toMatch(/analysts/);
  });

  it("discards a candidate that keeps failing validation instead of shipping it", async () => {
    const model = new ScriptedBulletModel((item) => ({ text: `Developed SQL dashboards for investors on ${item.requirement.slice(0, 20)}.` }));
    const set = await generateJobSpecificBullets({ job }, profiles, { ai: model, existing });
    expect(set.bullets).toEqual([]);
    expect(set.rejected.filter((r) => /failed validation/.test(r.reason)).every((r) => r.attempts === 3)).toBe(true);
    expect(set.metrics.discarded).toBeGreaterThan(0);
  });

  it("an empty answer (no honest bullet) is accepted as no bullet", async () => {
    const model = new ScriptedBulletModel(() => null);
    const set = await generateJobSpecificBullets({ job }, profiles, { ai: model, existing });
    expect(set.bullets).toEqual([]);
    expect(set.rejected.some((r) => r.reason === "model found no honest bullet")).toBe(true);
  });

  it("without an AI provider nothing is generated and the original lines stay", async () => {
    const set = await generateJobSpecificBullets({ job }, profiles, { ai: new NullProvider(), existing });
    expect(set.bullets).toEqual([]);
    expect(set.metrics.llmCalls).toBe(0);
    expect(set.rejected.some((r) => /no AI provider/.test(r.reason))).toBe(true);
  });

  it("asks the fast model only about requirements the rules could not parse, and keeps only grounded parts", async () => {
    const vague = jobOf("X", [{ text: "North-star narrative ownership across wellness journeys" }, { text: "Conduct user research with customers" }]);
    const model = new ScriptedBulletModel(() => null, {
      decompose: (req) => ({
        items: req.items.map((i) => ({
          id: i.id,
          actions: ["own"],
          objects: ["north-star narrative"],
          skills: ["SQL"],
          stakeholders: ["CEO"],
          outcome: null,
          discard: [],
        })),
      }),
    });
    const set = await generateJobSpecificBullets({ job: vague }, profiles, { ai: model, existing });
    const decompose = model.calls.find((c) => c.method === "decompose")!;
    expect(decompose.size).toBe(1);
    expect(set.templates.find((t) => t.requirementId === "req0")?.method).toBe("model");
  });
});

describe("negative cases: the system must not generate unsupported claims", () => {
  const solo = buildProfiles(
    resumeOf([
      {
        id: "solo",
        title: "Analyst",
        bullets: ["Analyzed product pricing and revenue trends for 3 product lines.", "Built a Python script that cleaned weekly sales data."],
      },
    ]),
  );
  const lines = Object.fromEntries(solo[0]!.evidence.filter((e) => e.kind === "bullet").map((e) => [e.id, e.text]));
  const greedy = (extra: string) =>
    new ScriptedBulletModel((item) => ({
      text: `Analyzed product pricing and revenue trends for 3 product lines ${extra}.`,
      ledger: [{ claim: "pricing", sources: [item.evidence[0]!.id] }],
    }));

  const cases: [string, string, string, RegExp][] = [
    ["JD mentions SQL, résumé has none", "Analyze pricing and revenue trends using SQL", "using SQL", /\bSQL\b/],
    ["JD mentions investors, résumé has none", "Analyze pricing and revenue trends for investors", "for investors", /investor/i],
    [
      "JD mentions managing a team, résumé shows individual work",
      "Manage a team of analysts to analyze pricing and revenue trends",
      "while managing a team of analysts",
      /managing a team|team of analysts/i,
    ],
    [
      "JD names an executive title",
      "Analyze pricing and revenue trends with the Chief Revenue Officer",
      "with the Chief Revenue Officer",
      /Chief Revenue Officer/i,
    ],
  ];
  for (const [name, req, extra, forbidden] of cases) {
    it(name, async () => {
      const set = await generateJobSpecificBullets({ job: jobOf("Acme", [{ text: req }]) }, solo, { ai: greedy(extra), existing: lines });
      for (const b of set.bullets) expect(b.text).not.toMatch(forbidden);
      expect(set.metrics.unsupportedClaimsBlocked).toBeGreaterThan(0);
    });
  }

  it("a specific executive title in the JD becomes broad stakeholder wording for the generator", async () => {
    const people = buildProfiles(resumeOf([{ id: "p", bullets: ["Presented pricing findings to leadership every quarter."] }]));
    const model = new ScriptedBulletModel(() => null);
    await generateJobSpecificBullets({ job: jobOf("Acme", [{ text: "Present pricing findings to the CEO and COO" }]) }, people, {
      ai: model,
      existing: { "experiences[p].responsibilities[0]": "Presented pricing findings to leadership every quarter." },
    });
    const item = model.generateRequests[0]!.items[0]!;
    expect(item.requirement).not.toMatch(/CEO|COO/);
    expect(item.stakeholders).toEqual(["leadership"]);
  });
});
