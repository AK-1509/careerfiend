import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";
import { parseEnvFile } from "@careerfiend/shared";

// Only `prisma migrate diff` / studio need a URL; `prisma generate` (postinstall, Vercel builds) must work without one.
const root = path.resolve(import.meta.dirname, "../..");
const env: Record<string, string | undefined> = {};
for (const name of [".env", ".env.local"]) {
  const p = path.join(root, name);
  if (existsSync(p)) Object.assign(env, parseEnvFile(readFileSync(p, "utf8")));
}
Object.assign(env, process.env);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env.DATABASE_URL_DIRECT ?? env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL ?? "" },
});
