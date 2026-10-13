/**
 * Generate the secrets a deployment needs (Vercel or any other host).
 *
 *   npm run hosted:env            # secrets only
 *   npm run hosted:env -- --all   # every variable the hosted mode needs
 *   npm run hosted:env -- --all --url https://your-app.vercel.app
 *
 * Writes private/vercel.env (gitignored, owner-only). In Vercel → Project →
 * Settings → Environment Variables, paste its contents (Vercel imports .env
 * text), then delete the file. APP_ENCRYPTION_KEY encrypts every account's
 * stored keys and answers: keep a copy somewhere safe, and never change it on a
 * deployment that has accounts (their encrypted data would become unreadable).
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadConfig } from "@careerfiend/shared";
import { info, ok } from "./_common";

const args = process.argv.slice(2);
const urlArg = args.includes("--url") ? args[args.indexOf("--url") + 1] : undefined;
const all = args.includes("--all");
const config = loadConfig();

const vars: [string, string][] = [
  ["APP_ENCRYPTION_KEY", randomBytes(32).toString("base64")],
  ["SESSION_SECRET", randomBytes(32).toString("base64")],
];
if (all) {
  vars.unshift(["CAREERFIEND_MODE", "hosted"], ["APP_ENCRYPTION_KEY_SOURCE", "env:APP_ENCRYPTION_KEY"]);
  vars.push(["SIGNUPS_OPEN", "true"], ["FORM_FILLING", "off"]);
  if (urlArg ?? config.PUBLIC_URL) vars.push(["PUBLIC_URL", (urlArg ?? config.PUBLIC_URL)!.replace(/\/$/, "")]);
}

const file = path.join(config.paths.privateDir, "vercel.env");
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, vars.map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
chmodSync(file, 0o600);
ok(`Wrote ${file} (${vars.length} variables: ${vars.map(([k]) => k).join(", ")})`);
info("DATABASE_URL comes from the Neon integration (Vercel → Storage), not from this file.");
info("Paste the file into Vercel → Settings → Environment Variables, redeploy, then delete the file (keep a safe copy of APP_ENCRYPTION_KEY).");
