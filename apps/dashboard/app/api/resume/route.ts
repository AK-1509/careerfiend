import { ctx } from "@/lib/ctx";
import { hasSession } from "@/lib/session";

/** Download one of your uploaded résumé PDFs. */
export async function GET(req: Request) {
  if (!(await hasSession())) return new Response("Sign in first.", { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^upl_[a-f0-9]+$/.test(id)) return new Response("Not found", { status: 404 });
  const row = await (await ctx()).db.resumeUpload.findUnique({ where: { id } });
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(row.data), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${row.fileName.replace(/"/g, "")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
