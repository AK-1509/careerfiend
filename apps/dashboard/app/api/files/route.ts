import path from "node:path";
import { contentTypeOf, readStoredFile, storageKey } from "@careerfiend/core";
import { ctx } from "@/lib/ctx";
import { hasSession } from "@/lib/session";

/** Serve an application's generated files by storage key (`app_…/r<n>/<file>`), from the database or this machine's output folder. */
export async function GET(req: Request) {
  if (!(await hasSession())) return new Response("Sign in first.", { status: 401 });
  const u = new URL(req.url);
  const app = u.searchParams.get("app") ?? "";
  const key = storageKey(u.searchParams.get("path") ?? "");
  if (!/^app_[a-f0-9]+$/.test(app) || !key || !key.startsWith(`${app}/`)) return new Response("Not found", { status: 404 });
  const data = await readStoredFile(await ctx(), key);
  if (!data) return new Response("Not found", { status: 404 });
  const ext = path.extname(key);
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": contentTypeOf(key),
      "content-disposition": `${ext === ".png" || ext === ".pdf" || ext === ".txt" ? "inline" : "attachment"}; filename="${path.basename(key)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
