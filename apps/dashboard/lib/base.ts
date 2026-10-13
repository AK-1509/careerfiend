import { createAppContext, type AppContext } from "@careerfiend/core";

const g = globalThis as unknown as { __cfBase?: AppContext };

/** The process-wide base context: the shared accounts database (survives dev hot reloads; shared with the desktop worker). */
export function baseCtx(): AppContext {
  g.__cfBase ??= createAppContext();
  return g.__cfBase;
}
