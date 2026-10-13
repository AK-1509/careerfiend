/**
 * Create or upgrade the tables in the Postgres database (DATABASE_URL_DIRECT,
 * else DATABASE_URL): the shared accounts schema, then every account's own
 * schema. Safe to run repeatedly. (Each schema also upgrades itself before its
 * first query, so this is only needed to upgrade everything at once.)
 *   npm run db:deploy
 */
import pgPkg from "pg";
import { migratePostgres, TENANT_RE } from "@careerfiend/db";
import { loadConfig } from "@careerfiend/shared";
import { bad, info, ok } from "./_common";

const config = loadConfig({ reload: true });
const url = config.DATABASE_URL_DIRECT ?? config.DATABASE_URL;
if (!url || !/^postgres/.test(url)) {
  bad("Set DATABASE_URL (and DATABASE_URL_DIRECT / DATABASE_URL_UNPOOLED for Neon) in .env.local first.");
  process.exit(1);
}
const applied = await migratePostgres(url);
ok(applied.length ? `Accounts schema: applied ${applied.join(", ")}` : "Accounts schema is up to date");

const client = new pgPkg.Client({ connectionString: url });
await client.connect();
const tenants = (await client.query<{ tenant: string }>(`SELECT "tenant" FROM "Account" ORDER BY "createdAt"`)).rows.map((r) => r.tenant);
await client.end();
let upgraded = 0;
for (const t of tenants) {
  if (!TENANT_RE.test(t)) continue;
  if ((await migratePostgres(url, t)).length) upgraded++;
}
info(`${tenants.length} account schema${tenants.length === 1 ? "" : "s"} checked, ${upgraded} upgraded.`);
