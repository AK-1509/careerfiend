import { assertTransition, randomId, type ApplicationState, type FailureCategory } from "@careerfiend/shared";
import type { Db, Tx } from "@careerfiend/db";

export type Actor = `user:${string}` | `worker:${string}` | `system:${string}` | `email:${string}`;

/**
 * The only way an application's state changes. Validates the transition
 * against the state machine, updates the row conditionally on the expected
 * current state (so concurrent writers cannot both win), and appends a
 * StatusEvent.
 */
export async function transition(
  db: Db | Tx,
  applicationId: string,
  to: ApplicationState,
  actor: Actor,
  reason: string,
  patch: {
    failureCategory?: FailureCategory | null;
    failureMessage?: string | null;
    failedDuringSubmit?: boolean;
    takeoverRequested?: boolean;
    currentRevisionId?: string;
  } = {},
): Promise<ApplicationState> {
  const app = await db.application.findUniqueOrThrow({ where: { id: applicationId } });
  const from = app.state as ApplicationState;
  assertTransition(from, to);
  const res = await db.application.updateMany({ where: { id: applicationId, state: from }, data: { state: to, ...patch } });
  if (res.count !== 1) throw new Error(`Concurrent state change on ${applicationId} (expected ${from}).`);
  await db.statusEvent.create({ data: { id: randomId("se"), applicationId, from, to, actor, reason } });
  return from;
}

/** Transition only if not already in `to` (restart-safe re-entry). */
export async function ensureState(db: Db | Tx, applicationId: string, to: ApplicationState, actor: Actor, reason: string): Promise<void> {
  const app = await db.application.findUniqueOrThrow({ where: { id: applicationId } });
  if (app.state !== to) await transition(db, applicationId, to, actor, reason);
}

export async function recordEvent(db: Db | Tx, applicationId: string, actor: Actor, reason: string): Promise<void> {
  const app = await db.application.findUniqueOrThrow({ where: { id: applicationId } });
  await db.statusEvent.create({ data: { id: randomId("se"), applicationId, from: app.state, to: app.state, actor, reason } });
}
