import Link from "next/link";
import { listSkills } from "@careerfiend/profile";
import { ctx } from "@/lib/ctx";
import { Badge, Flash } from "@/components/ui";
import { skillDecisionAction } from "../actions";

const FILTERS = ["UNVERIFIED", "CONFIRMED_BY_USER", "VERIFIED_FROM_SOURCE", "REJECTED_BY_USER", "job-description"];

export default async function Skills({ searchParams }: { searchParams: Promise<{ f?: string; msg?: string; error?: string }> }) {
  const sp = await searchParams;
  const all = await listSkills((await ctx()).db);
  const f = sp.f ?? "UNVERIFIED";
  const shown = all.filter((s) => (f === "all" ? true : f === "job-description" ? s.origin === "job-description" : s.status === f));
  const count = (k: string) => all.filter((s) => (k === "job-description" ? s.origin === "job-description" : s.status === k)).length;
  return (
    <>
      <h1>Skills inventory</h1>
      <Flash msg={sp.msg} error={sp.error} />
      <p className="muted">
        Only <strong>verified from your résumé</strong> and <strong>confirmed by you</strong> skills fill a form field. Confirmed skills never add text to your
        résumé. Skills from listings you posted also count toward matching through your <Link href="/bank">skill bank</Link>.
      </p>
      <p className="row">
        {[...FILTERS, "all"].map((k) => (
          <Link key={k} className="button" href={`/skills?f=${k}`} aria-current={f === k ? "page" : undefined}>
            {k === "all" ? `All (${all.length})` : `${k.replace(/_/g, " ").toLowerCase()} (${count(k)})`}
          </Link>
        ))}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Skill</th>
              <th scope="col">Status</th>
              <th scope="col">Basis / scope</th>
              <th scope="col">Decide</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.label}</strong>
                  <div className="mono muted">{s.id}</div>
                  <div className="small muted">
                    {s.category} · {s.origin}
                  </div>
                </td>
                <td>
                  <Badge value={s.status} />
                </td>
                <td className="small">
                  {s.scope ?? s.basis}
                  {s.claimLimit && <div className="muted">Limit: {s.claimLimit}</div>}
                  {s.firstSeen && <div className="muted">First required by: “{s.firstSeen.requirement}”</div>}
                  {s.evidence.length > 0 && <div className="mono muted">{s.evidence.map((e) => e.key).join(", ")}</div>}
                </td>
                <td>
                  {s.status === "VERIFIED_FROM_SOURCE" ? (
                    <span className="small muted">from your résumé</span>
                  ) : (
                    <form action={skillDecisionAction} className="row">
                      <input type="hidden" name="skillId" value={s.id} />
                      <input type="hidden" name="returnQuery" value={`?f=${f}`} />
                      <button
                        type="submit"
                        name="decision"
                        value="CONFIRMED_BY_USER"
                        disabled={s.status === "CONFIRMED_BY_USER"}
                        aria-label={`Confirm ${s.label}`}
                      >
                        Confirm
                      </button>
                      <button
                        type="submit"
                        name="decision"
                        value="REJECTED_BY_USER"
                        disabled={s.status === "REJECTED_BY_USER"}
                        aria-label={`Reject ${s.label}`}
                      >
                        Reject
                      </button>
                      <button type="submit" name="decision" value="UNVERIFIED" disabled={s.status === "UNVERIFIED"} aria-label={`Mark ${s.label} unsure`}>
                        Unsure
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
