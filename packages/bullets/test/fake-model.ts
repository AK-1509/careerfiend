import {
  NullProvider,
  type EvidenceRerankOutput,
  type EvidenceRerankRequest,
  type ExperienceExtractionOutput,
  type ExperienceExtractionRequest,
  type GroundedBulletRequest,
  type GroundedBulletsOutput,
  type RequirementDecompositionOutput,
  type RequirementDecompositionRequest,
} from "@careerfiend/ai";

export type GenItem = GroundedBulletRequest["items"][number];

/** A scripted reply for one item: text and ledger, given the item and which attempt this is (1-based). */
export type Writer = (item: GenItem, attempt: number) => { text: string; ledger?: { claim: string; sources: string[] }[]; matchedTerms?: string[] } | null;

/**
 * Stand-in for the model in tests and regression runs. Reranking is
 * deterministic (supports what the evidence literally names); generation is
 * scripted per requirement so tests can feed it honest, adversarial or
 * empty answers and watch the validators and the repair loop.
 */
export class ScriptedBulletModel extends NullProvider {
  override readonly name = "scripted";
  override readonly available = true;
  calls: { method: string; size: number }[] = [];
  generateRequests: GroundedBulletRequest[] = [];
  private attempts = new Map<string, number>();

  constructor(
    private readonly writer: Writer,
    private readonly opts: { decompose?: (req: RequirementDecompositionRequest) => RequirementDecompositionOutput; rerankNone?: RegExp } = {},
  ) {
    super();
  }

  override async decomposeRequirements(req: RequirementDecompositionRequest): Promise<RequirementDecompositionOutput> {
    this.calls.push({ method: "decompose", size: req.items.length });
    return this.opts.decompose?.(req) ?? { items: [] };
  }

  override async extractExperience(req: ExperienceExtractionRequest): Promise<ExperienceExtractionOutput> {
    this.calls.push({ method: "extract", size: req.spans.length });
    return { spans: [] };
  }

  override async rerankEvidence(req: EvidenceRerankRequest): Promise<EvidenceRerankOutput> {
    this.calls.push({ method: "rerank", size: req.pairs.length });
    return {
      pairs: req.pairs.map((p) => {
        const text = p.evidence.map((e) => e.text.toLowerCase()).join(" ");
        const supported = p.elements.skills.filter((s) => text.includes(s.toLowerCase()));
        const none = this.opts.rerankNone?.test(p.requirement) ?? false;
        return {
          pairId: p.pairId,
          matchScore: none ? 0.1 : 0.8,
          supportLevel: none ? ("none" as const) : ("strong" as const),
          supportedActions: [],
          supportedSkills: supported,
          supportedStakeholders: [],
          evidenceIds: p.evidence.slice(0, 2).map((e) => e.id),
          unsupported: p.elements.skills.filter((s) => !supported.includes(s)),
          transformation: "Frame the supported activity in the requirement's terms.",
        };
      }),
    };
  }

  override async generateBullets(req: GroundedBulletRequest): Promise<GroundedBulletsOutput> {
    this.calls.push({ method: "generate", size: req.items.length });
    this.generateRequests.push(structuredClone(req));
    return {
      bullets: req.items.flatMap((item) => {
        const n = (this.attempts.get(item.pairId) ?? 0) + 1;
        this.attempts.set(item.pairId, n);
        const out = this.writer(item, n);
        if (!out) return [{ pairId: item.pairId, text: "", matchedTerms: [], ledger: [] }];
        return [
          {
            pairId: item.pairId,
            text: out.text,
            matchedTerms: out.matchedTerms ?? [],
            ledger: out.ledger ?? [{ claim: out.text, sources: [item.evidence[0]!.id] }],
          },
        ];
      }),
    };
  }
}
