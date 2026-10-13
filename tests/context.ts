import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { createLogger, loadConfig } from "@careerfiend/shared";
import { NullProvider, type AiProvider } from "@careerfiend/ai";
import { importAnswers, importInventory, loadInventoryFile } from "@careerfiend/profile";
import { openEphemeral, type BrowserSession } from "@careerfiend/form-engine";
import { createAppContext, type AppContext, type PageProvider } from "@careerfiend/core";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";
import { ANSWERS_TEMPLATE, KIT_INVENTORY, makeResumeRepo, readResumeSource, storeResume, tempDir, testDbAsync } from "./helpers";

process.env.CF_TEST_KEY ??= randomBytes(32).toString("base64");

export interface TestEnv {
  ctx: AppContext;
  server: FixtureServer;
  browser: BrowserSession;
  pages: PageProvider;
  resumeRepo: string;
  root: string;
  close(): Promise<void>;
}

export const ANSWERS = readFileSync(ANSWERS_TEMPLATE, "utf8")
  .replace("- Phone:", "- Phone: (213) 555-0100")
  .replace(/- Policy \(pick one:.*$/m, '- Policy (pick one: "Prefer not to answer" everywhere / ask me each time / my stored answers): Prefer not to answer');

export async function makeTestEnv(opts: { ai?: AiProvider; resumeRepo?: string } = {}): Promise<TestEnv> {
  const root = tempDir("cf-root-");
  const resumeRepo = opts.resumeRepo ?? makeResumeRepo().dir;
  const config = loadConfig({
    root,
    env: {
      APP_ENCRYPTION_KEY_SOURCE: "env:CF_TEST_KEY",
      ALLOW_LOCALHOST_TARGETS: "true",
      FORM_FILLING: "on",
      AI_PROVIDER: "none",
    },
  });
  const { db } = await testDbAsync();
  const lines: string[] = [];
  const ctx = createAppContext({
    db,
    config,
    ai: opts.ai ?? new NullProvider(),
    logger: createLogger({ sink: (l) => lines.push(l), level: "warn" }),
    fetchers: { ignoreRobots: true },
  });
  await storeResume(db, readResumeSource(resumeRepo));
  await importInventory(db, loadInventoryFile(KIT_INVENTORY));
  await importAnswers(db, ANSWERS, ctx.key());
  const server = await startFixtureServer(0);
  const browser = await openEphemeral(true);
  const open = new Map<string, Page>();
  const pages: PageProvider = {
    async page(id) {
      const existing = open.get(id);
      if (existing && !existing.isClosed()) return { page: existing, reused: true };
      const page = await browser.newPage();
      open.set(id, page);
      return { page, reused: false };
    },
    async release(id, keepOpen) {
      if (keepOpen) return;
      const p = open.get(id);
      open.delete(id);
      await p?.close().catch(() => undefined);
    },
  };
  return {
    ctx,
    server,
    browser,
    pages,
    resumeRepo,
    root,
    close: async () => {
      await browser.close();
      await server.close();
      await db.$disconnect();
    },
  };
}
