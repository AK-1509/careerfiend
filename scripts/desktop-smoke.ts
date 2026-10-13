/**
 * Smoke test of the desktop app's server, exactly as the app runs it: the
 * staged standalone server (apps/desktop/server, from `npm run desktop:server`),
 * unpacked the way the app unpacks it, in desktop mode, with an embedded database in a temporary data folder and the
 * worker running inside the same process. It signs up, uploads a résumé PDF,
 * skips the model, pastes a job link (local fixture site) and waits until the
 * tailored application and its form answers are ready.
 *
 *   npm run desktop:smoke     (CI runs it on Windows, macOS and Linux before packaging)
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { startFixtureServer } from "../fixtures/server";

const root = path.resolve(import.meta.dirname, "..");
const staged = path.join(root, "apps", "desktop", "server");
if (!existsSync(path.join(staged, "STAGED"))) throw new Error("Run npm run desktop:server first.");
// Unpack it the way the app does on first launch.
const { unpackServer } = createRequire(import.meta.url)("../apps/desktop/unpack.cjs") as { unpackServer(src: string, dest: string): string };

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const pdf = (file: string) =>
  new Promise<void>((resolve) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => {
      writeFileSync(file, Buffer.concat(chunks));
      resolve();
    });
    doc.font("Helvetica-Bold").fontSize(18).text("Sam Lee");
    doc.font("Helvetica").fontSize(10).text("Quality specialist");
    doc.text("Los Angeles, CA | sam.lee@example.com");
    doc.moveDown().font("Helvetica-Bold").fontSize(12).text("EXPERIENCE");
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Quality Associate", { continued: true })
      .font("Helvetica")
      .text("     Jun 2023 – Present", { align: "right" });
    doc.text("Acme Bio, San Diego, CA");
    doc.text("• Reviewed batch records for 12 batches under GMP");
    doc.moveDown().font("Helvetica-Bold").fontSize(12).text("SKILLS");
    doc.font("Helvetica").fontSize(10).text("GMP, Quality Assurance");
    doc.end();
  });

const data = mkdtempSync(path.join(os.tmpdir(), "cf-desktop-"));
const serverDir = unpackServer(staged, path.join(data, "server"));
const serverJs = path.join(serverDir, "apps", "dashboard", "server.js");
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const fixtures = await startFixtureServer(0);
const server = spawn(process.execPath, [serverJs], {
  cwd: path.dirname(serverJs),
  env: {
    ...process.env,
    NODE_ENV: "production",
    CAREERFIEND_MODE: "desktop",
    CAREERFIEND_ROOT: serverDir,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    PUBLIC_URL: url,
    PRIVATE_DIR: path.join(data, "data"),
    APP_ENCRYPTION_KEY_SOURCE: path.join(data, "secret.key"),
    SESSION_SECRET: randomBytes(32).toString("base64"),
    ALLOW_LOCALHOST_TARGETS: "true",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const step = (msg: string) => console.log(`  ✓ ${msg}`);
let failed = false;
const browser = await chromium.launch();
try {
  const until = Date.now() + 60_000;
  for (;;) {
    const ok = await fetch(`${url}/api/health`)
      .then((r) => r.status === 200)
      .catch(() => false);
    if (ok) break;
    if (Date.now() > until || server.exitCode !== null) throw new Error("The server did not start.");
    await new Promise((r) => setTimeout(r, 500));
  }
  step("server started in desktop mode");

  const page = await browser.newPage();
  await page.goto(`${url}/login?mode=signup`);
  await page.fill("#su-email", "sam@example.com");
  await page.fill("#su-password", "a long enough password");
  await page.fill("#su-confirm", "a long enough password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\?welcome=1$/);
  step("account created");

  const file = path.join(data, "resume.pdf");
  await pdf(file);
  await page.setInputFiles("#resume-onb", file);
  await page.getByRole("button", { name: "Upload and read" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /Résumé read/ })
    .waitFor();
  step("résumé PDF read");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /Skipped/ })
    .waitFor();
  step("model skipped");

  await page.fill("#urls", `${fixtures.url}/listings/senior-title-entry-description.html`);
  await page.getByRole("button", { name: "Queue" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /1 link queued/ })
    .waitFor();
  const deadline = Date.now() + 180_000;
  for (;;) {
    await page.goto(url);
    if (await page.getByRole("link", { name: /Beacon Biologics/ }).count()) break;
    if (Date.now() > deadline) throw new Error("The in-app worker did not prepare the application in time.");
    await new Promise((r) => setTimeout(r, 2000));
  }
  step("the in-app worker read the listing and tailored the documents");
  await page
    .getByRole("link", { name: /Beacon Biologics/ })
    .first()
    .click();
  await page.getByRole("heading", { name: "Ready to apply" }).waitFor();
  await page.getByRole("heading", { name: "Answers for the application form" }).waitFor();
  if (!(await page.locator(".answer-text", { hasText: "sam.lee@example.com" }).count())) throw new Error("The answer sheet is missing the email answer.");
  step("application ready with its form answers");
  if (fixtures.submissions.length) throw new Error("Something was submitted.");
  console.log("Desktop smoke test passed.");
} catch (err) {
  failed = true;
  console.error(`Desktop smoke test FAILED: ${(err as Error).message}\n--- server log ---\n${log.slice(-6000)}`);
} finally {
  await browser.close();
  server.kill();
  await fixtures.close();
  try {
    rmSync(data, { recursive: true, force: true });
  } catch {
    /* Windows may still hold the database files for a moment */
  }
}
process.exit(failed ? 1 : 0);
