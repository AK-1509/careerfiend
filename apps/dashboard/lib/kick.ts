import "server-only";
import { after } from "next/server";
import { loadConfig } from "@careerfiend/shared";
import type { AppContext } from "@careerfiend/core";
import { wakeDesktopWorker } from "./desktop-worker";

/** Ask a hosted background endpoint to start (it returns at once and works in the background). */
export async function pokeWorker(path = "/api/worker"): Promise<void> {
  const c = loadConfig();
  if (c.CAREERFIEND_MODE !== "hosted" || !c.PUBLIC_URL) return;
  try {
    const res = await fetch(`${c.PUBLIC_URL.replace(/\/$/, "")}${path}`, { method: "POST", signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
  } catch {
    /* the next action, page view or schedule tries again */
  }
}

/** Start the worker after this request finishes (server actions, pages): hosted, a new run; desktop, wake the in-app loop. */
export function kickWorker(): void {
  const mode = loadConfig().CAREERFIEND_MODE;
  if (mode === "hosted") after(pokeWorker);
  else if (mode === "desktop") after(wakeDesktopWorker);
}

/** Start Project Recommendations work for one account: hosted, in its own function invocations; locally, after this request. */
export function kickProjects(c: AppContext): void {
  if (loadConfig().CAREERFIEND_MODE === "hosted") {
    after(() => pokeWorker(`/api/projects/run${c.account ? `?account=${c.account.id}` : ""}`));
    return;
  }
  after(async () => {
    const { advanceProjectRun } = await import("@careerfiend/core");
    for (let i = 0; i < 6 && (await advanceProjectRun(c)).more; i++);
  });
}
