import { randomBytes } from "node:crypto";
import PDFDocument from "pdfkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "@careerfiend/shared";
import { createDb } from "@careerfiend/db";
import { NullProvider, type AiProvider, type ResumeStructure } from "@careerfiend/ai";
import { fromStructure, currentFacts } from "@careerfiend/profile";
import {
  answerSheetView,
  askQuestion,
  connectLm,
  createAppContext,
  deleteAccount,
  disconnectLm,
  editResume,
  getResume,
  ingestUrl,
  lmState,
  prepare,
  saveResume,
  signup,
  skipLm,
  tenantContext,
  tenantKey,
  uploadResumePdf,
  type AppContext,
} from "../src/index";
import { tempDir } from "../../../tests/helpers";
import { makeTestEnv, type TestEnv } from "../../../tests/context";

process.env.CF_TEST_KEY ??= randomBytes(32).toString("base64");

/** The base context of a fresh deployment: an in-memory accounts database, tenants in memory too. */
function baseContext(ai: AiProvider = new NullProvider()): AppContext {
  const config = loadConfig({
    root: tempDir("cf-public-"),
    env: {
      DATABASE_URL: "pglite:memory",
      APP_ENCRYPTION_KEY_SOURCE: "env:CF_TEST_KEY",
      SESSION_SECRET: Buffer.alloc(32, 3).toString("base64"),
      AI_PROVIDER: "none",
    },
  });
  return createAppContext({ db: createDb("pglite:memory"), config, ai, logger: createLogger({ level: "error" }) });
}

async function account(base: AppContext, email: string) {
  const r = await signup(base, email, "a long enough password");
  if (!r.ok) throw new Error(r.error);
  return r.account;
}

/** A small text résumé PDF, made the way word processors make them (text, not an image). */
function resumePdf(): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.font("Helvetica-Bold").fontSize(18).text("Jordan Rivera");
    doc.font("Helvetica").fontSize(10).text("Product analyst who turns messy data into decisions");
    doc.text("Austin, TX | jordan.rivera@example.com | (512) 555-0134 | linkedin.com/in/jordanrivera");
    doc.moveDown().font("Helvetica-Bold").fontSize(12).text("EXPERIENCE");
    doc.font("Helvetica-Bold").fontSize(10).text("Data Analyst", { continued: true }).font("Helvetica").text("     Jan 2023 – Present", { align: "right" });
    doc.text("Northwind Logistics, Austin, TX");
    doc.text("• Built a weekly churn dashboard in SQL and Tableau used by 4 regional managers");
    doc.text("• Cut report preparation time by 30% by automating data pulls with Python");
    doc.moveDown().font("Helvetica-Bold").fontSize(12).text("PROJECTS");
    doc.font("Helvetica-Bold").fontSize(10).text("Budget Buddy | 2022");
    doc.font("Helvetica").text("• Shipped a React app that categorizes bank transactions for 200 users");
    doc.moveDown().font("Helvetica-Bold").fontSize(12).text("EDUCATION");
    doc.font("Helvetica-Bold").fontSize(10).text("University of Texas at Austin");
    doc.font("Helvetica").text("B.S. in Economics          2019 – 2023");
    doc.moveDown().font("Helvetica-Bold").fontSize(12).text("SKILLS");
    doc.font("Helvetica").fontSize(10).text("Technical: SQL, Python, Tableau");
    doc.text("Languages: English, Spanish");
    doc.end();
  });
}

describe("accounts and per-account data", () => {
  it("keeps every account's data in its own database, under its own key", async () => {
    const base = baseContext();
    const a = await tenantContext(base, await account(base, "a@example.com"));
    const b = await tenantContext(base, await account(base, "b@example.com"));
    expect(a.db).not.toBe(b.db);
    await a.db.setting.create({ data: { key: "only.a", value: "secret of a" } });
    expect(await b.db.setting.findUnique({ where: { key: "only.a" } })).toBeNull();
    expect(await base.db.setting.findUnique({ where: { key: "only.a" } })).toBeNull();
    expect(a.key().equals(b.key())).toBe(false);
    expect(a.key().equals(tenantKey(base.key(), a.account!.id))).toBe(true);
    expect(a.config.paths.outputDir).not.toBe(b.config.paths.outputDir);
    // Nobody's GitHub user leaks in from the server's environment.
    expect(a.config.GITHUB_USER).toBe("none");
  });

  it("deleting an account removes it and all of its data", async () => {
    const base = baseContext();
    const ref = await account(base, "gone@example.com");
    const t = await tenantContext(base, ref);
    await t.db.setting.create({ data: { key: "x", value: "y" } });
    await expect(deleteAccount(base, ref.id, "wrong password")).rejects.toThrow(/wrong/);
    await deleteAccount(base, ref.id, "a long enough password");
    expect(await base.db.account.count()).toBe(0);
    const again = await tenantContext(base, ref);
    expect(await again.db.setting.findUnique({ where: { key: "x" } })).toBeNull();
  });
});

describe("connect your own language model", () => {
  it("starts undecided; skipping stops the prompt; Project Recommendations stay off", async () => {
    const base = baseContext();
    const t = await tenantContext(base, await account(base, "lm@example.com"));
    expect((await lmState(t)).status).toBe("undecided");
    expect(t.ai.available).toBe(false);
    await skipLm(t);
    expect((await lmState(t)).status).toBe("skipped");
  });

  it("stores the connection encrypted, shows only the key's last 4 characters, and loads it per account", async () => {
    const base = baseContext();
    const ref = await account(base, "byo@example.com");
    const t = await tenantContext(base, ref);
    await expect(connectLm(t, { provider: "openai", model: "", apiKey: "sk-x" }, { skipTest: true })).rejects.toThrow(/Enter the model/);
    await expect(connectLm(t, { provider: "openai", model: "m", apiKey: "" }, { skipTest: true })).rejects.toThrow(/API key/);
    await expect(connectLm(t, { provider: "nope", model: "m", apiKey: "k" }, { skipTest: true })).rejects.toThrow(/Choose a provider/);
    const s = await connectLm(t, { provider: "anthropic", model: "", apiKey: "fake-test-key-1234" }, { skipTest: true });
    expect(s).toMatchObject({ status: "connected", provider: "anthropic", model: "claude-sonnet-5-5", keyHint: "…1234" });
    const raw = (await t.db.setting.findUniqueOrThrow({ where: { key: "lm.connection" } })).value;
    expect(raw).not.toContain("fake-test-key");
    const fresh = await tenantContext(base, ref);
    expect(fresh.ai.available).toBe(true);
    expect(fresh.ai.name).toBe("anthropic");
    await disconnectLm(fresh);
    expect((await lmState(fresh)).status).toBe("skipped");
    expect((await tenantContext(base, ref)).ai.available).toBe(false);
  });

  it("a custom endpoint must be public and https when hosted", async () => {
    const base = baseContext();
    const t = await tenantContext(base, await account(base, "custom@example.com"));
    const hosted = { ...t, config: { ...t.config, CAREERFIEND_MODE: "hosted" as const } };
    await expect(connectLm(hosted, { provider: "custom", model: "m", apiKey: "k", baseUrl: "http://169.254.169.254/v1" }, { skipTest: true })).rejects.toThrow(
      /not a public address/,
    );
    await expect(connectLm(hosted, { provider: "custom", model: "m", apiKey: "k", baseUrl: "http://localhost:11434/v1" }, { skipTest: true })).rejects.toThrow(
      /not a public address/,
    );
    await expect(connectLm(hosted, { provider: "custom", model: "m", apiKey: "k" }, { skipTest: true })).rejects.toThrow(/base URL/);
    // Running it yourself, a local server (Ollama) is fine.
    const s = await connectLm(t, { provider: "custom", model: "llama", apiKey: "", baseUrl: "http://localhost:11434/v1/" }, { skipTest: true });
    expect(s).toMatchObject({ status: "connected", baseUrl: "http://localhost:11434/v1", keyHint: "no key" });
  });
});

describe("résumé from a PDF and the Profile page", () => {
  it("reads an uploaded PDF into a résumé: entries, bullets, dates, skills; facts and verified skills follow", async () => {
    const base = baseContext();
    const t = await tenantContext(base, await account(base, "pdf@example.com"));
    await expect(uploadResumePdf(t, { name: "x.pdf", bytes: new TextEncoder().encode("not a pdf") })).rejects.toThrow(/not a PDF/);
    const r = await uploadResumePdf(t, { name: "Jordan Rivera.pdf", bytes: await resumePdf() });
    expect(r).toMatchObject({ method: "rules", version: 1, experiences: 3, skills: 3 });
    const { resume } = (await getResume(t))!;
    expect(resume.profile).toMatchObject({ name: "Jordan Rivera", email: "jordan.rivera@example.com", location: "Austin, TX" });
    const job = resume.experiences.find((e) => e.type === "work")!;
    expect(job).toMatchObject({ title: "Data Analyst", organization: "Northwind Logistics", startDate: "2023-01", endDate: null });
    expect(job.responsibilities[0]).toBe("Built a weekly churn dashboard in SQL and Tableau used by 4 regional managers");
    expect(job.endorsedSkills.sort()).toEqual(["python", "sql", "tableau"]);
    expect(resume.experiences.find((e) => e.type === "education")).toMatchObject({
      organization: "University of Texas at Austin",
      startDate: "2019",
      endDate: "2023",
    });
    expect(resume.languages).toEqual(["English", "Spanish"]);
    const sql = await t.db.skill.findUniqueOrThrow({ where: { id: "sql" } });
    expect(sql.status).toBe("VERIFIED_FROM_SOURCE");
    expect((await currentFacts(t.db)).some((f) => f.text.startsWith("Built a weekly churn dashboard"))).toBe(true);
    expect(await t.db.resumeUpload.count()).toBe(1);
  });

  it("with a model connected, keeps only values that appear word for word in the PDF", async () => {
    const text = "Jordan Rivera\nData Analyst Jan 2023 – Present\nNorthwind Logistics\n• Built a weekly churn dashboard in SQL\nSKILLS\nSQL";
    const structured: ResumeStructure = {
      name: "Jordan Rivera",
      headline: "Visionary data leader",
      location: "",
      email: "",
      phone: "",
      links: [],
      experiences: [
        {
          type: "work",
          title: "Data Analyst",
          organization: "Northwind Logistics",
          location: "",
          start: "Jan 2023",
          end: "Present",
          url: "",
          bullets: ["Built a weekly churn dashboard in SQL", "Led a team of 40 engineers"],
        },
      ],
      skills: [
        { label: "SQL", category: "technical" },
        { label: "Kubernetes", category: "technical" },
      ],
      languages: [],
    };
    const r = fromStructure(structured, text, { fallbackEmail: "me@example.com" });
    expect(r.dropped).toBe(3);
    expect(r.resume.profile.headline).toBe("");
    expect(r.resume.experiences[0]!.responsibilities).toEqual(["Built a weekly churn dashboard in SQL"]);
    expect(r.resume.experiences[0]).toMatchObject({ startDate: "2023-01", endDate: null });
    expect(r.resume.skills.map((s) => s.label)).toEqual(["SQL"]);
  });

  it("edits on the Profile page are new versions, and skills follow the text", async () => {
    const base = baseContext();
    const t = await tenantContext(base, await account(base, "edit@example.com"));
    await uploadResumePdf(t, { name: "r.pdf", bytes: await resumePdf() });
    const r = await editResume(t, (res) => {
      res.experiences.find((e) => e.type === "project")!.responsibilities.push("Wrote the SQL that powers its reports");
    });
    expect(r).toEqual({ version: 2, changed: true });
    const { resume } = (await getResume(t))!;
    expect(resume.experiences.find((e) => e.type === "project")!.endorsedSkills).toContain("sql");
    expect(await editResume(t, () => undefined)).toEqual({ version: 2, changed: false });
    await expect(saveResume(t, { ...resume, profile: { ...resume.profile, email: "nope" } }, "profile")).rejects.toThrow(/email/);
  });
});

describe("public edition pipeline (form filling off)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeTestEnv();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("tailors the résumé and cover letter, then leaves the application ready for you to apply", async () => {
    const c: AppContext = { ...env.ctx, config: { ...env.ctx.config, FORM_FILLING: "off" } };
    const r = await ingestUrl(c, `${env.server.url}/listings/senior-title-entry-description.html`, { endorse: true });
    const out = await prepare(c, r.applicationId!, env.pages);
    expect(out).toMatchObject({ state: "MANUAL", category: "DOCUMENTS_READY" });
    const app = await c.db.application.findUniqueOrThrow({ where: { id: r.applicationId! } });
    expect(app.failureCategory).toBe("DOCUMENTS_READY");
    const docs = await c.db.generatedDocument.findMany({ where: { applicationId: app.id } });
    expect(docs.map((d) => `${d.type}.${d.format}`).sort()).toEqual(expect.arrayContaining(["cover_letter.pdf", "resume.pdf"]));
    // The form was read, never filled or submitted.
    expect(await c.db.formField.count({ where: { applicationId: app.id } })).toBe(0);
    expect(env.server.submissions).toHaveLength(0);

    // Its questions come back with answers to copy and paste.
    const sheet = await answerSheetView(c, app.id);
    expect(sheet.source).toBe("form");
    const row = (q: RegExp) => sheet.rows.find((r) => q.test(r.question));
    expect(row(/^Email/)?.answer).toBe("applicant@example.com");
    expect(row(/^Full name/)?.answer).toBe("Test Applicant");
    expect(row(/^Mobile phone/)?.answer).toBe("(213) 555-0100"); // a saved answer from the Profile page
    // Questions on later steps of the form are listed too (the steps are never clicked through).
    expect(row(/Upload your resume/)?.note).toMatch(/tailored résumé PDF/);
    const why = row(/Why are you interested/)!;
    expect(why.answer).toBeNull(); // no model connected: nothing is made up
    expect(why.note).toMatch(/Connect a language model/);

    // With a model, an open question you paste gets a draft that cites your résumé lines.
    class DraftingAi extends NullProvider {
      override readonly available = true;
      override async draftFreeResponse() {
        return {
          answer: "I reviewed batch-manufacturing records and want to keep doing careful quality work.",
          claimKeys: ["experiences[acme-bio-quality-intern].responsibilities[1]"],
          confidence: 0.9,
          cannotAnswerReason: "",
        };
      }
    }
    const withAi: AppContext = { ...c, ai: new DraftingAi() };
    await askQuestion(withAi, app.id, "Describe a time you improved a process.");
    const after = await answerSheetView(withAi, app.id);
    const asked = after.rows.find((r) => r.origin === "asked")!;
    expect(asked.answer).toMatch(/batch-manufacturing records/);
    expect(asked.from).toMatch(/language model/);
    // Questions already read from the form are kept.
    expect(after.rows.some((r) => /Why are you interested/.test(r.question))).toBe(true);
  });
});
