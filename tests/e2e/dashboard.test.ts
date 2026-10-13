/**
 * Drives the real dashboard (production build) in a browser, the way a member
 * of the public uses it: sign up, upload a résumé PDF, connect a model or skip,
 * paste application links (LinkedIn/Indeed refused with directions), get the
 * tailored documents, mark it applied. Also: accounts never see each other's
 * data, every page has one h1 and labelled controls, and an account can delete
 * itself.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createDb, type Db } from "@careerfiend/db";
import { createLogger, loadConfig } from "@careerfiend/shared";
import { NullProvider } from "@careerfiend/ai";
import { createAppContext, type AppContext } from "@careerfiend/core";
import { runAllTenants } from "@careerfiend/worker";
import { startFixtureServer, type FixtureServer } from "../../fixtures/server";
import { REPO_ROOT, tempDir, tempPostgres } from "../helpers";

process.env.CF_TEST_KEY ??= randomBytes(32).toString("base64");

const DASH = path.join(REPO_ROOT, "apps/dashboard");
const PASSWORD = "e2e password 123";
let server: FixtureServer;
let next: ChildProcess;
let browser: Browser;
let alice: BrowserContext;
let db: Db;
let base: AppContext;
let url: string;
let pdfPath: string;
let appPath: string;

async function waitFor(u: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(u)).status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Dashboard did not start at ${u}`);
}

async function unlabeledControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("input:not([type=hidden]), select, textarea"))
      .filter((el) => {
        const e = el as HTMLInputElement;
        return !(e.labels && e.labels.length) && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby");
      })
      .map((el) => el.outerHTML.slice(0, 80)),
  );
}

function writeResumePdf(file: string): Promise<void> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => {
      writeFileSync(file, Buffer.concat(chunks));
      resolve();
    });
    doc.font("Helvetica-Bold").fontSize(18).text("Alex Morgan");
    doc.font("Helvetica").fontSize(10).text("Quality specialist in regulated manufacturing");
    doc.text("Los Angeles, CA | alex.morgan@example.com");
    doc.moveDown().font("Helvetica-Bold").fontSize(12).text("EXPERIENCE");
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Quality Associate", { continued: true })
      .font("Helvetica")
      .text("     Jun 2023 – Present", { align: "right" });
    doc.text("Acme Bio, San Diego, CA");
    doc.text("• Reviewed batch records for 12 batches under GMP and closed every deviation on time");
    doc.text("• Wrote SOPs for clinical manufacturing quality checks");
    doc.moveDown().font("Helvetica-Bold").fontSize(12).text("EDUCATION");
    doc.font("Helvetica-Bold").fontSize(10).text("State University");
    doc.font("Helvetica").text("B.S. in Biology          2019 – 2023");
    doc.moveDown().font("Helvetica-Bold").fontSize(12).text("SKILLS");
    doc.font("Helvetica").fontSize(10).text("GMP, Quality Assurance, SOP writing");
    doc.end();
  });
}

async function signUp(ctx: BrowserContext, email: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${url}/login?mode=signup`);
  await page.fill("#su-email", email);
  await page.fill("#su-password", PASSWORD);
  await page.fill("#su-confirm", PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/\?welcome=1$/);
  return page;
}

// The dashboard runs as a separate process, so both sides need a real Postgres
// server (embedded PGlite is single-process).
const pgServer = await tempPostgres();
const hasPg = pgServer !== null;
if (!hasPg) console.warn("dashboard e2e skipped: no Postgres (set TEST_DATABASE_URL or install postgresql)");

beforeAll(async () => {
  if (!hasPg) return;
  const databaseUrl = pgServer!.url;
  if (!existsSync(path.join(DASH, ".next", "BUILD_ID"))) {
    execFileSync("npx", ["next", "build"], { cwd: DASH, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  }
  const env = {
    PRIVATE_DIR: tempDir("cf-dash-"),
    APP_ENCRYPTION_KEY_SOURCE: "env:CF_TEST_KEY",
    CF_TEST_KEY: process.env.CF_TEST_KEY!,
    ALLOW_LOCALHOST_TARGETS: "true",
    BROWSER_HEADLESS: "true",
    AI_PROVIDER: "none",
    GMAIL_OAUTH_CLIENT_ID: "",
    GMAIL_OAUTH_CLIENT_SECRET: "",
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: Buffer.alloc(32, 3).toString("base64"),
    FORM_FILLING: "off",
  };
  const config = loadConfig({ root: REPO_ROOT, env });
  db = createDb(config.paths.databaseUrl, { migrateUrl: databaseUrl }); // fresh server: tables are created on first use
  base = createAppContext({ db, config, ai: new NullProvider(), logger: createLogger({ level: "error" }), fetchers: { ignoreRobots: true } });
  server = await startFixtureServer(0);
  pdfPath = path.join(tempDir("cf-pdf-"), "Alex Morgan resume.pdf");
  await writeResumePdf(pdfPath);

  const port = 3900 + Math.floor(Math.random() * 90);
  url = `http://127.0.0.1:${port}`;
  next = spawn(process.execPath, [path.join(REPO_ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: DASH,
    env: { ...process.env, ...env, DASHBOARD_PORT: String(port), NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stderr?.on("data", (d) => process.stderr.write(`[next] ${d}`));
  await waitFor(`${url}/api/health`, 60_000);
  browser = await chromium.launch();
  alice = await browser.newContext();
}, 300_000);

afterAll(async () => {
  await browser?.close();
  next?.kill("SIGTERM");
  await server?.close();
  await db?.$disconnect();
  pgServer?.stop();
});

describe.skipIf(!hasPg)("public dashboard", () => {
  it("needs an account: pages redirect to sign-in, files and APIs answer 401", async () => {
    const res = await fetch(`${url}/tracker`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/login\?next=%2Ftracker$/);
    expect((await fetch(`${url}/api/files?app=app_1&path=x`)).status).toBe(401);
    expect((await fetch(`${url}/api/resume?id=upl_1`)).status).toBe(401);
    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, login: true, signups: true, encryptionKey: true, database: true, formFilling: "off" });
    const page = await alice.newPage();
    await page.goto(`${url}/`);
    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
    expect(await page.getByText("LinkedIn and Indeed links don't work").count()).toBeGreaterThan(0);
    expect(await unlabeledControls(page)).toEqual([]);
    await page.close();
  });

  it("sign up, then the first-run steps: upload a résumé PDF, connect a model or skip", async () => {
    const page = await signUp(alice, "alice@example.com");
    expect(await page.getByRole("heading", { name: "Get started" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Skip for now" }).count()).toBe(1);
    expect(await page.getByLabel("Provider").first().locator("option").allInnerTexts()).toEqual(
      expect.arrayContaining(["Anthropic (Claude)", "OpenAI", "Google Gemini", "OpenRouter (many models)"]),
    );
    expect(await unlabeledControls(page)).toEqual([]);
    const cookie = (await alice.cookies()).find((c) => c.name === "cf_session");
    expect(cookie?.httpOnly).toBe(true);

    await page.setInputFiles("#resume-onb", pdfPath);
    await page.getByRole("button", { name: "Upload and read" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: /Résumé read with the built-in reader/ })
      .waitFor();

    await page.getByRole("button", { name: "Skip for now" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: /Skipped/ })
      .waitFor();
    expect(await page.getByRole("heading", { name: "Get started" }).count()).toBe(0);
    await page.close();
  });

  it("the Profile page shows what was read from the PDF and saves edits as a new version", async () => {
    const page = await alice.newPage();
    await page.goto(`${url}/profile`);
    expect(await page.locator("#p-name").inputValue()).toBe("Alex Morgan");
    expect(await page.getByText("Quality Associate").count()).toBeGreaterThan(0);
    expect(await unlabeledControls(page)).toEqual([]);
    await page.getByText("Add to projects").click();
    await page.fill("#new-project-title", "Deviation Tracker");
    await page.fill("#new-project-bullets", "Built a spreadsheet that tracks every open deviation by due date");
    await page
      .locator("form", { has: page.locator("#new-project-title") })
      .getByRole("button", { name: "Add" })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: /Saved \(version 2\)/ })
      .waitFor();
    expect(await page.getByText("Deviation Tracker").count()).toBeGreaterThan(0);
    await page.close();
  });

  it("refuses LinkedIn and Indeed links with directions, tailors documents for an application link, then tracks it", async () => {
    const page = await alice.newPage();
    await page.goto(url);
    await page.fill("#urls", "https://www.linkedin.com/jobs/view/4123456789/\nhttps://www.indeed.com/viewjob?jk=abc");
    await page.getByRole("button", { name: "Queue" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: /0 links queued.*LinkedIn and Indeed links don't work.*employer's application page.*send that link instead/ })
      .waitFor();

    await page.fill("#urls", `${server.url}/listings/senior-title-entry-description.html`);
    await page.getByRole("button", { name: "Queue" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: /1 link queued/ })
      .waitFor();

    // The worker runs every account's queue (here in-process, against the same database).
    for (let i = 0; i < 4; i++) {
      const r = await runAllTenants(base, 270_000, { serverless: false });
      if (!r.more) break;
    }
    await page.goto(url);
    const link = page.getByRole("link", { name: /Beacon Biologics/ }).first();
    await link.waitFor();
    appPath = (await link.getAttribute("href"))!;
    await link.click();
    await page.getByRole("heading", { name: "Ready to apply" }).waitFor();
    expect(await unlabeledControls(page)).toEqual([]);
    // Answers for the form, read without filling it, ready to copy.
    await page.getByRole("heading", { name: "Answers for the application form" }).waitFor();
    expect(await page.locator(".answer-text", { hasText: "alex.morgan@example.com" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: /^Copy answer: Email address/ }).count()).toBe(1);
    expect(await page.getByText("Why are you interested in this role?").count()).toBeGreaterThan(0);
    await page.fill("#ask-q", "What is your favorite quality tool?");
    await page.getByRole("button", { name: "Get an answer" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: /Question added/ })
      .waitFor();
    expect(await page.getByText("What is your favorite quality tool?").count()).toBe(1);
    const pdfLink = page.getByRole("link", { name: "PDF" }).first();
    const res = await alice.request.get(`${url}${await pdfLink.getAttribute("href")}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/pdf");

    await page.goto(`${url}${appPath}`);
    await page.getByRole("button", { name: /I applied/ }).click();
    await page.waitForURL(/msg=/);
    expect(await page.locator("h1 .badge").innerText()).toBe("Submitted");
    expect(server.submissions).toHaveLength(0); // CareerFiend never submitted anything itself
    await page.close();
  });

  it("another account sees none of it", async () => {
    const bob = await browser.newContext();
    const page = await signUp(bob, "bob@example.com");
    expect(await page.getByRole("heading", { name: "Get started" }).count()).toBe(1); // no résumé yet
    expect(await page.getByRole("link", { name: /Beacon Biologics/ }).count()).toBe(0);
    expect((await page.goto(`${url}${appPath}`))?.status()).toBe(404);
    const appId = /applications\/(app_[a-f0-9]+)/.exec(appPath)![1];
    expect((await bob.request.get(`${url}/api/files?app=${appId}&path=${appId}/r1/resume.pdf`)).status()).toBe(404);
    await page.goto(`${url}/profile`);
    expect(await page.getByText("Alex Morgan").count()).toBe(0);
    await bob.close();
  });

  it("every page renders with one h1 and labelled controls", async () => {
    const page = await alice.newPage();
    for (const p of ["/", "/tracker", "/tracker?bucket=submitted", "/jobs", "/skills", "/bank", "/profile", "/watchlist", "/projects", "/settings"]) {
      const res = await page.goto(`${url}${p}`);
      expect(res?.status(), p).toBe(200);
      expect(await page.locator("h1").count(), p).toBe(1);
      expect(await unlabeledControls(page), p).toEqual([]);
    }
    // Without a model, Project Recommendations ask for one.
    await page.goto(`${url}/projects`);
    expect(await page.getByRole("heading", { name: /Connect a language model/ }).count()).toBe(1);
    await page.close();
  });

  it("an account can delete itself and everything in it", async () => {
    const page = await alice.newPage();
    await page.goto(`${url}/settings`);
    await page.fill("#del-pw", PASSWORD);
    await page.fill("#del-confirm", "DELETE");
    await page.getByRole("button", { name: "Delete my account" }).click();
    await page.waitForURL(/\/login\?msg=/);
    expect(await db.account.count({ where: { email: "alice@example.com" } })).toBe(0);
    await page.goto(`${url}/login`);
    await page.fill("#li-email", "alice@example.com");
    await page.fill("#li-password", PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Wrong email or password.").waitFor();
    await page.close();
  });
});
