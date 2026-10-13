import { collapseWhitespace, normalizeLabel, stableId, type InventorySkill, type NormalizedJob } from "@careerfiend/shared";
import { fromJson, toJson } from "@careerfiend/db";
import { USER_AGENT, type Fetcher } from "@careerfiend/job-parser";
import { harvestJob, transferScore, type BankEntry, type TransferCandidate, type TransferScore } from "@careerfiend/matcher";
import { currentFacts, listSkills } from "@careerfiend/profile";
import type { AppContext } from "./context";
import { enqueue } from "./queue";

/**
 * Skill bank and the transferable-experience protocol.
 *
 * 1. Harvest: a listing you post yourself adds its skills and duties to the
 *    bank (never years, degrees, licenses, certifications, clearance or
 *    logistics). See harvestJob in @careerfiend/matcher.
 * 2. Transfer: each banked entry is linked to the real experience that backs
 *    it: résumé facts (verbatim, by provenance key) and your public GitHub
 *    repositories. Deterministic scoring first (named / same competency /
 *    shared terms); the AI provider, when configured, proposes more links,
 *    which are kept only when the entry and the evidence ref both exist.
 * 3. Match: active entries count toward later listings as TRANSFERABLE, with
 *    the linked evidence ranking résumé bullets and feeding the cover letter.
 */

/** Links scoring below this are not stored. */
export const TRANSFER_MIN = 0.5;
const PER_ENTRY = { RESUME_FACT: 3, GITHUB_REPO: 2 } as const;
const AI_BATCH = 30;

export interface BankSource {
  jobId: string;
  company: string;
  title: string;
  requirement: string;
}

/* ---------------------------------------------------------------- harvest */

/** Add a posted listing's skills to the bank. Returns how many entries are new. */
export async function bankFromJob(
  ctx: AppContext,
  jobId: string,
  job: NormalizedJob,
  skills: InventorySkill[],
  extraLabels: { requirementId: string; label: string }[] = [],
): Promise<{ added: number; seen: number }> {
  let added = 0;
  let seen = 0;
  for (const item of harvestJob(job, skills, extraLabels)) {
    const norm = `${item.kind === "duty" ? "duty:" : ""}${normalizeLabel(item.label)}`;
    const source: BankSource = { jobId, company: job.company, title: job.title, requirement: item.requirement };
    const existing = await ctx.db.bankedSkill.findUnique({ where: { normalizedLabel: norm } });
    if (existing) {
      if (existing.status === "REMOVED") continue; // you took it out: never re-added
      const sources = fromJson<BankSource[]>(existing.sources, []);
      if (sources.some((s) => s.jobId === jobId)) continue;
      await ctx.db.bankedSkill.update({
        where: { id: existing.id },
        data: { sources: toJson([...sources, source].slice(-20)), timesSeen: existing.timesSeen + 1 },
      });
      seen++;
      continue;
    }
    await ctx.db.bankedSkill.create({
      data: {
        id: stableId("bank", norm),
        kind: item.kind,
        label: item.label,
        normalizedLabel: norm,
        category: item.category,
        sources: toJson([source]),
      },
    });
    added++;
  }
  if (added) await enqueue(ctx.db, "TRANSFER_MATCH", {}, { dedupeKey: "transfer:pending" });
  return { added, seen };
}

const BACKFILL_KEY = "bank.backfilled";

/** Whether listings pasted before the skill bank existed still need banking. */
export async function bankBackfillPending(ctx: AppContext): Promise<boolean> {
  return !(await ctx.db.setting.findUnique({ where: { key: BACKFILL_KEY } }));
}

/**
 * One time: listings you pasted before the skill bank existed (finished
 * INGEST_URL items) are marked as yours and banked. Their decisions are left as they were.
 */
export async function backfillPostedJobs(ctx: AppContext): Promise<{ jobs: number; added: number }> {
  const items = await ctx.db.workItem.findMany({ where: { kind: "INGEST_URL", status: "DONE" } });
  const urls = [...new Set(items.map((i) => String(fromJson<{ url?: string }>(i.payload, {}).url ?? "")).filter(Boolean))];
  const skills = await listSkills(ctx.db);
  let jobs = 0;
  let added = 0;
  for (const url of urls) {
    const job = await ctx.db.job.findFirst({ where: { OR: [{ sourceUrl: url }, { canonicalUrl: url }], endorsed: false } });
    if (!job) continue;
    const normalized = fromJson<NormalizedJob | null>(job.normalized, null);
    if (!normalized) continue;
    added += (await bankFromJob(ctx, job.id, normalized, skills)).added;
    await ctx.db.job.update({ where: { id: job.id }, data: { endorsed: true } });
    jobs++;
  }
  await ctx.db.setting.upsert({
    where: { key: BACKFILL_KEY },
    create: { key: BACKFILL_KEY, value: ctx.now().toISOString() },
    update: { value: ctx.now().toISOString() },
  });
  if (jobs) ctx.logger.info("bank.backfilled", { count: jobs });
  return { jobs, added };
}

/** Active bank entries with the evidence that backs them, for the matcher. */
export async function loadBank(ctx: AppContext): Promise<BankEntry[]> {
  const rows = await ctx.db.bankedSkill.findMany({
    where: { status: "ACTIVE" },
    include: { transfers: { where: { score: { gte: TRANSFER_MIN } }, orderBy: { score: "desc" } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as BankEntry["kind"],
    label: r.label,
    category: r.category as BankEntry["category"],
    evidenceKeys: r.transfers.map((t) => (t.evidenceType === "GITHUB_REPO" ? `github:${t.evidenceRef}` : t.evidenceRef)),
  }));
}

export async function setBankedSkillStatus(ctx: AppContext, id: string, status: "ACTIVE" | "REMOVED"): Promise<string> {
  const row = await ctx.db.bankedSkill.update({ where: { id }, data: { status } });
  return status === "REMOVED"
    ? `Removed “${row.label}” from your skill bank. Later listings will not count it.`
    : `Restored “${row.label}” to your skill bank.`;
}

/** Re-link every entry (for example after the résumé or your GitHub projects changed). */
export async function requestTransferRefresh(ctx: AppContext): Promise<string> {
  // Marking entries unlinked (not passing `all`) lets a long refresh continue across worker runs.
  await ctx.db.bankedSkill.updateMany({ where: { status: "ACTIVE" }, data: { matchedAt: null } });
  await enqueue(ctx.db, "TRANSFER_MATCH", {}, { dedupeKey: "transfer:pending" });
  return "Re-matching your skill bank against your résumé and GitHub. It runs on the worker in a minute or two.";
}

export interface BankView {
  id: string;
  kind: string;
  label: string;
  category: string;
  status: string;
  timesSeen: number;
  sources: BankSource[];
  matchedAt: Date | null;
  transfers: { type: string; ref: string; text: string; url: string | null; score: number; method: string; rationale: string }[];
}

export async function listBank(ctx: AppContext): Promise<BankView[]> {
  const rows = await ctx.db.bankedSkill.findMany({
    include: { transfers: { orderBy: { score: "desc" } } },
    orderBy: [{ timesSeen: "desc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    category: r.category,
    status: r.status,
    timesSeen: r.timesSeen,
    sources: fromJson<BankSource[]>(r.sources, []),
    matchedAt: r.matchedAt,
    transfers: r.transfers.map((t) => ({
      type: t.evidenceType,
      ref: t.evidenceRef,
      text: t.evidenceText,
      url: t.url,
      score: t.score,
      method: t.method,
      rationale: t.rationale,
    })),
  }));
}

/* ----------------------------------------------------------------- GitHub */

export interface RepoSummary {
  /** owner/name */
  ref: string;
  name: string;
  url: string;
  description: string;
  language: string | null;
  topics: string[];
  /** README excerpt with markup removed. */
  readme: string;
}

interface GithubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics?: string[];
  fork: boolean;
  archived?: boolean;
  private?: boolean;
  default_branch?: string;
}

const REPO_CACHE_KEY = "github.repos";
const STATUS_KEY = "github.status";
const REPO_TTL_MS = 24 * 3600_000;

export function githubUser(ctx: AppContext): string | null {
  const u = ctx.config.GITHUB_USER;
  return u && u.toLowerCase() !== "none" && /^[A-Za-z0-9-]{1,39}$/.test(u) ? u : null;
}

/** Plain text from a README: no code blocks, images, HTML, link targets or markup. */
export function readmeText(md: string): string {
  return collapseWhitespace(
    md
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^[#>*\-+\s|]+/gm, " ")
      .replace(/[`*_|]/g, " "),
  ).slice(0, 3000);
}

/** Your public, non-fork repositories with a README excerpt. Cached for a day. */
export async function githubRepos(ctx: AppContext, opts: { fresh?: boolean } = {}): Promise<RepoSummary[]> {
  const user = githubUser(ctx);
  if (!user) return [];
  if (!opts.fresh) {
    const cached = await ctx.db.setting.findUnique({ where: { key: REPO_CACHE_KEY } });
    const c = cached ? fromJson<{ user: string; at: number; repos: RepoSummary[] }>(cached.value, { user: "", at: 0, repos: [] }) : null;
    if (c && c.user === user && ctx.now().getTime() - c.at < REPO_TTL_MS) return c.repos;
  }
  const token = ctx.config.GITHUB_TOKEN;
  const fetcher: Fetcher =
    ctx.fetchers?.github ??
    ((url) =>
      fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: url.startsWith("https://api.github.com/") ? "application/vnd.github+json" : "text/plain",
          ...(token && url.startsWith("https://api.github.com/") ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      }));
  const res = await fetcher(`https://api.github.com/users/${user}/repos?per_page=100&sort=pushed&type=owner`).catch(() => null);
  if (!res?.ok) {
    const status = res?.status ?? 0;
    const problem =
      status === 403 || status === 429
        ? "GitHub's rate limit for anonymous requests was hit (shared hosting addresses). Add a read-only GITHUB_TOKEN to raise it."
        : status === 404
          ? `GitHub user ${user} was not found.`
          : `GitHub could not be reached (${status || "network error"}).`;
    await setGithubStatus(ctx, { ok: false, problem });
    ctx.logger.warn("github.repos_failed", { status: String(status) });
    return [];
  }
  const list = ((await res.json()) as GithubRepo[]).filter((r) => !r.fork && !r.private);
  const repos: RepoSummary[] = [];
  for (const r of list.slice(0, 30)) {
    let readme = "";
    const branch = r.default_branch ?? "HEAD";
    for (const name of ["README.md", "readme.md", "README"]) {
      const rr = await fetcher(`https://raw.githubusercontent.com/${r.full_name}/${branch}/${name}`).catch(() => null);
      if (rr?.ok) {
        readme = readmeText(await rr.text());
        break;
      }
    }
    repos.push({
      ref: r.full_name,
      name: r.name,
      url: r.html_url,
      description: collapseWhitespace(r.description ?? ""),
      language: r.language,
      topics: r.topics ?? [],
      readme,
    });
  }
  await setGithubStatus(ctx, { ok: true, problem: null });
  await ctx.db.setting.upsert({
    where: { key: REPO_CACHE_KEY },
    create: { key: REPO_CACHE_KEY, value: toJson({ user, at: ctx.now().getTime(), repos }) },
    update: { value: toJson({ user, at: ctx.now().getTime(), repos }) },
  });
  return repos;
}

async function setGithubStatus(ctx: AppContext, s: { ok: boolean; problem: string | null }): Promise<void> {
  const value = toJson({ ...s, at: ctx.now().toISOString() });
  await ctx.db.setting.upsert({ where: { key: STATUS_KEY }, create: { key: STATUS_KEY, value }, update: { value } });
}

/** Last GitHub read: when, and what went wrong if it failed. */
export async function githubStatus(ctx: AppContext): Promise<{ ok: boolean; problem: string | null; at: string } | null> {
  const row = await ctx.db.setting.findUnique({ where: { key: STATUS_KEY } });
  return row ? fromJson(row.value, null) : null;
}

function repoSummary(r: RepoSummary): string {
  const first = r.readme.split(/(?<=[.!?])\s/)[0] ?? "";
  return collapseWhitespace([r.name, r.description || first.slice(0, 200), r.language ? `(${r.language})` : ""].filter(Boolean).join(": ")).slice(0, 300);
}

/* --------------------------------------------------------------- transfer */

interface Evidence extends TransferCandidate {
  /** Text shown to you and stored with the link. */
  display: string;
  url: string | null;
}

async function evidencePool(ctx: AppContext): Promise<Evidence[]> {
  const facts = (await currentFacts(ctx.db)).filter(
    (f) => f.kind === "responsibility" || f.kind === "summary" || f.kind === "skill" || f.key.endsWith(".endorsedSkills"),
  );
  const out: Evidence[] = facts.map((f) => ({ type: "RESUME_FACT", ref: f.key, text: f.text, display: f.text, url: null }));
  let repos: RepoSummary[] = [];
  try {
    repos = await githubRepos(ctx);
  } catch (err) {
    ctx.logger.warn("github.repos_failed", { error: err });
  }
  for (const r of repos) {
    out.push({
      type: "GITHUB_REPO",
      ref: r.ref,
      text: [r.name.replace(/[-_]/g, " "), r.description, r.language ?? "", r.topics.join(" "), r.readme].join(". "),
      display: repoSummary(r),
      url: r.url,
    });
  }
  return out;
}

interface Link {
  score: number;
  method: TransferScore["method"] | "ai";
  rationale: string;
  evidence: Evidence;
}

function keepBest(links: Link[]): Link[] {
  const byRef = new Map<string, Link>();
  for (const l of links) {
    const k = `${l.evidence.type}:${l.evidence.ref}`;
    const prev = byRef.get(k);
    if (!prev || l.score > prev.score) byRef.set(k, l);
  }
  const all = [...byRef.values()].filter((l) => l.score >= TRANSFER_MIN).sort((a, b) => b.score - a.score);
  return [
    ...all.filter((l) => l.evidence.type === "RESUME_FACT").slice(0, PER_ENTRY.RESUME_FACT),
    ...all.filter((l) => l.evidence.type === "GITHUB_REPO").slice(0, PER_ENTRY.GITHUB_REPO),
  ];
}

/**
 * Link banked entries to the experience that backs them. By default only
 * entries not linked yet; `all` re-links everything. Works in batches and
 * saves each one, so a bounded worker run that stops at `deadline` (epoch ms)
 * keeps what it finished; the rest is queued as a follow-up item.
 */
export async function computeTransfers(
  ctx: AppContext,
  opts: { all?: boolean; deadline?: number } = {},
): Promise<{ entries: number; links: number; ai: boolean; remaining: number }> {
  if (opts.all) await ctx.db.bankedSkill.updateMany({ where: { status: "ACTIVE" }, data: { matchedAt: null } });
  const rows = await ctx.db.bankedSkill.findMany({ where: { status: "ACTIVE", matchedAt: null }, orderBy: [{ timesSeen: "desc" }, { createdAt: "asc" }] });
  if (!rows.length) return { entries: 0, links: 0, ai: false, remaining: 0 };
  const pool = await evidencePool(ctx);
  const byRef = new Map(pool.map((e) => [e.ref, e]));

  let usedAi = false;
  let done = 0;
  let total = 0;
  for (let i = 0; i < rows.length; i += AI_BATCH) {
    // An AI batch takes 10 to 30 s: stop early rather than be cut off mid-batch.
    if (opts.deadline !== undefined && opts.deadline - Date.now() < 45_000) break;
    const batch = rows.slice(i, i + AI_BATCH);
    const links = new Map<string, Link[]>();
    for (const r of batch) {
      const found: Link[] = [];
      for (const e of pool) {
        const s = transferScore({ kind: r.kind as BankEntry["kind"], label: r.label }, e);
        if (s) found.push({ ...s, evidence: e });
      }
      links.set(r.id, found);
    }
    if (ctx.ai.available && pool.length) {
      try {
        const out = await ctx.ai.proposeTransfers({
          entries: batch.map((r) => ({ id: r.id, kind: r.kind as "skill" | "duty", label: r.label })),
          evidence: pool.map((e) => ({ ref: e.ref, type: e.type, text: e.type === "GITHUB_REPO" ? e.text.slice(0, 800) : e.text })),
        });
        usedAi = true;
        for (const m of out.matches) {
          const e = byRef.get(m.ref);
          // Policy check: the entry and the evidence must exist; weak or rambling proposals are dropped.
          if (!links.has(m.bankId) || !e || !(m.strength >= 0.6) || !m.rationale.trim() || m.rationale.length > 400) continue;
          links.get(m.bankId)!.push({ score: Math.min(0.95, m.strength), method: "ai", rationale: collapseWhitespace(m.rationale), evidence: e });
        }
      } catch (err) {
        ctx.logger.warn("ai.transfer_failed", { error: err });
      }
    }
    for (const r of batch) {
      const best = keepBest(links.get(r.id) ?? []);
      await ctx.db.transferMatch.deleteMany({ where: { bankedSkillId: r.id } });
      if (best.length) {
        await ctx.db.transferMatch.createMany({
          data: best.map((l) => ({
            id: stableId("tm", r.id, l.evidence.type, l.evidence.ref),
            bankedSkillId: r.id,
            evidenceType: l.evidence.type,
            evidenceRef: l.evidence.ref,
            evidenceText: l.evidence.display.slice(0, 600),
            url: l.evidence.url,
            score: Math.round(l.score * 100) / 100,
            method: l.method,
            rationale: l.rationale.slice(0, 400),
          })),
        });
      }
      total += best.length;
      await ctx.db.bankedSkill.update({ where: { id: r.id }, data: { matchedAt: ctx.now() } });
    }
    done += batch.length;
  }
  const remaining = rows.length - done;
  if (remaining) await enqueue(ctx.db, "TRANSFER_MATCH", {}, { dedupeKey: "transfer:continue" });
  ctx.logger.info("bank.transfers", { count: done, status: `${total} links${usedAi ? " (with AI)" : ""}; ${remaining} left` });
  return { entries: done, links: total, ai: usedAi, remaining };
}

/** GitHub projects that back this job's transferable items, as cover-letter facts. */
export async function githubFactsFor(ctx: AppContext, refs: string[]): Promise<{ key: string; text: string }[]> {
  const wanted = new Set(refs.filter((r) => r.startsWith("github:")).map((r) => r.slice("github:".length)));
  if (!wanted.size) return [];
  const rows = await ctx.db.transferMatch.findMany({ where: { evidenceType: "GITHUB_REPO", evidenceRef: { in: [...wanted] } } });
  const seen = new Set<string>();
  return rows
    .filter((r) => !seen.has(r.evidenceRef) && seen.add(r.evidenceRef))
    .map((r) => ({ key: `github:${r.evidenceRef}`, text: `Public GitHub project ${r.evidenceText}` }));
}
