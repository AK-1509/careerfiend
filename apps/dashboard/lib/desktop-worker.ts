import type { AppContext } from "@careerfiend/core";

/**
 * Desktop app: the worker runs inside the dashboard's own process (the
 * embedded database allows one process), looping over every account's queue
 * and sleeping when there is nothing to do. Any dashboard action wakes it.
 */
const g = globalThis as unknown as { __cfDesktopWorker?: { wake(): void } };

export function wakeDesktopWorker(): void {
  g.__cfDesktopWorker?.wake();
}

export function startDesktopWorker(base: AppContext): void {
  if (g.__cfDesktopWorker) return;
  let wakeUp: (() => void) | null = null;
  g.__cfDesktopWorker = { wake: () => wakeUp?.() };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        wakeUp = null;
        resolve();
      }
      wakeUp = done;
    });
  void (async () => {
    const { runAllTenants } = await import("@careerfiend/worker");
    const minIdle = 2_000;
    const maxIdle = 60_000;
    let idle = minIdle;
    base.logger.info("worker.started", { status: "desktop" });
    for (;;) {
      const r = await runAllTenants(base, 5 * 60_000, { serverless: false, systemBrowser: true }).catch((err) => {
        base.logger.error("worker.loop_error", { error: err });
        return { accounts: 0, processed: 0, more: false };
      });
      if (r.processed > 0 || r.more) idle = minIdle;
      else idle = Math.min(idle * 2, maxIdle);
      await sleep(r.processed > 0 || r.more ? 250 : idle);
    }
  })();
}
