import { mkdirSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import pgPkg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaClient } from "../generated/client";
import { loadConfig } from "@careerfiend/shared";
import { MIGRATIONS } from "./migrations.generated";

export { PrismaClient };
export type * from "../generated/client";
export type Db = PrismaClient;
/** Interactive-transaction client type. */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** SQL of every migration, in order (embedded so a deployed dashboard can apply them). */
export function migrationSql(): { name: string; sql: string }[] {
  return MIGRATIONS;
}

/**
 * Apply migrations to an embedded PGlite database (tracked in _cf_migrations).
 * Real Postgres uses the same files and table through `migratePostgres`.
 */
export async function migratePglite(pg: PGlite): Promise<void> {
  await pg.exec(`CREATE TABLE IF NOT EXISTS "_cf_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" TIMESTAMP NOT NULL DEFAULT now())`);
  const done = new Set((await pg.query<{ name: string }>(`SELECT "name" FROM "_cf_migrations"`)).rows.map((r) => r.name));
  for (const m of migrationSql()) {
    if (done.has(m.name)) continue;
    await pg.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query(`INSERT INTO "_cf_migrations" ("name") VALUES ($1)`, [m.name]);
    });
  }
}

/** Postgres schema names this app creates: "t_" + lowercase letters/digits/underscores. */
export const TENANT_RE = /^t_[a-z0-9_]{6,60}$/;

/**
 * Apply pending migrations to a real Postgres (`npm run db:deploy`). Returns the names applied.
 * With `schema` (a tenant), the schema is created if needed and migrated on its own.
 */
export async function migratePostgres(url: string, schema?: string): Promise<string[]> {
  if (schema !== undefined && !TENANT_RE.test(schema)) throw new Error(`Invalid tenant schema name ${schema}`);
  const client = new pgPkg.Client({ connectionString: strictSsl(url) });
  await client.connect();
  const applied: string[] = [];
  // One migrator per schema at a time (several serverless instances or a worker may start together).
  const lockId = schema ? `hashtext('cf:${schema}')` : "727274";
  try {
    await client.query(`SELECT pg_advisory_lock(${lockId})`);
    if (schema) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS "_cf_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" TIMESTAMP NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>(`SELECT "name" FROM "_cf_migrations"`)).rows.map((r) => r.name));
    for (const m of migrationSql()) {
      if (done.has(m.name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(`INSERT INTO "_cf_migrations" ("name") VALUES ($1)`, [m.name]);
        await client.query("COMMIT");
        applied.push(m.name);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${lockId})`).catch(() => undefined);
    await client.end();
  }
  return applied;
}

/** Drop a tenant's schema and everything in it (account deletion). */
export async function dropTenantSchema(url: string, schema: string): Promise<void> {
  if (!TENANT_RE.test(schema)) throw new Error(`Invalid tenant schema name ${schema}`);
  const client = new pgPkg.Client({ connectionString: strictSsl(url) });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

type AdapterFactory = ConstructorParameters<typeof PrismaClient>[0] extends infer O ? (O extends { adapter?: infer A } ? NonNullable<A> : never) : never;

/** pg already treats sslmode=require as verify-full; say so explicitly (keeps behavior, silences its warning). */
function strictSsl(url: string): string {
  return url.replace(/([?&])sslmode=(prefer|require|verify-ca)(?=&|$)/, "$1sslmode=verify-full");
}

/** A promise-like that starts `fn` on first await (so creating a client does no I/O). */
function lazy(fn: () => Promise<void>): PromiseLike<void> {
  let p: Promise<void> | undefined;
  const start = () =>
    fn().catch((err) => {
      p = undefined; // retry on the next query (e.g. the database was briefly unreachable)
      throw err;
    });
  return { then: (a, b) => (p ??= start()).then(a, b) };
}

/** Wrap an adapter factory so `ready` resolves before the first connection. */
function afterReady(inner: AdapterFactory, ready: PromiseLike<void>): AdapterFactory {
  return new Proxy(inner as object, {
    get(target, prop, receiver) {
      if (prop === "connect") {
        return async () => {
          await ready;
          return (target as { connect(): Promise<unknown> }).connect();
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as AdapterFactory;
}

const pgliteInstances = new Map<string, PGlite>();
const pgPools = new Map<string, pgPkg.Pool>();

/** One connection pool per database URL, shared by every tenant on it (so tenants do not multiply connections). */
function sharedPool(url: string): pgPkg.Pool {
  let pool = pgPools.get(url);
  if (!pool) {
    pool = new pgPkg.Pool({ connectionString: strictSsl(url), max: Number(process.env.DATABASE_POOL_MAX ?? 5) });
    pgPools.set(url, pool);
  }
  return pool;
}

/**
 * Create a Prisma client for a database URL:
 *   postgres://… / postgresql://…  real Postgres (hosted: Neon pooled URL)
 *   pglite:memory                  embedded, in memory (tests); pglite:memory:<name> is one shared named instance
 *   pglite:/abs/dir                embedded, on disk (local mode without a server)
 * `schema` (Postgres only) puts every table in that schema: one tenant of the public edition.
 */
export function createDb(url: string, opts: { migrateUrl?: string; schema?: string } = {}): PrismaClient {
  if (/^postgres(ql)?:\/\//.test(url)) {
    if (opts.schema !== undefined && !TENANT_RE.test(opts.schema)) throw new Error(`Invalid tenant schema name ${opts.schema}`);
    const adapter = opts.schema ? new PrismaPg(sharedPool(url), { schema: opts.schema }) : new PrismaPg(sharedPool(url));
    if (!opts.migrateUrl) return new PrismaClient({ adapter });
    // Apply pending migrations before the first query (idempotent; the direct URL avoids the pooler for DDL).
    const ready = lazy(() => migratePostgres(opts.migrateUrl!, opts.schema).then(() => undefined));
    return new PrismaClient({ adapter: afterReady(adapter as unknown as AdapterFactory, ready) });
  }
  if (url.startsWith("pglite:")) {
    const where = url.slice("pglite:".length);
    const ephemeral = where === "memory";
    let pg = ephemeral ? undefined : pgliteInstances.get(where);
    if (!pg) {
      const inMemory = where === "memory" || where.startsWith("memory:");
      if (!inMemory) mkdirSync(where, { recursive: true });
      pg = inMemory ? new PGlite() : new PGlite(where);
      if (!ephemeral) pgliteInstances.set(where, pg);
    }
    const ready = migratePglite(pg);
    // The adapter is typed against an older PGlite; the runtime API it uses is unchanged (covered by tests).
    const adapter = new PrismaPGlite(pg as unknown as ConstructorParameters<typeof PrismaPGlite>[0]);
    return new PrismaClient({ adapter: afterReady(adapter as unknown as AdapterFactory, ready) });
  }
  throw new Error(`Unsupported DATABASE_URL: use postgres://… or pglite:<dir> (got ${url.split(":")[0]}:)`);
}

/**
 * Close and forget an embedded tenant database (account deletion). Postgres
 * tenants are removed with `dropTenantSchema`.
 */
export async function closePglite(url: string): Promise<void> {
  const where = url.slice("pglite:".length);
  const pg = pgliteInstances.get(where);
  pgliteInstances.delete(where);
  await pg?.close().catch(() => undefined);
}

const globalForDb = globalThis as unknown as { __careerfiendDb?: PrismaClient };

/** Process-wide client for the configured database (public edition: the shared accounts database). */
export function getDb(): PrismaClient {
  if (!globalForDb.__careerfiendDb) {
    const c = loadConfig();
    // Worker, dashboard and scripts bring the schema up to date themselves; `npm run db:deploy` does the same by hand.
    globalForDb.__careerfiendDb = createDb(c.paths.databaseUrl, { migrateUrl: c.DATABASE_URL_DIRECT ?? c.paths.databaseUrl });
  }
  return globalForDb.__careerfiendDb;
}

/* ---- JSON column helpers (JSON is stored as text) ------------------------ */

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
