import Link from "next/link";
import { notFound } from "next/navigation";
import { applicationDetail, canRegenerate } from "@careerfiend/core";
import { ctx } from "@/lib/ctx";
import { fmtDate, humanState, pct } from "@/lib/format";
import { Badge, Empty, Flash } from "@/components/ui";
import {
  answerQuestionAction,
  approveAction,
  deleteApplicationAction,
  editAnswerAction,
  editLetterAction,
  markAppliedAction,
  regenerateAction,
  rejectAction,
  resolveUncertainAction,
  resumeTakeoverAction,
  retryAction,
  submitAction,
} from "../../actions";

function fileUrl(appId: string, p: string) {
  return `/api/files?app=${encodeURIComponent(appId)}&path=${encodeURIComponent(p)}`;
}

export default async function ApplicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const c = await ctx();
  let d;
  try {
    d = await applicationDetail(c, id);
  } catch {
    notFound();
  }
  const { app, job, revision, warnings, letter, resumeReport } = d;
  const state = app.state;
  const openQuestions = d.questions.filter((q) => !q.answeredAt);
  const editable = state === "READY_FOR_REVIEW" || state === "APPROVED";
  const nonBlocking = warnings.filter((w) => !w.blocking);
  const blocking = warnings.filter((w) => w.blocking);
  const docs = d.documents;
  const applyYourself = state === "MANUAL" || state === "FAILED";
  const regenerable = canRegenerate(state);
  const beforeSubmission = state === "READY_FOR_REVIEW" || state === "APPROVED" || state === "NEEDS_INPUT";
  const doc = (type: string, format: string) => docs.find((x) => x.type === type && x.format === format);

  return (
    <>
      <p className="small">
        <Link href="/">← Daily queue</Link>
      </p>
      <h1>
        {job.company} — {job.title} <Badge value={state} />
      </h1>
      <Flash msg={sp.msg} error={sp.error} />
      <p className="muted">
        {job.location.raw || "Location not stated"} · keyword match {pct(app.job.coverage)} · <a href={job.sourceUrl}>original listing</a>
        {job.applyUrl && (
          <>
            {" "}
            · <a href={job.applyUrl}>application page</a>
          </>
        )}
        {job.compensation && <> · {job.compensation}</>}
      </p>

      {/* ------------------------------------------------ regenerate (every application) */}
      <section className="panel accent" aria-labelledby="regen-h">
        <form action={regenerateAction} className="row" style={{ alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
          <input type="hidden" name="applicationId" value={app.id} />
          <div style={{ flex: "1 1 20rem" }}>
            <h2 id="regen-h" style={{ margin: 0, fontSize: "1.05rem" }}>
              Regenerate résumé and cover letter
            </h2>
            <p className="small muted" style={{ margin: "0.25rem 0 0" }}>
              {!regenerable
                ? "CareerFiend is working on this application right now. Regenerate is available as soon as it finishes."
                : beforeSubmission
                  ? `Rebuilds the tailored résumé, cover letter and form answers from your current profile as a new revision${state === "APPROVED" ? " (your approval is cancelled and you review it again)" : ""}.`
                  : "Rebuilds the tailored résumé and cover letter from your current profile. The status stays the same and nothing is submitted."}
            </p>
          </div>
          <button type="submit" className="primary big" disabled={!regenerable}>
            Regenerate
          </button>
        </form>
      </section>

      {applyYourself ? (
        <section className="panel" aria-labelledby="apply-h">
          <h2 id="apply-h" style={{ marginTop: 0 }}>
            {app.failureCategory === "DOCUMENTS_READY" ? "Ready to apply" : "Apply yourself"}
          </h2>
          {app.failureCategory !== "DOCUMENTS_READY" && (
            <p>
              CareerFiend could not finish this application on the employer&apos;s site
              {app.failureMessage ? (
                <>
                  : <span className="muted">{app.failureMessage}</span>
                </>
              ) : (
                "."
              )}
            </p>
          )}
          <p>
            Your tailored résumé and cover letter are ready <a href="#res-h">below</a>. Apply on{" "}
            <a href={job.applyUrl ?? job.sourceUrl} target="_blank" rel="noreferrer">
              the employer&apos;s application page
            </a>
            , then mark it as applied so CareerFiend tracks it.
          </p>
          <form action={markAppliedAction} className="row" style={{ alignItems: "flex-end" }}>
            <input type="hidden" name="applicationId" value={app.id} />
            <div style={{ flex: "1 1 16rem" }}>
              <label htmlFor="applied-note" className="small">
                Note (optional)
              </label>
              <input id="applied-note" name="note" type="text" placeholder="e.g. applied through the company portal" />
            </div>
            <button type="submit" className="primary">
              I applied: mark as submitted
            </button>
          </form>
          {!app.failedDuringSubmit && c.config.FORM_FILLING === "on" && (
            <form action={retryAction} style={{ marginTop: "0.6rem" }}>
              <input type="hidden" name="applicationId" value={app.id} />
              <button type="submit" className="link small">
                Try filling it automatically again
              </button>
            </form>
          )}
        </section>
      ) : (
        d.recovery && (
          <div className={`flash ${state === "SUBMISSION_UNCERTAIN" ? "bad" : "warn"}`} role="alert">
            <strong>{app.failureCategory}</strong>: {app.failureMessage}
            <div className="small">{d.recovery}</div>
          </div>
        )
      )}

      {/* ------------------------------------------------ open questions */}
      {openQuestions.length > 0 && (
        <section className="panel" aria-labelledby="q-h">
          <h2 id="q-h" style={{ marginTop: 0 }}>
            Questions for you ({openQuestions.length})
          </h2>
          {openQuestions.map((q) =>
            q.kind === "TAKEOVER" ? (
              <form key={q.id} action={resumeTakeoverAction} className="stack">
                <input type="hidden" name="applicationId" value={app.id} />
                <p>
                  <strong>Take over in the browser window:</strong> {q.question}
                </p>
                <p className="small muted">
                  {q.context}. Finish the step yourself in the CareerFiend browser window (the worker keeps the page open), then press Resume.
                </p>
                <button className="primary" type="submit">
                  Resume
                </button>
              </form>
            ) : (
              <form key={q.id} action={answerQuestionAction} className="panel stack">
                <input type="hidden" name="applicationId" value={app.id} />
                <input type="hidden" name="questionId" value={q.id} />
                <label htmlFor={`a-${q.id}`}>
                  {q.question} {q.sensitive && <Badge value="SENSITIVE_PENDING" label="Sensitive" />}
                </label>
                {q.context && <p className="small muted">{q.context}</p>}
                {q.options.length > 0 ? (
                  <select id={`a-${q.id}`} name="answer" required defaultValue="">
                    <option value="" disabled>
                      Choose…
                    </option>
                    {q.options
                      .filter((o) => o && !/^(select|choose)/i.test(o))
                      .map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                  </select>
                ) : (
                  <textarea id={`a-${q.id}`} name="answer" rows={2} required />
                )}
                {q.kind === "FIELD" && (
                  <label className="inline">
                    <input type="checkbox" name="reusable" /> Save as a reusable answer for future applications
                  </label>
                )}
                <button type="submit">Save answer</button>
              </form>
            ),
          )}
        </section>
      )}

      {/* ------------------------------------------------ review / approval */}
      {revision && (
        <section className="panel" aria-labelledby="rev-h">
          <h2 id="rev-h" style={{ marginTop: 0 }}>
            Revision {revision.number} <span className="mono muted">{revision.hash.slice(0, 16)}</span>
          </h2>
          <p className="small muted">
            {revision.reason} · {fmtDate(revision.createdAt)} · target {revision.payload.targetUrl} · final button “{revision.payload.finalSubmitLabel ?? "?"}”
            · résumé source {revision.payload.sourceCommit.slice(0, 7)}
          </p>
          {warnings.length > 0 && (
            <ul>
              {warnings.map((w) => (
                <li key={w.code}>
                  <Badge value={w.blocking ? "BLOCKER" : "WARNING"} label={w.code} /> {w.message}
                </li>
              ))}
            </ul>
          )}

          {state === "READY_FOR_REVIEW" && (
            <form action={approveAction} className="panel stack" aria-labelledby="approve-h">
              <h3 id="approve-h">Approve this exact revision</h3>
              <input type="hidden" name="applicationId" value={app.id} />
              <input type="hidden" name="revisionHash" value={revision.hash} />
              {blocking.length > 0 && <p className="flash bad">Resolve blocking warnings first: {blocking.map((w) => w.code).join(", ")}.</p>}
              {revision.unresolved > 0 && <p className="flash bad">{revision.unresolved} required answer(s) are empty.</p>}
              {nonBlocking.map((w) => (
                <label className="inline" key={w.code}>
                  <input type="checkbox" name="ack" value={w.code} required /> I have read: {w.code}
                </label>
              ))}
              <label htmlFor="approve-confirm">Type APPROVE to approve revision {revision.number}. This does not submit anything.</label>
              <input id="approve-confirm" name="confirmation" type="text" autoComplete="off" required pattern="APPROVE" />
              <div className="row">
                <button className="primary" type="submit" disabled={blocking.length > 0 || revision.unresolved > 0}>
                  Approve current revision
                </button>
              </div>
            </form>
          )}

          {state === "APPROVED" && (
            <form action={submitAction} className="panel stack" aria-labelledby="submit-h">
              <h3 id="submit-h">Submit approved application</h3>
              <input type="hidden" name="applicationId" value={app.id} />
              <p>
                Revision {revision.number} is approved. The worker will open {new URL(revision.payload.targetUrl).host}, re-enter exactly these answers and
                uploads, and press “{revision.payload.finalSubmitLabel}” once. It never retries an ambiguous result.
              </p>
              <label htmlFor="submit-confirm">Type SUBMIT to confirm</label>
              <input id="submit-confirm" name="confirmation" type="text" autoComplete="off" required pattern="SUBMIT" />
              <button className="primary" type="submit">
                Submit approved application
              </button>
            </form>
          )}
        </section>
      )}

      {state === "SUBMISSION_UNCERTAIN" && (
        <section className="panel danger-zone" aria-labelledby="unc-h">
          <h2 id="unc-h" style={{ marginTop: 0 }}>
            Submission result unknown
          </h2>
          <p>Do not resubmit. Check your email and the employer portal, then record what happened.</p>
          <form action={resolveUncertainAction} className="stack">
            <input type="hidden" name="applicationId" value={app.id} />
            <label htmlFor="unc-note">What did you find?</label>
            <input id="unc-note" name="note" type="text" required />
            <div className="row">
              <button type="submit" name="outcome" value="SUBMITTED">
                It was submitted
              </button>
              <button type="submit" name="outcome" value="FAILED" className="danger">
                It was not submitted
              </button>
            </div>
          </form>
        </section>
      )}

      <div className="row" style={{ marginBottom: "1rem" }}>
        {(state === "READY_FOR_REVIEW" || state === "APPROVED" || state === "NEEDS_INPUT" || applyYourself) && (
          <form action={rejectAction} className="row">
            <input type="hidden" name="applicationId" value={app.id} />
            <label className="sr-only" htmlFor="reason">
              Reason
            </label>
            <input id="reason" name="reason" type="text" placeholder="Reason (optional)" style={{ width: "16rem" }} />
            <button type="submit" className="danger">
              Reject
            </button>
          </form>
        )}
      </div>

      {/* ------------------------------------------------ requirements */}
      <section aria-labelledby="req-h">
        <h2 id="req-h">Requirements and evidence</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Requirement</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Résumé evidence (verbatim)</th>
              </tr>
            </thead>
            <tbody>
              {(
                resumeReport?.matchReport ??
                d.matches.map((m) => ({
                  requirement: m.text,
                  category: m.category,
                  status: m.status,
                  skills: JSON.parse(m.skillIds) as string[],
                  bullet: null,
                  bulletKey: null,
                  note: m.note ?? "",
                }))
              ).map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.requirement}
                    {r.note && <div className="small muted">{r.note}</div>}
                  </td>
                  <td>{r.category}</td>
                  <td>
                    <Badge value={r.status} />
                  </td>
                  <td>
                    {r.bullet ? (
                      <>
                        “{r.bullet}”<div className="mono muted">{r.bulletKey}</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------ documents */}
      <div className="grid two">
        <section aria-labelledby="res-h">
          <h2 id="res-h">Tailored résumé</h2>
          <p className="small">
            {["pdf", "docx", "txt"].map((f) => {
              const x = doc("resume", f);
              return x ? (
                <a key={f} href={fileUrl(app.id, x.path)} style={{ marginRight: "0.8rem" }}>
                  {f.toUpperCase()}
                </a>
              ) : null;
            })}
            {resumeReport?.pages && (
              <span className="muted">
                {resumeReport.pages} page(s) · from your résumé {resumeReport.sourceCommit}
                {resumeReport.ats ? ` · ${resumeReport.ats.tailoredBullets} bullet(s) tailored to this listing` : ""}
              </span>
            )}
          </p>
          {resumeReport?.ats && resumeReport.ats.keywords.length > 0 && (
            <div className="panel">
              <strong>
                ATS keyword check: {resumeReport.ats.keywords.filter((k) => k.found).length} of {resumeReport.ats.keywords.length} listing keywords appear in
                this résumé
              </strong>
              <p className="small" style={{ margin: "0.4rem 0 0" }}>
                {resumeReport.ats.keywords.map((k) => (
                  <span key={k.label} style={{ marginRight: "0.35rem", display: "inline-block" }}>
                    <Badge value={k.found ? "COVERED" : "NOT_APPLICABLE"} label={k.label} />
                  </span>
                ))}
              </p>
              {resumeReport.ats.skillsAdded.length > 0 && (
                <p className="small muted" style={{ margin: "0.4rem 0 0" }}>
                  Added to the Skills line from your confirmed skills and skill bank: {resumeReport.ats.skillsAdded.join(", ")}.
                </p>
              )}
              <p className="small muted" style={{ margin: "0.4rem 0 0" }}>
                Missing keywords are things the listing names that your résumé does not show yet. To add one, confirm it on the Skills page and regenerate.
              </p>
            </div>
          )}
          <div className="panel">
            {(resumeReport?.lines ?? []).map((l, i) => {
              const g = l.kind === "tailored" ? resumeReport?.generatedBullets?.bullets.find((b) => b.anchorId === l.key) : undefined;
              return (
                <div key={i} className="small" style={{ marginBottom: "0.25rem" }}>
                  {l.line}
                  {l.key && <span className="mono muted"> [{l.kind === "tailored" ? `tailored from ${l.key}` : l.key}]</span>}
                  {l.original && <div className="muted">Original: “{l.original}”</div>}
                  {g && (
                    <div className="muted">
                      Written for: {g.template}
                      {g.matchedTerms.length ? ` · employer terms: ${g.matchedTerms.join(", ")}` : ""} · evidence: {g.evidenceIds.join(", ")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {resumeReport?.dropped && resumeReport.dropped.length > 0 && (
            <details>
              <summary>Left out for the page limit ({resumeReport.dropped.length})</summary>
              <ul className="small">
                {resumeReport.dropped.map((x, i) => (
                  <li key={i}>
                    <span className="mono">{x.key}</span> — {x.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section aria-labelledby="letter-h">
          <h2 id="letter-h">Cover letter</h2>
          <p className="small">
            {["pdf", "docx", "txt"].map((f) => {
              const x = doc("cover_letter", f);
              return x ? (
                <a key={f} href={fileUrl(app.id, x.path)} style={{ marginRight: "0.8rem" }}>
                  {f.toUpperCase()}
                </a>
              ) : null;
            })}
            {letter && (
              <span className="muted">
                {letter.wordCount} words · {letter.generator}
              </span>
            )}
          </p>
          {letter ? (
            <div className="panel letter">
              {letter.sentences.map((s, i) => (
                <div className="claim" key={i}>
                  <div>{s.text}</div>
                  {s.sources.length > 0 ? (
                    s.sources.map((src) => (
                      <div className="src" key={src.key}>
                        ↳ <span className="mono">{src.key}</span>: “{src.text}”
                      </div>
                    ))
                  ) : (
                    <div className="src">no factual claim</div>
                  )}
                </div>
              ))}
              {letter.problems.length > 0 && <p className="flash bad small">{letter.problems.join(" ")}</p>}
            </div>
          ) : (
            <Empty>Not generated yet.</Empty>
          )}
          {editable && revision && (
            <details>
              <summary>Edit cover letter (creates a new revision)</summary>
              <form action={editLetterAction} className="stack">
                <input type="hidden" name="applicationId" value={app.id} />
                <label htmlFor="letter">Paragraphs separated by a blank line</label>
                <textarea id="letter" name="letter" rows={14} defaultValue={revision.payload.coverLetter.paragraphs.join("\n\n")} />
                <button type="submit">Save letter</button>
              </form>
            </details>
          )}
        </section>
      </div>

      {/* ------------------------------------------------ answers */}
      <section aria-labelledby="ans-h">
        <h2 id="ans-h">Form answers</h2>
        {revision ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Question</th>
                  <th scope="col">Answer</th>
                  <th scope="col">Source</th>
                  <th scope="col">Confidence</th>
                  {editable && <th scope="col">Edit</th>}
                </tr>
              </thead>
              <tbody>
                {revision.answers.map((a) => (
                  <tr key={a.fieldKey}>
                    <td>{a.step}</td>
                    <td>
                      {a.label} {a.required && <span className="muted small">(required)</span>}{" "}
                      {a.sensitive && <Badge value="SENSITIVE_PENDING" label="Sensitive" />}
                      <div className="small muted">{humanState(a.semanticType)}</div>
                    </td>
                    <td>
                      {a.value ?? <span className="muted">left blank</span>}
                      {a.note && <div className="small muted">{a.note}</div>}
                    </td>
                    <td>
                      {a.source}
                      {a.provenance.length > 0 && <div className="mono muted">{a.provenance.slice(0, 3).join(", ")}</div>}
                    </td>
                    <td>{pct(a.confidence)}</td>
                    {editable && (
                      <td>
                        <form action={editAnswerAction} className="row">
                          <input type="hidden" name="applicationId" value={app.id} />
                          <input type="hidden" name="fieldKey" value={a.fieldKey} />
                          <label className="sr-only" htmlFor={`e-${a.fieldKey}`}>
                            New answer for {a.label}
                          </label>
                          <input id={`e-${a.fieldKey}`} name="value" type="text" defaultValue={a.value ?? ""} style={{ width: "12rem" }} />
                          <button type="submit">Save</button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : d.fields.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Field</th>
                  <th scope="col">Proposed</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {d.fields.map((f) => (
                  <tr key={f.id}>
                    <td>{f.step}</td>
                    <td>
                      {f.label} {f.required && <span className="muted small">(required)</span>}
                    </td>
                    <td>
                      {f.proposedValue ?? "—"}
                      {(f.note || f.validationMessage) && <div className="small muted">{f.validationMessage ?? f.note}</div>}
                    </td>
                    <td>
                      <Badge value={f.reviewState} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>The form has not been read yet.</Empty>
        )}
        {revision && revision.payload.uploads.length > 0 && (
          <>
            <h3>Files that will be uploaded</h3>
            <ul className="small">
              {revision.payload.uploads.map((u) => (
                <li key={u.fieldKey}>
                  <a href={fileUrl(app.id, u.path)}>{u.path.split("/").slice(-2).join("/")}</a>{" "}
                  <span className="mono muted">sha256 {u.sha256.slice(0, 16)}…</span> → {u.fieldKey}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {d.screenshots.length > 0 && (
        <section aria-labelledby="shots-h">
          <h2 id="shots-h">Screenshots</h2>
          <div className="shots">
            {d.screenshots.map((s) => (
              <a key={s} href={fileUrl(app.id, s)}>
                <img src={fileUrl(app.id, s)} alt={`Application step screenshot ${s.split("/").pop()}`} loading="lazy" />
              </a>
            ))}
          </div>
        </section>
      )}

      <div className="grid two">
        <section aria-labelledby="sub-h">
          <h2 id="sub-h">Submission and email</h2>
          {app.attempts.length === 0 ? (
            <Empty>Not submitted.</Empty>
          ) : (
            app.attempts.map((a) => (
              <div className="panel small" key={a.id}>
                <Badge
                  value={
                    a.result === "SUBMITTED"
                      ? "SUBMITTED"
                      : a.result === "UNCERTAIN"
                        ? "SUBMISSION_UNCERTAIN"
                        : a.result === "FAILED"
                          ? "BLOCKER"
                          : "SUBMITTING"
                  }
                  label={a.result === "FAILED" ? "Not accepted" : a.result}
                />{" "}
                {fmtDate(a.startedAt)}
                <div className="mono muted">idempotency {a.idempotencyKey}</div>
                {a.confirmationText && <div>“{a.confirmationText}”</div>}
                {a.confirmationUrl && <div className="mono">{a.confirmationUrl}</div>}
                {a.errorMessage && <div>{a.errorMessage}</div>}
                {a.screenshotPath && <a href={fileUrl(app.id, a.screenshotPath)}>confirmation screenshot</a>}
              </div>
            ))
          )}
          {app.emails.length > 0 && (
            <ul className="small">
              {app.emails.map((e) => (
                <li key={e.id}>
                  <Badge value="MATCHED" label={e.classification} /> {e.email.subject}{" "}
                  <span className="muted">
                    ({fmtDate(e.email.receivedAt)}, {e.assignedBy})
                  </span>{" "}
                  <span className="mono muted">{e.label}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="audit-h">
          <h2 id="audit-h">Audit timeline</h2>
          <ol className="timeline small">
            {app.events.map((e) => (
              <li key={e.id}>
                <strong>{e.from === e.to ? "note" : `${e.from ?? "—"} → ${e.to}`}</strong> · {fmtDate(e.createdAt)} · {e.actor}
                <div className="muted">{e.reason}</div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="panel danger-zone" aria-labelledby="del-h">
        <h2 id="del-h" style={{ marginTop: 0 }}>
          Delete application data
        </h2>
        <form action={deleteApplicationAction} className="row">
          <input type="hidden" name="applicationId" value={app.id} />
          <label htmlFor="del-confirm">Type DELETE to remove this application&apos;s files and records</label>
          <input id="del-confirm" name="confirmation" type="text" autoComplete="off" style={{ width: "8rem" }} />
          <button type="submit" className="danger">
            Delete
          </button>
        </form>
      </section>
    </>
  );
}
