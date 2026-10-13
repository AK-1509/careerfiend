import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "@careerfiend/shared";

export const ROOT = findRepoRoot();

export function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}
export function bad(msg: string) {
  console.log(`  ✗ ${msg}`);
}
export function info(msg: string) {
  console.log(`  • ${msg}`);
}

/** Set KEY=value in .env.local, keeping everything else as written. */
export function setEnvLocal(key: string, value: string): void {
  const file = path.join(ROOT, ".env.local");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(file, re.test(text) ? text.replace(re, () => `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`);
}
