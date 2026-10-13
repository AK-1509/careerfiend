import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, migratePostgres, type Db } from "@careerfiend/db";
import { ingestResume, parseResumeSource, type ResumeSource } from "@careerfiend/profile";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const FIXTURE_RESUME = path.join(REPO_ROOT, "fixtures/resume/resume.json");
/** A synthetic skills inventory and checklist (candidates UNVERIFIED), paired with the fixture résumé. */
export const KIT_INVENTORY = path.join(REPO_ROOT, "fixtures/profile/skills-inventory.kit.json");
export const KIT_CHECKLIST = path.join(REPO_ROOT, "fixtures/profile/skills-to-confirm.kit.md");
export const ANSWERS_TEMPLATE = path.join(REPO_ROOT, "fixtures/profile/answers-later.template.md");

export function tempDir(prefix = "cf-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A fresh database with the schema applied: in-memory PGlite by default, or a
 * new database on a real server when TEST_PG_ADMIN_URL is set (use testDbAsync).
 */
export function testDb(): { db: Db } {
  return { db: createDb("pglite:memory") };
}

export async function testDbAsync(): Promise<{ db: Db; url: string }> {
  const admin = process.env.TEST_PG_ADMIN_URL;
  if (!admin) return { db: createDb("pglite:memory"), url: "pglite:memory" };
  const name = `cf_${randomBytes(6).toString("hex")}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const url = admin.replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
  await migratePostgres(url);
  return { db: createDb(url), url };
}

/**
 * A throwaway real Postgres server for tests that need two processes (the
 * dashboard end-to-end test). Uses TEST_DATABASE_URL when set; otherwise
 * starts a local server with initdb/pg_ctl if they are installed. Returns
 * null when neither is available.
 */
export async function tempPostgres(): Promise<{ url: string; stop(): void } | null> {
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, stop: () => undefined };
  const candidates = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin", "/opt/homebrew/bin", "/usr/local/bin"];
  const bin = candidates.find((d) => existsSync(path.join(d, "initdb")) && existsSync(path.join(d, "pg_ctl")));
  if (!bin) return null;
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const run = (cmd: string, args: string[]) =>
    asRoot
      ? execFileSync("runuser", ["-u", "postgres", "--", path.join(bin, cmd), ...args], { stdio: "ignore" })
      : execFileSync(path.join(bin, cmd), args, { stdio: "ignore" });
  const dir = mkdtempSync(path.join(os.tmpdir(), "cf-pg-"));
  if (asRoot) execFileSync("chown", ["postgres", dir]);
  const port = 55000 + Math.floor(Math.random() * 5000);
  run("initdb", ["-D", path.join(dir, "data"), "-U", "careerfiend", "--auth=trust", "-E", "UTF8"]);
  run("pg_ctl", ["-D", path.join(dir, "data"), "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, "-l", path.join(dir, "log"), "-w", "start"]);
  return {
    url: `postgresql://careerfiend@127.0.0.1:${port}/postgres`,
    stop: () => {
      try {
        run("pg_ctl", ["-D", path.join(dir, "data"), "-m", "fast", "stop"]);
      } catch {
        /* already stopped */
      }
    },
  };
}

/**
 * A throwaway folder holding content/resume.json and its version number: the
 * stand-in for the résumé a person saved (the public edition keeps it in the
 * database; `storeResume` puts it there).
 */
export function makeResumeRepo(json: string = readFileSync(FIXTURE_RESUME, "utf8")): { dir: string; commit: string } {
  const dir = tempDir("cf-resume-");
  mkdirSync(path.join(dir, "content"), { recursive: true });
  writeFileSync(path.join(dir, "content/resume.json"), json);
  writeFileSync(path.join(dir, "version"), "1");
  return { dir, commit: "v1" };
}

/** Save a new version of the résumé in a folder from makeResumeRepo. Returns its version ("v<N>"). */
export function commitResume(dir: string, json: string): string {
  writeFileSync(path.join(dir, "content/resume.json"), json);
  const n = Number(readFileSync(path.join(dir, "version"), "utf8")) + 1;
  writeFileSync(path.join(dir, "version"), String(n));
  return `v${n}`;
}

/** The résumé in a folder from makeResumeRepo, pinned at its version. */
export function readResumeSource(dir: string): ResumeSource {
  const n = Number(readFileSync(path.join(dir, "version"), "utf8"));
  return parseResumeSource({ repoPath: "profile", commit: `v${n}`, rawText: readFileSync(path.join(dir, "content/resume.json"), "utf8") });
}

/** Make `src` the stored, current résumé (what saving it on the Profile page does, minus the skills sync) and extract its facts. */
export async function storeResume(db: Db, src: ResumeSource): Promise<void> {
  const version = Number(src.commit.slice(1));
  await db.resumeDraft.upsert({
    where: { id: "me" },
    create: { id: "me", json: src.rawText, version, origin: "profile" },
    update: { json: src.rawText, version, origin: "profile" },
  });
  await ingestResume(db, src);
}

export function testKey(): Buffer {
  return randomBytes(32);
}

/** Dump every text column of every table (for "never appears anywhere" tests). */
export async function dumpDatabase(db: Db): Promise<string> {
  const tables = (await db.$queryRawUnsafe<{ name: string }[]>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'")).map(
    (t) => t.name,
  );
  const parts: string[] = [];
  for (const t of tables) parts.push(JSON.stringify(await db.$queryRawUnsafe(`SELECT * FROM "${t}"`), (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
  return parts.join("\n");
}
