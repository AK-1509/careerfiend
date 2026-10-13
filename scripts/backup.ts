/**
 * Back up the Postgres database (pg_dump, custom format) and local generated
 * files into private/backups/<timestamp>/. Neon also keeps point-in-time
 * history (restore from the Neon console).
 *   npm run backup
 * Restore: pg_restore --clean --no-owner -d "$DATABASE_URL_DIRECT" careerfiend.dump
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "@careerfiend/shared";
import { bad, info, ok } from "./_common";

const config = loadConfig({ reload: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.join(config.paths.privateDir, "backups", stamp);
mkdirSync(dest, { recursive: true });
const url = config.DATABASE_URL_DIRECT ?? config.paths.databaseUrl;
if (/^postgres/.test(url)) {
  try {
    execFileSync("pg_dump", ["--format=custom", "--no-owner", "--file", path.join(dest, "careerfiend.dump"), url], { stdio: ["ignore", "ignore", "inherit"] });
    ok(`Database → ${dest}/careerfiend.dump`);
  } catch {
    bad("pg_dump failed or is not installed (brew install libpq / apt install postgresql-client). Neon's point-in-time restore still covers the database.");
  }
} else info("DATABASE_URL is not Postgres; nothing to dump.");
if (existsSync(config.paths.outputDir)) {
  cpSync(config.paths.outputDir, path.join(dest, "output"), { recursive: true });
  ok("Local copies of generated files copied (the database also stores them)");
}
console.log(`Backup complete: ${dest}\nThe encryption key is NOT in the backup; keep it (keychain, key file, or the Vercel env var).`);
