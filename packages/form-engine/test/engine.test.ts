import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "@careerfiend/shared";
import { acceptDraft, proposeValue, type ProfileContext } from "@careerfiend/policy";
import { openEphemeral, prepareApplication, submitRevision, type BrowserSession, type Proposer, type PrepareResult } from "../src/index";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/server";
import { tempDir } from "../../../tests/helpers";

let server: FixtureServer;
let browser: BrowserSession;
const dir = tempDir("cf-engine-");
const resumePath = path.join(dir, "resume.pdf");
writeFileSync(resumePath, "%PDF-1.4\n% fixture résumé\n");

const baseCtx = (): ProfileContext => ({
  name: "Test Applicant",
  email: "applicant@example.com",
  location: "Los Angeles, CA",
  links: [
    { label: "GitHub", url: "https://github.com/example" },
    { label: "LinkedIn", url: "https://www.linkedin.com/in/example" },
  ],
  headline: "h",
  currentRole: { title: "Quality Intern", organization: "Acme Bio", titleKey: "experiences[a].title", orgKey: "experiences[a].organization" },
  latestEducation: null,
  values: {},
  skills: [
    {
      id: "gmp",
      label: "GMP",
      aliases: [],
      category: "domain",
      status: "VERIFIED_FROM_SOURCE",
      origin: "resume",
      inResumeRegistry: true,
      evidence: [{ key: "experiences[a].responsibilities[0]", kind: "work" }],
    },
  ],
  documents: { resumePath, resumeSha256: sha256("%PDF-1.4\n% fixture résumé\n"), coverLetterPath: null, coverLetterSha256: null, coverLetterText: null },
  eeoPolicy: "UNSET",
  job: { company: "Acme", title: "QA", sourceUrl: "https://acme.example/jobs/1" },
  userAnswers: {},
});

const proposerFor =
  (ctx: ProfileContext): Proposer =>
  async (f) =>
    proposeValue(f, ctx);
const opts = (p: string) => ({ targetUrl: `${server.url}${p}`, outputDir: tempDir("cf-out-"), allowedHosts: ["localhost"] });
const byLabel = (r: PrepareResult, label: string) => r.fields.find((f) => f.label === label);

beforeAll(async () => {
  server = await startFixtureServer(0);
  browser = await openEphemeral(true);
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
beforeEach(() => {
  server.submissions.length = 0;
});

describe("preparation (never submits)", () => {
  it("fills a single-page form and stops before final submit", async () => {
    const page = await browser.newPage();
    const r = await prepareApplication(page, opts("/ats/single-page/apply.html"), proposerFor(baseCtx()));
    expect(r.outcome).toBe("READY");
    expect(r.finalSubmitLabel).toBe("Submit Application");
    expect(byLabel(r, "First Name")).toMatchObject({ proposedValue: "Test", reviewState: "FILLED" });
    expect(byLabel(r, "Resume/CV")).toMatchObject({ reviewState: "FILLED", source: "document" });
    expect(byLabel(r, "LinkedIn Profile")?.proposedValue).toBe("https://www.linkedin.com/in/example");
    expect(byLabel(r, "Do you have experience with GMP?")).toMatchObject({ proposedValue: "Yes", source: "skills" });
    expect(byLabel(r, "Phone")?.reviewState).toBe("SKIPPED_OPTIONAL");
    expect(byLabel(r, "Gender")?.reviewState).toBe("SKIPPED_OPTIONAL");
    expect(await page.locator("#first_name").inputValue()).toBe("Test");
    expect(r.steps[0]!.screenshotPath).toMatch(/step-1\.png$/);
    expect(server.submissions).toHaveLength(0);
    await page.close();
  });

  it("walks a multi-step form, pausing for each unknown required field, and preserves values", async () => {
    const ctx = baseCtx();
    const page = await browser.newPage();
    let r = await prepareApplication(page, opts("/ats/multi-step/step1.html"), proposerFor(ctx));
    expect(r.outcome).toBe("NEEDS_INPUT");
    expect(r.questions.map((q) => q.label)).toEqual(["Mobile phone"]);

    ctx.userAnswers["mobile-phone:tel"] = "(213) 555-0100";
    r = await prepareApplication(page, opts("/ats/multi-step/step1.html"), proposerFor(ctx));
    expect(r.outcome).toBe("NEEDS_INPUT");
    expect(r.questions.map((q) => q.label)).toEqual(["Why are you interested in this role?"]);
    expect(byLabel(r, "State")?.proposedValue).toBe("California");
    expect(byLabel(r, "Current company")?.proposedValue).toBe("Acme Bio");

    ctx.userAnswers["why-are-you-interested-in-this-role:textarea"] = "The QA release work.";
    r = await prepareApplication(page, opts("/ats/multi-step/step1.html"), proposerFor(ctx));
    expect(r.outcome).toBe("NEEDS_INPUT");
    expect(r.questions).toMatchObject([{ label: "I agree to the privacy notice", sensitive: true }]);

    ctx.userAnswers["i-agree-to-the-privacy-notice:checkbox"] = "Yes";
    r = await prepareApplication(page, opts("/ats/multi-step/step1.html"), proposerFor(ctx));
    expect(r.outcome).toBe("READY");
    expect(r.steps.map((s) => s.step)).toEqual([1, 2, 3]);
    // Values from step 1 are still in the (hidden) step-1 inputs.
    expect(await page.locator("#phone").inputValue()).toBe("(213) 555-0100");
    expect(await page.locator("#name").inputValue()).toBe("Test Applicant");
    expect(server.submissions).toHaveLength(0);
    await page.close();
  });

  it("detects site validation errors", async () => {
    const ctx = baseCtx();
    ctx.userAnswers["mobile-phone:tel"] = "abc";
    const page = await browser.newPage();
    const r = await prepareApplication(page, opts("/ats/multi-step/step1.html"), proposerFor(ctx));
    expect(r.outcome).toBe("NEEDS_INPUT");
    expect(r.category, JSON.stringify(r.questions)).toBe("VALIDATION_FAILED");
    expect(r.message).toMatch(/valid phone/i);
    await page.close();
  });

  it("operates dynamic React-style controls and fields that appear later", async () => {
    const ctx = baseCtx();
    const page = await browser.newPage();
    let r = await prepareApplication(page, opts("/ats/react-controls.html"), proposerFor(ctx));
    expect(byLabel(r, "Country")).toMatchObject({ control: "combobox", proposedValue: "United States", reviewState: "FILLED" });
    expect(r.questions.map((q) => q.label).sort()).toEqual(["I have read the job description", "Work preference"]);
    ctx.userAnswers["i-have-read-the-job-description:checkbox"] = "Yes";
    ctx.userAnswers["work-preference:select"] = "Hybrid";
    r = await prepareApplication(page, opts("/ats/react-controls.html"), proposerFor(ctx));
    expect(r.questions.map((q) => q.label)).toEqual(["Preferred office"]);
    expect(await page.locator("#ack").getAttribute("aria-checked")).toBe("true");
    await page.close();
  });

  it("pauses on every sensitive question without a stored rule", async () => {
    const page = await browser.newPage();
    const r = await prepareApplication(page, opts("/ats/sensitive.html"), proposerFor({ ...baseCtx(), eeoPolicy: "PREFER_NOT_TO_ANSWER" }));
    expect(r.outcome).toBe("NEEDS_INPUT");
    expect(r.category).toBe("SENSITIVE_ANSWER_REQUIRED");
    const pending = r.fields
      .filter((f) => f.reviewState === "SENSITIVE_PENDING")
      .map((f) => f.semanticType)
      .sort();
    expect(pending).toEqual(["compensation", "criminal_history", "signature", "sponsorship", "veteran", "work_authorization"]);
    expect(byLabel(r, "Race / Ethnicity")).toMatchObject({ proposedValue: "Decline to self-identify", reviewState: "FILLED" });
    await page.close();
  });

  it("pauses for CAPTCHA and login pages instead of bypassing them", async () => {
    const page = await browser.newPage();
    expect(await prepareApplication(page, opts("/ats/captcha.html"), proposerFor(baseCtx()))).toMatchObject({
      outcome: "PAUSED",
      category: "CAPTCHA_OR_BOT_CHECK",
    });
    expect(await prepareApplication(page, opts("/ats/login.html"), proposerFor(baseCtx()))).toMatchObject({ outcome: "PAUSED", category: "LOGIN_REQUIRED" });
    await page.close();
  });

  it("custom questions: no years claims, no unverified skills, AI drafts must cite facts", async () => {
    const ctx = baseCtx();
    const facts = new Map([["experiences[a].responsibilities[2]", "Standardized communication templates and processes to improve efficiency."]]);
    const proposer: Proposer = async (f) => {
      if (f.semanticType === "custom_free_response") {
        return acceptDraft(
          f,
          {
            answer: "I standardized communication templates and processes to improve efficiency.",
            claimKeys: ["experiences[a].responsibilities[2]"],
            confidence: 0.9,
            cannotAnswerReason: "",
          },
          new Set(facts.keys()),
          facts,
        );
      }
      return proposeValue(f, ctx);
    };
    const page = await browser.newPage();
    const r = await prepareApplication(page, opts("/ats/custom-questions.html"), proposer);
    expect(r.outcome).toBe("NEEDS_INPUT");
    expect(r.questions.map((q) => q.label).sort()).toEqual([
      "Do you have experience with Veeva Vault?",
      "German language proficiency",
      "How many years of experience do you have with Python?",
    ]);
    expect(byLabel(r, "Describe a process you improved.")).toMatchObject({ source: "ai-draft", reviewState: "FILLED" });
    await page.close();
  });

  it("blocks Enter-key and programmatic submits during preparation", async () => {
    const page = await browser.newPage();
    await prepareApplication(page, opts("/ats/single-page/apply.html"), proposerFor(baseCtx()));
    await page.locator("#email").press("Enter");
    await page.evaluate("document.getElementById('app').submit()");
    await page.waitForTimeout(500);
    expect(await page.evaluate("window.__cfBlockedSubmits")).toBeGreaterThanOrEqual(2);
    expect(server.submissions).toHaveLength(0);
    await page.close();
  });
});

describe("submission replay", () => {
  async function staged(p: string, ctx = baseCtx()) {
    const page = await browser.newPage();
    const r = await prepareApplication(page, opts(p), proposerFor(ctx));
    await page.close();
    const answers: Record<string, string> = {};
    const uploads: Record<string, { path: string; sha256: string }> = {};
    for (const f of r.fields) {
      if (f.reviewState !== "FILLED" || f.proposedValue === null) continue;
      if (f.control === "file") uploads[f.fieldKey] = { path: f.proposedValue, sha256: ctx.documents.resumeSha256! };
      else answers[f.fieldKey] = f.proposedValue;
    }
    return { r, answers, uploads };
  }

  it("submits the approved revision once and captures confirmation", async () => {
    const { answers, uploads } = await staged("/ats/single-page/apply.html");
    const page = await browser.newPage();
    const res = await submitRevision(page, { ...opts("/ats/single-page/apply.html"), confirmTimeoutMs: 5000 }, { answers, uploads });
    expect(res.result).toBe("SUBMITTED");
    expect(res.confirmationText).toMatch(/Thank you for applying/);
    expect(server.submissions).toHaveLength(1);
    expect(server.submissions[0]!.fields.first_name).toBe("Test");
    expect(server.submissions[0]!.files[0]!.sha256).toBe(uploads[Object.keys(uploads)[0]!]!.sha256);
    await page.close();
  });

  it("refuses when an upload changed after approval", async () => {
    const { answers, uploads } = await staged("/ats/single-page/apply.html");
    const key = Object.keys(uploads)[0]!;
    const page = await browser.newPage();
    const res = await submitRevision(page, opts("/ats/single-page/apply.html"), { answers, uploads: { [key]: { ...uploads[key]!, sha256: "0".repeat(64) } } });
    expect(res).toMatchObject({ result: "FAILED", errorCategory: "VALIDATION_FAILED" });
    expect(server.submissions).toHaveLength(0);
    await page.close();
  });

  it("refuses when the form gained a required field not in the revision", async () => {
    const { answers, uploads } = await staged("/ats/single-page/apply.html");
    delete answers["email:email"];
    const page = await browser.newPage();
    const res = await submitRevision(page, opts("/ats/single-page/apply.html"), { answers, uploads });
    expect(res.result).toBe("FAILED");
    expect(server.submissions).toHaveLength(0);
    await page.close();
  });

  it("an ambiguous response becomes UNCERTAIN (no retry)", async () => {
    const { answers, uploads } = await staged("/ats/ambiguous.html");
    const page = await browser.newPage();
    const res = await submitRevision(page, { ...opts("/ats/ambiguous.html"), confirmTimeoutMs: 3000 }, { answers, uploads });
    expect(res).toMatchObject({ result: "UNCERTAIN", errorCategory: "SUBMISSION_UNCERTAIN" });
    expect(server.submissions).toHaveLength(1);
    await page.close();
  });
});
