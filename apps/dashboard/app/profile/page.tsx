import Link from "next/link";
import { currentFacts, getProfileValues, type Experience, type Resume } from "@careerfiend/profile";
import { fromJson } from "@careerfiend/db";
import { getResume, listUploads } from "@careerfiend/core";
import { ctx } from "@/lib/ctx";
import { fmtDate } from "@/lib/format";
import { Badge, Empty, Flash } from "@/components/ui";
import {
  deleteEntryAction,
  moveEntryAction,
  saveContactAction,
  saveEntryAction,
  saveSkillsAction,
  setGithubUserAction,
  setProfileValueAction,
  startBlankResumeAction,
  uploadResumeAction,
} from "../actions";

const SECTIONS: { type: Experience["type"]; label: string; titleLabel: string; orgLabel: string }[] = [
  { type: "work", label: "Experience", titleLabel: "Job title", orgLabel: "Organization" },
  { type: "project", label: "Projects", titleLabel: "Project name", orgLabel: "Client or organization (optional)" },
  { type: "education", label: "Education", titleLabel: "Degree or program", orgLabel: "School" },
];

function EntryForm({ e, type, titleLabel, orgLabel }: { e?: Experience; type: Experience["type"]; titleLabel: string; orgLabel: string }) {
  const id = e?.id ?? `new-${type}`;
  return (
    <form action={saveEntryAction} className="stack">
      {e && <input type="hidden" name="id" value={e.id} />}
      <input type="hidden" name="type" value={type} />
      <div className="grid two" style={{ gap: "0.5rem" }}>
        <div>
          <label htmlFor={`${id}-title`}>{titleLabel}</label>
          <input id={`${id}-title`} name="title" type="text" defaultValue={e?.title} required />
        </div>
        <div>
          <label htmlFor={`${id}-org`}>{orgLabel}</label>
          <input id={`${id}-org`} name="organization" type="text" defaultValue={e?.organization} />
        </div>
        <div>
          <label htmlFor={`${id}-loc`}>Location (optional)</label>
          <input id={`${id}-loc`} name="location" type="text" defaultValue={e?.location} placeholder="City, ST or Remote" />
        </div>
        <div>
          <label htmlFor={`${id}-url`}>Link (optional)</label>
          <input id={`${id}-url`} name="url" type="url" defaultValue={e?.url} placeholder="https://" />
        </div>
        <div>
          <label htmlFor={`${id}-start`}>Start</label>
          <input id={`${id}-start`} name="start" type="text" defaultValue={e?.startDate} placeholder="2023-01, Jan 2023 or 2023" />
        </div>
        <div>
          <label htmlFor={`${id}-end`}>End</label>
          <input id={`${id}-end`} name="end" type="text" defaultValue={e?.endDate ?? ""} placeholder="2024-05, May 2024 or 2024" />
          <label className="inline">
            <input type="checkbox" name="present" defaultChecked={e ? e.endDate === null : false} /> Ongoing (present)
          </label>
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-bullets`}>What you did: one bullet per line, written as you want it on your résumé</label>
        <textarea id={`${id}-bullets`} name="bullets" rows={Math.max(4, (e?.responsibilities.length ?? 0) + 1)} defaultValue={e?.responsibilities.join("\n")} />
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Tailored résumés reorder these lines and may reword one toward a listing&apos;s wording, but every fact must come from what you write here.
      </p>
      <div className="row">
        <button type="submit" className="primary">
          {e ? "Save" : "Add"}
        </button>
      </div>
    </form>
  );
}

function ResumeEditor({ resume }: { resume: Resume }) {
  const p = resume.profile;
  const skillsOf = (cat: string) =>
    resume.skills
      .filter((s) => s.category === cat)
      .map((s) => s.label)
      .join(", ");
  return (
    <>
      <section className="panel" aria-labelledby="contact-h">
        <h2 id="contact-h" style={{ marginTop: 0 }}>
          Name and contact
        </h2>
        <form action={saveContactAction} className="stack">
          <div className="grid two" style={{ gap: "0.5rem" }}>
            <div>
              <label htmlFor="p-name">Name</label>
              <input id="p-name" name="name" type="text" defaultValue={p.name} required />
            </div>
            <div>
              <label htmlFor="p-email">Email on your résumé</label>
              <input id="p-email" name="email" type="email" defaultValue={p.email} required />
            </div>
            <div>
              <label htmlFor="p-headline">Headline (optional, one line under your name)</label>
              <input id="p-headline" name="headline" type="text" defaultValue={p.headline} />
            </div>
            <div>
              <label htmlFor="p-location">Location (optional)</label>
              <input id="p-location" name="location" type="text" defaultValue={p.location} placeholder="City, ST" />
            </div>
          </div>
          <div>
            <label htmlFor="p-links">Links, one per line (optionally &quot;Label | https://…&quot;)</label>
            <textarea id="p-links" name="links" rows={3} defaultValue={p.links.map((l) => `${l.label} | ${l.url}`).join("\n")} />
          </div>
          <div className="row">
            <button type="submit" className="primary">
              Save
            </button>
          </div>
        </form>
      </section>

      {SECTIONS.map((sec) => {
        const entries = resume.experiences.filter((e) => e.type === sec.type);
        return (
          <section key={sec.type} aria-labelledby={`sec-${sec.type}`}>
            <h2 id={`sec-${sec.type}`}>
              {sec.label} ({entries.length})
            </h2>
            {entries.length === 0 && <Empty>None yet.</Empty>}
            {entries.map((e, i) => (
              <details key={e.id} className="panel">
                <summary>
                  <span className="entry-head">
                    <strong>{e.title}</strong>
                    {e.organization && <span>{e.organization}</span>}
                    <span className="small muted">
                      {[e.startDate, e.endDate === null ? "present" : e.endDate].filter(Boolean).join(" – ") || "no dates"} · {e.responsibilities.length} line
                      {e.responsibilities.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </summary>
                <EntryForm e={e} type={sec.type} titleLabel={sec.titleLabel} orgLabel={sec.orgLabel} />
                <div className="row" style={{ marginTop: "0.5rem" }}>
                  {i > 0 && (
                    <form action={moveEntryAction}>
                      <input type="hidden" name="id" value={e.id} />
                      <input type="hidden" name="dir" value="up" />
                      <button type="submit">Move up</button>
                    </form>
                  )}
                  {i < entries.length - 1 && (
                    <form action={moveEntryAction}>
                      <input type="hidden" name="id" value={e.id} />
                      <input type="hidden" name="dir" value="down" />
                      <button type="submit">Move down</button>
                    </form>
                  )}
                  <form action={deleteEntryAction}>
                    <input type="hidden" name="id" value={e.id} />
                    <button type="submit" className="danger">
                      Remove entry
                    </button>
                  </form>
                </div>
              </details>
            ))}
            <details className="panel">
              <summary>Add to {sec.label.toLowerCase()}</summary>
              <EntryForm type={sec.type} titleLabel={sec.titleLabel} orgLabel={sec.orgLabel} />
            </details>
          </section>
        );
      })}

      <section className="panel" aria-labelledby="skills-h">
        <h2 id="skills-h" style={{ marginTop: 0 }}>
          Skills and languages
        </h2>
        <p className="small muted">
          Comma-separated or one per line. Skills listed here are verified from your résumé; each counts for every entry whose lines mention it.
        </p>
        <form action={saveSkillsAction} className="stack">
          <div className="grid two" style={{ gap: "0.5rem" }}>
            <div>
              <label htmlFor="sk-tech">Technical (tools, software, methods)</label>
              <textarea id="sk-tech" name="technical" rows={3} defaultValue={skillsOf("technical")} />
            </div>
            <div>
              <label htmlFor="sk-domain">Domain knowledge</label>
              <textarea id="sk-domain" name="domain" rows={3} defaultValue={skillsOf("domain")} />
            </div>
            <div>
              <label htmlFor="sk-soft">Interpersonal</label>
              <textarea id="sk-soft" name="soft" rows={3} defaultValue={skillsOf("soft")} />
            </div>
            <div>
              <label htmlFor="sk-lang">Spoken languages</label>
              <textarea id="sk-lang" name="languages" rows={3} defaultValue={resume.languages.join(", ")} />
            </div>
          </div>
          <div className="row">
            <button type="submit" className="primary">
              Save skills
            </button>
          </div>
        </form>
      </section>
    </>
  );
}

export default async function Profile({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const sp = await searchParams;
  const c = await ctx();
  const [current, uploads, facts, values, githubUser] = await Promise.all([
    getResume(c),
    listUploads(c),
    currentFacts(c.db),
    getProfileValues(c.db, c.key()),
    c.db.setting.findUnique({ where: { key: "profile.githubUser" } }),
  ]);
  const formFilling = c.config.FORM_FILLING === "on";
  return (
    <>
      <h1>Profile</h1>
      <Flash msg={sp.msg} error={sp.error} />

      <section className="panel" aria-labelledby="src-h">
        <h2 id="src-h" style={{ marginTop: 0 }}>
          Your résumé
        </h2>
        {current ? (
          <p>
            Version {current.version}, {current.origin === "profile" ? "last edited on this page" : "read from your uploaded PDF"} {fmtDate(current.updatedAt)}:{" "}
            {current.resume.experiences.length} entries, {current.resume.skills.length} skills. Every tailored résumé is built from it.
          </p>
        ) : (
          <p>No résumé yet. Upload your PDF, or start a blank profile and type your experience and projects.</p>
        )}
        <form action={uploadResumeAction} className="row">
          <label htmlFor="resume-file">{current ? "Replace with a new PDF:" : "Résumé PDF:"}</label>
          <input id="resume-file" name="resume" type="file" accept="application/pdf,.pdf" required style={{ maxWidth: "22rem" }} />
          <button type="submit" className="primary">
            Upload and read
          </button>
        </form>
        <p className="small muted">
          Up to {c.config.MAX_UPLOAD_MB} MB. Uploading replaces the résumé below with what the new PDF says (a new version; earlier applications keep the
          version they were built from). Your edits on this page are not merged into a new upload.
        </p>
        {!current && (
          <form action={startBlankResumeAction} className="row">
            <label htmlFor="blank-name">Or start blank. Your name:</label>
            <input id="blank-name" name="name" type="text" required style={{ maxWidth: "16rem" }} />
            <button type="submit">Start blank profile</button>
          </form>
        )}
        {uploads.length > 0 && (
          <details style={{ marginTop: "0.5rem" }}>
            <summary className="small">Uploaded PDFs ({uploads.length})</summary>
            <ul className="small">
              {uploads.map((u) => (
                <li key={u.id}>
                  <a href={`/api/resume?id=${u.id}`}>{u.fileName}</a> · {fmtDate(u.createdAt)} · {Math.round(u.size / 1024)} KB ·{" "}
                  {u.status === "PARSED"
                    ? u.method === "rules+model"
                      ? "read with your language model"
                      : "read with the built-in reader"
                    : "could not be read"}
                  {fromJson<string[]>(u.notes, []).length > 0 && <span className="muted"> — {fromJson<string[]>(u.notes, []).join(" ")}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {current && <ResumeEditor resume={current.resume} />}

      <section className="panel" aria-labelledby="gh-h">
        <h2 id="gh-h" style={{ marginTop: 0 }}>
          GitHub projects (optional)
        </h2>
        <p className="small muted">
          Your public, non-fork repositories can back skills from listings you saved (see <Link href="/bank">Skill bank</Link>) and give Project Recommendations
          a real angle. Only public data is read.
        </p>
        <form action={setGithubUserAction} className="row">
          <label htmlFor="gh-user">GitHub user name</label>
          <input id="gh-user" name="githubUser" type="text" defaultValue={githubUser?.value ?? ""} style={{ maxWidth: "16rem" }} />
          <button type="submit">Save</button>
        </form>
      </section>

      <section aria-labelledby="vals-h" id="saved-answers">
        <h2 id="vals-h">Saved answers for application forms</h2>
        <p className="small muted">
          Phone, work authorization, sponsorship, salary, start date and similar answers that are not on your résumé. Type each and press Save: they appear in
          every application&apos;s answer sheet{formFilling ? " and fill forms" : ""}. Sensitive ones are encrypted. Blank ones stay for you to answer each
          time.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Question</th>
                <th scope="col">Answer</th>
                <th scope="col">Status</th>
                <th scope="col">Set</th>
              </tr>
            </thead>
            <tbody>
              {values.map((v) => (
                <tr key={v.key}>
                  <td>
                    {v.label} {v.sensitive && <Badge value="SENSITIVE_PENDING" label="Sensitive (encrypted)" />}
                  </td>
                  <td>{v.value ?? <span className="muted">blank: you answer it each time</span>}</td>
                  <td>
                    <Badge value={v.status} />
                  </td>
                  <td>
                    <form action={setProfileValueAction} className="row">
                      <input type="hidden" name="key" value={v.key} />
                      <label className="sr-only" htmlFor={`v-${v.key}`}>
                        {v.label}
                      </label>
                      <input id={`v-${v.key}`} name="value" type="text" style={{ width: "12rem" }} />
                      <button type="submit">Save</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {facts.length > 0 && (
        <details className="panel">
          <summary>Facts CareerFiend may use ({facts.length})</summary>
          <p className="muted small">Every line of a tailored résumé or cover letter traces back to one of these, by the key shown.</p>
          <ul className="small">
            {facts.map((f) => (
              <li key={f.id}>
                {f.text} <span className="mono muted">[{f.key}]</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
