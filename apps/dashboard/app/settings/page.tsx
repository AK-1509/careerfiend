import { lmState } from "@careerfiend/core";
import { MIN_PASSWORD_LENGTH } from "@careerfiend/shared";
import { ctx } from "@/lib/ctx";
import { fmtDate } from "@/lib/format";
import { Badge, Flash } from "@/components/ui";
import { LmConnectForm } from "@/components/lm-form";
import { changePasswordAction, deleteAccountAction, disconnectLmAction } from "../actions";

export default async function Settings({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const sp = await searchParams;
  const c = await ctx();
  const lm = await lmState(c);
  return (
    <>
      <h1>Settings</h1>
      <Flash msg={sp.msg} error={sp.error} />

      <section className="panel" aria-labelledby="lm-h">
        <h2 id="lm-h" style={{ marginTop: 0 }}>
          Language model
        </h2>
        {lm.status === "connected" ? (
          <>
            <p>
              <Badge value="SUBMITTED" label="Connected" /> {lm.providerLabel}, model <code>{lm.model}</code>
              {lm.fastModel && (
                <>
                  {" "}
                  (fast model <code>{lm.fastModel}</code>)
                </>
              )}
              {lm.baseUrl && (
                <>
                  {" "}
                  at <code>{lm.baseUrl}</code>
                </>
              )}
              , key {lm.keyHint}, since {fmtDate(lm.connectedAt)}.
            </p>
            <p className="small muted">
              Used for Project Recommendations, and to sharpen requirement reading, tailored bullets, cover letters and the reading of your résumé PDF. Every
              answer is checked by code: nothing the model writes reaches your documents unless it is backed by a line of your résumé.
            </p>
            <form action={disconnectLmAction} className="row">
              <button type="submit">Disconnect and delete the key</button>
            </form>
            <details style={{ marginTop: "0.75rem" }}>
              <summary>Switch to another provider or model</summary>
              <LmConnectForm back="/settings" showSkip={false} />
            </details>
          </>
        ) : (
          <>
            <p>
              {lm.status === "skipped" ? <Badge value="QUEUED" label="Not connected (skipped)" /> : <Badge value="WARNING" label="Not connected" />} Connect the
              model of your choice to turn on Project Recommendations. Without one, résumés and cover letters are still tailored, using the built-in rules.
            </p>
            <LmConnectForm back="/settings" showSkip={lm.status === "undecided"} />
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="acct-h">
        <h2 id="acct-h" style={{ marginTop: 0 }}>
          Account
        </h2>
        <p>
          Signed in as <strong>{c.account?.email}</strong>.
        </p>
        <form action={changePasswordAction} className="stack" style={{ maxWidth: "26rem" }}>
          <h3>Change password</h3>
          <div>
            <label htmlFor="pw-cur">Current password</label>
            <input id="pw-cur" name="current" type="password" autoComplete="current-password" required />
          </div>
          <div>
            <label htmlFor="pw-new">New password (at least {MIN_PASSWORD_LENGTH} characters)</label>
            <input id="pw-new" name="next" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required />
          </div>
          <div>
            <label htmlFor="pw-confirm">Repeat new password</label>
            <input id="pw-confirm" name="confirm" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required />
          </div>
          <p>
            <button type="submit">Change password</button>
          </p>
        </form>
      </section>

      <section className="panel danger-zone" aria-labelledby="del-h">
        <h2 id="del-h" style={{ marginTop: 0 }}>
          Delete account
        </h2>
        <p className="small">
          Deletes your account and everything in it: your résumé and uploads, applications, generated documents, skills, project ideas and your language model
          key. This cannot be undone.
        </p>
        <form action={deleteAccountAction} className="stack" style={{ maxWidth: "26rem" }}>
          <div>
            <label htmlFor="del-pw">Password</label>
            <input id="del-pw" name="password" type="password" autoComplete="current-password" required />
          </div>
          <div>
            <label htmlFor="del-confirm">Type DELETE to confirm</label>
            <input id="del-confirm" name="confirmation" type="text" required pattern="DELETE" />
          </div>
          <p>
            <button type="submit" className="danger">
              Delete my account
            </button>
          </p>
        </form>
      </section>
    </>
  );
}
