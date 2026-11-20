import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "@careerfiend/shared";
import { createDb } from "@careerfiend/db";
import { NullProvider } from "@careerfiend/ai";
import {
  availableSources,
  createAppContext,
  leadAction,
  locationMatches,
  politeFetch,
  runSavedSearches,
  saveResume,
  saveSearch,
  setSourceKey,
  signup,
  tailorLead,
  tenantContext,
  titleMatches,
  type AppContext,
} from "../src/index";
import { FIXTURE_RESUME, tempDir } from "../../../tests/helpers";

process.env.CF_TEST_KEY ??= randomBytes(32).toString("base64");

/* Response shapes as the services returned them (trimmed), November 2026. */
const FEEDS: Record<string, unknown> = {
  "https://remotive.com/api/remote-jobs": {
    "0-legal-notice": "Please link back…",
    jobs: [
      {
        id: 2069746,
        url: "https://remotive.com/remote-jobs/data/data-analyst-2069746",
        title: "Senior Data Analyst",
        company_name: "Mitre Media",
        publication_date: "2026-11-14T20:33:53",
        candidate_required_location: "USA",
        salary: "$120k",
        description: "<p>Analyze data with SQL.</p>",
      },
    ],
  },
  "https://himalayas.app/jobs/api/search?q=Data%20Analyst&page=1": {
    jobs: [
      {
        title: "Data Analyst",
        companyName: "Pontoon",
        locationRestrictions: ["United States"],
        description: "<h3>Role</h3><p>Dashboards in SQL.</p>",
        pubDate: 1795109207,
        expiryDate: 4102444800,
        applicationLink: "https://himalayas.app/companies/pontoon/jobs/data-analyst?utm_source=api",
        guid: "https://himalayas.app/companies/pontoon/jobs/data-analyst",
        minSalary: 90000,
        maxSalary: 110000,
        currency: "USD",
      },
      {
        title: "Data Analyst (expired)",
        companyName: "Old Co",
        locationRestrictions: [],
        description: "<p>x</p>",
        pubDate: 1600000000,
        expiryDate: 1600000001,
        applicationLink: "https://himalayas.app/companies/old/jobs/x",
        guid: "https://himalayas.app/companies/old/jobs/x",
      },
    ],
  },
  "https://remoteok.com/api": [
    { last_updated: 1795140013, legal: "API Terms of Service: Please link back…" },
    {
      id: "1137806",
      position: "Data Analyst",
      company: "Pontoon",
      location: "Remote",
      description: "Same job as on Himalayas",
      url: "https://remoteOK.com/remote-jobs/remote-data-analyst-1137806",
      date: "2026-11-18T16:00:49+00:00",
    },
    {
      id: "2",
      position: "Project Manager",
      company: "Syner-G",
      location: "Remote",
      description: "x",
      url: "https://remoteOK.com/remote-jobs/2",
      date: "2026-11-18",
    },
  ],
};

function fakeHttp(extra: Record<string, unknown | ((init?: RequestInit) => Response)> = {}) {
  const calls: string[] = [];
  const all = { ...FEEDS, ...extra };
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const hit = all[url];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (typeof hit === "function") return (hit as (i?: RequestInit) => Response)(init);
    return new Response(typeof hit === "string" ? hit : JSON.stringify(hit), { status: 200 });
  }) as typeof fetch;
  return { http, calls };
}

function base(http: typeof fetch, mode: "local" | "hosted" = "local", now?: () => Date): AppContext {
  const config = loadConfig({
    root: tempDir("cf-search-"),
    env: {
      DATABASE_URL: "pglite:memory",
      APP_ENCRYPTION_KEY_SOURCE: "env:CF_TEST_KEY",
      SESSION_SECRET: Buffer.alloc(32, 3).toString("base64"),
      AI_PROVIDER: "none",
    },
  });
  return createAppContext({
    db: createDb("pglite:memory"),
    config: { ...config, CAREERFIEND_MODE: mode },
    ai: new NullProvider(),
    logger: createLogger({ level: "error" }),
    fetchers: { http },
    now,
  });
}

async function account(b: AppContext, email: string): Promise<AppContext> {
  const r = await signup(b, email, "a long enough password");
  if (!r.ok) throw new Error(r.error);
  return tenantContext(b, r.account);
}

describe("matching", () => {
  it("titles: every word of one wanted title, any order; excluded phrases win", () => {
    expect(titleMatches("Senior Data Analyst II", ["data analyst"], [])).toBe(true);
    expect(titleMatches("Analyst, Data Platform", ["data analyst"], [])).toBe(true);
    expect(titleMatches("Data Engineer", ["data analyst"], [])).toBe(false);
    expect(titleMatches("Product Analysts", ["product analyst"], [])).toBe(true);
    expect(titleMatches("Senior Data Analyst", ["data analyst"], ["senior"])).toBe(false);
    expect(titleMatches("Data Analyst", ["data analyst", "business analyst"], ["director"])).toBe(true);
  });

  it("locations: remote always counts unless remote-only; otherwise a wanted place must appear", () => {
    expect(locationMatches({ location: "Los Angeles, CA", remote: false }, "Los Angeles, San Diego", false)).toBe(true);
    expect(locationMatches({ location: "Austin, TX", remote: false }, "Los Angeles, San Diego", false)).toBe(false);
    expect(locationMatches({ location: "Anywhere", remote: true }, "Los Angeles", false)).toBe(true);
    expect(locationMatches({ location: "Austin, TX", remote: false }, "", false)).toBe(true);
    expect(locationMatches({ location: "Austin, TX", remote: false }, "", true)).toBe(false);
  });
});

describe("job search across sources", () => {
  it("finds matches on each source, credits them, drops expired and duplicate jobs, and needs keys only where the source does", async () => {
    const { http } = fakeHttp();
    const t = await account(base(http), "a@example.com");
    await saveSearch(t, { titles: ["Data Analyst"], sources: ["remotive", "himalayas", "remoteok", "adzuna"] });
    const r = await runSavedSearches(t);
    expect(r.searches).toBe(1);
    const leads = await t.db.lead.findMany({ orderBy: { source: "asc" } });
    // Himalayas' Pontoon job and Remote OK's copy of it are one lead; the expired one is dropped.
    expect(leads.map((l) => `${l.source}:${l.company}`).sort()).toEqual(["himalayas:Pontoon", "remotive:Mitre Media"]);
    const h = leads.find((l) => l.source === "himalayas")!;
    expect(h.url).toContain("himalayas.app"); // link back to the source's own listing
    expect(h.compensation).toBe("90,000–110,000 USD");
    expect(leadAction(h)).toBe("tailor");
    const status = JSON.parse((await t.db.savedSearch.findFirstOrThrow()).status) as Record<string, { note: string | null; added: number }>;
    expect(status.adzuna!.note).toMatch(/add your free Adzuna key/);
    expect(status.remoteok!.added).toBe(0);
  });

  it("one request serves every account searching the same thing (shared cache)", async () => {
    const { http, calls } = fakeHttp();
    const b = base(http);
    const a = await account(b, "a@example.com");
    const c = await account(b, "c@example.com");
    await saveSearch(a, { titles: ["Data Analyst"], sources: ["himalayas"] });
    await saveSearch(c, { titles: ["data analyst"], sources: ["himalayas"] });
    await runSavedSearches(a);
    await runSavedSearches(c);
    expect(calls.filter((u) => u.includes("himalayas.app"))).toHaveLength(1);
    expect(await c.db.lead.count()).toBe(1);
    expect(await a.db.lead.count()).toBe(1);
  });

  it("a 429 pauses the host for everyone (Retry-After honored) and later runs use the last answer", async () => {
    let t0 = new Date("2026-11-20T10:00:00Z").getTime();
    let limited = false;
    const { http, calls } = fakeHttp({
      "https://remoteok.com/api": () =>
        limited
          ? new Response("slow down", { status: 429, headers: { "retry-after": "7200" } })
          : new Response(JSON.stringify(FEEDS["https://remoteok.com/api"])),
    });
    const b = base(http, "local", () => new Date(t0));
    const req = { host: "remoteok.com", url: "https://remoteok.com/api", cacheKey: "remoteok:all", ttlMs: 60_000, hostIntervalMs: 1_000 };
    expect((await politeFetch(b, req)).ok).toBe(true);
    t0 += 120_000; // cache expired
    limited = true;
    const second = await politeFetch(b, req);
    expect(second).toMatchObject({ ok: true, fromCache: true }); // stale answer, not an error
    const row = await b.db.sourceThrottle.findUniqueOrThrow({ where: { host: "remoteok.com" } });
    expect(row.blockedUntil!.getTime()).toBe(t0 + 7_200_000);
    const before = calls.length;
    t0 += 60_000;
    await politeFetch(b, req);
    expect(calls.length).toBe(before); // paused: no request at all
    t0 += 7_300_000;
    limited = false;
    expect(await politeFetch(b, req)).toMatchObject({ ok: true, fromCache: false });
  });

  it("Remotive is not offered on a public website (its terms forbid showing jobs behind a sign-up)", async () => {
    const hosted = base(fakeHttp().http, "hosted");
    expect(availableSources(hosted).map((s) => s.id)).not.toContain("remotive");
    expect(availableSources(base(fakeHttp().http)).map((s) => s.id)).toContain("remotive");
    const t = await account(hosted, "h@example.com");
    await expect(saveSearch(t, { titles: ["Data Analyst"], sources: ["remotive"] })).rejects.toThrow(/at least one source/);
  });

  it("keyed sources use the person's own key: Adzuna, USAJOBS (key and email headers) and Jooble", async () => {
    let usaHeaders: Record<string, string> = {};
    let joobleBody = "";
    const { http } = fakeHttp({
      "https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=abc123&app_key=key45678&results_per_page=50&what=Data%20Analyst&content-type=application/json": {
        results: [
          {
            id: "5001",
            title: "<strong>Data Analyst</strong>",
            company: { display_name: "Acme" },
            location: { display_name: "Los Angeles, CA" },
            description: "A summary…",
            redirect_url: "https://www.adzuna.com/land/ad/5001",
            created: "2026-11-19T00:00:00Z",
            salary_min: 70000,
          },
        ],
      },
      "https://data.usajobs.gov/api/search?Keyword=Data%20Analyst&ResultsPerPage=100": (init?: RequestInit) => {
        usaHeaders = init?.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            SearchResult: {
              SearchResultItems: [
                {
                  MatchedObjectId: "800",
                  MatchedObjectDescriptor: {
                    PositionTitle: "Data Analyst",
                    OrganizationName: "Department of Energy",
                    PositionLocationDisplay: "Washington, DC",
                    PositionURI: "https://www.usajobs.gov/job/800",
                    PublicationStartDate: "2026-11-01",
                    QualificationSummary: "One year of specialized experience.",
                    UserArea: { Details: { JobSummary: "Analyze program data.", MajorDuties: ["Build reports"] } },
                  },
                },
              ],
            },
          }),
        );
      },
      "https://jooble.org/api/jkey1234": (init?: RequestInit) => {
        joobleBody = String(init?.body);
        return new Response(
          JSON.stringify({ jobs: [{ id: 9, title: "Data Analyst", company: "Zed", location: "Remote", snippet: "…", link: "https://jooble.org/desc/9" }] }),
        );
      },
    });
    const t = await account(base(http), "k@example.com");
    await setSourceKey(t, "adzuna", { appId: "abc123", appKey: "key45678", country: "us" });
    await setSourceKey(t, "usajobs", { key: "usakey123", email: "me@example.com" });
    await setSourceKey(t, "jooble", { key: "jkey1234" });
    expect((await t.db.setting.findUniqueOrThrow({ where: { key: "sources.keys" } })).value).not.toContain("key45678");
    await saveSearch(t, { titles: ["Data Analyst"], sources: ["adzuna", "usajobs", "jooble"] });
    await runSavedSearches(t);
    const leads = await t.db.lead.findMany();
    const by = (s: string) => leads.find((l) => l.source === s)!;
    expect(by("adzuna")).toMatchObject({ title: "Data Analyst", descriptionComplete: false });
    expect(leadAction(by("adzuna"))).toBe("paste-link");
    expect(by("usajobs")).toMatchObject({ company: "Department of Energy", descriptionComplete: true });
    expect(usaHeaders).toMatchObject({ "User-Agent": "me@example.com", "Authorization-Key": "usakey123" });
    expect(JSON.parse(joobleBody)).toMatchObject({ keywords: "Data Analyst" });
    expect(by("jooble").url).toBe("https://jooble.org/desc/9");
  });

  it("company boards: the watchlist's career-site feeds, filtered by title (Recruitee, Personio, Workable, SmartRecruiters)", async () => {
    const { http } = fakeHttp({
      "https://acme.recruitee.com/api/offers/": {
        offers: [
          {
            id: 1,
            title: "Data Analyst",
            location: "Berlin",
            description: "<p>SQL</p>",
            careers_url: "https://acme.recruitee.com/o/data-analyst",
            published_at: "2026-11-01",
          },
          { id: 2, title: "Chef", location: "Berlin", description: "<p>Cook</p>", careers_url: "https://acme.recruitee.com/o/chef" },
        ],
      },
      "https://beta.jobs.personio.de/xml?language=en":
        "<?xml version='1.0'?><workzag-jobs><position><id>77</id><name>Data Analyst (m/w/d)</name><office>Munich</office><jobDescriptions><jobDescription><name>Tasks</name><value><![CDATA[<p>Reports</p>]]></value></jobDescription></jobDescriptions><createdAt>2026-11-02</createdAt></position></workzag-jobs>",
      "https://apply.workable.com/api/v1/widget/accounts/gamma?details=true": {
        name: "Gamma",
        jobs: [
          { title: "Lead Data Analyst", shortcode: "AB12", url: "https://apply.workable.com/gamma/j/AB12/", telecommuting: true, description: "<p>Lead</p>" },
        ],
      },
      "https://api.smartrecruiters.com/v1/companies/Delta/postings?limit=100": {
        content: [{ id: "744", name: "Data Analyst", company: { name: "Delta Inc" }, location: { city: "Austin", region: "TX", country: "us" } }],
      },
    });
    const t = await account(base(http), "b@example.com");
    for (const [ats, slug] of [
      ["recruitee", "acme"],
      ["personio", "beta"],
      ["workable", "gamma"],
      ["smartrecruiters", "Delta"],
    ] as const)
      await t.db.watchlistCompany.create({ data: { id: `wl_${slug}`, ats, boardSlug: slug, name: slug } });
    await saveSearch(t, { titles: ["Data Analyst"], sources: ["boards"] });
    await runSavedSearches(t);
    const leads = await t.db.lead.findMany({ orderBy: { source: "asc" } });
    expect(leads.map((l) => `${l.source}:${l.title}`)).toEqual([
      "personio:Data Analyst (m/w/d)",
      "recruitee:Data Analyst",
      "smartrecruiters:Data Analyst",
      "workable:Lead Data Analyst",
    ]);
    expect(leads.find((l) => l.source === "personio")!.description).toContain("Reports");
    // SmartRecruiters' list has no description: choosing it reads the posting's own page.
    expect(leadAction(leads.find((l) => l.source === "smartrecruiters")!)).toBe("read-page");
  });

  it("tailoring a lead: from its own text (applying through the source's listing), or from a pasted application link", async () => {
    const { http } = fakeHttp();
    const t = await account(base(http), "t@example.com");
    await saveResume(t, JSON.parse(readFileSync(FIXTURE_RESUME, "utf8")), "profile");
    await saveSearch(t, { titles: ["Data Analyst"], sources: ["himalayas"] });
    await runSavedSearches(t);
    const lead = await t.db.lead.findFirstOrThrow();
    expect(await tailorLead(t, lead.id)).toMatch(/Tailoring your résumé/);
    const app = await t.db.application.findFirstOrThrow({ include: { job: true } });
    expect(app.job.applyUrl).toBeNull(); // CareerFiend never opens the service's page to read a form
    expect(app.job.sourceUrl).toContain("himalayas.app");
    expect(app.job.warnings).toMatch(/Apply through Himalayas/);
    expect((await t.db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("TAILORED");

    const other = await t.db.lead.create({
      data: {
        id: "lead_x",
        searchId: lead.searchId,
        source: "adzuna",
        externalId: "1",
        title: "Data Analyst",
        company: "Q",
        url: "https://www.adzuna.com/land/ad/1",
      },
    });
    await expect(tailorLead(t, other.id)).rejects.toThrow(/paste that link/);
    await expect(tailorLead(t, other.id, "https://www.linkedin.com/jobs/view/1")).rejects.toThrow(/LinkedIn and Indeed links don't work/);
    expect(await tailorLead(t, other.id, "https://boards.greenhouse.io/q/jobs/1")).toMatch(/1 link queued/);
  });
});
