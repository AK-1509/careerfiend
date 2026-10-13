import Link from "next/link";
import { demandBuilding, demandView, latestProjectRuns, MIN_IDEAS, projectsUnavailableReason, refreshQuota, type ProjectRunView } from "@careerfiend/core";
import type { ProjectIdea } from "@careerfiend/ai";
import { ctx } from "@/lib/ctx";
import { LmConnectForm } from "@/components/lm-form";
import { fmtDate } from "@/lib/format";
import { Badge, Empty, Flash } from "@/components/ui";
import { AutoRefresh } from "@/components/auto-refresh";
import { DemandSidebar } from "@/components/demand-sidebar";
import { generateProjectIdeasAction } from "../actions";

const PHASE: Record<string, string> = {
  PENDING: "Starting…",
  RESEARCHING: "Finding the tasks your jobs have in common…",
  RESEARCHED: "Writing ideas…",
  SYNTHESIZING: "Writing and checking ideas…",
};

function IdeaCard({ idea, n, run }: { idea: ProjectIdea; n: number; run: ProjectRunView }) {
  const jobs = idea.jobIds.map((id) => run.jobs.find((j) => j.id === id)).filter((j) => !!j);
  const requirements = idea.requirementIds
    .map((id) => {
      const job = run.jobs.find((j) => j.requirements.some((r) => r.id === id));
      const req = job?.requirements.find((r) => r.id === id);
      return job && req ? { id, text: req.text, job: `${job.title} at ${job.company}` } : null;
    })
    .filter((r) => !!r);
  return (
    <article className="panel" aria-labelledby={`idea-${run.id}-${n}`}>
      <h2 id={`idea-${run.id}-${n}`} style={{ marginTop: 0, marginBottom: "0.3rem" }}>
        {n}. {idea.title}
      </h2>
      <p style={{ fontSize: "1.05rem", margin: "0 0 0.5rem" }}>{idea.pitch}</p>
      <p className="small" style={{ margin: "0 0 0.3rem" }}>
        <Badge value="READY_FOR_REVIEW" label={idea.task} /> {idea.howItHelps}
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        Build time: {idea.buildTime} · Asked for by{" "}
        {jobs.map((j, i) => (
          <span key={j.id}>
            {i > 0 && ", "}
            <Link href="/jobs">
              {j.title} at {j.company}
            </Link>
          </span>
        ))}
      </p>
      {requirements.length > 0 && (
        <details className="small" style={{ marginTop: "0.4rem" }}>
          <summary>What the listings ask for</summary>
          <ul>
            {requirements.map((r) => (
              <li key={r.id}>
                {r.text} <span className="muted">({r.job})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

export default async function Projects({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const sp = await searchParams;
  const c = await ctx();
  const [{ current, active, earlier }, quota, demand, building] = await Promise.all([latestProjectRuns(c), refreshQuota(c), demandView(c), demandBuilding(c)]);
  const running = active && active.status !== "FAILED";
  const unavailable = projectsUnavailableReason(c);
  return (
    <>
      <h1>Project Recommendations</h1>
      <Flash msg={sp.msg} error={sp.error} />
      <div className="with-sidebar">
        <div>
          <p className="muted">
            Small tools you could vibecode (build quickly with AI coding help) in a weekend to two weeks. Each one makes a task that several of your jobs ask
            for easier to do, so building it shows you can do that task. Every idea fits in one line that anyone, including a hiring manager outside the field,
            can understand. They lean toward the most-requested skills your résumé doesn&apos;t show yet (see the sidebar).
          </p>

          {unavailable && (
            <section className="panel accent" aria-labelledby="lm-h">
              <h2 id="lm-h" style={{ marginTop: 0 }}>
                Connect a language model to turn this on
              </h2>
              <p className="small">
                Project Recommendations are written by the AI model of your choice, with your own API key. Connect one here (or later in{" "}
                <Link href="/settings">Settings</Link>); the rest of CareerFiend works without it.
              </p>
              <LmConnectForm back="/settings" showSkip={false} />
            </section>
          )}

          {running && (
            <section className="panel" aria-live="polite">
              <AutoRefresh seconds={10} />
              <p style={{ margin: 0 }}>
                <Badge value="QUEUED" label={PHASE[active.status] ?? active.status} /> Started {fmtDate(active.createdAt)}. This page updates by itself.
              </p>
            </section>
          )}
          {active?.status === "FAILED" && (
            <div className="flash bad" role="status">
              The last run failed: {active.error ?? "unknown error"}. {current ? "Your previous ideas are below." : ""} Failed runs don&apos;t use a refresh.
            </div>
          )}

          <section className="panel row" aria-label="Generate">
            {current ? (
              <form action={generateProjectIdeasAction} className="row">
                <input type="hidden" name="trigger" value="refresh" />
                <button type="submit" className="primary" disabled={!!running || quota.remaining === 0 || !!unavailable}>
                  Refresh: {MIN_IDEAS} new ideas
                </button>
                <span className="small muted">
                  {quota.remaining} of {quota.limit} refreshes left in the last 5 hours
                  {quota.nextAt ? `; the next one frees up at ${fmtDate(quota.nextAt)}` : ""}.
                </span>
              </form>
            ) : (
              <form action={generateProjectIdeasAction} className="row">
                <input type="hidden" name="trigger" value="initial" />
                <button type="submit" className="primary" disabled={!!running || !!unavailable}>
                  Generate project ideas
                </button>
                <span className="small muted">Uses the jobs in your queue. Doesn&apos;t count as a refresh.</span>
              </form>
            )}
          </section>

          {current ? (
            <>
              <p className="small muted">
                {current.ideas.length} ideas from {fmtDate(current.finishedAt ?? current.createdAt)}, built from {current.jobs.length} queued job
                {current.jobs.length === 1 ? "" : "s"}.
              </p>
              {current.ideas.map((idea, i) => (
                <IdeaCard key={i} idea={idea} n={i + 1} run={current} />
              ))}
            </>
          ) : (
            !running && <Empty>No ideas yet. Press Generate project ideas.</Empty>
          )}

          {earlier.length > 0 && (
            <section aria-labelledby="earlier-h">
              <h2 id="earlier-h">Earlier ideas</h2>
              {earlier.map((r) => (
                <details key={r.id}>
                  <summary>
                    {fmtDate(r.finishedAt ?? r.createdAt)}: {r.ideas.map((i) => i.title).join(" · ")}
                  </summary>
                  {r.ideas.map((idea, i) => (
                    <IdeaCard key={i} idea={idea} n={i + 1} run={r} />
                  ))}
                </details>
              ))}
            </section>
          )}
        </div>
        <DemandSidebar view={demand} building={building} />
      </div>
    </>
  );
}
