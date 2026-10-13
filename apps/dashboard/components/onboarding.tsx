import Link from "next/link";
import type { LmState } from "@careerfiend/core";
import { uploadResumeAction } from "@/app/actions";
import { LmConnectForm } from "./lm-form";

/** First-run steps on the Daily queue: add a résumé, then connect a language model or skip. */
export function Onboarding({ hasResume, lm, maxMb }: { hasResume: boolean; lm: LmState; maxMb: number }) {
  if (hasResume && lm.status !== "undecided") return null;
  return (
    <section className="panel accent" aria-labelledby="start-h">
      <h2 id="start-h" style={{ marginTop: 0 }}>
        Get started
      </h2>
      <ol className="steps">
        <li className={hasResume ? "done" : ""}>
          <h3>1. Add your résumé {hasResume && <span className="badge ok">Done</span>}</h3>
          {!hasResume && (
            <>
              <p className="small">
                Upload your résumé as a PDF. CareerFiend reads it, keeps it, and builds every tailored résumé from its lines. You can correct anything, or add
                experience and projects by hand, on the <Link href="/profile">Profile</Link> page.
              </p>
              <form action={uploadResumeAction} className="row">
                <input type="hidden" name="back" value="/" />
                <label className="sr-only" htmlFor="resume-onb">
                  Résumé PDF
                </label>
                <input id="resume-onb" name="resume" type="file" accept="application/pdf,.pdf" required />
                <button type="submit" className="primary">
                  Upload and read
                </button>
                <span className="small muted">PDF, up to {maxMb} MB. Scanned images can&apos;t be read.</span>
              </form>
              <p className="small">
                No PDF handy? <Link href="/profile">Fill out your profile by hand</Link> instead.
              </p>
            </>
          )}
        </li>
        <li className={lm.status !== "undecided" ? "done" : ""}>
          <h3>2. Connect a language model (optional)</h3>
          {lm.status === "undecided" ? (
            <>
              <p className="small">
                Connect the AI model of your choice to turn on <strong>Project Recommendations</strong>: small projects you could build that prove you can do
                what your saved jobs ask for. The same model also sharpens your tailored résumé bullets, cover letters and the reading of your PDF. Bring your
                own API key from Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, DeepSeek, Mistral or any OpenAI-compatible service.
              </p>
              <LmConnectForm back="/" showSkip />
            </>
          ) : (
            <p className="small">Done.</p>
          )}
        </li>
      </ol>
    </section>
  );
}

/** The warning shown wherever job links are pasted. */
export function JobBoardWarning() {
  return (
    <div className="callout warn" role="note">
      <strong>LinkedIn and Indeed links don&apos;t work.</strong> Open the listing on LinkedIn or Indeed, follow it to the employer&apos;s application page
      (click <em>Apply</em> or <em>Apply on company site</em>), and send that link instead. Links from the employer&apos;s careers site, Greenhouse, Lever,
      Ashby, Workday and similar application pages work.
    </div>
  );
}
