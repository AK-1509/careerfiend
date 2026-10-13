import { hkdfSync } from "node:crypto";
import path from "node:path";
import { closePglite, createDb, dropTenantSchema, type Db } from "@careerfiend/db";
import { NullProvider } from "@careerfiend/ai";
import type { Config } from "@careerfiend/shared";
import type { AppContext } from "./context";
import { loadLmProvider } from "./lm";

/**
 * Public edition: one tenant database per account. On Postgres a tenant is a
 * schema (`t_<id>`) in the same database, sharing one connection pool; with the
 * embedded database it is its own PGlite folder. Every service in this package
 * was written for one person's data, so it runs unchanged on a tenant context.
 */

export interface AccountRef {
  id: string;
  email: string;
  tenant: string;
}

export function tenantName(accountId: string): string {
  return `t_${accountId.replace(/[^a-z0-9_]/g, "")}`;
}

/** Database URL (and Postgres schema) of one tenant. */
export function tenantLocation(config: Config, tenant: string): { url: string; schema?: string; migrateUrl?: string } {
  const url = config.paths.databaseUrl;
  if (/^postgres(ql)?:\/\//.test(url)) return { url, schema: tenant, migrateUrl: config.DATABASE_URL_DIRECT ?? url };
  if (url === "pglite:memory" || url.startsWith("pglite:memory:")) return { url: `pglite:memory:${tenant}` };
  return { url: `pglite:${path.join(config.paths.dataDir, "tenants", tenant)}` };
}

const g = globalThis as unknown as { __cfTenantDbs?: Map<string, Db> };

/** Prisma client for one tenant (cached per process; migrations run before its first query). */
export function tenantDb(config: Config, tenant: string): Db {
  g.__cfTenantDbs ??= new Map();
  const loc = tenantLocation(config, tenant);
  const cacheKey = `${loc.url}#${loc.schema ?? ""}`;
  let db = g.__cfTenantDbs.get(cacheKey);
  if (!db) {
    db = createDb(loc.url, { schema: loc.schema, migrateUrl: loc.migrateUrl });
    g.__cfTenantDbs.set(cacheKey, db);
  }
  return db;
}

/** Remove a tenant's data entirely (account deletion). */
export async function dropTenant(config: Config, tenant: string): Promise<void> {
  const loc = tenantLocation(config, tenant);
  const cacheKey = `${loc.url}#${loc.schema ?? ""}`;
  const db = g.__cfTenantDbs?.get(cacheKey);
  g.__cfTenantDbs?.delete(cacheKey);
  if (loc.schema) {
    await db?.$disconnect().catch(() => undefined);
    await dropTenantSchema(loc.migrateUrl ?? loc.url, loc.schema);
    return;
  }
  await db?.$disconnect().catch(() => undefined);
  await closePglite(loc.url);
  if (!loc.url.startsWith("pglite:memory")) {
    const { rmSync } = await import("node:fs");
    rmSync(loc.url.slice("pglite:".length), { recursive: true, force: true });
  }
}

/** Each tenant's data is encrypted with its own key, derived from the server key. */
export function tenantKey(serverKey: Buffer, accountId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", serverKey, Buffer.from(accountId), Buffer.from("careerfiend-tenant-key-v1"), 32));
}

/**
 * A context for one account: its own database, encryption key, output folders,
 * GitHub user and the language model it connected (none until it connects one).
 */
export async function tenantContext(base: AppContext, account: AccountRef, opts: { db?: Db } = {}): Promise<AppContext> {
  const db = opts.db ?? tenantDb(base.config, account.tenant);
  let key: Buffer | undefined;
  const keyFn = () => (key ??= tenantKey(base.key(), account.id));
  const githubUser = (await db.setting.findUnique({ where: { key: "profile.githubUser" } }))?.value || undefined;
  const p = base.config.paths;
  const config: Config = {
    ...base.config,
    // Never fall back to an operator-wide GitHub user: only the person's own, or none.
    GITHUB_USER: githubUser ?? "none",
    paths: {
      ...p,
      outputDir: path.join(p.outputDir, account.tenant),
      browserProfileDir: path.join(p.browserProfileDir, account.tenant),
    },
  };
  const partial: AppContext = { ...base, db, config, key: keyFn, account, ai: new NullProvider() };
  partial.ai = await loadLmProvider(partial);
  return partial;
}
