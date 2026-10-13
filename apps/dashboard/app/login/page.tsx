import { MIN_PASSWORD_LENGTH, safeNextPath } from "@careerfiend/shared";
import { Flash } from "@/components/ui";
import { baseCtx } from "@/lib/ctx";
import { loginAction, signupAction } from "./actions";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; msg?: string; next?: string; mode?: string }> }) {
  const sp = await searchParams;
  const signupsOpen = baseCtx().config.SIGNUPS_OPEN === "true";
  const signupFirst = sp.mode === "signup" && signupsOpen;
  const signIn = (
    <section className="panel" aria-labelledby="signin-h">
      <h2 id="signin-h" style={{ marginTop: 0 }}>
        Sign in
      </h2>
      <form action={loginAction} className="stack">
        <input type="hidden" name="next" value={safeNextPath(sp.next)} />
        <div>
          <label htmlFor="li-email">Email</label>
          <input id="li-email" name="email" type="email" autoComplete="email" required autoFocus={!signupFirst} />
        </div>
        <div>
          <label htmlFor="li-password">Password</label>
          <input id="li-password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <p>
          <button type="submit" className="primary">
            Sign in
          </button>
        </p>
      </form>
      <p className="small muted">Five wrong passwords in a row lock sign-in to that account for 15 minutes.</p>
    </section>
  );
  const signUp = signupsOpen ? (
    <section className="panel" aria-labelledby="signup-h">
      <h2 id="signup-h" style={{ marginTop: 0 }}>
        Create an account
      </h2>
      <form action={signupAction} className="stack">
        <div>
          <label htmlFor="su-email">Email</label>
          <input id="su-email" name="email" type="email" autoComplete="email" required autoFocus={signupFirst} />
        </div>
        <div>
          <label htmlFor="su-password">Password (at least {MIN_PASSWORD_LENGTH} characters)</label>
          <input id="su-password" name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required />
        </div>
        <div>
          <label htmlFor="su-confirm">Repeat password</label>
          <input id="su-confirm" name="confirm" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required />
        </div>
        <p>
          <button type="submit" className="primary">
            Create account
          </button>
        </p>
      </form>
      <p className="small muted">Your data is kept in its own space, separate from every other account, and you can delete all of it at any time.</p>
    </section>
  ) : (
    <section className="panel">
      <p>New sign-ups are closed on this site.</p>
    </section>
  );
  return (
    <div className="landing">
      <h1 style={{ marginBottom: "0.3rem" }}>Tailored résumés for every job you apply to</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Upload your résumé once. Send CareerFiend the application links of jobs you want, and it builds a résumé and cover letter tailored to each listing,
        using only what your résumé says, and tracks every application. Connect your own AI model for project ideas that prove you can do what those jobs ask.
      </p>
      <Flash msg={sp.msg} error={sp.error} />
      <div className="grid two">
        {signupFirst ? signUp : signIn}
        {signupFirst ? signIn : signUp}
      </div>
      <section className="panel" aria-labelledby="how-h" style={{ marginTop: "1rem" }}>
        <h2 id="how-h" style={{ marginTop: 0 }}>
          How it works
        </h2>
        <ol>
          <li>Upload your résumé PDF (or type your experience and projects on the Profile page).</li>
          <li>Optionally connect a language model of your choice, or skip.</li>
          <li>
            Paste application links. <strong>LinkedIn and Indeed links don&apos;t work</strong>: follow the listing on those sites to the employer&apos;s
            application page and send that link instead.
          </li>
          <li>Download the tailored résumé and cover letter, apply on the employer&apos;s site, and mark it applied to track it.</li>
        </ol>
      </section>
    </div>
  );
}
