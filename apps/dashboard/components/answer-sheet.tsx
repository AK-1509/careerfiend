import Link from "next/link";
import type { AnswerSheetView } from "@careerfiend/core";
import { askQuestionAction, removeAskedQuestionAction } from "@/app/actions";
import { CopyButton } from "./copy-button";
import { Badge } from "./ui";

/** Answers for the application form, ready to copy and paste (CareerFiend never fills the form itself). */
export function AnswerSheet({ applicationId, sheet, aiConnected }: { applicationId: string; sheet: AnswerSheetView; aiConnected: boolean }) {
  const answered = sheet.rows.filter((r) => r.answer !== null).length;
  return (
    <section className="panel" aria-labelledby="answers-h">
      <h2 id="answers-h" style={{ marginTop: 0 }}>
        Answers for the application form
      </h2>
      <p className="small muted">
        {sheet.source === "form" ? (
          <>
            Read from{" "}
            {sheet.formUrl ? (
              <a href={sheet.formUrl} target="_blank" rel="noreferrer">
                the application form
              </a>
            ) : (
              "the application form"
            )}{" "}
            (nothing was typed into it).{" "}
          </>
        ) : (
          <>{sheet.note ?? "The usual application questions."} </>
        )}
        {answered} of {sheet.rows.length} answered. Copy each answer into the form; check every one before you submit.
        {sheet.source === "form" && sheet.note ? ` ${sheet.note}` : ""}
      </p>
      <ol className="answers">
        {sheet.rows.map((r) => (
          <li key={r.fieldKey}>
            <div className="entry-head">
              <strong>{r.question}</strong>
              {r.required && <span className="small muted">required</span>}
              {r.sensitive && <Badge value="SENSITIVE_PENDING" label="Your call" />}
              {r.origin === "asked" && (
                <form action={removeAskedQuestionAction} className="inline-form">
                  <input type="hidden" name="applicationId" value={applicationId} />
                  <input type="hidden" name="fieldKey" value={r.fieldKey} />
                  <button type="submit" className="link small">
                    Remove
                  </button>
                </form>
              )}
            </div>
            {r.options.length > 0 && <div className="small muted">Options: {r.options.join(" · ")}</div>}
            {r.answer !== null ? (
              <div className="answer">
                <p className="answer-text">{r.answer}</p>
                <div className="row">
                  <CopyButton text={r.answer} label={r.question} />
                  {r.from && <span className="small muted">{r.from}</span>}
                </div>
                {r.note && <p className="small muted">{r.note}</p>}
              </div>
            ) : (
              <p className="small muted">
                {r.note}
                {r.from && ` (${r.from})`}
              </p>
            )}
          </li>
        ))}
      </ol>
      <form action={askQuestionAction} className="stack" style={{ marginTop: "0.75rem" }}>
        <input type="hidden" name="applicationId" value={applicationId} />
        <label htmlFor="ask-q">Another question on the form? Paste it here for an answer (forms with several pages show more questions as you go).</label>
        <textarea id="ask-q" name="question" rows={2} required placeholder="e.g. Describe a time you improved a process." />
        <div className="row">
          <button type="submit">Get an answer</button>
          {!aiConnected && (
            <span className="small muted">
              Open questions need a language model: <Link href="/settings">connect one</Link>.
            </span>
          )}
        </div>
      </form>
      <p className="small muted">
        Phone, work authorization, sponsorship, salary and similar answers come from your <Link href="/profile#saved-answers">saved answers</Link>.
      </p>
    </section>
  );
}
