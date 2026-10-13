import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerQuestion,
  approve,
  editAnswer,
  editCoverLetter,
  ingestUrl,
  lease,
  performSubmission,
  prepare,
  recoverAfterRestart,
  requestSubmission,
  resolveUncertain,
  currentRevision,
  applicationDetail,
  allWarnings,
  dashboardCounts,
  listStored,
  readStoredFile,
  storageKey,
  createAppContext,
  lastLocalTask,
  importProfileIfEmpty,
  applyToJob,
  releaseHeldApplications,
  login,
  signup,
  performLocalTask,
  requestLocalTask,
  resumeHead,
  type AppContext,
} from "../src/index";
import { readSession } from "@careerfiend/shared";
import { createDb } from "@careerfiend/db";
import { commitResume, readResumeSource, storeResume } from "../../../tests/helpers";
import { makeTestEnv, type TestEnv } from "../../../tests/context";

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv();
});
afterAll(async () => {
  await env?.close();
});

const listing = (name: string) => `${env.server.url}/listings/${name}`;

async function prepareUntilReady(appId: string, answers: Record<string, string>) {
  for (let i = 0; i < 6; i++) {
    const out = await prepare(env.ctx, appId, env.pages);
    if (out.state !== "NEEDS_INPUT") return out;
    const qs = await env.ctx.db.userQuestion.findMany({ where: { applicationId: appId, answeredAt: null } });
    for (const q of qs) {
      const a = answers[q.fieldKey];
      if (a === undefined) throw new Error(`No test answer for ${q.fieldKey}: ${q.question}`);
      await answerQuestion(env.ctx, q.id, a);
    }
  }
  throw new Error("did not converge");
}

async function ackAll(appId: string) {
  return (await allWarnings(env.ctx, appId)).filter((w) => !w.blocking).map((w) => w.code);
}

describe("Phase 4: review, approval and controlled submission", () => {
  let appId: string;

  it("ingests, prepares, pauses for input and stages a revision", async () => {
    const r = await ingestUrl(env.ctx, listing("senior-title-entry-description.html"), { endorse: true });
    appId = r.applicationId!;
    const first = await prepare(env.ctx, appId, env.pages);
    expect(first.state).toBe("NEEDS_INPUT");
    const qs = await env.ctx.db.userQuestion.findMany({ where: { applicationId: appId } });
    expect(qs.map((q) => q.fieldKey)).toEqual(["why-are-you-interested-in-this-role:textarea"]);
    const out = await prepareUntilReady(appId, {
      "why-are-you-interested-in-this-role:textarea": "The quality work on clinical manufacturing.",
      "i-agree-to-the-privacy-notice:checkbox": "Yes",
    });
    expect(out.state).toBe("READY_FOR_REVIEW");
    const rev = await currentRevision(env.ctx.db, appId);
    expect(rev!.row.number).toBe(1);
    expect(rev!.payload.uploads).toHaveLength(1);
    expect(rev!.payload.answers.find((a) => a.fieldKey === "mobile-phone:tel")?.value).toBe("(213) 555-0100");
    // The privacy consent is sensitive: encrypted in the revision payload.
    const consent = rev!.payload.answers.find((a) => a.fieldKey === "i-agree-to-the-privacy-notice:checkbox")!;
    expect(consent.sensitive).toBe(true);
    expect(consent.value).not.toBe("Yes");
    expect(env.server.submissions).toHaveLength(0);
  });

  it("backend rejects submission without a current approval", async () => {
    await expect(requestSubmission(env.ctx, appId, { confirmation: "SUBMIT" })).rejects.toThrow(/not APPROVED|No approval/);
  });

  it("approval is bound to the reviewed revision hash and needs acknowledgements", async () => {
    await expect(approve(env.ctx, appId, { revisionHash: "stale", confirmation: "APPROVE", acknowledgedWarnings: [] })).rejects.toThrow(
      /changed after you opened it/,
    );
    const rev = await currentRevision(env.ctx.db, appId);
    const acks = await ackAll(appId);
    expect(acks).toEqual(expect.arrayContaining(["COVER_LETTER_FALLBACK", "LEGAL_ATTESTATION"]));
    await expect(approve(env.ctx, appId, { revisionHash: rev!.row.hash, confirmation: "APPROVE", acknowledgedWarnings: [] })).rejects.toThrow(
      /Acknowledge warnings/,
    );
    await expect(approve(env.ctx, appId, { revisionHash: rev!.row.hash, confirmation: "ok", acknowledgedWarnings: acks })).rejects.toThrow(/Type APPROVE/);
    await approve(env.ctx, appId, { revisionHash: rev!.row.hash, confirmation: "APPROVE", acknowledgedWarnings: acks });
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id: appId } })).state).toBe("APPROVED");
  });

  it("editing any answer invalidates the approval and creates a new revision", async () => {
    const before = await currentRevision(env.ctx.db, appId);
    await editAnswer(env.ctx, appId, "why-are-you-interested-in-this-role:textarea", "Clinical manufacturing QA.");
    const after = await currentRevision(env.ctx.db, appId);
    expect(after!.row.number).toBe(before!.row.number + 1);
    expect(after!.row.hash).not.toBe(before!.row.hash);
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id: appId } })).state).toBe("READY_FOR_REVIEW");
    const approvals = await env.ctx.db.approval.findMany({ where: { applicationId: appId } });
    expect(approvals.every((a) => a.invalidatedAt !== null)).toBe(true);
    await expect(requestSubmission(env.ctx, appId, { confirmation: "SUBMIT" })).rejects.toThrow();
  });

  it("editing the cover letter creates new files and a new revision", async () => {
    const r = await editCoverLetter(env.ctx, appId, [
      "Your clinical QA work is why I'm writing.",
      "I performed QA testing on 12 batches under GMP protocols.",
      "Thanks for reading.",
    ]);
    expect(r.problems).toEqual([]);
    const rev = await currentRevision(env.ctx.db, appId);
    expect(rev!.payload.coverLetter.generator).toBe("user");
    const edited = await editCoverLetter(env.ctx, appId, ["I tested 40 batches."]);
    expect(edited.problems.join(" ")).toMatch(/"40"/);
  });

  it("a replaced file after approval is caught by the hash check", async () => {
    await editCoverLetter(env.ctx, appId, [
      "Your clinical QA work is why I'm writing.",
      "I performed QA testing on 12 batches under GMP protocols.",
      "Thanks for reading.",
    ]);
    const rev = await currentRevision(env.ctx.db, appId);
    await approve(env.ctx, appId, { revisionHash: rev!.row.hash, confirmation: "APPROVE", acknowledgedWarnings: await ackAll(appId) });
    const resume = rev!.payload.documents.find((d) => d.type === "resume" && d.format === "pdf")!;
    const original = readFileSync(resume.path);
    writeFileSync(resume.path, Buffer.concat([original, Buffer.from("tampered")]));
    await expect(requestSubmission(env.ctx, appId, { confirmation: "SUBMIT" })).rejects.toThrow(/hash mismatch/);
    writeFileSync(resume.path, original);
    await expect(requestSubmission(env.ctx, appId, { confirmation: "" })).rejects.toThrow(/second confirmation/);
  });

  it("files are stored in the database; with no local copy the database bytes are hashed", async () => {
    const rev = await currentRevision(env.ctx.db, appId);
    const resume = rev!.payload.documents.find((d) => d.type === "resume" && d.format === "pdf")!;
    const key = storageKey(resume.path)!;
    expect(key).toMatch(new RegExp(`^${appId}/r\\d+/resume\\.pdf$`));
    expect((await listStored(env.ctx, `${appId}/`)).some((k) => k.endsWith("/steps/step-1.png"))).toBe(true);
    const bytes = readFileSync(resume.path);
    // As on the hosted dashboard: no output folder at all.
    rmSync(path.join(env.ctx.config.paths.outputDir, appId), { recursive: true, force: true });
    expect(await readStoredFile(env.ctx, key)).toEqual(bytes);
    expect(await readStoredFile(env.ctx, `${appId}/../x/resume.pdf`)).toBeNull();
    const row = await env.ctx.db.storedFile.findUniqueOrThrow({ where: { path: key } });
    await env.ctx.db.storedFile.update({ where: { path: key }, data: { data: new Uint8Array(Buffer.concat([Buffer.from(row.data), Buffer.from("x")])) } });
    await expect(requestSubmission(env.ctx, appId, { confirmation: "SUBMIT" })).rejects.toThrow(/hash mismatch/);
    await env.ctx.db.storedFile.update({ where: { path: key }, data: { data: row.data } });
  });

  it("double-click / replay cannot create duplicate submissions", async () => {
    const [a, b] = await Promise.all([
      requestSubmission(env.ctx, appId, { confirmation: "SUBMIT" }),
      requestSubmission(env.ctx, appId, { confirmation: "SUBMIT" }),
    ]);
    expect(a.attemptId).toBe(b.attemptId);
    const again = await requestSubmission(env.ctx, appId, { confirmation: "SUBMIT" });
    expect(again).toEqual({ attemptId: a.attemptId, existing: true });
    expect(await env.ctx.db.submissionAttempt.count({ where: { applicationId: appId } })).toBe(1);
    expect(await env.ctx.db.workItem.count({ where: { kind: "SUBMIT" } })).toBe(1);

    process.env.CF_CONFIRM_TIMEOUT_MS = "5000";
    // The worker has no local copies (removed above); it fetches them from the database.
    expect(existsSync(path.join(env.ctx.config.paths.outputDir, appId))).toBe(false);
    expect(await performSubmission(env.ctx, a.attemptId, env.pages)).toBe("SUBMITTED");
    expect(await performSubmission(env.ctx, a.attemptId, env.pages)).toBe("SUBMITTED"); // no-op
    expect(await listStored(env.ctx, `${appId}/`)).toContainEqual(expect.stringMatching(/steps\/submission-result\.png$/));
    expect(env.server.submissions).toHaveLength(1);
    const rev = await currentRevision(env.ctx.db, appId);
    const upload = rev!.payload.uploads[0]!;
    expect(env.server.submissions[0]!.files[0]!.sha256).toBe(upload.sha256);
    const detail = await applicationDetail(env.ctx, appId);
    expect(detail.app.state).toBe("SUBMITTED");
    expect(detail.app.attempts[0]!.confirmationText).toMatch(/Thank you/);
    expect(detail.tracking).toMatchObject({ company: "Beacon Biologics", recipient: "applicant@example.com" });
  });

  it("an ambiguous submission becomes SUBMISSION_UNCERTAIN and is never retried", async () => {
    const r = await ingestUrl(env.ctx, listing("ambiguous-listing.html"), { endorse: true });
    const id = r.applicationId!;
    expect((await prepare(env.ctx, id, env.pages)).state).toBe("READY_FOR_REVIEW");
    const rev = await currentRevision(env.ctx.db, id);
    await approve(env.ctx, id, { revisionHash: rev!.row.hash, confirmation: "APPROVE", acknowledgedWarnings: await ackAll(id) });
    const { attemptId } = await requestSubmission(env.ctx, id, { confirmation: "SUBMIT" });
    process.env.CF_CONFIRM_TIMEOUT_MS = "3000";
    expect(await performSubmission(env.ctx, attemptId, env.pages)).toBe("UNCERTAIN");
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id } })).state).toBe("SUBMISSION_UNCERTAIN");
    const item = await env.ctx.db.workItem.findFirstOrThrow({ where: { kind: "SUBMIT", payload: { contains: attemptId } } });
    expect(item.maxAttempts).toBe(1);
    await expect(requestSubmission(env.ctx, id, { confirmation: "SUBMIT" })).resolves.toMatchObject({ existing: true });
    await resolveUncertain(env.ctx, id, "SUBMITTED", "Confirmation email arrived");
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id } })).state).toBe("SUBMITTED");
  });

  it("restart recovery: a submit interrupted mid-run becomes UNCERTAIN; preparation resumes", async () => {
    const r = await ingestUrl(env.ctx, listing("unknown-skill.html"), { endorse: true });
    const id = r.applicationId!;
    const out = await prepareUntilReady(id, { "do-you-have-experience-with-gmp:radio": "Yes" });
    expect(out.state).toBe("READY_FOR_REVIEW");
    const rev = await currentRevision(env.ctx.db, id);
    await approve(env.ctx, id, { revisionHash: rev!.row.hash, confirmation: "APPROVE", acknowledgedWarnings: await ackAll(id) });
    const { attemptId } = await requestSubmission(env.ctx, id, { confirmation: "SUBMIT" });
    // Earlier tests ran submissions directly; mark their queue items done.
    await env.ctx.db.workItem.updateMany({ where: { kind: "SUBMIT", NOT: { payload: { contains: attemptId } } }, data: { status: "DONE" } });
    // Worker leases the SUBMIT item, then "crashes" (lease expires).
    const leased = await lease(env.ctx.db, "w1", ["SUBMIT"], new Date(), 1);
    expect(leased?.payload.attemptId).toBe(attemptId);
    await new Promise((res) => setTimeout(res, 10));
    const rec = await recoverAfterRestart(env.ctx);
    expect(rec.uncertain).toBe(1);
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id } })).state).toBe("SUBMISSION_UNCERTAIN");
    expect((await env.ctx.db.submissionAttempt.findUniqueOrThrow({ where: { id: attemptId } })).result).toBe("UNCERTAIN");
    const before = env.server.submissions.length;
    expect(await performSubmission(env.ctx, attemptId, env.pages)).toBe("UNCERTAIN");
    expect(env.server.submissions.length).toBe(before);
  });
});

describe("you decide: no qualification checks", () => {
  it("a near-miss-style listing still gets an application that is prepared, with no skill questions", async () => {
    const r = await ingestUrl(env.ctx, listing("near-miss.html"), { endorse: true });
    const app = await env.ctx.db.application.findUniqueOrThrow({ where: { id: r.applicationId! } });
    expect(app.state).toBe("QUEUED");
    expect(await env.ctx.db.userQuestion.count({ where: { applicationId: app.id } })).toBe(0);
    expect(await env.ctx.db.workItem.count({ where: { kind: "PREPARE", payload: { contains: app.id } } })).toBe(1);
  });

  it("held applications and skipped listings you added are released once", async () => {
    // Simulate data from before: a near-miss held for skill questions, and a listing you added that was skipped.
    const held = await ingestUrl(env.ctx, listing("remote-uk.html"), { endorse: true });
    await env.ctx.db.workItem.updateMany({ where: { kind: "PREPARE", payload: { contains: held.applicationId! } }, data: { status: "DONE" } });
    await env.ctx.db.application.update({ where: { id: held.applicationId! }, data: { state: "NEEDS_INPUT" } });
    await env.ctx.db.userQuestion.create({
      data: {
        id: "uq_old",
        applicationId: held.applicationId!,
        kind: "SKILL_CONFIRM",
        fieldKey: "microsoft-excel",
        question: "Do you have Excel?",
        context: "",
      },
    });
    const skipped = await ingestUrl(env.ctx, listing("expired.html")); // read without an application
    await env.ctx.db.job.update({ where: { id: skipped.jobId }, data: { endorsed: true } });
    const out = await releaseHeldApplications(env.ctx);
    expect(out).toEqual({ started: 1, resumed: 1 });
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id: held.applicationId! } })).state).toBe("GENERATING_DOCUMENTS");
    expect(await env.ctx.db.userQuestion.count({ where: { kind: "SKILL_CONFIRM" } })).toBe(0);
    expect(await env.ctx.db.application.count({ where: { jobId: skipped.jobId } })).toBe(1);
    expect(await releaseHeldApplications(env.ctx)).toEqual({ started: 0, resumed: 0 });
  });

  it("a watchlist find waits for you; Apply starts it", async () => {
    const found = await ingestUrl(env.ctx, listing("entry-title-senior-description.html")); // like a watchlist find: listed only
    expect(found.applicationId).toBeNull();
    await applyToJob(env.ctx, found.jobId);
    expect(await env.ctx.db.application.count({ where: { jobId: found.jobId } })).toBe(1);
    expect((await env.ctx.db.job.findUniqueOrThrow({ where: { id: found.jobId } })).endorsed).toBe(true);
  });

  it("an unknown required skill is appended exactly once as UNVERIFIED", async () => {
    const skills = await env.ctx.db.skill.findMany({ where: { origin: "job-description" } });
    expect(skills.filter((s) => s.label === "Veeva Vault").map((s) => s.status)).toEqual(["UNVERIFIED"]);
    const total = skills.length;
    const again = await ingestUrl(env.ctx, listing("unknown-skill.html"), { endorse: true });
    expect(again.duplicate).toBe(true);
    expect(await env.ctx.db.skill.count({ where: { origin: "job-description" } })).toBe(total);
  });

  it("out-of-region listings you add get an application too (region is your call)", async () => {
    const r = await ingestUrl(env.ctx, listing("out-of-region.html"), { endorse: true });
    expect(r.applicationId).not.toBeNull();
  });

  it("a résumé change marks drafts SOURCE_CHANGED and blocks approval", async () => {
    const ready = (await env.ctx.db.application.findMany({ where: { state: "SUBMITTED" } }))[0]!;
    const raw = readFileSync(path.join(env.resumeRepo, "content/resume.json"), "utf8");
    commitResume(env.resumeRepo, raw.replace("12 batches", "13 batches"));
    await storeResume(env.ctx.db, readResumeSource(env.resumeRepo));
    const w = await allWarnings(env.ctx, ready.id);
    expect(w.find((x) => x.code === "SOURCE_CHANGED")?.blocking).toBe(true);
    commitResume(env.resumeRepo, raw);
    await storeResume(env.ctx.db, readResumeSource(env.resumeRepo));
    const counts = await dashboardCounts(env.ctx);
    expect(counts.submitted).toBeGreaterThanOrEqual(2);
  });
});

describe("Phase 5: Gmail tracking (fake provider, controlled messages)", () => {
  it("polls incrementally and idempotently, labels matches, updates status, queues ambiguous mail", async () => {
    const { FakeEmailProvider } = await import("@careerfiend/email");
    const { pollEmail, assignEmail } = await import("../src/index");
    const provider = new FakeEmailProvider("label");
    const submitted = await env.ctx.db.application.findMany({ where: { state: "SUBMITTED" }, include: { job: true } });
    const beacon = submitted.find((a) => a.job.company === "Beacon Biologics")!;
    const delta = submitted.find((a) => a.job.company === "Delta Labs")!;
    const now = new Date();
    provider.deliver({
      id: "m1",
      threadId: "t1",
      from: "Beacon Biologics <no-reply@greenhouse-mail.io>",
      to: "applicant@example.com",
      subject: "Thank you for applying to Beacon Biologics",
      date: now,
      snippet: "We received your application for Senior Quality Associate.",
    });
    provider.deliver({
      id: "m2",
      threadId: "t2",
      from: "Talent <talent@example.org>",
      to: "applicant@example.com",
      subject: "Your application",
      date: now,
      snippet: "Thanks for applying to Beacon Biologics and Delta Labs.",
    });
    provider.deliver({
      id: "m3",
      threadId: "t3",
      from: "Store <deals@shop.example>",
      to: "applicant@example.com",
      subject: "Sale",
      date: now,
      snippet: "50% off",
    });

    const first = await pollEmail(env.ctx, provider);
    expect(first).toMatchObject({ processed: 3, matched: 1, unmatched: 1, ignored: 1 });
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id: beacon.id } })).state).toBe("CONFIRMATION_RECEIVED");
    const labels = provider.labelNamesOn("m1");
    expect(labels).toContain("Job Applications/Applied");
    expect(labels.some((l) => l.startsWith("Job Applications/Apps/Beacon Biologics - Senior Quality Associate - "))).toBe(true);
    expect(provider.labelNamesOn("m2")).toEqual([]); // ambiguous: not labeled
    const ignored = await env.ctx.db.emailMessage.findUniqueOrThrow({ where: { providerId: "m3" } });
    expect(ignored.subject).toBe(""); // minimization
    const unmatched = await env.ctx.db.emailMessage.findUniqueOrThrow({ where: { providerId: "m2" } });
    expect(unmatched.matchStatus).toBe("UNMATCHED");

    // Incremental and idempotent: nothing new, nothing reprocessed.
    const second = await pollEmail(env.ctx, provider);
    expect(second.processed).toBe(0);
    expect(provider.calls.filter((c) => c.startsWith("sync:")).at(-1)).not.toBe("sync:full");

    // A rejection in the same thread updates both labels and dashboard status.
    provider.deliver({
      id: "m4",
      threadId: "t1",
      from: "Beacon Biologics <no-reply@greenhouse-mail.io>",
      to: "applicant@example.com",
      subject: "Update on your Beacon Biologics application",
      date: new Date(),
      snippet: "Unfortunately, we will not be moving forward with your application for Senior Quality Associate.",
    });
    const third = await pollEmail(env.ctx, provider);
    expect(third.matched).toBe(1);
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id: beacon.id } })).state).toBe("REJECTED");
    expect(provider.labelNamesOn("m4")).toContain("Job Applications/Rejection");

    // Manual assignment of the ambiguous message; an interview updates Delta Labs.
    await assignEmail(env.ctx, provider, unmatched.id, delta.id, "interview");
    expect((await env.ctx.db.application.findUniqueOrThrow({ where: { id: delta.id } })).state).toBe("INTERVIEW");
    expect(provider.labelNamesOn("m2")).toContain("Job Applications/Interview");
    expect(provider.calls.some((c) => /send|trash|delete|archive/i.test(c))).toBe(false);
  });

  it("Gmail connect stores tokens encrypted; disconnect revokes and deletes them", async () => {
    const { finishGmailConnect, startGmailConnect, disconnectGmail, gmailStatus } = await import("../src/index");
    env.ctx.config.GMAIL_OAUTH_CLIENT_ID = "client";
    env.ctx.config.GMAIL_OAUTH_CLIENT_SECRET = "secret";
    const url = new URL(await startGmailConnect(env.ctx, "http://localhost:3100/api/gmail/callback", "label"));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const seen: string[] = [];
    const http = async (u: string, init?: { method?: string; body?: string }) => {
      seen.push(`${init?.method ?? "GET"} ${u.split("?")[0]}`);
      if (u.startsWith("https://oauth2.googleapis.com/token"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "ya29.test", refresh_token: "1//refresh-token-value", expires_in: 3600, scope: "gmail.modify" }),
          text: async () => "",
        };
      return { ok: true, status: 200, json: async () => ({ emailAddress: "applicant@example.com", historyId: "5" }), text: async () => "" };
    };
    const account = await finishGmailConnect(env.ctx, "code", url.searchParams.get("state")!, http);
    expect(account).toBe("applicant@example.com");
    const row = await env.ctx.db.oAuthToken.findUniqueOrThrow({ where: { provider: "gmail" } });
    expect(row.encrypted).not.toContain("refresh-token-value");
    expect((await gmailStatus(env.ctx)).connected).toBe(true);
    await disconnectGmail(env.ctx, http);
    expect(seen.some((s) => s === "POST https://oauth2.googleapis.com/revoke")).toBe(true);
    expect(await env.ctx.db.oAuthToken.count()).toBe(0);
    expect((await gmailStatus(env.ctx)).connected).toBe(false);
  });
});

describe("hosted dashboard", () => {
  const hostedCtx = (extra: Partial<AppContext["config"]> = {}, now?: () => Date): AppContext =>
    createAppContext({
      db: env.ctx.db,
      config: { ...env.ctx.config, CAREERFIEND_MODE: "hosted", ...extra },
      logger: env.ctx.logger,
      ai: env.ctx.ai,
      key: env.ctx.key,
      now,
    });

  it("re-reads the stored résumé directly (no computer needed)", async () => {
    const hosted = hostedCtx();
    expect(await requestLocalTask(hosted, "reingest-resume")).toMatch(/résumé v\d+/);
    expect((await lastLocalTask(hosted))?.message).toMatch(/résumé v\d+/);
    expect(await resumeHead(hosted)).toBe(await resumeHead(env.ctx));
    // A queued task is taken by the worker too.
    const r = await performLocalTask(env.ctx, "reingest-resume");
    expect(r.ok).toBe(true);
    expect(await lease(env.ctx.db, "test-worker", ["LOCAL_TASK"], new Date())).toBeNull();
  });

  it("a worker on an account with a saved résumé but no facts extracts them once", async () => {
    const db = createDb("pglite:memory");
    const fresh = createAppContext({ db, config: env.ctx.config, logger: env.ctx.logger, ai: env.ctx.ai, key: env.ctx.key });
    expect(await importProfileIfEmpty(fresh)).toBeNull(); // nothing saved yet
    const src = readResumeSource(env.resumeRepo);
    await db.resumeDraft.create({ data: { id: "me", json: src.rawText, version: 1, origin: "profile" } });
    const r = await importProfileIfEmpty(fresh);
    expect(r).toMatchObject({ ok: true });
    expect(await db.sourceDocument.count()).toBe(1);
    expect(await importProfileIfEmpty(fresh)).toBeNull();
    await db.$disconnect();
  });

  it("accounts: sign-up gives a session; five wrong passwords lock the account, even for the right password", async () => {
    let t = new Date("2026-09-25T12:00:00Z").getTime();
    const secret = Buffer.alloc(32, 7).toString("base64");
    const db = createDb("pglite:memory");
    const c = createAppContext({
      db,
      config: { ...env.ctx.config, SESSION_SECRET: secret },
      logger: env.ctx.logger,
      ai: env.ctx.ai,
      key: env.ctx.key,
      now: () => new Date(t),
    });
    const made = await signup(c, "Person@Example.com", "correct horse battery");
    expect(made.ok).toBe(true);
    expect(await signup(c, "person@example.com", "another long password")).toMatchObject({ ok: false, error: expect.stringMatching(/already exists/) });
    expect(await signup(c, "x@example.com", "short")).toMatchObject({ ok: false });
    const good = await login(c, "person@example.com", "correct horse battery");
    expect(good.ok && readSession(good.token, secret, t)?.accountId).toBe(made.ok && made.account.id);
    for (let i = 0; i < 4; i++) expect(await login(c, "person@example.com", "nope")).toEqual({ ok: false, error: "Wrong email or password." });
    expect((await login(c, "person@example.com", "nope")) as { error: string }).toMatchObject({ error: expect.stringMatching(/locked for 15 minutes/) });
    expect((await login(c, "person@example.com", "correct horse battery")) as { error: string }).toMatchObject({
      error: expect.stringMatching(/Try again in 15 minutes/),
    });
    t += 16 * 60_000;
    expect((await login(c, "person@example.com", "correct horse battery")).ok).toBe(true);
    expect(await login(c, "nobody@example.com", "whatever pass")).toEqual({ ok: false, error: "Wrong email or password." });
    const closed = createAppContext({ db, config: { ...c.config, SIGNUPS_OPEN: "false" }, logger: env.ctx.logger, ai: env.ctx.ai, key: env.ctx.key });
    expect(await signup(closed, "new@example.com", "correct horse battery")).toMatchObject({ ok: false, error: expect.stringMatching(/closed/) });
    expect(await login(hostedCtx({ SESSION_SECRET: undefined }), "a@b.co", "x")).toMatchObject({ ok: false, error: expect.stringMatching(/not configured/) });
    await db.$disconnect();
  });
});
