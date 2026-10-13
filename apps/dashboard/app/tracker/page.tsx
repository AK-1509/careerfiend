import Link from "next/link";
import { BUCKET_LABELS, BUCKETS, listApplications } from "@careerfiend/core";
import { APPLICATION_STATES } from "@careerfiend/shared";
import { ctx } from "@/lib/ctx";
import { fmtDate, pct } from "@/lib/format";
import { Badge, Empty, Flash } from "@/components/ui";

export default async function Tracker({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const rows = await listApplications(await ctx(), {
    q: sp.q || undefined,
    bucket: sp.bucket || undefined,
    state: sp.state || undefined,
    source: sp.source || undefined,
    from: sp.from ? new Date(sp.from) : undefined,
    to: sp.to ? new Date(`${sp.to}T23:59:59`) : undefined,
    emailStatus: sp.email || undefined,
  });
  return (
    <>
      <h1>Tracker</h1>
      <Flash msg={sp.msg} error={sp.error} />
      <form className="panel" role="search" aria-label="Filter applications">
        <div className="grid two" style={{ gap: "0.5rem", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <div>
            <label htmlFor="q">Company or role</label>
            <input id="q" name="q" type="text" defaultValue={sp.q} />
          </div>
          <div>
            <label htmlFor="state">State</label>
            <select id="state" name="state" defaultValue={sp.state ?? ""}>
              <option value="">Any</option>
              {APPLICATION_STATES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bucket">Group</label>
            <select id="bucket" name="bucket" defaultValue={sp.bucket ?? ""}>
              <option value="">Any</option>
              {Object.keys(BUCKETS).map((b) => (
                <option key={b} value={b}>
                  {BUCKET_LABELS[b] ?? b}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="source">Source</label>
            <select id="source" name="source" defaultValue={sp.source ?? ""}>
              <option value="">Any</option>
              {["page", "greenhouse", "lever", "ashby", "fixture", "import"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="email">Email response</label>
            <select id="email" name="email" defaultValue={sp.email ?? ""}>
              <option value="">Any</option>
              <option value="none">No email yet</option>
              {["confirmation", "action_required", "recruiter_response", "interview", "rejection", "offer", "other"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="from">From</label>
            <input id="from" name="from" type="date" defaultValue={sp.from} />
          </div>
          <div>
            <label htmlFor="to">To</label>
            <input id="to" name="to" type="date" defaultValue={sp.to} />
          </div>
        </div>
        <div className="row" style={{ marginTop: "0.6rem" }}>
          <button className="primary" type="submit">
            Filter
          </button>
          <Link href="/tracker">Clear</Link>
        </div>
      </form>
      {rows.length === 0 ? (
        <Empty>No applications match.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Role</th>
                <th scope="col">State</th>
                <th scope="col">Keyword match</th>
                <th scope="col">Email</th>
                <th scope="col">Source</th>
                <th scope="col">Created</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/applications/${r.id}`}>{r.company}</Link>
                  </td>
                  <td>{r.title}</td>
                  <td>
                    <Badge value={r.state} />
                  </td>
                  <td>{pct(r.coverage)}</td>
                  <td>{r.emailStatus ?? "—"}</td>
                  <td>{r.source}</td>
                  <td>{fmtDate(r.createdAt)}</td>
                  <td>{fmtDate(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
