/**
 * Typed contracts between the stages of job-specific bullet generation:
 *
 *   requirements -> RequirementTemplate[]        (normalize.ts)
 *   résumé       -> ExperienceProfile[]          (experience.ts, cached per résumé version)
 *   template x profiles -> Candidate[]           (semantic.ts retrieval + scoring.ts structured scores)
 *   candidate    -> EvidencePacket               (evidence.ts: relevant vs proven)
 *   packet       -> BulletDraft                  (generation, via the AI provider)
 *   draft        -> ValidationReport             (validate.ts: grounding, alignment, ATS, quality)
 *   drafts       -> GeneratedBullet[]            (select.ts)
 */

export type SparseVector = Record<string, number>;

export interface ActionRef {
  /** Base form, e.g. "develop". */
  verb: string;
  family: string;
}

export interface ConceptRef {
  id: string;
  label: string;
  domain: string;
  /** Wording as written in the source. */
  term: string;
  weak: boolean;
}

export interface StakeholderRef {
  category: string;
  /** Wording as written in the source (often a specific title; never copied into a bullet). */
  as: string;
}

export interface Discarded {
  text: string;
  reason: "company" | "location" | "low_value" | "seniority" | "title" | "framing" | "constraint";
}

/** Grammatical/semantic decomposition of one sentence (shared by job requirements and résumé lines). */
export interface Decomposition {
  actions: ActionRef[];
  /** Each action with its own objects, in order ("Conduct user research ... to identify pain points"). */
  clauses: { verb: string; objects: string[]; joiner: "and" | "to" | null }[];
  objects: string[];
  concepts: ConceptRef[];
  /** Named tools/technologies. */
  tools: string[];
  stakeholders: StakeholderRef[];
  outcome: string | null;
  context: string | null;
  /** Numbers with what they count ("12 batches", "95% forecast accuracy"). */
  metrics: string[];
  /** People management or authority over others. */
  managerial: boolean;
  /** "duty" (verb-led) or "skill" (noun-led: "Experience with SQL"). */
  frame: "duty" | "skill";
  discarded: Discarded[];
  /** Text after framing, culture and company language were removed. */
  core: string;
}

export interface RequirementTemplate extends Decomposition {
  requirementId: string;
  category: string;
  kind: string;
  sourceText: string;
  /** Normalized wording, e.g. "Develop product goals and KPIs using competitive intelligence with leadership." */
  template: string;
  /** From the platform's existing analysis (category weight, keyword weight, order). Higher first. */
  importance: number;
  /** Dominant domain, used to weight similarity dimensions. */
  domain: string;
  /** 0..1. Below LOW_CONFIDENCE the uncertain details are never treated as hard requirements. */
  confidence: number;
  lowConfidence: boolean;
  /** Years and other checkable constraints: recorded, never used for bullets. */
  constraints: string[];
  method: "rules" | "model";
  vector: SparseVector;
}

export interface EvidenceSpan {
  /** Provenance key into resume.json, e.g. experiences[acme].responsibilities[0]. */
  id: string;
  kind: "bullet" | "summary" | "skills";
  text: string;
}

export interface Attribute {
  value: string;
  family?: string;
  /** Evidence span ids the attribute comes from. */
  sources: string[];
}

/** Structured capability representation of one experience; every attribute points back at its source lines. */
export interface ExperienceProfile {
  experienceId: string;
  type: string;
  role: string;
  organization: string | null;
  industry: string | null;
  actions: Attribute[];
  objects: Attribute[];
  concepts: Attribute[];
  tools: Attribute[];
  methods: Attribute[];
  stakeholders: Attribute[];
  outputs: Attribute[];
  outcomes: Attribute[];
  metrics: Attribute[];
  scale: Attribute[];
  userExposure: boolean;
  managerial: boolean;
  evidence: EvidenceSpan[];
  /** Per-span decomposition (cached; the matcher works on these, not on raw text). */
  spans: Record<string, Decomposition>;
  spanVectors: Record<string, SparseVector>;
  vector: SparseVector;
}

export interface DimensionScores {
  action: number;
  object: number;
  skill: number;
  method: number;
  stakeholder: number;
  outcome: number;
  industry: number;
  semantic: number;
}

export interface Candidate {
  requirementId: string;
  experienceId: string;
  /** Best-matching evidence spans of the experience, strongest first. */
  spanIds: string[];
  retrieval: number;
  dims: DimensionScores;
  /** Weighted structured score, 0..1. */
  score: number;
}

/** Model reranking verdict for one (template, candidate) pair, after id validation. */
export interface RerankVerdict {
  matchScore: number;
  supportLevel: "strong" | "partial" | "none";
  supportedActions: string[];
  supportedSkills: string[];
  supportedStakeholders: string[];
  evidenceIds: string[];
  unsupported: string[];
  transformation: string;
}

export interface ProvenElement {
  kind: "action" | "concept" | "tool" | "stakeholder" | "outcome";
  /** Family / category / tool name. */
  value: string;
  /** The employer's wording for it (for ATS alignment). */
  jdTerm: string;
  /** exact: the evidence uses the employer's wording; equivalent: same concept, different wording. */
  match: "exact" | "equivalent";
  sources: string[];
}

/** What can legitimately be claimed for one requirement from one experience. Relevance is not proof. */
export interface EvidencePacket {
  requirementId: string;
  experienceId: string;
  anchorId: string;
  spans: EvidenceSpan[];
  proven: ProvenElement[];
  /** Employer terms the evidence does not establish: must not appear in the bullet. */
  unsupported: string[];
  /** Broad stakeholder phrases the evidence supports. */
  stakeholderPhrases: string[];
  relevance: number;
  supportLevel: "strong" | "partial" | "weak";
  transformation: string;
}

export interface LedgerEntry {
  claim: string;
  sources: string[];
}

export interface BulletDraft {
  pairId: string;
  text: string;
  matchedTerms: string[];
  ledger: LedgerEntry[];
}

export type FailureCode =
  | "unsupported_number"
  | "unsupported_tool"
  | "unsupported_concept"
  | "unsupported_term"
  | "unsupported_stakeholder"
  | "specific_title"
  | "unsupported_management"
  | "unsupported_outcome"
  | "unsupported_action"
  | "unsupported_credential"
  | "invalid_ledger"
  | "jd_mismatch"
  | "missing_terminology"
  | "too_long"
  | "too_short"
  | "no_action_verb"
  | "filler"
  | "keyword_repetition"
  | "duplicate"
  | "no_improvement"
  | "formatting";

export interface Failure {
  validator: "grounding" | "alignment" | "ats" | "quality";
  code: FailureCode;
  detail: string;
}

export interface ValidationReport {
  pass: boolean;
  failures: Failure[];
  /** Supported employer terms present in the bullet. */
  matchedTerms: string[];
  /** Supported employer terms the bullet could still use. */
  missingTerms: string[];
  alignment: number;
}

export interface GeneratedBullet {
  experienceId: string;
  requirementId: string;
  /** Résumé line the bullet replaces in this job's résumé. */
  anchorId: string;
  /** Other lines of the same experience folded into this bullet (left out of this résumé). */
  absorbedIds: string[];
  text: string;
  originalText: string;
  template: string;
  relevanceScore: number;
  groundingStatus: "verified";
  evidenceIds: string[];
  matchedTerms: string[];
  ledger: LedgerEntry[];
  attempts: number;
}

export interface RejectedCandidate {
  requirementId: string;
  experienceId: string | null;
  reason: string;
  attempts: number;
}

export interface BulletMetrics {
  templates: number;
  lowConfidenceTemplates: number;
  candidates: number;
  packets: number;
  drafts: number;
  accepted: number;
  kept_original: number;
  discarded: number;
  attemptsTotal: number;
  /** Claims the validators stopped (counted per failing draft). */
  unsupportedClaimsBlocked: number;
  llmCalls: number;
  modelCalls: { stage: string; tier: "fast" | "strong"; durationMs: number; ok: boolean }[];
  durationMs: number;
}

export interface GeneratedBulletSet {
  bullets: GeneratedBullet[];
  rejected: RejectedCandidate[];
  templates: Pick<RequirementTemplate, "requirementId" | "template" | "confidence" | "method" | "importance" | "domain">[];
  metrics: BulletMetrics;
}
