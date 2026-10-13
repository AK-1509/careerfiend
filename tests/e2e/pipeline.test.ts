/**
 * DoD walk-through without the UI: paste URL → worker prepares → questions →
 * approve exact revision → separate submit → confirmation evidence → Gmail
 * labels and tracker status → restart without repeating side effects.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmailProvider } from "@careerfiend/email";
import {
  allWarnings,
  answerQuestion,
  approve,
  currentRevision,
  enqueueUrls,
  pollEmail,
  requestSubmission,
  updateWorkerSettings,
  applicationDetail,
} from "@careerfiend/core";
import { Worker, runCloudWorker } from "@careerfiend/worker";
import { createAppContext } from "@careerfiend/core";
import { makeTestEnv, type TestEnv } from "../context";

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv();
  await updateWorkerSettings(env.ctx, { runWindow: "00:00-00:00" });
});
afterAll(async () => {
  await env?.close();
});

describe("end-to-end pipeline", () => {
  it("runs the full MVP flow and survives a restart", async () => {
    const worker = new Worker(env.ctx, { ephemeralBrowser: true, headless: true });
    await enqueueUrls(env.ctx, `${env.server.url}/listings/senior-title-entry-description.html`);
    await worker.drain();
    const app = await env.ctx.db.application.findFirstOrThrow();
    expect(app.state).toBe("NEEDS_INPUT");

    for (let i = 0; i < 4; i++) {
      const open = await env.ctx.db.userQuestion.findMany({ where: { applicationId: app.id, answeredAt: null } });
      if (!open.length) break;
      for (const q of open) await answerQuestion(env.ctx, q.id, /privacy/i.test(q.question) ? "Yes" : "Your clinical QA work.");
      await worker.drain();
    }
    const rev = await currentRevision(env.ctx.db, app.id);
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id: app.id } })).state).toBe("READY_FOR_REVIEW");
    expect(env.server.submissions).toHaveLength(0);

    await approve(env.ctx, app.id, {
      revisionHash: rev!.row.hash,
      confirmation: "APPROVE",
      acknowledgedWarnings: (await allWarnings(env.ctx, app.id)).filter((w) => !w.blocking).map((w) => w.code),
    });
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id: app.id } })).state).toBe("APPROVED");
    expect(env.server.submissions).toHaveLength(0); // approval alone never submits

    await requestSubmission(env.ctx, app.id, { confirmation: "SUBMIT" });
    await requestSubmission(env.ctx, app.id, { confirmation: "SUBMIT" });
    process.env.CF_CONFIRM_TIMEOUT_MS = "5000";
    await worker.drain();
    const detail = await applicationDetail(env.ctx, app.id);
    expect(detail.app.state).toBe("SUBMITTED");
    expect(detail.app.attempts).toHaveLength(1);
    expect(detail.app.attempts[0]!.screenshotPath).toMatch(/submission-result\.png$/);
    expect(env.server.submissions).toHaveLength(1);

    const mail = new FakeEmailProvider("label");
    mail.deliver({
      id: "e1",
      threadId: "th1",
      from: "Beacon Biologics <no-reply@greenhouse-mail.io>",
      to: "applicant@example.com",
      subject: "Interview with Beacon Biologics",
      date: new Date(),
      snippet: "We'd like to schedule an interview for the Senior Quality Associate role. Please share your availability.",
    });
    expect((await pollEmail(env.ctx, mail)).matched).toBe(1);
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id: app.id } })).state).toBe("INTERVIEW");
    expect(mail.labelNamesOn("e1")).toContain("Job Applications/Interview");

    await worker.stop();
    const restarted = new Worker(env.ctx, { ephemeralBrowser: true, headless: true });
    expect(await restarted.drain()).toBe(0);
    await restarted.stop();
    expect(env.server.submissions).toHaveLength(1);
  });

  it("hosted worker: one bounded run reads and prepares with serverless Chromium; a concurrent run backs off", async () => {
    const fresh = await makeTestEnv();
    try {
      await updateWorkerSettings(fresh.ctx, { runWindow: "00:00-00:00" });
      const hosted = createAppContext({
        db: fresh.ctx.db,
        config: { ...fresh.ctx.config, CAREERFIEND_MODE: "hosted" },
        logger: fresh.ctx.logger,
        ai: fresh.ctx.ai,
        key: fresh.ctx.key,
        fetchers: fresh.ctx.fetchers,
      });
      await enqueueUrls(hosted, `${fresh.server.url}/listings/senior-title-entry-description.html`);
      // Production budget: preparing needs 150 s left once the listing is read (slow under parallel test load).
      const [a, b] = await Promise.all([runCloudWorker(hosted, 270_000), runCloudWorker(hosted, 270_000)]);
      expect([a.ran, b.ran].sort()).toEqual([false, true]);
      expect((a.ran ? a : b).processed).toBe(3); // read the listing, linked its skills to the résumé (skill bank), then prepared it
      const app = await fresh.ctx.db.application.findFirstOrThrow();
      expect(app.state).toBe("NEEDS_INPUT"); // stopped at the questions it could not answer, like the local worker
      expect(await fresh.ctx.db.formField.count({ where: { applicationId: app.id } })).toBeGreaterThan(5);
      expect(await fresh.ctx.db.storedFile.count({ where: { applicationId: app.id } })).toBeGreaterThan(5); // documents + screenshots
      expect(fresh.server.submissions).toHaveLength(0);
      expect((await runCloudWorker(hosted, 60_000)).ran).toBe(true); // lock released
    } finally {
      await fresh.close();
    }
  }, 400_000);
});
