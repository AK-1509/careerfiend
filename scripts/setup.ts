/**
 * First-run setup for running CareerFiend yourself. Safe to run again.
 *   npm run setup
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "@careerfiend/shared";
import { bad, info, ok, ROOT, setEnvLocal } from "./_common";

console.log("CareerFiend setup");
const envLocal = path.join(ROOT, ".env.local");
if (!existsSync(envLocal)) {
  copyFileSync(path.join(ROOT, ".env.example"), envLocal);
  ok("Created .env.local from .env.example");
} else ok(".env.local exists");

let config = loadConfig({ reload: true });
if (!config.SESSION_SECRET) {
  setEnvLocal("SESSION_SECRET", randomBytes(32).toString("base64"));
  ok("Generated SESSION_SECRET (signs sign-in cookies)");
  config = loadConfig({ reload: true });
} else ok("SESSION_SECRET is set");

for (const dir of [config.paths.dataDir, config.paths.outputDir, config.paths.profileDir]) mkdirSync(dir, { recursive: true });
ok(`Private data folder: ${config.paths.privateDir}`);

try {
  execFileSync("git", ["-C", ROOT, "config", "core.hooksPath", ".githooks"]);
  ok("Git pre-commit hook enabled (blocks private/ files and secrets)");
} catch {
  info("Not a git checkout; skipped hook setup.");
}
try {
  execFileSync("git", ["-C", ROOT, "check-ignore", "-q", "private/"]);
  ok("private/ is gitignored");
} catch {
  bad("private/ is NOT gitignored. Fix .gitignore before committing anything.");
}

if (/^postgres/.test(config.paths.databaseUrl)) {
  info("Database: Postgres (DATABASE_URL). Create or update its tables with: npm run db:deploy");
} else {
  info(`Database: embedded, in ${config.paths.dataDir} (one folder per account). Fine for one computer; use Postgres to deploy.`);
}
info("Next: npm run build && npm run dashboard, then open http://127.0.0.1:3100 and create an account.");
