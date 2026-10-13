import { gmailStatus } from "@careerfiend/core";
import { ctx } from "@/lib/ctx";
import { fmtDate } from "@/lib/format";
import { Badge, Empty, Flash } from "@/components/ui";
import { assignEmailAction, dismissEmailAction, gmailConnectAction, gmailDisconnectAction, pollEmailAction } from "../actions";

export default async function Email({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const sp = await searchParams;
  const c = await ctx();
  const status = await gmailStatus(c);
  const unmatched = await c.db.emailMessage.findMany({ where: { matchStatus: "UNMATCHED" }, orderBy: { receivedAt: "desc" } });
  const apps = await c.db.application.findMany({
    where: { state: { in: ["SUBMITTED", "CONFIRMATION_RECEIVED", "RESPONDED", "INTERVIEW", "OFFER", "SUBMISSION_UNCERTAIN"] } },
    include: { job: true },
  });
  const configured = !!c.config.GMAIL_OAUTH_CLIENT_ID && !!c.config.GMAIL_OAUTH_CLIENT_SECRET;
  return (
    <>
      <h1>Email tracking</h1>
      <Flash msg={sp.msg} error={sp.error} />
      <section className="panel" aria-labelledby="gm-h">
        <h2 id="gm-h" style={{ marginTop: 0 }}>
          Gmail
        </h2>
        {status.connected ? (
          <>
            <p>
              Connected as <strong>{status.account}</strong> in <strong>{status.mode}</strong> mode.{" "}
              {status.mode === "label" ? "Matched mail gets “Job Applications/…” labels." : "Read-only: replies update the tracker; Gmail is not changed."}
            </p>
            <p className="small muted">
              CareerFiend only reads matching mail and adds labels. It never sends, replies, forwards, deletes, archives or marks mail read.
            </p>
            <div className="row">
              <form action={pollEmailAction}>
                <button type="submit">Check now</button>
              </form>
              <form action={gmailDisconnectAction}>
                <button type="submit" className="danger">
                  Disconnect and revoke
                </button>
              </form>
            </div>
            <p className="small muted">You can also revoke access any time at myaccount.google.com → Security → Third-party access.</p>
          </>
        ) : configured ? (
          <form action={gmailConnectAction} className="stack">
            <fieldset>
              <legend>Access level</legend>
              <label className="inline">
                <input type="radio" name="mode" value="label" defaultChecked /> Read + add labels (Google scope gmail.modify, used only for labels)
              </label>
              <label className="inline">
                <input type="radio" name="mode" value="readonly" /> Read-only (gmail.readonly; no labels)
              </label>
            </fieldset>
            <button className="primary" type="submit">
              Connect Gmail
            </button>
          </form>
        ) : (
          <p>
            Add <code>GMAIL_OAUTH_CLIENT_ID</code> and <code>GMAIL_OAUTH_CLIENT_SECRET</code> (a Google Cloud OAuth client of type “Desktop app”) to{" "}
            <code>.env.local</code>, then restart the dashboard. See README → Gmail.
          </p>
        )}
      </section>

      <section aria-labelledby="un-h">
        <h2 id="un-h">Unmatched email ({unmatched.length})</h2>
        <p className="muted small">Mail that could belong to an application but did not meet the matching threshold. Nothing here was labeled.</p>
        {unmatched.length === 0 ? (
          <Empty>Nothing to review.</Empty>
        ) : (
          unmatched.map((e) => {
            const cands = JSON.parse(e.evidence) as { applicationId: string; score: number; signals: string[] }[];
            return (
              <div className="panel" key={e.id}>
                <strong>{e.subject}</strong>{" "}
                <span className="muted small">
                  from {e.fromAddress} · {fmtDate(e.receivedAt)}
                </span>{" "}
                {e.classification && <Badge value="UNMATCHED" label={e.classification} />}
                <p className="small">{e.snippet}</p>
                {cands.length > 0 && (
                  <p className="small muted">
                    Candidates:{" "}
                    {cands
                      .map(
                        (c) => `${apps.find((a) => a.id === c.applicationId)?.job.company ?? c.applicationId} (${c.score.toFixed(2)}: ${c.signals.join(", ")})`,
                      )
                      .join("; ")}
                  </p>
                )}
                <div className="row">
                  <form action={assignEmailAction} className="row">
                    <input type="hidden" name="emailId" value={e.id} />
                    <label className="sr-only" htmlFor={`app-${e.id}`}>
                      Application
                    </label>
                    <select id={`app-${e.id}`} name="applicationId" required defaultValue={cands[0]?.applicationId ?? ""}>
                      <option value="" disabled>
                        Assign to…
                      </option>
                      {apps.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.job.company} — {a.job.title}
                        </option>
                      ))}
                    </select>
                    <label className="sr-only" htmlFor={`cls-${e.id}`}>
                      Type
                    </label>
                    <select id={`cls-${e.id}`} name="classification" defaultValue={e.classification ?? ""}>
                      <option value="">keep type</option>
                      {["confirmation", "action_required", "recruiter_response", "interview", "rejection", "offer", "other"].map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                    <button type="submit">Assign</button>
                  </form>
                  <form action={dismissEmailAction}>
                    <input type="hidden" name="emailId" value={e.id} />
                    <button type="submit">Not job-related</button>
                  </form>
                </div>
              </div>
            );
          })
        )}
      </section>
    </>
  );
}
