import Link from "next/link";
import {
  dashboardCounts,
  endOfDaySummary,
  failedIngest,
  listApplications,
  pendingIngest,
  readyQueue,
  runLockActive,
  workerAlive,
  workerHeartbeat,
  workerSettings,
  lmState,
  resumeSourceConfigured,
  type ApplicationRow,
} from "@careerfiend/core";
import { ctx } from "@/lib/ctx";
import { fmtDate, fmtDay, pct } from "@/lib/format";
import { Badge, Empty, Flash } from "@/components/ui";
import { addUrls, bulkAction, runWorkerNowAction, saveWorkerSettings, toggleWorker } from "./actions";
import { kickWorker } from "@/lib/kick";
import { JobBoardWarning, Onboarding } from "@/components/onboarding";

/** Public edition (form filling off): you apply yourself, so there is no review or approval step. */
const PUBLIC_TILES: { key: string; label: string }[] = [
  { key: "queued", label: "Queued" },
  { key: "preparing", label: "Tailoring" },
  { key: "manual", label: "Ready to apply" },
  { key: "submitted", label: "Applied" },
];

const TILES: { key: string; label: string }[] = [
  { key: "queued", label: "Queued" },
  { key: "preparing", label: "Preparing" },
  { key: "needsInput", label: "Needs input" },
  { key: "ready", label: "Ready for review" },
  { key: "approved", label: "Approved" },
  { key: "submitted", label: "Submitted" },
  { key: "uncertain", label: "Uncertain" },
  { key: "manual", label: "Apply yourself" },
];

function groupByDay(rows: ApplicationRow[]): [string, ApplicationRow[]][] {
  const groups = new Map<string, ApplicationRow[]>();
  for (const r of rows) {
    const k = fmtDay(r.updatedAt);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups];
}

export default async function DailyQueue({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string; welcome?: string }> }) {
  const sp = await searchParams;
  const c = await ctx();
  const formFilling = c.config.FORM_FILLING === "on";
  const [hasResume, lm, counts, ready, needs, manual, settings, beat, eod, waiting, running, unreadable] = await Promise.all([
    resumeSourceConfigured(c),
    lmState(c),
    dashboardCounts(c),
    readyQueue(c),
    listApplications(c, { bucket: "needsInput" }),
    listApplications(c, { bucket: "manual" }).then(async (f) => [...(await listApplications(c, { bucket: "uncertain" })), ...f]),
    workerSettings(c),
    workerHeartbeat(c),
    endOfDaySummary(c),
    pendingIngest(c),
    runLockActive(c),
    failedIngest(c),
  ]);
  // The desktop app runs its worker inside the app, like the hosted one runs by itself.
  const desktop = c.config.CAREERFIEND_MODE === "desktop";
  const hosted = c.config.CAREERFIEND_MODE === "hosted" || desktop;
  const alive = hosted ? running : workerAlive(c, beat);
  // Hosted: opening the queue with links waiting starts a worker run if none is going.
  if (hosted && waiting.length > 0 && !running) kickWorker();
  const now = new Date();
  const [eh, em] = settings.endOfDay.split(":").map(Number);
  const pastEod = now.getHours() * 60 + now.getMinutes() >= (eh ?? 18) * 60 + (em ?? 0);

  return (
    <>
      <h1>{formFilling ? "Daily queue" : "Your applications"}</h1>
      <Flash msg={sp.msg} error={sp.error} />
      <Onboarding hasResume={hasResume} lm={lm} maxMb={c.config.MAX_UPLOAD_MB} />

      <div className="tiles" role="list" aria-label="Application counts">
        {(formFilling ? TILES : PUBLIC_TILES).map((t) => (
          <Link role="listitem" key={t.key} href={`/tracker?bucket=${t.key}`} className={`tile${t.key === "ready" && (counts[t.key] ?? 0) > 0 ? " hot" : ""}`}>
            <span className="n">{counts[t.key] ?? 0}</span>
            <span className="l">{t.label}</span>
          </Link>
        ))}
      </div>

      {formFilling && pastEod && (
        <section className="panel" aria-labelledby="eod">
          <h2 id="eod" style={{ marginTop: 0 }}>
            End-of-day summary
          </h2>
          <p>
            Today: <strong>{eod.ready.length}</strong> ready for review, <strong>{eod.blocked.length}</strong> blocked on your input,{" "}
            <strong>{eod.manual.length}</strong> to apply to yourself, {eod.uncertain.length > 0 && <>{eod.uncertain.length} to check, </>}
            {eod.submitted.length} submitted. Nothing is submitted without your approval and a second confirmation.
          </p>
        </section>
      )}

      {formFilling && (
        <section aria-labelledby="ready-h">
          <h2 id="ready-h">Ready for review ({ready.length})</h2>
          {ready.length === 0 ? (
            <Empty>Nothing waiting. Prepared applications appear here for your end-of-day review.</Empty>
          ) : (
            <form action={bulkAction}>
              {groupByDay(ready).map(([day, rows]) => (
                <div key={day}>
                  <h3>{day}</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">
                            <span className="sr-only">Select</span>
                          </th>
                          <th scope="col">Company</th>
                          <th scope="col">Role</th>
                          <th scope="col">Location</th>
                          <th scope="col">Keyword match</th>
                          <th scope="col">Priority</th>
                          <th scope="col">Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <input type="checkbox" name="ids" value={r.id} aria-label={`Select ${r.company} ${r.title}`} />
                            </td>
                            <td>
                              <Link href={`/applications/${r.id}`}>{r.company}</Link>
                            </td>
                            <td>{r.title}</td>
                            <td>{r.location || "—"}</td>
                            <td>{pct(r.coverage)}</td>
                            <td>{r.priority}</td>
                            <td>{fmtDate(r.updatedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              <fieldset className="panel" style={{ marginTop: "0.8rem" }}>
                <legend>Bulk action (approval and submission are always one at a time)</legend>
                <div className="row">
                  <label className="inline">
                    <input type="radio" name="action" value="reject" required /> Reject
                  </label>
                  <label className="inline">
                    <input type="radio" name="action" value="defer" /> Defer by
                    <input type="number" name="days" min={1} defaultValue={1} style={{ width: "4rem" }} aria-label="Days to defer" /> day(s)
                  </label>
                  <label className="inline">
                    <input type="radio" name="action" value="priority" /> Set priority
                    <input type="number" name="priority" defaultValue={1} style={{ width: "4rem" }} aria-label="Priority" />
                  </label>
                  <button type="submit">Apply to selected</button>
                </div>
              </fieldset>
            </form>
          )}
        </section>
      )}

      <div className="grid two">
        <section aria-labelledby="needs-h">
          <h2 id="needs-h">Needs your input ({needs.length})</h2>
          {needs.length === 0 ? (
            <Empty>No open questions.</Empty>
          ) : (
            <ul>
              {needs.map((r) => (
                <li key={r.id}>
                  <Link href={`/applications/${r.id}`}>
                    {r.company} — {r.title}
                  </Link>{" "}
                  {r.failureCategory && <Badge value="WARNING" label={r.failureCategory} />}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="manual-h">
          <h2 id="manual-h">
            {formFilling ? "Apply yourself" : "Ready to apply"} ({manual.length})
          </h2>
          <p className="small muted">
            {formFilling
              ? "CareerFiend could not finish these on the employer's site (often a spam or bot check). The tailored résumé and cover letter are ready: apply yourself, then mark it as applied."
              : "The résumé and cover letter tailored to each listing are ready. Open one, download them, apply on the employer's site, then mark it as applied."}
          </p>
          {manual.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <ul>
              {manual.map((r) => (
                <li key={r.id}>
                  <Link href={`/applications/${r.id}`}>
                    {r.company} — {r.title}
                  </Link>{" "}
                  {r.state === "SUBMISSION_UNCERTAIN" && <Badge value={r.state} label="Check if it went through" />}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid two">
        <section className="panel" aria-labelledby="add-h">
          <h2 id="add-h" style={{ marginTop: 0 }}>
            Add job URLs
          </h2>
          <JobBoardWarning />
          <form action={addUrls}>
            <label htmlFor="urls">
              Paste application links, one per line: the employer&apos;s own job or Apply page. Every link gets a résumé and cover letter tailored to that
              listing{formFilling ? ", and the worker fills the application" : ""}; its skills also go to your <Link href="/bank">skill bank</Link>.
              {!hasResume && <strong> Add your résumé first (above) so there is something to tailor.</strong>}
            </label>
            <textarea id="urls" name="urls" rows={5} required placeholder="https://boards.greenhouse.io/company/jobs/123" />
            <button className="primary" type="submit" style={{ marginTop: "0.5rem" }}>
              Queue
            </button>
          </form>
          {unreadable.length > 0 && (
            <details style={{ marginTop: "0.75rem" }}>
              <summary className="small">
                {unreadable.length} link{unreadable.length === 1 ? "" : "s"} could not be read in the last 7 days
              </summary>
              <ul className="small">
                {unreadable.map((u, i) => (
                  <li key={i}>
                    <span className="mono">{u.url}</span>: {u.reason} <span className="muted">({fmtDate(u.at)})</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {waiting.length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <p className="small">
                <strong>{waiting.length}</strong> link{waiting.length === 1 ? "" : "s"} waiting for the worker to read
                {alive || hosted ? "." : " (the worker is not running, so nothing will happen until you start it)."} Jobs appear in the queue after that.
              </p>
              <ul className="small muted">
                {waiting.map((w, i) => (
                  <li key={i}>
                    {w.url}
                    {w.lastError ? ` (retrying: ${w.lastError.slice(0, 120)})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <section className="panel" aria-labelledby="worker-h">
          <h2 id="worker-h" style={{ marginTop: 0 }}>
            Worker
          </h2>
          {hosted ? (
            <>
              <p>
                Status: {running ? <Badge value="SUBMITTED" label="Running now" /> : <Badge value="QUEUED" label="Idle" />}{" "}
                {settings.paused && <Badge value="WARNING" label="Paused" />}
                <span className="small muted"> Last active {beat ? fmtDate(beat.at) : "never"}.</span>
              </p>
              <p className="small muted">
                {desktop
                  ? "Runs inside this app while it is open: it starts by itself when you add links or change something. Close the app and it picks up where it left off next time."
                  : "Runs in the cloud: it starts by itself when you add links or change something, when you open this page with links waiting, and on a schedule for the watchlist."}
              </p>
              <form action={runWorkerNowAction} className="row" style={{ marginBottom: "0.5rem" }}>
                <button type="submit" className="primary">
                  Run worker now
                </button>
              </form>
            </>
          ) : (
            <p>
              Status: {alive ? <Badge value="SUBMITTED" label="Running" /> : <Badge value="BLOCKER" label="Not running" />}{" "}
              {settings.paused && <Badge value="WARNING" label="Paused" />}
              {!alive && (
                <span className="small muted">
                  {" "}
                  Start it on your computer with <code>npm run worker</code>
                  {beat ? ` (last seen ${fmtDate(beat.at)})` : " (never seen by this database: check DATABASE_URL in the worker's .env.local)"}.
                </span>
              )}
            </p>
          )}
          <form action={toggleWorker} className="row">
            <input type="hidden" name="paused" value={settings.paused ? "false" : "true"} />
            <button type="submit">{settings.paused ? "Resume worker" : "Pause worker"}</button>
          </form>
          <form action={saveWorkerSettings}>
            <div className="grid two" style={{ gap: "0.5rem" }}>
              <div>
                <label htmlFor="dailyLimit">Daily preparation limit</label>
                <input id="dailyLimit" name="dailyLimit" type="number" min={1} defaultValue={settings.dailyLimit ?? ""} placeholder="No limit" />
              </div>
              <div>
                <label htmlFor="runWindow">Run window</label>
                <input
                  id="runWindow"
                  name="runWindow"
                  type="text"
                  defaultValue={settings.runWindow}
                  pattern="\d{2}:\d{2}-\d{2}:\d{2}"
                  aria-describedby="rw-help"
                />
                <span id="rw-help" className="small muted">
                  HH:MM-HH:MM; 00:00-00:00 means always
                </span>
              </div>
              <div>
                <label htmlFor="endOfDay">End of day</label>
                <input id="endOfDay" name="endOfDay" type="text" defaultValue={settings.endOfDay} pattern="\d{2}:\d{2}" />
              </div>
            </div>
            <button type="submit" style={{ marginTop: "0.5rem" }}>
              Save
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
