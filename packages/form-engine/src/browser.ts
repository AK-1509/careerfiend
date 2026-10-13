import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * Browser sessions. A worker on your computer uses a visible persistent
 * Chromium profile (private/browser-profile) so logins survive restarts and
 * you can take over. The hosted worker uses a headless serverless Chromium.
 * Tests use a headless throwaway context.
 */

export interface BrowserSession {
  context: BrowserContext;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

export async function openPersistent(profileDir: string, headless: boolean): Promise<BrowserSession> {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
  });
  return { context, newPage: () => context.newPage(), close: () => context.close() };
}

export async function openEphemeral(headless = true): Promise<BrowserSession & { browser: Browser }> {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return {
    browser,
    context,
    newPage: () => context.newPage(),
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

/**
 * Desktop app: a headless browser the computer already has (Microsoft Edge is
 * on every Windows computer; Chrome on most others), else Playwright's own
 * Chromium if it was installed. Throws when none can start; callers then fall
 * back to plain HTTP reading.
 */
export async function openSystemBrowser(): Promise<BrowserSession & { browser: Browser }> {
  const attempts: { channel?: string }[] = [{ channel: "msedge" }, { channel: "chrome" }, {}];
  let last: unknown;
  for (const a of attempts) {
    try {
      const browser = await chromium.launch({ headless: true, ...a });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      return {
        browser,
        context,
        newPage: () => context.newPage(),
        close: async () => {
          await context.close();
          await browser.close();
        },
      };
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`No browser could be started (tried Microsoft Edge, Google Chrome and Playwright's Chromium): ${(last as Error)?.message ?? last}`);
}

/**
 * Headless Chromium for serverless functions (Vercel): the @sparticuz/chromium
 * build, unpacked to /tmp on first use. Loaded lazily so nothing else pays for it.
 */
export async function openServerless(): Promise<BrowserSession & { browser: Browser }> {
  const { default: Chromium } = await import("@sparticuz/chromium");
  const browser = await chromium.launch({ executablePath: await Chromium.executablePath(), args: Chromium.args, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return {
    browser,
    context,
    newPage: () => context.newPage(),
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

/** Render a URL and return its HTML (for listings that need JavaScript). */
export async function renderHtml(session: BrowserSession, url: string): Promise<{ html: string; finalUrl: string; status: number }> {
  const page = await session.newPage();
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(800);
    return { html: await page.content(), finalUrl: page.url(), status: res?.status() ?? 0 };
  } finally {
    await page.close();
  }
}
