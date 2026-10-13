import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NullProvider, type ProjectIdea, type ProjectIdeasRequest, type ProjectMapping, type ProjectMappingRequest } from "@careerfiend/ai";
import {
  advanceProjectRun,
  createAppContext,
  ingestUrl,
  latestProjectRuns,
  privateTerms,
  projectExperiences,
  projectQueue,
  refreshQuota,
  requestProjectIdeas,
  undefinedJargon,
  validateIdeas,
  type AppContext,
} from "../src/index";
import { makeTestEnv, type TestEnv } from "../../../tests/context";

const EXP = "experiences[data-co-analyst-intern]";

/** A stand-in for the model: the mapping uses each job's first requirement; ideas come from whatever the test queues. */
class FakeAi extends NullProvider {
  override readonly name = "fake";
  override readonly available = true;
  mapCalls: ProjectMappingRequest[] = [];
  synthCalls: ProjectIdeasRequest[] = [];
  queue: ((jobIds: string[], reqIds: string[]) => ProjectIdea[])[] = [];
  override async mapProjectAsks(req: ProjectMappingRequest): Promise<ProjectMapping> {
    this.mapCalls.push(req);
    const asks = ["analyzing data", "writing reports", "reviewing records", "planning work"].map((ask, i) => ({
      ask,
      requirementIds: req.jobs.map((j) => j.requirements[i % j.requirements.length]!.id),
      experienceRef: EXP,
      insight: "Cleaned weekly data and noticed reports went stale.",
    }));
    return { asks };
  }
  override async synthesizeProjectIdeas(req: ProjectIdeasRequest): Promise<ProjectIdea[]> {
    this.synthCalls.push(req);
    const jobIds = req.jobs.map((j) => j.id);
    const reqIds = req.jobs.map((j) => j.requirements[0]!.id);
    const next = this.queue.shift() ?? ((ids, reqs) => ideas(ids, reqs, `batch${this.synthCalls.length}`));
    return next(jobIds, reqIds);
  }
}

function idea(title: string, jobIds: string[], reqIds: string[], over: Partial<ProjectIdea> = {}): ProjectIdea {
  return {
    title,
    pitch: "A tool where you state a null hypothesis (the default assumption that nothing changed) and it tests your raw data against it.",
    task: "Turning research into insights",
    howItHelps: "Tells you in minutes whether the evidence — not a hunch — supports a decision.",
    jobIds,
    requirementIds: reqIds,
    basedOn: { experienceRef: EXP, link: "Cleaning weekly data showed how often conclusions outrun the evidence." },
    buildTime: "about a week",
    ...over,
  };
}
const ideas = (jobIds: string[], reqIds: string[], prefix: string, n = 5) =>
  Array.from({ length: n }, (_, i) => idea(`${prefix} idea ${i + 1}`, jobIds, reqIds));

let env: TestEnv;
let ai: FakeAi;
let t = new Date("2026-10-02T15:00:00Z").getTime();
let pctx: AppContext;

beforeAll(async () => {
  env = await makeTestEnv();
  await ingestUrl(env.ctx, `${env.server.url}/listings/senior-title-entry-description.html`);
  await ingestUrl(env.ctx, `${env.server.url}/listings/unknown-skill.html`);
  ai = new FakeAi();
  pctx = createAppContext({ db: env.ctx.db, config: env.ctx.config, logger: env.ctx.logger, ai, key: env.ctx.key, now: () => new Date(t) });
}, 120_000);
afterAll(async () => {
  await env?.close();
});

describe("Project Recommendations: small tools for tasks many jobs share", () => {
  it("builds the queue from jobs with their real requirement ids", async () => {
    const q = await projectQueue(pctx);
    expect(q.length).toBe(2);
    expect(q.map((j) => j.company)).toContain("Beacon Biologics");
    expect(q[0]!.requirements.length).toBeGreaterThan(1);
  });

  it("draws on work and projects from the résumé, never education or excluded entries", async () => {
    const exps = await projectExperiences(pctx);
    expect(exps.map((e) => e.ref)).toEqual([
      "experiences[acme-bio-quality-intern]",
      "experiences[data-co-analyst-intern]",
      "experiences[sidequest-labs-founder]",
    ]);
    expect(exps[0]).toMatchObject({ kind: "work", name: "Quality Intern at Acme Bio" });
  });

  it("knows which names would give the experience away (organization or project name, not a job title)", async () => {
    const [acme, , sidequest] = await projectExperiences(pctx);
    expect(privateTerms(acme!)).toEqual(["acme", "acme bio"]); // the organization, not the "Quality Intern" job title
    expect(privateTerms(sidequest!)).toEqual(["sidequest", "sidequest labs"]);
    expect(privateTerms({ ref: "github:me/validex-app", kind: "github", name: "validex-app", lines: [] })).toEqual(["validex", "validex app"]);
    const dataCo = (await projectExperiences(pctx))[1]!;
    expect(privateTerms(dataCo)).toEqual(["data co"]);
  });

  it("flags jargon that is not explained in parentheses on first use", () => {
    expect(undefinedJargon("Test your data against a null hypothesis.")).toEqual(["null hypothesis"]);
    expect(undefinedJargon("State a null hypothesis (the default assumption) and test it.")).toEqual([]);
    expect(undefinedJargon("Uses an LLM to summarize.")).toEqual(["LLM"]);
    expect(undefinedJargon("Uses an LLM (a text-writing AI model) and embeddings (number fingerprints of text).")).toEqual([]);
    expect(undefinedJargon("A tool for everyday reports.")).toEqual([]);
  });

  it("keeps only plain one-line tools tied to several jobs and a real, unnamed experience", async () => {
    const q = await projectQueue(pctx);
    const jobIds = q.map((j) => j.id);
    const reqs = q.map((j) => j.requirements[0]!.id);
    const exps = await projectExperiences(pctx);
    const { kept, problems } = validateIdeas(
      [
        idea("Evidence Check", jobIds, reqs),
        idea("One job only", jobIds, [reqs[0]!]),
        idea("Made-up requirement", jobIds, ["req_nope"]),
        idea("Unknown experience", jobIds, reqs, { basedOn: { experienceRef: "experiences[nope]", link: "x" } }),
        idea("Sidequest Insight Board", jobIds, reqs, { basedOn: { experienceRef: "experiences[sidequest-labs-founder]", link: "x" } }),
        idea("Too long", jobIds, reqs, { pitch: Array.from({ length: 35 }, () => "word").join(" ") + "." }),
        idea("Two sentences", jobIds, reqs, { pitch: "It reads your notes. Then it writes a report." }),
        idea("Jargon", jobIds, reqs, { pitch: "Runs a regression on your sales data to find what drives revenue." }),
        idea("Evidence Check", jobIds, reqs),
        idea("Old idea", jobIds, reqs),
      ],
      q,
      exps,
      ["old idea"],
    );
    expect(kept.map((i) => i.title)).toEqual(["Evidence Check"]);
    expect(kept[0]!.howItHelps).not.toContain("—");
    expect(kept[0]!.jobIds).toEqual(jobIds);
    const all = problems.join(" ");
    expect(all).toMatch(/"One job only": it ties to 1 queued job/);
    expect(all).toMatch(/"Made-up requirement": it ties to 0 queued job/);
    expect(all).toMatch(/"Unknown experience": basedOn does not name an experience/);
    expect(all).toMatch(/"Sidequest Insight Board": it names the experience behind it \(sidequest\)/);
    expect(all).toMatch(/"Too long": the pitch is not one sentence/);
    expect(all).toMatch(/"Two sentences": the pitch is not one sentence/);
    expect(all).toMatch(/"Jargon": define in parentheses after first use: regression/);
    expect(all.match(/repeats an earlier idea/g)).toHaveLength(2);
  });

  it("needs an AI provider (no web search needed) and refuses a second run while one is active", async () => {
    const off = createAppContext({ db: env.ctx.db, config: env.ctx.config, logger: env.ctx.logger, ai: new NullProvider(), key: env.ctx.key });
    await expect(requestProjectIdeas(off, "initial")).rejects.toThrow(/need a language model.*Settings/);
    // Ideas from before the switch to one-line tools are hidden and do not block a fresh first run.
    await env.ctx.db.projectIdeaRun.create({
      data: {
        id: "pir_old",
        trigger: "initial",
        status: "DONE",
        jobs: "[]",
        ideas: JSON.stringify([{ title: "Niche patentable engine", problem: "x" }]),
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
    });
    expect((await latestProjectRuns(pctx)).current).toBeNull();
    await requestProjectIdeas(pctx, "initial");
    await expect(requestProjectIdeas(pctx, "refresh")).rejects.toThrow(/already being generated/);
  });

  it("maps tasks to experience privately, then writes ideas in a separate step with one repair round", async () => {
    // First synthesis: 3 valid ideas and 2 that name only one job; the repair round supplies the rest.
    ai.queue.push((jobIds, reqs) => [...ideas(jobIds, reqs, "first", 3), idea("bad 1", jobIds, [reqs[0]!]), idea("bad 2", jobIds, [reqs[0]!])]);
    ai.queue.push((jobIds, reqs) => ideas(jobIds, reqs, "repair", 3));
    expect(await advanceProjectRun(pctx)).toEqual({ ran: true, more: true }); // mapping
    expect((await latestProjectRuns(pctx)).active?.status).toBe("RESEARCHED");
    expect(ai.mapCalls[0]!.experiences.map((e) => e.ref)).toContain(EXP);
    expect(await advanceProjectRun(pctx)).toEqual({ ran: true, more: false }); // ideas + repair
    expect(ai.synthCalls[0]!.mapping.asks[0]).toMatchObject({ ask: "analyzing data", experienceRef: EXP });
    expect(ai.synthCalls.at(-1)!.feedback!.join(" ")).toMatch(/bad 1.*ties to 1 queued job/);
    const { current, active } = await latestProjectRuns(pctx);
    expect(active).toBeNull();
    expect(current!.ideas).toHaveLength(6);
    expect(current!.ideas[0]!.basedOn.experienceRef).toBe(EXP); // kept for the record, never rendered
    expect(await advanceProjectRun(pctx)).toEqual({ ran: false, more: false });
  });

  it("refresh gives new ideas, at most 3 per rolling 5 hours, and a failed run does not count", async () => {
    await expect(requestProjectIdeas(pctx, "initial")).rejects.toThrow(/use Refresh/);
    for (let i = 0; i < 3; i++) {
      await requestProjectIdeas(pctx, "refresh");
      await advanceProjectRun(pctx);
      await advanceProjectRun(pctx);
      t += 10 * 60_000;
    }
    const titles = (await env.ctx.db.projectIdeaRun.findMany({ where: { status: "DONE", id: { not: "pir_old" } } })).flatMap((r) =>
      JSON.parse(r.ideas).map((i: ProjectIdea) => i.title),
    );
    expect(new Set(titles).size).toBe(titles.length);
    expect(ai.synthCalls.at(-1)!.avoid.length).toBeGreaterThanOrEqual(15);
    expect(ai.synthCalls.at(-1)!.avoid).not.toContain("Niche patentable engine");
    expect(await refreshQuota(pctx)).toMatchObject({ used: 3, remaining: 0 });
    await expect(requestProjectIdeas(pctx, "refresh")).rejects.toThrow(/all 3 refreshes/);
    t += 5 * 3600_000 - 25 * 60_000;
    expect((await refreshQuota(pctx)).remaining).toBe(1);

    // A run whose ideas keep naming their experience fails and frees its refresh.
    const leaky = (jobIds: string[], reqs: string[]) =>
      ideas(jobIds, reqs, "leaky").map((i) => ({ ...i, title: `${i.title} for Data Co`, basedOn: { experienceRef: EXP, link: "x" } }));
    ai.queue.push(leaky, leaky);
    await requestProjectIdeas(pctx, "refresh");
    await advanceProjectRun(pctx);
    await advanceProjectRun(pctx);
    const latest = await latestProjectRuns(pctx);
    expect(latest.active?.status).toBe("FAILED");
    expect(latest.active?.error).toMatch(/Only 0 ideas passed.*names the experience/);
    expect((await refreshQuota(pctx)).remaining).toBe(1);
  });

  it("an interrupted step is picked up again", async () => {
    await requestProjectIdeas(pctx, "refresh");
    const run = await env.ctx.db.projectIdeaRun.findFirstOrThrow({ where: { status: "PENDING" } });
    await env.ctx.db.$executeRawUnsafe(`UPDATE "ProjectIdeaRun" SET status='RESEARCHING', "updatedAt"=$1 WHERE id=$2`, new Date(t - 7 * 60_000), run.id);
    expect(await advanceProjectRun(pctx)).toEqual({ ran: true, more: true });
    expect(await advanceProjectRun(pctx)).toEqual({ ran: true, more: false });
    expect((await env.ctx.db.projectIdeaRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("DONE");
  });
});
