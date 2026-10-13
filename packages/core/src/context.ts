import { createDb, getDb, type Db } from "@careerfiend/db";
import { createProvider, type AiProvider } from "@careerfiend/ai";
import { createLogger, loadConfig, resolveKey, type Config, type Logger } from "@careerfiend/shared";
import type { AtsBases, Fetcher, HtmlFetcher } from "@careerfiend/job-parser";

/**
 * Everything a service needs. The base context is created once per process
 * (dashboard, worker, scripts) and points at the shared accounts database; each
 * request or worker run uses a tenant context (`tenantContext`) for one account.
 */
export interface AppContext {
  db: Db;
  config: Config;
  logger: Logger;
  ai: AiProvider;
  /** At-rest encryption key (lazy: resolved on first use). */
  key(): Buffer;
  now(): Date;
  /** Public edition: the signed-in account whose tenant database `db` is (absent for the shared accounts context). */
  account?: { id: string; email: string; tenant: string };
  /** Injection points for tests and the fixture demo. */
  fetchers?: { html?: HtmlFetcher; json?: Fetcher; atsBases?: AtsBases; ignoreRobots?: boolean; github?: Fetcher };
}

export function createAppContext(overrides: Partial<AppContext> & { dbFile?: string } = {}): AppContext {
  const config = overrides.config ?? loadConfig();
  const logger = overrides.logger ?? createLogger();
  const db = overrides.db ?? (overrides.dbFile ? createDb(overrides.dbFile) : getDb());
  let key: Buffer | undefined;
  return {
    db,
    config,
    logger,
    ai: overrides.ai ?? createProvider(config, logger),
    key:
      overrides.key ??
      (() =>
        (key ??= resolveKey(config.APP_ENCRYPTION_KEY_SOURCE, config.root, {
          ...process.env,
          APP_ENCRYPTION_KEY: config.APP_ENCRYPTION_KEY ?? process.env.APP_ENCRYPTION_KEY,
        }))),
    now: overrides.now ?? (() => new Date()),
    fetchers: overrides.fetchers,
  };
}
