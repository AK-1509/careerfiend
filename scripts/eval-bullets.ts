/**
 * Evaluation report for job-specific bullets.
 *
 *   npm run eval:bullets              replay the stored cases with their scripted model answers
 *   npm run eval:bullets -- --live    run the same cases against the configured AI provider
 *   ... -- --out report.md            also write the Markdown report to a file
 *
 * Cases live in fixtures/bullets/cases.json. The headline metric is the
 * unsupported claim rate, which must be 0; the run exits non-zero otherwise.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createProvider } from "@careerfiend/ai";
import { createLogger, loadConfig } from "@careerfiend/shared";
import { reportMarkdown, runCase, summarize, type EvalCase } from "../packages/bullets/src/index";
import { ScriptedBulletModel } from "../packages/bullets/test/fake-model";

const args = process.argv.slice(2);
const live = args.includes("--live");
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : undefined;

const cases = JSON.parse(readFileSync(path.join(process.cwd(), "fixtures/bullets/cases.json"), "utf8")) as EvalCase[];

function scripted(c: EvalCase) {
  return new ScriptedBulletModel((item, attempt) => {
    const s = c.script?.find((x) => new RegExp(x.match, "i").test(item.requirement));
    const text = s ? (s.attempts[Math.min(attempt, s.attempts.length) - 1] ?? "") : "";
    return text ? { text, ledger: [{ claim: text, sources: item.evidence.filter((e) => e.id.includes(".responsibilities[")).map((e) => e.id) }] } : null;
  });
}

const config = loadConfig();
const provider = live ? createProvider(config, createLogger({ level: "warn" })) : null;
if (live && !provider?.available) {
  console.error("--live needs an AI provider (AI_PROVIDER=anthropic with ANTHROPIC_API_KEY).");
  process.exit(2);
}

const results = [];
for (const c of cases) results.push(await runCase(c, provider ?? scripted(c)));
const report = summarize(results);
const md = reportMarkdown(report);
console.log(md);
console.log(JSON.stringify(report.totals));
if (out) writeFileSync(out, md);
if (report.totals.unsupportedClaimRate > 0) {
  console.error("Unsupported claims found: the rate must be 0.");
  process.exit(1);
}
