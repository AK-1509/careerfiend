import Link from "next/link";
import { ATS_KINDS } from "@careerfiend/job-parser";
import { ctx } from "@/lib/ctx";
import { fmtDate } from "@/lib/format";
import { Empty, Flash } from "@/components/ui";
import { addWatchAction, pollWatchlistNowAction, toggleWatchAction } from "../actions";

export default async function Watchlist({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const sp = await searchParams;
  const rows = await (await ctx()).db.watchlistCompany.findMany({ orderBy: { name: "asc" } });
  return (
    <>
      <h1>Company watchlist</h1>
      <Flash msg={sp.msg} error={sp.error} />
      <p className="muted">
        Discovery reads only the companies&apos; public career-site feeds ({ATS_KINDS.map((k) => k.label).join(", ")}). New postings appear on the Jobs page;
        nothing is applied to until you press Apply. A <Link href="/searches">job search</Link> with &quot;Company job boards&quot; turned on also looks through
        these companies for your job title. No LinkedIn or Indeed scraping.
      </p>
      <form action={addWatchAction} className="panel">
        <div className="grid two" style={{ gap: "0.5rem", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <div>
            <label htmlFor="ats">Job board</label>
            <select id="ats" name="ats" required>
              {ATS_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} ({k.slugHelp})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="boardSlug">Board slug</label>
            <input id="boardSlug" name="boardSlug" type="text" required placeholder="e.g. acme (the <slug> part of the career-site address)" />
          </div>
          <div>
            <label htmlFor="name">Company name</label>
            <input id="name" name="name" type="text" required />
          </div>
        </div>
        <button type="submit" style={{ marginTop: "0.6rem" }}>
          Add company
        </button>
      </form>
      <form action={pollWatchlistNowAction} style={{ marginBottom: "1rem" }}>
        <button type="submit">Poll watchlist now</button>
      </form>
      {rows.length === 0 ? (
        <Empty>No companies yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Board</th>
                <th scope="col">Last polled</th>
                <th scope="col">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="mono">
                    {r.ats}/{r.boardSlug}
                  </td>
                  <td>{fmtDate(r.lastPolledAt)}</td>
                  <td>
                    <form action={toggleWatchAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <button type="submit">{r.enabled ? "Disable" : "Enable"}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
