import Link from "next/link";
import { githubStatus, githubUser, listBank, type BankView } from "@careerfiend/core";
import { ctx } from "@/lib/ctx";
import { fmtDate } from "@/lib/format";
import { Badge, Empty, Flash } from "@/components/ui";
import { bankStatusAction, refreshTransfersAction } from "../actions";

const FILTERS = [
  { key: "skill", label: "Skills" },
  { key: "duty", label: "Duties" },
  { key: "unbacked", label: "No evidence yet" },
  { key: "REMOVED", label: "Removed" },
];

const METHOD: Record<string, string> = {
  direct: "named",
  related: "same competency",
  overlap: "shared terms",
  ai: "AI-proposed, checked",
};

function Evidence({ e }: { e: BankView["transfers"][number] }) {
  return (
    <li className="small">
      {e.type === "GITHUB_REPO" ? (
        <>
          <Badge value="COVERED" label="GitHub" />{" "}
          <a href={e.url ?? `https://github.com/${e.ref}`} target="_blank" rel="noopener noreferrer">
            {e.ref}
          </a>{" "}
          <span className="muted">{e.text}</span>
        </>
      ) : (
        <>
          <Badge value="VERIFIED_FROM_SOURCE" label="résumé" /> “{e.text}” <span className="mono muted">{e.ref}</span>
        </>
      )}
      <div className="muted">
        {e.rationale} ({METHOD[e.method] ?? e.method}, {Math.round(e.score * 100)}%)
      </div>
    </li>
  );
}

export default async function SkillBank({ searchParams }: { searchParams: Promise<{ f?: string; msg?: string; error?: string }> }) {
  const sp = await searchParams;
  const c = await ctx();
  const all = await listBank(c);
  const f = sp.f ?? "skill";
  const active = all.filter((b) => b.status === "ACTIVE");
  const pick = (k: string) =>
    k === "REMOVED"
      ? all.filter((b) => b.status === "REMOVED")
      : k === "unbacked"
        ? active.filter((b) => b.matchedAt && !b.transfers.length)
        : active.filter((b) => b.kind === k);
  const shown = pick(f);
  const pending = active.filter((b) => !b.matchedAt).length;
  const backed = active.filter((b) => b.transfers.length).length;
  const gh = githubUser(c);
  const ghStatus = await githubStatus(c);
  return (
    <>
      <h1>Skill bank</h1>
      <Flash msg={sp.msg} error={sp.error} />
      <p className="muted">
        Every listing you paste on the Daily queue is one you read and chose, so its skills and duties are saved here and count toward later listings as{" "}
        <Badge value="TRANSFERABLE" /> items. Years of experience, degrees, licenses, certifications, clearance and logistics are never saved; those are checked
        as facts. Saved skills steer how your résumé is tailored; they never fill a form field.
      </p>
      <p>
        <strong>Transferable-experience links</strong> connect each entry to the résumé lines (verbatim) and public GitHub projects
        {gh ? (
          <>
            {" "}
            of <a href={`https://github.com/${gh}`}>{gh}</a>
          </>
        ) : null}{" "}
        that show it. Those lines rank higher on tailored résumés, and the linked facts and projects are offered to the cover letter.
      </p>
      {ghStatus && !ghStatus.ok && (
        <p role="status" className="flash bad">
          GitHub projects were not used on the last run: {ghStatus.problem}
        </p>
      )}
      <div className="panel row">
        <span>
          {active.length} active · {backed} with evidence{pending ? ` · ${pending} waiting to be linked` : ""}
        </span>
        <form action={refreshTransfersAction}>
          <button type="submit">Re-link to résumé and GitHub</button>
        </form>
      </div>
      <p className="row">
        {FILTERS.map((x) => (
          <Link key={x.key} className="button" href={`/bank?f=${x.key}`} aria-current={f === x.key ? "page" : undefined}>
            {x.label} ({pick(x.key).length})
          </Link>
        ))}
      </p>
      {shown.length === 0 ? (
        <Empty>{all.length ? "Nothing here." : "Empty so far. Paste a job link on the Daily queue and its skills land here once it is read."}</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{f === "duty" ? "Duty" : "Skill"}</th>
                <th scope="col">From listings</th>
                <th scope="col">Transferable experience</th>
                <th scope="col">Keep</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.label}</strong>
                    <div className="small muted">{b.category}</div>
                  </td>
                  <td className="small">
                    {b.sources.slice(-3).map((s, i) => (
                      <div key={i}>
                        {s.title} at {s.company}
                        {b.kind === "skill" && <div className="muted">“{s.requirement.slice(0, 140)}”</div>}
                      </div>
                    ))}
                    {b.timesSeen > 3 && <div className="muted">seen in {b.timesSeen} listings</div>}
                  </td>
                  <td>
                    {b.transfers.length ? (
                      <ul className="plain">
                        {b.transfers.map((e) => (
                          <Evidence key={`${e.type}:${e.ref}`} e={e} />
                        ))}
                      </ul>
                    ) : (
                      <span className="small muted">
                        {b.matchedAt ? `No backing found (checked ${fmtDate(b.matchedAt)}). It still counts; you vouched for it.` : "Linking soon…"}
                      </span>
                    )}
                  </td>
                  <td>
                    <form action={bankStatusAction}>
                      <input type="hidden" name="id" value={b.id} />
                      <input type="hidden" name="returnQuery" value={`?f=${f}`} />
                      {b.status === "ACTIVE" ? (
                        <button type="submit" name="status" value="REMOVED" aria-label={`Remove ${b.label}`}>
                          Remove
                        </button>
                      ) : (
                        <button type="submit" name="status" value="ACTIVE" aria-label={`Restore ${b.label}`}>
                          Restore
                        </button>
                      )}
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
