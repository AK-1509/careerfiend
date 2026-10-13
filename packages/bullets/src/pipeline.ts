import { CareerFiendError, type Logger, type NormalizedJob } from "@careerfiend/shared";
import type { AiProvider } from "@careerfiend/ai";
import type {
  BulletDraft,
  BulletMetrics,
  Candidate,
  EvidencePacket,
  ExperienceProfile,
  GeneratedBulletSet,
  RejectedCandidate,
  RequirementTemplate,
  RerankVerdict,
} from "./types";
import { buildTemplates, hasSubstance, mergeModelDecomposition } from "./normalize";
import { candidatesFor } from "./scoring";
import { buildPacket } from "./evidence";
import { repairFeedback, validateDraft, type StyleContext } from "./validate";
import { selectBullets, type Validated } from "./select";

/**
 * Job-specific bullet generation, end to end:
 *
 *   requirements -> canonical templates (rules; fast model only for low-confidence ones)
 *   templates x cached experience profiles -> semantic retrieval -> structured scores
 *   small candidate set -> model reranking (one batched call) -> evidence packets
 *   packets -> grounded generation (one batched call) -> four validators
 *   failures -> repair rounds (batched, at most MAX_REPAIRS) -> discard
 *   validated drafts -> selection against the original lines
 *
 * The job description decides the framing, the experience decides the facts,
 * the validators decide whether the transformation is legitimate. Without an
 * AI provider nothing is generated (the original lines stay).
 */

export interface JobRequirementsInput {
  job: Pick<NormalizedJob, "company" | "title" | "location" | "requirements">;
  /** Importance from the platform's existing analysis (requirement id -> weight). */
  importance?: Record<string, number>;
}

export interface ResumeContext {
  ai: AiProvider;
  logger?: Logger;
  /** Every résumé line id -> text (style and duplicate checks). */
  existing: Record<string, string>;
  maxTemplates?: number;
  maxBullets?: number;
  maxRepairs?: number;
  /** Stop starting new model rounds after this long (ms). */
  budgetMs?: number;
  now?: () => number;
}

export const MAX_TEMPLATES = 10;
export const MAX_REPAIRS = 2;
const PAIRS_PER_TEMPLATE = 2;

interface Tracker {
  metrics: BulletMetrics;
  logger?: Logger;
  now: () => number;
}

async function callModel<T>(tr: Tracker, stage: string, tier: "fast" | "strong", fn: () => Promise<T>): Promise<T | null> {
  const started = tr.now();
  tr.metrics.llmCalls++;
  try {
    const out = await fn();
    tr.metrics.modelCalls.push({ stage, tier, durationMs: tr.now() - started, ok: true });
    tr.logger?.info("bullets.model", { step: stage, status: "ok", durationMs: tr.now() - started, kind: tier });
    return out;
  } catch (err) {
    tr.metrics.modelCalls.push({ stage, tier, durationMs: tr.now() - started, ok: false });
    tr.logger?.warn("bullets.model", { step: stage, status: "failed", kind: tier, error: err instanceof CareerFiendError ? err.category : "error" });
    return null;
  }
}

function styleOf(existing: Record<string, string>): StyleContext {
  const corpus = Object.values(existing);
  const bullets = corpus.filter((t) => t.split(/\s+/).length >= 4);
  const avgChars = bullets.length ? bullets.reduce((a, t) => a + t.length, 0) / bullets.length : 110;
  return { corpus, avgChars, existing };
}

function emptyMetrics(): BulletMetrics {
  return {
    templates: 0,
    lowConfidenceTemplates: 0,
    candidates: 0,
    packets: 0,
    drafts: 0,
    accepted: 0,
    kept_original: 0,
    discarded: 0,
    attemptsTotal: 0,
    unsupportedClaimsBlocked: 0,
    llmCalls: 0,
    modelCalls: [],
    durationMs: 0,
  };
}

/**
 * Generate job-specific bullets for one listing from the user's experiences.
 * Returns the bullets to display (text) with their evidence ledgers and
 * scores; never modifies the experiences themselves.
 */
export async function generateJobSpecificBullets(
  jobRequirements: JobRequirementsInput,
  userExperiences: ExperienceProfile[],
  resumeContext: ResumeContext,
): Promise<GeneratedBulletSet> {
  const now = resumeContext.now ?? (() => Date.now());
  const started = now();
  const tr: Tracker = { metrics: emptyMetrics(), logger: resumeContext.logger, now };
  const { ai, logger } = resumeContext;
  const budget = resumeContext.budgetMs ?? 120_000;
  const overBudget = () => now() - started > budget;
  const rejected: RejectedCandidate[] = [];
  const profileById = new Map(userExperiences.map((p) => [p.experienceId, p]));

  // 1-3. Requirement extraction, normalization, canonical templates.
  let templates = buildTemplates(jobRequirements.job, { importance: jobRequirements.importance }).slice(0, resumeContext.maxTemplates ?? MAX_TEMPLATES);
  tr.metrics.templates = templates.length;
  const uncertain = templates.filter((t) => t.lowConfidence);
  tr.metrics.lowConfidenceTemplates = uncertain.length;
  if (uncertain.length && ai.available) {
    const out = await callModel(tr, "decompose", "fast", () =>
      ai.decomposeRequirements({ items: uncertain.map((t) => ({ id: t.requirementId, text: t.sourceText })) }),
    );
    if (out) {
      const byId = new Map(out.items.map((i) => [i.id, i]));
      templates = templates.map((t) => (t.lowConfidence && byId.has(t.requirementId) ? mergeModelDecomposition(t, byId.get(t.requirementId)!) : t));
    }
  }
  templates = templates.filter(hasSubstance);
  tr.metrics.templates = templates.length;
  for (const t of templates) logger?.info("bullets.template", { requirementId: t.requirementId, confidence: t.confidence, step: t.method });
  // Uncertain details are never hard requirements: a template still low-confidence keeps only its proven core later.

  const finish = (validated: Validated[]): GeneratedBulletSet => {
    const selection = selectBullets(validated, resumeContext.maxBullets ?? 8);
    tr.metrics.accepted = selection.bullets.length;
    tr.metrics.kept_original = selection.keptOriginal.length;
    tr.metrics.durationMs = now() - started;
    for (const k of selection.keptOriginal)
      rejected.push({ requirementId: k.requirementId, experienceId: k.experienceId, reason: `kept original: ${k.reason}`, attempts: 0 });
    logger?.info("bullets.done", {
      count: selection.bullets.length,
      durationMs: tr.metrics.durationMs,
      attempt: tr.metrics.llmCalls,
      status: `${tr.metrics.discarded} discarded`,
    });
    return {
      bullets: selection.bullets,
      rejected,
      templates: templates.map((t) => ({
        requirementId: t.requirementId,
        template: t.template,
        confidence: t.confidence,
        method: t.method,
        importance: t.importance,
        domain: t.domain,
      })),
      metrics: tr.metrics,
    };
  };

  if (!userExperiences.length || !templates.length) return finish([]);

  // 4-6. Experience representations (cached by the caller) -> semantic retrieval -> structured scoring.
  const candidates = new Map<string, Candidate[]>();
  for (const t of templates) {
    const c = candidatesFor(t, userExperiences, PAIRS_PER_TEMPLATE);
    if (c.length) candidates.set(t.requirementId, c);
    else rejected.push({ requirementId: t.requirementId, experienceId: null, reason: "no related experience", attempts: 0 });
    tr.metrics.candidates += c.length;
  }
  if (!ai.available) {
    for (const t of templates)
      if (candidates.has(t.requirementId))
        rejected.push({ requirementId: t.requirementId, experienceId: null, reason: "no AI provider: original lines kept", attempts: 0 });
    return finish([]);
  }

  // 7. Semantic reranking on the small candidate set (one call).
  const pairs = templates.flatMap((t) =>
    (candidates.get(t.requirementId) ?? []).map((c) => {
      const p = profileById.get(c.experienceId)!;
      return { pairId: `${t.requirementId}|${c.experienceId}`, t, c, p };
    }),
  );
  const verdicts = new Map<string, RerankVerdict>();
  if (pairs.length) {
    const out = await callModel(tr, "rerank", "strong", () =>
      ai.rerankEvidence({
        pairs: pairs.map(({ pairId, t, c, p }) => ({
          pairId,
          requirement: t.template,
          elements: {
            actions: t.actions.map((a) => a.verb),
            skills: [...t.tools, ...t.concepts.map((x) => x.term)],
            stakeholders: t.stakeholders.map((s) => s.as),
          },
          // The candidate's best lines first, then the rest of the entry so the model can cite other supporting lines.
          evidence: [...p.evidence]
            .sort((a, b) => Number(c.spanIds.includes(b.id)) - Number(c.spanIds.includes(a.id)))
            .slice(0, 6)
            .map((e) => ({ id: e.id, text: e.text })),
        })),
      }),
    );
    for (const v of out?.pairs ?? []) {
      const pair = pairs.find((x) => x.pairId === v.pairId);
      if (!pair) continue;
      const ids = new Set(pair.p.evidence.map((e) => e.id));
      verdicts.set(v.pairId, {
        matchScore: Math.max(0, Math.min(1, v.matchScore)),
        supportLevel: v.supportLevel,
        supportedActions: v.supportedActions,
        supportedSkills: v.supportedSkills,
        supportedStakeholders: v.supportedStakeholders,
        evidenceIds: v.evidenceIds.filter((id) => ids.has(id)),
        unsupported: v.unsupported,
        transformation: v.transformation.slice(0, 300),
      });
    }
  }

  // 8. Evidence extraction: one packet per requirement, from its best-supported experience.
  const packets: { t: RequirementTemplate; packet: EvidencePacket; profile: ExperienceProfile }[] = [];
  for (const t of templates) {
    const options = (candidates.get(t.requirementId) ?? [])
      .map((c) => {
        const p = profileById.get(c.experienceId)!;
        const v = verdicts.get(`${t.requirementId}|${c.experienceId}`);
        const packet = buildPacket(t, p, c, v);
        logger?.info("bullets.match", {
          requirementId: t.requirementId,
          experienceId: c.experienceId,
          confidence: c.score,
          status: packet ? packet.supportLevel : "unproven",
        });
        return packet ? { t, packet, profile: p } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.packet.relevance - a.packet.relevance);
    if (options[0]) packets.push(options[0]);
    else if (candidates.has(t.requirementId))
      rejected.push({ requirementId: t.requirementId, experienceId: null, reason: "related experience, but nothing it proves", attempts: 0 });
  }
  tr.metrics.packets = packets.length;
  if (!packets.length) return finish([]);

  // 9-11. Grounded generation, validation, automatic repair.
  const style = styleOf(resumeContext.existing);
  const targetWords = Math.max(12, Math.min(24, Math.round(style.avgChars / 6.2)));
  const examples = style.corpus.filter((t) => t.split(/\s+/).length >= 6).slice(0, 4);
  const state = new Map<string, { attempts: number; feedback?: string[]; previous?: string; done: boolean }>();
  for (const x of packets) state.set(`${x.t.requirementId}|${x.packet.experienceId}`, { attempts: 0, done: false });
  const validated: Validated[] = [];
  const accepted: string[] = [];
  const maxRounds = 1 + (resumeContext.maxRepairs ?? MAX_REPAIRS);

  for (let round = 0; round < maxRounds; round++) {
    const todo = packets.filter((x) => !state.get(`${x.t.requirementId}|${x.packet.experienceId}`)!.done);
    if (!todo.length) break;
    if (round > 0 && overBudget()) {
      for (const x of todo)
        rejected.push({
          requirementId: x.t.requirementId,
          experienceId: x.packet.experienceId,
          reason: "time budget reached before repair",
          attempts: state.get(`${x.t.requirementId}|${x.packet.experienceId}`)!.attempts,
        });
      tr.metrics.discarded += todo.length;
      break;
    }
    const out = await callModel(tr, round === 0 ? "generate" : "repair", "strong", () =>
      ai.generateBullets({
        style: { targetWords, examples },
        items: todo.map(({ t, packet }) => {
          const st = state.get(`${t.requirementId}|${packet.experienceId}`)!;
          return {
            pairId: `${t.requirementId}|${packet.experienceId}`,
            requirement: t.template,
            evidence: packet.spans.map((s) => ({ id: s.id, text: s.text })),
            useTerms: packet.proven.filter((e) => e.kind === "concept" || e.kind === "tool").map((e) => ({ term: e.jdTerm, match: e.match })),
            avoidTerms: packet.unsupported,
            stakeholders: packet.stakeholderPhrases,
            transformation: packet.transformation,
            feedback: st.feedback,
            previous: st.previous,
          };
        }),
      }),
    );
    if (!out) {
      for (const x of todo)
        rejected.push({
          requirementId: x.t.requirementId,
          experienceId: x.packet.experienceId,
          reason: "generation failed",
          attempts: state.get(`${x.t.requirementId}|${x.packet.experienceId}`)!.attempts,
        });
      tr.metrics.discarded += todo.length;
      break;
    }
    const byPair = new Map(out.bullets.map((b) => [b.pairId, b]));
    for (const x of todo) {
      const key = `${x.t.requirementId}|${x.packet.experienceId}`;
      const st = state.get(key)!;
      st.attempts++;
      tr.metrics.attemptsTotal++;
      const raw = byPair.get(key);
      if (!raw || !raw.text.trim()) {
        st.done = true;
        tr.metrics.discarded++;
        rejected.push({ requirementId: x.t.requirementId, experienceId: x.packet.experienceId, reason: "model found no honest bullet", attempts: st.attempts });
        logger?.info("bullets.attempt", { requirementId: x.t.requirementId, experienceId: x.packet.experienceId, attempt: st.attempts, status: "empty" });
        continue;
      }
      tr.metrics.drafts++;
      const draft: BulletDraft = { pairId: key, text: normalizeEnding(raw.text, style), matchedTerms: raw.matchedTerms, ledger: raw.ledger };
      const report = validateDraft(draft, { template: x.t, packet: x.packet, profile: x.profile, style, accepted });
      logger?.info("bullets.attempt", {
        requirementId: x.t.requirementId,
        experienceId: x.packet.experienceId,
        attempt: st.attempts,
        status: report.pass ? "pass" : "fail",
        category: report.failures.map((f) => f.code).join(",") || undefined,
        confidence: report.alignment,
      });
      if (report.pass) {
        st.done = true;
        accepted.push(draft.text);
        validated.push({ draft, report, packet: x.packet, template: x.t, attempts: st.attempts });
        continue;
      }
      if (report.failures.some((f) => f.validator === "grounding")) tr.metrics.unsupportedClaimsBlocked++;
      st.previous = draft.text;
      st.feedback = repairFeedback(report, x.packet, x.t);
      if (st.attempts >= maxRounds) {
        st.done = true;
        tr.metrics.discarded++;
        rejected.push({
          requirementId: x.t.requirementId,
          experienceId: x.packet.experienceId,
          reason: `failed validation: ${[...new Set(report.failures.map((f) => f.code))].join(", ")}`,
          attempts: st.attempts,
        });
      }
    }
  }
  // Any packet still open after the last round is discarded.
  for (const x of packets) {
    const st = state.get(`${x.t.requirementId}|${x.packet.experienceId}`)!;
    if (!st.done && !rejected.some((r) => r.requirementId === x.t.requirementId && r.experienceId === x.packet.experienceId)) {
      tr.metrics.discarded++;
      rejected.push({ requirementId: x.t.requirementId, experienceId: x.packet.experienceId, reason: "not repaired in time", attempts: st.attempts });
    }
  }
  return finish(validated);
}

/** Match the user's ending punctuation (most résumés end bullets with or without a period consistently). */
function normalizeEnding(text: string, style: StyleContext): string {
  const t = text.trim().replace(/\s+/g, " ");
  const withPeriod = style.corpus.filter((x) => /\.$/.test(x.trim())).length;
  const wantPeriod = withPeriod >= style.corpus.length / 2;
  const bare = t.replace(/[.;,\s]+$/, "");
  return wantPeriod ? `${bare}.` : bare;
}
