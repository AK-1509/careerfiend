/**
 * Runs once when the server starts. In the desktop app it also starts the
 * background worker in this same process (see lib/desktop-worker.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.CAREERFIEND_MODE !== "desktop") return;
  const { baseCtx } = await import("./lib/base");
  const { startDesktopWorker } = await import("./lib/desktop-worker");
  startDesktopWorker(baseCtx());
}
