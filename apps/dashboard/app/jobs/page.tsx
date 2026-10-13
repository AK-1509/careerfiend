import Link from "next/link";
import { listJobs } from "@careerfiend/core";
import { ctx } from "@/lib/ctx";
import { fmtDate, pct } from "@/lib/format";
import { Badge, Empty, Flash } from "@/components/ui";
import { applyToJobAction } from "../actions";

const FILTERS = [
  { key: "", label: "All" },
  { key: "added", label: "Added by you" },
  { key: "found", label: "Found by watchlist" },
];

export default async function Jobs({ searchParams }: { searchParams: Promise<{ f?: string; msg?: string; error?: string }> }) {
  const sp = await searchParams;
  const jobs = await listJobs(await ctx(), sp.f || undefined);
  return (
    <>
      <h1>Jobs</h1>
      <Flash msg={sp.msg} error={sp.error} />
      <p className="muted">
        You decide where to apply. Every link you paste gets an application that the worker fills; watchlist finds wait here until you press{" "}
        <strong>Apply</strong>. The keyword match only shows how well your tailored résumé covers the listing&apos;s wording. It never stops an application.
      </p>
      <p className="row">
        {FILTERS.map((x) => (
          <Link key={x.key} href={x.key ? `/jobs?f=${x.key}` : "/jobs"} aria-current={(sp.f ?? "") === x.key ? "page" : undefined} className="button">
            {x.label}
          </Link>
        ))}
      </p>
      {jobs.length === 0 ? (
        <Empty>No jobs yet. Paste links on the Daily queue.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Company / role</th>
                <th scope="col">Location</th>
                <th scope="col">Application</th>
                <th scope="col">Keyword match</th>
                <th scope="col">Not on your résumé yet</th>
                <th scope="col">Read</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const gaps = JSON.parse(j.gaps) as string[];
                const app = j.applications.find((a) => a.state !== "CLOSED") ?? j.applications[0];
                return (
                  <tr key={j.id}>
                    <td>
                      <strong>{j.company}</strong>
                      <div>
                        <a href={j.canonicalUrl}>{j.title}</a>
                      </div>
                      <div className="small muted">{j.endorsed ? "added by you" : "found by watchlist"}</div>
                    </td>
                    <td>{j.location || "—"}</td>
                    <td>
                      {app ? (
                        <Link href={`/applications/${app.id}`}>
                          <Badge value={app.state} />
                        </Link>
                      ) : (
                        <form action={applyToJobAction}>
                          <input type="hidden" name="jobId" value={j.id} />
                          <button type="submit" className="primary" aria-label={`Apply to ${j.title} at ${j.company}`}>
                            Apply
                          </button>
                        </form>
                      )}
                    </td>
                    <td>{pct(j.coverage)}</td>
                    <td className="small">
                      {gaps.slice(0, 5).map((g, i) => (
                        <div key={i}>{g}</div>
                      ))}
                      {gaps.length > 5 && <div className="muted">+{gaps.length - 5} more</div>}
                    </td>
                    <td>{fmtDate(j.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
