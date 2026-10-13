import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { CareerFiendError } from "./errors";

/** Walk up from `start` to the monorepo root (the package.json with workspaces). */
export function findRepoRoot(start = process.cwd()): string {
  if (process.env.CAREERFIEND_ROOT) return path.resolve(process.env.CAREERFIEND_ROOT);
  let dir = path.resolve(start);
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; workspaces?: unknown };
        if (json.name === "careerfiend" && json.workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/** Minimal .env parser: KEY=VALUE, # comments, optional quotes. No interpolation. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const ConfigSchema = z.object({
  root: z.string(),
  /** Optional read-only token for api.github.com (raises the rate limit on shared hosting IPs). Sent only to api.github.com. */
  GITHUB_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Per account: the GitHub user whose public repositories back transferable skills (set on the Profile page; never from the environment in production). */
  GITHUB_USER: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Where all personal runtime data lives (gitignored). */
  PRIVATE_DIR: z.preprocess(emptyToUndefined, z.string().default("./private")),
  /**
   * postgres://… for a real Postgres (hosted: Neon pooled URL), or
   * pglite:<dir> / pglite:memory for embedded Postgres. Default: pglite:<PRIVATE_DIR>/data/pglite
   */
  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Non-pooled URL for migrations (Neon "unpooled"); falls back to DATABASE_URL. */
  DATABASE_URL_DIRECT: z.preprocess(emptyToUndefined, z.string().optional()),
  /** "local" (one computer: dashboard + worker), "hosted" (Vercel: dashboard and bounded worker runs, no local files). */
  CAREERFIEND_MODE: z.preprocess(emptyToUndefined, z.enum(["local", "hosted"]).default("local")),
  /** "true": anyone can create an account. "false": sign-up is closed (existing accounts still sign in). */
  SIGNUPS_OPEN: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")),
  /**
   * "off" (default): CareerFiend tailors the résumé and cover letter and you apply on the employer's site.
   * "on" (self-hosted only): the worker also fills the application form in a browser, as in the single-user edition.
   */
  FORM_FILLING: z.preprocess(emptyToUndefined, z.enum(["on", "off"]).default("off")),
  /** Largest résumé PDF accepted, in megabytes (Vercel caps request bodies at 4.5 MB). */
  MAX_UPLOAD_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(4.5).default(4)),
  /** Random secret that signs session cookies (32+ bytes, base64). Required. */
  SESSION_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Public origin of the dashboard, e.g. https://careerfiend.vercel.app (Gmail OAuth redirect). */
  PUBLIC_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  APP_ENCRYPTION_KEY_SOURCE: z.string().default("keychain"),
  /** The key itself (base64) when APP_ENCRYPTION_KEY_SOURCE=env:APP_ENCRYPTION_KEY; may live in .env.local. */
  APP_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  /** anthropic: Claude for everything. deepseek: DeepSeek, with Claude (if keyed) for the web-search research step. */
  AI_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["anthropic", "deepseek", "none"]).default("none")),
  AI_MODEL: z.preprocess(emptyToUndefined, z.string().default("claude-sonnet-5-5")),
  /** Cheaper Claude model for structured extraction steps (requirement and experience parsing); the main model does matching and writing. */
  AI_FAST_MODEL: z.preprocess(emptyToUndefined, z.string().default("claude-haiku-4-5")),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  DEEPSEEK_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  DEEPSEEK_MODEL: z.preprocess(emptyToUndefined, z.string().default("deepseek-chat")),
  DEEPSEEK_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default("https://api.deepseek.com")),
  /** Output token cap per DeepSeek request. */
  DEEPSEEK_MAX_TOKENS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8192)),
  GMAIL_OAUTH_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  GMAIL_OAUTH_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  PLAYWRIGHT_PROFILE_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  BROWSER_HEADLESS: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  RESUME_PAGE_LIMIT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(1)),
  DAILY_PREPARE_LIMIT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  BROWSER_CONCURRENCY: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(1)),
  /** When the worker may prepare applications, in DISPLAY_TIMEZONE. "00:00-00:00" = any time. */
  RUN_WINDOW: z.preprocess(emptyToUndefined, z.string().default("00:00-00:00")),
  END_OF_DAY: z.preprocess(emptyToUndefined, z.string().default("18:00")),
  DASHBOARD_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().default(3100)),
  ALLOW_LOCALHOST_TARGETS: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  /** Days to keep generated files for rejected/closed applications (0 = keep forever). */
  RETENTION_DAYS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).default(0)),
  EMAIL_POLL_MINUTES: z.preprocess(emptyToUndefined, z.coerce.number().int().min(5).default(30)),
  /** Longest pause between queue checks while the worker is idle (seconds). Over 300 lets Neon suspend. */
  WORKER_MAX_IDLE_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(2).default(60)),
  /** IANA time zone for dates shown in the dashboard (hosted servers run in UTC), e.g. America/Los_Angeles. */
  DISPLAY_TIMEZONE: z.preprocess(emptyToUndefined, z.string().optional()),
});
export type Config = z.infer<typeof ConfigSchema> & {
  /** Absolute paths derived from the config. */
  paths: {
    privateDir: string;
    dataDir: string;
    outputDir: string;
    profileDir: string;
    browserProfileDir: string;
    databaseUrl: string;
  };
};

let cached: Config | undefined;

export function loadConfig(opts: { root?: string; env?: Record<string, string | undefined>; reload?: boolean } = {}): Config {
  if (cached && !opts.reload && !opts.root && !opts.env) return cached;
  const root = opts.root ?? findRepoRoot();
  const fileEnv: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) {
    const p = path.join(/*turbopackIgnore: true*/ root, name);
    if (existsSync(p)) Object.assign(fileEnv, parseEnvFile(readFileSync(p, "utf8")));
  }
  const merged: Record<string, string | undefined> = { ...fileEnv, ...(opts.env ?? process.env), root };
  // Neon's Vercel integration names the direct URL DATABASE_URL_UNPOOLED.
  merged.DATABASE_URL_DIRECT ??= merged.DATABASE_URL_UNPOOLED;
  // On Vercel the production domain is provided at runtime.
  if (!merged.PUBLIC_URL && merged.VERCEL_PROJECT_PRODUCTION_URL) merged.PUBLIC_URL = `https://${merged.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (merged.CAREERFIEND_MODE === "hosted") {
    // A hosted dashboard has no persistent disk and no repo checkout to write to.
    if (!merged.PRIVATE_DIR) merged.PRIVATE_DIR = path.join(os.tmpdir(), "careerfiend");
  }
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new CareerFiendError(
      "FATAL_CONFIGURATION",
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const c = parsed.data;
  if (c.CAREERFIEND_MODE === "hosted" && !/^postgres(ql)?:\/\//.test(c.DATABASE_URL ?? "")) {
    throw new CareerFiendError("FATAL_CONFIGURATION", "CAREERFIEND_MODE=hosted needs DATABASE_URL set to a Postgres server (postgres://…).");
  }
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(/*turbopackIgnore: true*/ root, p));
  const privateDir = abs(c.PRIVATE_DIR);
  let dbUrl = c.DATABASE_URL ?? `pglite:${path.join(privateDir, "data", "pglite")}`;
  if (dbUrl.startsWith("pglite:") && dbUrl !== "pglite:memory") dbUrl = `pglite:${abs(dbUrl.slice(7))}`;
  const config: Config = {
    ...c,
    paths: {
      privateDir,
      dataDir: path.join(privateDir, "data"),
      outputDir: path.join(privateDir, "output"),
      profileDir: path.join(privateDir, "profile"),
      browserProfileDir: c.PLAYWRIGHT_PROFILE_DIR ? abs(c.PLAYWRIGHT_PROFILE_DIR) : path.join(privateDir, "browser-profile"),
      databaseUrl: dbUrl,
    },
  };
  if (!opts.root && !opts.env) cached = config;
  return config;
}

export function resetConfigCache(): void {
  cached = undefined;
}
