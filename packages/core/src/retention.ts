import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { AppContext } from "./context";
import { deleteStored } from "./files";

/** Delete everything CareerFiend stored for one application (files and rows). */
export async function deleteApplicationData(ctx: AppContext, applicationId: string): Promise<void> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId } });
  if (app.state === "SUBMITTING") throw new Error("Cannot delete an application while it is being submitted.");
  const dir = path.join(ctx.config.paths.outputDir, applicationId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  await deleteStored(ctx, applicationId);
  // Unlink emails from this application (the email rows themselves stay for other matches).
  await ctx.db.emailThreadLink.deleteMany({ where: { applicationId } });
  await ctx.db.submissionAttempt.deleteMany({ where: { applicationId } });
  await ctx.db.approval.deleteMany({ where: { applicationId } });
  await ctx.db.workItem.updateMany({ where: { status: "PENDING", payload: { contains: applicationId } }, data: { status: "CANCELLED" } });
  await ctx.db.application.delete({ where: { id: applicationId } });
  ctx.logger.info("application.deleted", { applicationId });
}

/** Remove generated files of finished applications older than RETENTION_DAYS (0 = keep). */
export async function applyRetention(ctx: AppContext): Promise<number> {
  const days = ctx.config.RETENTION_DAYS;
  if (!days) return 0;
  const cutoff = new Date(ctx.now().getTime() - days * 86_400_000);
  const old = await ctx.db.application.findMany({ where: { state: { in: ["REJECTED", "CLOSED", "MANUAL", "FAILED"] }, updatedAt: { lt: cutoff } } });
  let n = 0;
  for (const a of old) {
    const dir = path.join(ctx.config.paths.outputDir, a.id);
    const had = existsSync(dir);
    if (had) rmSync(dir, { recursive: true, force: true });
    if ((await deleteStored(ctx, a.id)) > 0 || had) n++;
  }
  return n;
}
