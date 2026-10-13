import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCase, summarize, reportMarkdown, type EvalCase } from "../src/index";
import { ScriptedBulletModel } from "./fake-model";
import { REPO_ROOT } from "../../../tests/helpers";

/** Stored job/résumé pairs (fixtures/bullets/cases.json) replayed with their scripted model answers. */
export const CASES = JSON.parse(readFileSync(path.join(REPO_ROOT, "fixtures/bullets/cases.json"), "utf8")) as EvalCase[];

export function scriptedModel(c: EvalCase): ScriptedBulletModel {
  return new ScriptedBulletModel((item, attempt) => {
    const s = c.script?.find((x) => new RegExp(x.match, "i").test(item.requirement));
    if (!s) return null;
    const text = s.attempts[Math.min(attempt, s.attempts.length) - 1] ?? "";
    return text ? { text, ledger: [{ claim: text, sources: item.evidence.filter((e) => e.id.includes(".responsibilities[")).map((e) => e.id) }] } : null;
  });
}

describe("regression: stored job/résumé pairs", () => {
  it("never ships an unsupported claim and covers the requirements the résumé supports", async () => {
    const results = [];
    for (const c of CASES) results.push(await runCase(c, scriptedModel(c)));
    const report = summarize(results);
    const md = reportMarkdown(report);
    expect(report.totals.unsupportedClaimRate, md).toBe(0);
    expect(report.totals.expectedMissing, md).toBe(0);
    expect(report.totals.duplicateRate, md).toBe(0);
    expect(report.totals.llmCalls, md).toBeLessThanOrEqual(4);
    expect(report.totals.bullets, md).toBeGreaterThanOrEqual(3);
  });
});
