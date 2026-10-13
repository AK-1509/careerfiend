import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWatchlistCompany, enqueueUrls, updateWorkerSettings, withinWindow, workerSettings } from "@careerfiend/core";
import { Worker } from "../src/index";
import { makeTestEnv, type TestEnv } from "../../../tests/context";
import { REPO_ROOT } from "../../../tests/helpers";

let env: TestEnv;
let worker: Worker;
beforeAll(async () => {
  env = await makeTestEnv();
  worker = new Worker(env.ctx, { ephemeralBrowser: true, headless: true });
  await updateWorkerSettings(env.ctx, { runWindow: "00:00-00:00" });
});
afterAll(async () => {
  await worker?.stop();
  await env?.close();
});

describe("worker", () => {
  it("does nothing while paused", async () => {
    await updateWorkerSettings(env.ctx, { paused: true });
    await enqueueUrls(env.ctx, `${env.server.url}/listings/unknown-skill.html`);
    expect(await worker.runOnce()).toBe(false);
    await updateWorkerSettings(env.ctx, { paused: false });
  });

  it("ingests pasted URLs and prepares applications from the durable queue", async () => {
    const r = await enqueueUrls(env.ctx, `${env.server.url}/listings/unknown-skill.html\n${env.server.url}/listings/unknown-skill.html\nnot a url`);
    expect(r).toEqual({ queued: 0, alreadyQueued: [`${env.server.url}/listings/unknown-skill.html`], blocked: [], invalid: ["not", "a", "url"] }); // already queued above (dedupe)
    await worker.drain();
    const app = await env.ctx.db.application.findFirstOrThrow({ include: { job: true } });
    expect(app.job.company).toBe("Cobalt Pharma");
    expect(["NEEDS_INPUT", "READY_FOR_REVIEW"]).toContain(app.state);
    expect(env.server.submissions).toHaveLength(0);
  });

  it("respects the daily preparation limit and the run window", async () => {
    await updateWorkerSettings(env.ctx, { dailyLimit: 1 });
    await enqueueUrls(env.ctx, `${env.server.url}/listings/ambiguous-listing.html`);
    await worker.drain();
    const delta = await env.ctx.db.application.findFirstOrThrow({ where: { job: { company: "Delta Labs" } } });
    expect(delta.state).toBe("QUEUED"); // limit reached: PREPARE waits
    expect(await env.ctx.db.workItem.count({ where: { kind: "PREPARE", status: "PENDING" } })).toBe(1);
    await updateWorkerSettings(env.ctx, { dailyLimit: null });
    const s = await workerSettings(env.ctx);
    expect(s.dailyLimit).toBeNull();
    await worker.drain();
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id: delta.id } })).state).toBe("READY_FOR_REVIEW");
    expect(withinWindow(new Date("2026-09-25T09:00:00"), "08:00-20:00")).toBe(true);
    expect(withinWindow(new Date("2026-09-25T21:00:00"), "08:00-20:00")).toBe(false);
    expect(withinWindow(new Date("2026-09-25T23:30:00"), "22:00-06:00")).toBe(true);
    expect(withinWindow(new Date("2026-09-25T03:00:00"), "00:00-00:00")).toBe(true);
    // Vercel runs in UTC: 23:30 UTC is 16:30 in Los Angeles, inside an 08:00-20:00 window there.
    expect(withinWindow(new Date("2026-10-03T23:30:00Z"), "08:00-20:00", "America/Los_Angeles")).toBe(true);
    expect(withinWindow(new Date("2026-10-04T04:30:00Z"), "08:00-20:00", "America/Los_Angeles")).toBe(false);
    await updateWorkerSettings(env.ctx, { runWindow: "08:00-08:01" });
    await enqueueUrls(env.ctx, `${env.server.url}/listings/near-miss.html`);
    const outside = !withinWindow(new Date(), "08:00-08:01");
    if (outside) {
      await env.ctx.db.workItem.create({ data: { id: "wi_window", kind: "PREPARE", payload: JSON.stringify({ applicationId: delta.id }), runAt: new Date() } });
      await worker.drain();
      expect((await env.ctx.db.workItem.findUniqueOrThrow({ where: { id: "wi_window" } })).status).toBe("PENDING");
      await env.ctx.db.workItem.delete({ where: { id: "wi_window" } });
    }
    await updateWorkerSettings(env.ctx, { runWindow: "00:00-00:00" });
  });

  it("lists watchlist postings for you (no filtering) and applies to none of them", async () => {
    const board = JSON.parse(readFileSync(path.join(REPO_ROOT, "fixtures/ats-api/greenhouse-board.json"), "utf8"));
    env.ctx.fetchers = {
      ...env.ctx.fetchers,
      json: async (u) => ({ ok: true, status: 200, json: async () => (u.includes("/examplebio/jobs") ? board : {}), text: async () => "" }),
    };
    await addWatchlistCompany(env.ctx, { ats: "greenhouse", boardSlug: "examplebio", name: "Example Bio" });
    const { pollWatchlist } = await import("@careerfiend/core");
    const r = await pollWatchlist(env.ctx);
    expect(r).toMatchObject({ companies: 1, seen: 2, ingested: 2 });
    const jobs = await env.ctx.db.job.findMany({ where: { company: "Example Bio" }, include: { applications: true } });
    expect(jobs.map((j) => j.source)).toEqual(["greenhouse", "greenhouse"]);
    expect(jobs.every((j) => !j.endorsed && j.applications.length === 0)).toBe(true);
  });
});
