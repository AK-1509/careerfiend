import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  atsRefFromUrl,
  blocksFromText,
  classifyItem,
  greenhouseBoard,
  parseListingHtml,
  parseLocation,
  readListing,
  regionGate,
  robotsAllows,
  sitePolicy,
  splitRequirements,
  type Fetcher,
} from "../src/index";
import { REPO_ROOT } from "../../../tests/helpers";

const listing = (name: string) => readFileSync(path.join(REPO_ROOT, "fixtures/listings", name), "utf8");
const url = (name: string) => `http://localhost:4545/listings/${name}`;
const jsonFetcher =
  (map: Record<string, unknown>): Fetcher =>
  async (u) => {
    const body = map[u];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

describe("listing extraction", () => {
  it("extracts JSON-LD fields, apply link and categorized requirements", () => {
    const { job } = parseListingHtml(listing("senior-title-entry-description.html"), url("senior-title-entry-description.html"), "fixture");
    expect(job.company).toBe("Beacon Biologics");
    expect(job.title).toBe("Senior Quality Associate");
    expect(job.location.workplaceType).toBe("onsite");
    expect(job.compensation).toBe("USD 28–34/hour");
    expect(job.applyUrl).toBe("http://localhost:4545/ats/multi-step/step1.html");
    const cats = job.requirements.map((r) => `${r.category}:${r.kind}`);
    expect(cats).toContain("required:degree");
    expect(cats).toContain("responsibility:skill");
    expect(cats).toContain("preferred:skill");
    expect(cats).toContain("logistics:location");
    expect(job.requirements.find((r) => r.text.startsWith("Familiarity"))?.depth).toBe("familiarity");
  });

  it("detects expired listings", () => {
    expect(parseListingHtml(listing("expired.html"), url("expired.html")).job.expired).toBe(true);
  });

  it("classifies requirement kinds", () => {
    expect(classifyItem("5+ years of experience in QA")).toMatchObject({ kind: "experience-years", years: 5 });
    expect(classifyItem("PhD in chemistry")).toMatchObject({ kind: "degree", degreeLevel: "doctorate" });
    expect(classifyItem("Bachelor's or Master's degree in biology")).toMatchObject({ kind: "degree", degreeLevel: "bachelor" });
    expect(classifyItem("Active secret security clearance")).toMatchObject({ kind: "clearance" });
    expect(classifyItem("Registered Pharmacist license in California")).toMatchObject({ kind: "license" });
    expect(classifyItem("Valid driver's license").kind).not.toBe("license");
  });

  it("splits plain text with headings and bullets", () => {
    const reqs = splitRequirements(blocksFromText("About us\nWe make drugs.\nQualifications:\n- GMP\n- Python\nNice to have\n- Figma"), "k");
    expect(reqs.map((r) => [r.category, r.text])).toEqual([
      ["logistics", "We make drugs."],
      ["required", "GMP"],
      ["required", "Python"],
      ["preferred", "Figma"],
    ]);
  });
});

describe("region gate (D5)", () => {
  const gate = (raw: string, extra: Partial<Parameters<typeof parseLocation>[0]> = {}) => regionGate(parseLocation({ raw, ...extra }));
  it("accepts California on-site or hybrid", () => {
    expect(gate("Thousand Oaks, CA").pass).toBe(true);
    expect(gate("Hybrid - San Francisco").pass).toBe(true);
    expect(gate("South San Francisco, California").pass).toBe(true);
  });
  it("accepts US remote, rejects non-US remote and other states", () => {
    expect(gate("Remote - US").pass).toBe(true);
    expect(gate("Remote", { applicantCountries: ["United States"] }).pass).toBe(true);
    expect(gate("Remote - UK")).toMatchObject({ pass: false, reason: "REGION" });
    expect(gate("Boston, MA")).toMatchObject({ pass: false, reason: "REGION" });
    expect(gate("Hybrid - Austin, TX")).toMatchObject({ pass: false, reason: "REGION" });
  });
  it("accepts unstated remote scope with a review warning", () => {
    const r = gate("Remote");
    expect(r.pass).toBe(true);
    expect(r.warning).toMatch(/REMOTE_SCOPE_UNSTATED/);
  });
});

describe("site policy and discovery (D6)", () => {
  it("never automates LinkedIn or Indeed", () => {
    expect(sitePolicy("https://www.linkedin.com/jobs/view/1")).toMatchObject({ automationAllowed: false, followExternalApplyOnly: true });
    expect(sitePolicy("https://www.indeed.com/viewjob?jk=1")).toMatchObject({ automationAllowed: false, followExternalApplyOnly: true });
    expect(sitePolicy("https://jobs.lever.co/acme/1").automationAllowed).toBe(true);
    expect(sitePolicy("http://localhost:4545/x").readAllowed).toBe(false);
    expect(sitePolicy("http://localhost:4545/x", { allowLocalhost: true }).readAllowed).toBe(true);
  });

  it("never reads LinkedIn or Indeed pages, and says how to find the application link instead", async () => {
    let fetched = false;
    for (const url of ["https://www.linkedin.com/jobs/view/999", "https://www.indeed.com/viewjob?jk=1"]) {
      await expect(
        readListing(url, {
          html: async (u) => {
            fetched = true;
            return { html: listing("linkedin-view.html"), finalUrl: u, status: 200 };
          },
          ignoreRobots: true,
        }),
      ).rejects.toThrow(/LinkedIn and Indeed links don't work.*employer's application page/);
    }
    expect(fetched).toBe(false);
  });

  it("reads the ATS application page that a LinkedIn listing points to", async () => {
    const parsed = await readListing("https://jobs.lever.co/acmeco/abc-123", {
      json: jsonFetcher({
        "https://api.lever.co/v0/postings/acmeco/abc-123?mode=json": JSON.parse(
          readFileSync(path.join(REPO_ROOT, "fixtures/ats-api/lever-acmeco-abc-123.json"), "utf8"),
        ),
      }),
      ignoreRobots: true,
    });
    expect(parsed.job.title).toBe("Growth Associate");
    expect(parsed.job.applyUrl).toBe("https://jobs.lever.co/acmeco/abc-123/apply");
    expect(parsed.job.location.remoteScope).toBe("US");
  });

  it("refuses a LinkedIn listing with Easy Apply only", async () => {
    await expect(
      readListing("https://www.linkedin.com/jobs/view/1", {
        html: async (u) => ({ html: "<main><h1>X</h1><button>Easy Apply</button><a href='/jobs/view/1'>Apply</a></main>", finalUrl: u, status: 200 }),
        ignoreRobots: true,
      }),
    ).rejects.toMatchObject({ category: "SITE_NOT_PERMITTED" });
  });

  it("reads a Greenhouse board through its public endpoint", async () => {
    const board = JSON.parse(readFileSync(path.join(REPO_ROOT, "fixtures/ats-api/greenhouse-board.json"), "utf8"));
    const jobs = await greenhouseBoard("examplebio", jsonFetcher({ "https://boards-api.greenhouse.io/v1/boards/examplebio/jobs?content=true": board }));
    expect(jobs.map((j) => j.title)).toEqual(["Clinical Operations Associate", "Lab Manager"]);
    expect(jobs[0]!.descriptionHtml).toContain("<li>GMP experience</li>");
  });

  it("recognizes hosted ATS URLs", () => {
    expect(atsRefFromUrl("https://boards.greenhouse.io/acme/jobs/123")).toEqual({ ats: "greenhouse", board: "acme", id: "123" });
    expect(atsRefFromUrl("https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x")).toEqual({ ats: "greenhouse", board: "acme", id: "123" });
    expect(atsRefFromUrl("https://jobs.lever.co/acme/uuid-1/apply")).toEqual({ ats: "lever", board: "acme", id: "uuid-1" });
    expect(atsRefFromUrl("https://jobs.ashbyhq.com/acme/uuid-2")).toEqual({ ats: "ashby", board: "acme", id: "uuid-2" });
  });

  it("evaluates robots.txt", () => {
    const robots = "User-agent: *\nDisallow: /private\nAllow: /private/jobs\n";
    expect(robotsAllows(robots, "/jobs/1")).toBe(true);
    expect(robotsAllows(robots, "/private/x")).toBe(false);
    expect(robotsAllows(robots, "/private/jobs/1")).toBe(true);
  });
});
