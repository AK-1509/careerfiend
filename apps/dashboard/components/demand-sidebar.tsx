import type { DemandView } from "@careerfiend/core";
import { fmtDate } from "@/lib/format";
import { Badge } from "@/components/ui";
import { AutoRefresh } from "@/components/auto-refresh";
import { rebuildDemandAction } from "@/app/actions";

const GROUPS = [
  { status: "not_shown", title: "Not on your résumé yet", hint: "Demonstrate these: a project, a bullet, or a skill to confirm." },
  { status: "transferable", title: "Transferable", hint: "In your skill bank and linked to your experience; make it explicit on the résumé." },
  { status: "shown", title: "Already shown", hint: "Your résumé or confirmed skills show these." },
] as const;

const TONE = { not_shown: "WARNING", transferable: "TRANSFERABLE", shown: "COVERED" } as const;

/** Skills and processes your queued jobs ask for, most-requested first, grouped by whether you already show them. */
export function DemandSidebar({ view, building }: { view: DemandView | null; building: boolean }) {
  const total = view?.jobs.length ?? 0;
  return (
    <aside className="panel" aria-labelledby="demand-h">
      <h2 id="demand-h" style={{ marginTop: 0 }}>
        Skills to demonstrate
      </h2>
      {building && <AutoRefresh seconds={15} />}
      {view ? (
        <p className="small muted">
          What the {total} job{total === 1 ? "" : "s"} you added ask for, built {fmtDate(view.generatedAt)}
          {view.method === "keywords" ? " from listing keywords (no AI provider)" : ""}.
          {view.newJobs > 0 ? ` ${view.newJobs} job${view.newJobs === 1 ? "" : "s"} added since.` : ""}
        </p>
      ) : (
        <p className="small muted">{building ? "Building the list from every job you added…" : "Not built yet."}</p>
      )}
      <form action={rebuildDemandAction} style={{ marginBottom: "0.5rem" }}>
        <button type="submit" disabled={building}>
          {building ? "Building…" : view ? "Rebuild list" : "Build list"}
        </button>
      </form>
      {view &&
        GROUPS.map((g) => {
          const items = view.items.filter((i) => i.status === g.status);
          if (!items.length) return null;
          return (
            <section key={g.status} aria-label={g.title}>
              <h3 style={{ marginBottom: "0.2rem" }}>
                {g.title} ({items.length})
              </h3>
              <p className="small muted" style={{ marginTop: 0 }}>
                {g.hint}
              </p>
              {items.map((item) => {
                const share = total ? item.jobIds.length / total : 0;
                const quotes = item.requirementIds
                  .slice(0, 3)
                  .map((id) => view.requirements[id])
                  .filter(Boolean);
                const companies = [...new Set(item.jobIds.map((id) => view.jobs.find((j) => j.id === id)?.company).filter(Boolean))];
                return (
                  <div key={item.name} className="demand-item">
                    <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
                      <strong>{item.name}</strong>
                      <Badge value={TONE[item.status]} label={item.kind} />
                    </div>
                    <div className="demand-bar" aria-hidden="true">
                      <span style={{ width: `${Math.max(4, Math.round(share * 100))}%` }} />
                    </div>
                    <div className="small">
                      {item.jobIds.length} of {total} jobs
                      {companies.length ? (
                        <span className="muted">
                          {" "}
                          · {companies.slice(0, 3).join(", ")}
                          {companies.length > 3 ? "…" : ""}
                        </span>
                      ) : null}
                    </div>
                    {item.whyItMatters && <div className="small muted">{item.whyItMatters}</div>}
                    {item.evidence.map((e, i) => (
                      <div key={i} className="small muted">
                        {e}
                      </div>
                    ))}
                    {quotes.length > 0 && (
                      <details className="small">
                        <summary>What the listings say</summary>
                        <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem" }}>
                          {quotes.map((q, i) => (
                            <li key={i}>“{q}”</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                );
              })}
            </section>
          );
        })}
      {view && view.items.length === 0 && <p className="small muted">No skills could be read from the listings yet.</p>}
    </aside>
  );
}
