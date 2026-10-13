import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "@careerfiend/shared";
import type { AppContext } from "./context";

/**
 * Generated files (documents, screenshots, manifests) live in two places: the
 * worker's output folder and the StoredFile table, so a hosted dashboard with
 * no disk can show them. Rows store absolute paths from whichever machine made
 * the file; the storage key (`app_<id>/r<n>/<file>`) is the same everywhere.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
};

export function contentTypeOf(p: string): string {
  return CONTENT_TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

/** `app_<hex>/…` from an absolute path or a key; null for anything else (or any `..`). */
export function storageKey(p: string): string | null {
  const m = /(?:^|[\\/])(app_[a-f0-9]+(?:[\\/][^\\/]+)+)$/.exec(p);
  if (!m) return null;
  const parts = m[1]!.split(/[\\/]/);
  if (parts.some((s) => s === "" || s === "." || s === "..")) return null;
  return parts.join("/");
}

/** Where a stored file lives in this machine's output folder. */
export function localFile(ctx: AppContext, p: string): string {
  const key = storageKey(p);
  return key ? path.join(ctx.config.paths.outputDir, ...key.split("/")) : p;
}

/** Copy local files into the database (skips unchanged ones). */
export async function storeFiles(ctx: AppContext, applicationId: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    const key = storageKey(p);
    if (!key || !existsSync(p)) continue;
    const data = readFileSync(p);
    const hash = sha256(data);
    const existing = await ctx.db.storedFile.findUnique({ where: { path: key }, select: { sha256: true } });
    if (existing?.sha256 === hash) continue;
    const row = { applicationId, contentType: contentTypeOf(p), sha256: hash, size: data.length, data: new Uint8Array(data) };
    await ctx.db.storedFile.upsert({ where: { path: key }, create: { path: key, ...row }, update: row });
  }
}

/** Store every file under a local directory (screenshots and manifests). */
export async function storeDir(ctx: AppContext, applicationId: string, dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => path.join(dir, f))
    .filter((f) => statSync(f).isFile());
  await storeFiles(ctx, applicationId, files);
}

/** File bytes: this machine's copy if present, else the database copy. */
export async function readStoredFile(ctx: AppContext, p: string): Promise<Buffer | null> {
  const local = localFile(ctx, p);
  if (existsSync(local) && statSync(local).isFile()) return readFileSync(local);
  const key = storageKey(p);
  if (!key) return null;
  const row = await ctx.db.storedFile.findUnique({ where: { path: key }, select: { data: true } });
  return row ? Buffer.from(row.data) : null;
}

/** Make sure a file exists in this machine's output folder; returns its local path or null. */
export async function materialize(ctx: AppContext, p: string): Promise<string | null> {
  const local = localFile(ctx, p);
  if (existsSync(local)) return local;
  const data = await readStoredFile(ctx, p);
  if (!data) return null;
  mkdirSync(path.dirname(local), { recursive: true });
  writeFileSync(local, data);
  return local;
}

/** Keys of stored files under a prefix such as `app_x/r1/steps/`. */
export async function listStored(ctx: AppContext, prefix: string): Promise<string[]> {
  const rows = await ctx.db.storedFile.findMany({ where: { path: { startsWith: prefix } }, select: { path: true }, orderBy: { path: "asc" } });
  return rows.map((r) => r.path);
}

export async function deleteStored(ctx: AppContext, applicationId: string): Promise<number> {
  return (await ctx.db.storedFile.deleteMany({ where: { OR: [{ applicationId }, { path: { startsWith: `${applicationId}/` } }] } })).count;
}
