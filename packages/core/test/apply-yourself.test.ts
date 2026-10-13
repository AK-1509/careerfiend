import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationSql } from "@careerfiend/db";
import {
  approve,
  createAppContext,
  currentRevision,
  dashboardCounts,
  allWarnings,
  ingestUrl,
  markAppliedManually,
  performSubmission,
  prepare,
  regenerate,
  regenerateDocuments,
  requestSubmission,
  resolveUncertain,
  retryPreparation,
  type AppContext,
} from "../src/index";
import { makeTestEnv, type TestEnv } from "../../../tests/context";

let env: TestEnv;
let hosted: AppContext;
beforeAll(async () => {
  env = await makeTestEnv();
  hosted = createAppContext({
    db: env.ctx.db,
    config: { ...env.ctx.config, CAREERFIEND_MODE: "hosted" },
    logger: env.ctx.logger,
    ai: env.ctx.ai,
    key: env.ctx.key,
  });
}, 120_000);
afterAll(async () => env?.close());

const listing = (name: string) => `${env.server.url}/listings/${name}`;
const stateOf = async (id: string) => (await env.ctx.db.application.findUniqueOrThrow({ where: { id } })).state;

describe("apply yourself (no more 'failed')", () => {
  let id: string;

  it("a bot check the cloud worker cannot pass leaves the application ready to apply by hand, not failed", async () => {
    const r = await ingestUrl(env.ctx, listing("captcha-listing.html"), { endorse: true });
    id = r.applicationId!;
    const out = await prepare(hosted, id, env.pages);
    expect(out.state).toBe("MANUAL");
    const app = await env.ctx.db.application.findUniqueOrThrow({ where: { id } });
    expect(app).toMatchObject({ state: "MANUAL", failureCategory: "CAPTCHA_OR_BOT_CHECK", failedDuringSubmit: false });
    expect(app.failureMessage).toMatch(/résumé and cover letter are ready/);
    expect(await env.ctx.db.generatedDocument.count({ where: { applicationId: id, type: "resume", format: "pdf" } })).toBe(1);
    const counts = await dashboardCounts(env.ctx);
    expect(counts.manual).toBe(1);
    expect(counts).not.toHaveProperty("failed");
  });

  it("regenerate rebuilds the documents in place and leaves the status alone", async () => {
    const before = await env.ctx.db.generatedDocument.findFirstOrThrow({ where: { applicationId: id, type: "resume", format: "pdf" } });
    expect(await regenerate(env.ctx, id)).toBe("documents");
    expect(await stateOf(id)).toBe("MANUAL");
    const item = await env.ctx.db.workItem.findFirstOrThrow({ where: { kind: "REGENERATE_DOCUMENTS", payload: { contains: id } } });
    expect(item.status).toBe("PENDING");
    await regenerateDocuments(env.ctx, id);
    expect(await stateOf(id)).toBe("MANUAL");
    const after = await env.ctx.db.generatedDocument.findFirstOrThrow({ where: { applicationId: id, type: "resume", format: "pdf" } });
    expect(after.id).not.toBe(before.id);
  });

  it("'I applied' marks it submitted and starts tracking replies; nothing is sent by CareerFiend", async () => {
    await markAppliedManually(env.ctx, id, "applied on the company site");
    const app = await env.ctx.db.application.findUniqueOrThrow({ where: { id } });
    expect(app.state).toBe("SUBMITTED");
    expect(JSON.parse(app.tracking)).toMatchObject({ company: "Gamma Bio", role: "Lab Assistant" });
    expect(env.server.submissions).toHaveLength(0);
    // Regenerate still works after submission, without changing the status.
    expect(await regenerate(env.ctx, id)).toBe("documents");
    expect(await stateOf(id)).toBe("SUBMITTED");
    await expect(markAppliedManually(env.ctx, id)).rejects.toThrow(/waiting for you to apply/);
  });

  it("regenerate waits while CareerFiend is preparing the application", async () => {
    const r = await ingestUrl(env.ctx, listing("unknown-skill.html"), { endorse: true });
    expect(await stateOf(r.applicationId!)).toBe("QUEUED");
    await expect(regenerate(env.ctx, r.applicationId!)).rejects.toThrow(/working on this application right now/);
  });

  it("a submission found not to have gone through waits for you to apply yourself and is never re-queued", async () => {
    const r = await ingestUrl(env.ctx, listing("ambiguous-listing.html"), { endorse: true });
    const aid = r.applicationId!;
    expect((await prepare(env.ctx, aid, env.pages)).state).toBe("READY_FOR_REVIEW");
    const rev = await currentRevision(env.ctx.db, aid);
    const acks = (await allWarnings(env.ctx, aid)).filter((w) => !w.blocking).map((w) => w.code);
    await approve(env.ctx, aid, { revisionHash: rev!.row.hash, confirmation: "APPROVE", acknowledgedWarnings: acks });
    const { attemptId } = await requestSubmission(env.ctx, aid, { confirmation: "SUBMIT" });
    process.env.CF_CONFIRM_TIMEOUT_MS = "3000";
    expect(await performSubmission(env.ctx, attemptId, env.pages)).toBe("UNCERTAIN");
    await resolveUncertain(env.ctx, aid, "FAILED", "No confirmation email and nothing in the portal");
    const app = await env.ctx.db.application.findUniqueOrThrow({ where: { id: aid } });
    expect(app).toMatchObject({ state: "MANUAL", failedDuringSubmit: true });
    await expect(retryPreparation(env.ctx, aid)).rejects.toThrow(/cannot be re-queued/);
    expect(await regenerate(env.ctx, aid)).toBe("documents");
  });

  it("the migration turns old 'failed' applications into 'apply yourself' with a history entry", async () => {
    const r = await ingestUrl(env.ctx, listing("near-miss.html"), { endorse: true });
    const aid = r.applicationId!;
    await env.ctx.db.application.update({ where: { id: aid }, data: { state: "FAILED" } });
    const sql = migrationSql().find((m) => m.name === "0006_apply_yourself")!.sql;
    for (const stmt of sql
      .split(/;\s*$/m)
      .map((x) => x.trim())
      .filter((x) => x && !/^--[^\n]*$/.test(x)))
      await env.ctx.db.$executeRawUnsafe(stmt);
    expect(await stateOf(aid)).toBe("MANUAL");
    const ev = await env.ctx.db.statusEvent.findFirstOrThrow({ where: { applicationId: aid, to: "MANUAL" } });
    expect(ev).toMatchObject({ from: "FAILED", actor: "system:migration" });
  });
});
