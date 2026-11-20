import Link from "next/link";
import { fromJson } from "@careerfiend/db";
import { availableSources, leadAction, leadSourceLabel, listLeads, sourceInfo, sourceKeyStatus, type SourceRunStatus } from "@careerfiend/core";
import { ctx } from "@/lib/ctx";
import { fmtDate } from "@/lib/format";
import { Badge, Empty, Flash } from "@/components/ui";
import {
  deleteSearchAction,
  leadStatusAction,
  runSearchesNowAction,
  saveSearchAction,
  saveSourceKeyAction,
  tailorLeadAction,
  toggleSearchAction,
} from "../actions";

type SearchRow = {
  id: string;
  name: string;
  titles: string;
  location: string;
  remoteOnly: boolean;
  exclude: string;
  sources: string;
  enabled: boolean;
  status: string;
  lastRunAt: Date | null;
};

function SearchForm({ s, sources, keys }: { s?: SearchRow; sources: ReturnType<typeof availableSources>; keys: Record<string, string | null> }) {
  const id = s?.id ?? "new";
  const chosen = new Set(s ? fromJson<string[]>(s.sources, []) : sources.filter((x) => !x.key).map((x) => x.id));
  return (
    <form action={saveSearchAction} className="stack">
      {s && <input type="hidden" name="id" value={s.id} />}
      <div className="grid two" style={{ gap: "0.5rem" }}>
        <div>
          <label htmlFor={`${id}-titles`}>Job title, and other titles that count (one per line or comma-separated, up to 5)</label>
          <textarea
            id={`${id}-titles`}
            name="titles"
            rows={2}
            required
            defaultValue={s ? fromJson<string[]>(s.titles, []).join("\n") : ""}
            placeholder="Data analyst"
          />
        </div>
        <div>
          <label htmlFor={`${id}-location`}>Location (optional; remote jobs always count)</label>
          <input id={`${id}-location`} name="location" type="text" defaultValue={s?.location ?? ""} placeholder="e.g. Los Angeles, San Diego" />
          <label className="inline">
            <input type="checkbox" name="remoteOnly" defaultChecked={s?.remoteOnly ?? false} /> Remote jobs only
          </label>
        </div>
        <div>
          <label htmlFor={`${id}-exclude`}>Skip titles containing (optional)</label>
          <input
            id={`${id}-exclude`}
            name="exclude"
            type="text"
            defaultValue={s ? fromJson<string[]>(s.exclude, []).join(", ") : ""}
            placeholder="e.g. senior, director, intern"
          />
        </div>
        <div>
          <label htmlFor={`${id}-name`}>Name for this search (optional)</label>
          <input id={`${id}-name`} name="name" type="text" defaultValue={s?.name ?? ""} />
        </div>
      </div>
      <fieldset>
        <legend>Where to look</legend>
        {sources.map((src) => {
          const needsKey = !!src.key && !keys[src.key];
          return (
            <label key={src.id} className="inline" style={{ display: "block" }}>
              <input type="checkbox" name="sources" value={src.id} defaultChecked={chosen.has(src.id)} /> <strong>{src.label}</strong>{" "}
              <span className="small muted">
                {src.covers}
                {needsKey ? " (needs your free key, below)" : ""}
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="row">
        <button type="submit" className="primary">
          {s ? "Save" : "Start looking"}
        </button>
      </div>
    </form>
  );
}

export default async function Searches({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string; show?: string }> }) {
  const sp = await searchParams;
  const c = await ctx();
  const showAll = sp.show === "all";
  const [searches, leads, keys] = await Promise.all([
    c.db.savedSearch.findMany({ orderBy: { createdAt: "asc" } }),
    listLeads(c, { status: showAll ? undefined : ["NEW", "SEEN"] }),
    sourceKeyStatus(c),
  ]);
  const sources = availableSources(c);
  const nameOf = new Map(searches.map((s) => [s.id, s.name]));
  const fresh = leads.filter((l) => l.status === "NEW").length;
  return (
    <>
      <h1>Job search</h1>
      <Flash msg={sp.msg} error={sp.error} />
      <p className="muted">
        Save a job title and CareerFiend keeps looking for it, every hour, on every source whose terms allow automated search. New matches appear below as
        leads; nothing is applied to until you choose one. Each source is asked at most as often as its terms allow, and one answer is shared by everyone
        searching for the same thing.
      </p>
      <div className="callout warn" role="note">
        <strong>LinkedIn, Indeed, Glassdoor and Handshake are not searched:</strong> their terms forbid automated access. To follow jobs there, turn on their
        job-alert emails, follow a listing to the employer&apos;s application page, and paste that link on the Applications page.
      </div>

      <section aria-labelledby="leads-h">
        <h2 id="leads-h">Leads {fresh > 0 && <Badge value="READY_FOR_REVIEW" label={`${fresh} new`} />}</h2>
        <p className="small">
          <Link href={showAll ? "/searches" : "/searches?show=all"}>{showAll ? "Hide tailored and dismissed" : "Show tailored and dismissed too"}</Link>
          {" · "}
          <form action={runSearchesNowAction} className="inline-form">
            <button type="submit" className="link small">
              Check now
            </button>
          </form>
        </p>
        {leads.length === 0 ? (
          <Empty>{searches.length ? "No leads yet. The first check runs within a minute or two of saving a search." : "Save a search below to start."}</Empty>
        ) : (
          <ol className="answers">
            {leads.map((l) => {
              const action = leadAction(l);
              return (
                <li key={l.id}>
                  <div className="entry-head">
                    <strong>{l.title}</strong>
                    <span>{l.company}</span>
                    <span className="small muted">
                      {[l.location, l.compensation, l.postedAt ? `posted ${fmtDate(l.postedAt)}` : null].filter(Boolean).join(" · ")}
                    </span>
                    {l.status === "NEW" && <Badge value="READY_FOR_REVIEW" label="New" />}
                    {l.status === "TAILORED" && <Badge value="SUBMITTED" label="Tailored" />}
                    {l.status === "DISMISSED" && <Badge value="CLOSED" label="Dismissed" />}
                  </div>
                  <div className="small muted">
                    Found by &quot;{nameOf.get(l.searchId) ?? "search"}&quot; on {fmtDate(l.foundAt)} · via{" "}
                    <a href={l.url} target="_blank" rel="noopener">
                      {leadSourceLabel(l.source)}
                    </a>
                  </div>
                  {l.status !== "TAILORED" && (
                    <div className="row" style={{ marginTop: "0.35rem" }}>
                      {action === "paste-link" ? (
                        <form action={tailorLeadAction} className="row">
                          <input type="hidden" name="leadId" value={l.id} />
                          <label className="sr-only" htmlFor={`url-${l.id}`}>
                            Application link for {l.title}
                          </label>
                          <input
                            id={`url-${l.id}`}
                            name="url"
                            type="url"
                            required
                            placeholder="Open the listing, then paste the application link"
                            style={{ maxWidth: "26rem" }}
                          />
                          <button type="submit">Tailor</button>
                        </form>
                      ) : (
                        <form action={tailorLeadAction}>
                          <input type="hidden" name="leadId" value={l.id} />
                          <button type="submit" className="primary">
                            Tailor my résumé
                          </button>
                        </form>
                      )}
                      <a className="button" href={l.url} target="_blank" rel="noopener">
                        Open listing
                      </a>
                      {l.status !== "DISMISSED" && (
                        <form action={leadStatusAction}>
                          <input type="hidden" name="leadId" value={l.id} />
                          <input type="hidden" name="status" value="DISMISSED" />
                          <button type="submit">Dismiss</button>
                        </form>
                      )}
                    </div>
                  )}
                  {l.status === "TAILORED" && l.jobId && <p className="small">Its application is on the Applications page.</p>}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="searches-h">
        <h2 id="searches-h">Your searches ({searches.length})</h2>
        {searches.map((s) => {
          const status = fromJson<Record<string, SourceRunStatus>>(s.status, {});
          return (
            <details key={s.id} className="panel">
              <summary>
                <span className="entry-head">
                  <strong>{s.name}</strong>
                  <span className="small muted">
                    {fromJson<string[]>(s.titles, []).join(" / ")}
                    {s.location ? ` · ${s.location}` : ""}
                    {s.remoteOnly ? " · remote only" : ""} · {s.lastRunAt ? `checked ${fmtDate(s.lastRunAt)}` : "first check pending"}
                  </span>
                  {!s.enabled && <Badge value="WARNING" label="Paused" />}
                </span>
              </summary>
              {Object.keys(status).length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Source</th>
                        <th scope="col">Matching</th>
                        <th scope="col">New</th>
                        <th scope="col">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(status).map(([src, st]) => (
                        <tr key={src}>
                          <td>{sourceInfo(src)?.label ?? src}</td>
                          <td>{st.matched}</td>
                          <td>{st.added}</td>
                          <td className="small muted">{st.note ?? "ok"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <SearchForm s={s} sources={sources} keys={keys} />
              <div className="row" style={{ marginTop: "0.5rem" }}>
                <form action={toggleSearchAction}>
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="enabled" value={s.enabled ? "false" : "true"} />
                  <button type="submit">{s.enabled ? "Pause" : "Resume"}</button>
                </form>
                <form action={deleteSearchAction}>
                  <input type="hidden" name="id" value={s.id} />
                  <button type="submit" className="danger">
                    Delete search
                  </button>
                </form>
              </div>
            </details>
          );
        })}
        <details className="panel" open={searches.length === 0}>
          <summary>New search</summary>
          <SearchForm sources={sources} keys={keys} />
        </details>
      </section>

      <section className="panel" aria-labelledby="keys-h">
        <h2 id="keys-h" style={{ marginTop: 0 }}>
          Sources that need your own free key
        </h2>
        <p className="small muted">
          Their terms are per key and per person, so each person uses their own. Keys are encrypted with your account&apos;s key and used only for your
          searches. Leave the fields empty and save to remove a key.
        </p>
        <form action={saveSourceKeyAction} className="stack">
          <input type="hidden" name="source" value="adzuna" />
          <h3>Adzuna {keys.adzuna && <Badge value="SUBMITTED" label={`Connected: ${keys.adzuna}`} />}</h3>
          <p className="small muted">
            Free key at{" "}
            <a href="https://developer.adzuna.com" target="_blank" rel="noopener">
              developer.adzuna.com
            </a>
            . Results are credited to Adzuna.
          </p>
          <div className="grid two" style={{ gap: "0.5rem" }}>
            <div>
              <label htmlFor="adz-id">App ID</label>
              <input id="adz-id" name="appId" type="text" autoComplete="off" />
            </div>
            <div>
              <label htmlFor="adz-key">App key</label>
              <input id="adz-key" name="appKey" type="password" autoComplete="off" />
            </div>
            <div>
              <label htmlFor="adz-country">Country code (us, gb, ca, au, de, fr, in…)</label>
              <input id="adz-country" name="country" type="text" defaultValue="us" />
            </div>
          </div>
          <p>
            <button type="submit">Save Adzuna key</button>
          </p>
        </form>
        <form action={saveSourceKeyAction} className="stack">
          <input type="hidden" name="source" value="usajobs" />
          <h3>USAJOBS {keys.usajobs && <Badge value="SUBMITTED" label={`Connected: ${keys.usajobs}`} />}</h3>
          <p className="small muted">
            Free key at{" "}
            <a href="https://developer.usajobs.gov" target="_blank" rel="noopener">
              developer.usajobs.gov
            </a>
            . Their API requires the email you registered with to be sent along with the key.
          </p>
          <div className="grid two" style={{ gap: "0.5rem" }}>
            <div>
              <label htmlFor="usa-key">API key</label>
              <input id="usa-key" name="key" type="password" autoComplete="off" />
            </div>
            <div>
              <label htmlFor="usa-email">Email you registered the key with</label>
              <input id="usa-email" name="email" type="email" autoComplete="off" />
            </div>
          </div>
          <p>
            <button type="submit">Save USAJOBS key</button>
          </p>
        </form>
        <form action={saveSourceKeyAction} className="stack">
          <input type="hidden" name="source" value="jooble" />
          <h3>Jooble {keys.jooble && <Badge value="SUBMITTED" label={`Connected: ${keys.jooble}`} />}</h3>
          <p className="small muted">
            Free key at{" "}
            <a href="https://jooble.org/api/about" target="_blank" rel="noopener">
              jooble.org/api/about
            </a>
            .
          </p>
          <div>
            <label htmlFor="jooble-key">API key</label>
            <input id="jooble-key" name="key" type="password" autoComplete="off" style={{ maxWidth: "26rem" }} />
          </div>
          <p>
            <button type="submit">Save Jooble key</button>
          </p>
        </form>
      </section>

      <section aria-labelledby="terms-h">
        <h2 id="terms-h">Sources and their terms</h2>
        <ul className="small">
          {sources.map((s) => (
            <li key={s.id}>
              <strong>
                {s.site ? (
                  <a href={s.site} target="_blank" rel="noopener">
                    {s.label}
                  </a>
                ) : (
                  s.label
                )}
              </strong>
              : {s.terms}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
