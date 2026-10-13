import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { CareerFiendError, type Logger } from "@careerfiend/shared";
import {
  NullProvider,
  TASKS,
  type AiProvider,
  type CoverLetterDraft,
  type CoverLetterRequest,
  type EmailClassificationDraft,
  type FreeResponseDraft,
  type MappingProposal,
  type ProjectIdea,
  type ProjectIdeasRequest,
  type ProjectMapping,
  type ProjectMappingRequest,
  type RequirementSplit,
  type ResumeStructure,
  type StructuredTask,
  type DemandMap,
  type DemandRequest,
  type EvidenceRerankOutput,
  type EvidenceRerankRequest,
  type ExperienceExtractionOutput,
  type ExperienceExtractionRequest,
  type GroundedBulletRequest,
  type GroundedBulletsOutput,
  type RequirementDecompositionOutput,
  type RequirementDecompositionRequest,
  type TransferProposal,
  type TransferRequest,
} from "./common";
import { DeepSeekProvider } from "./deepseek";

export * from "./connection";

export * from "./common";
export * from "./deepseek";

/* ------------------------------------------------------ Anthropic impl */

export interface AnthropicProviderOptions {
  apiKey?: string;
  model: string;
  /** Cheaper model for structured extraction (tasks with tier "fast"); defaults to `model`. */
  fastModel?: string;
  logger?: Logger;
  client?: Anthropic;
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly available = true;
  private client: Anthropic;
  private model: string;
  private fastModel: string;
  private logger?: Logger;

  constructor(opts: AnthropicProviderOptions) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model;
    this.fastModel = opts.fastModel ?? opts.model;
    this.logger = opts.logger;
  }

  async checkCredentials(): Promise<string | null> {
    try {
      // Token counting is free and needs a valid key and a model id the account can use.
      await this.client.messages.countTokens({ model: this.model, messages: [{ role: "user", content: "ping" }] });
      return null;
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected.";
      if (err instanceof Anthropic.PermissionDeniedError) return "The key has no access to this model.";
      if (err instanceof Anthropic.NotFoundError) return `Unknown model ${this.model}.`;
      if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}`.trim();
      return "Anthropic API could not be reached.";
    }
  }

  private mapError(err: unknown): unknown {
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
      return new CareerFiendError("NETWORK_TRANSIENT", "AI provider temporarily unavailable.", { cause: err });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return new CareerFiendError("FATAL_CONFIGURATION", "The Anthropic API key is invalid.", { cause: err });
    }
    return err;
  }

  private async structured<T extends z.ZodType>(
    schema: T,
    system: string,
    user: string,
    maxTokens = 16000,
    effort?: "low" | "medium" | "high",
    tier: "fast" | "strong" = "strong",
  ): Promise<z.infer<T>> {
    const started = Date.now();
    // The fast tier (structured extraction) runs on the cheaper model, which takes neither effort nor refusal fallbacks.
    const fast = tier === "fast" && this.fastModel !== this.model;
    const model = fast ? this.fastModel : this.model;
    let response;
    try {
      const params = {
        model,
        max_tokens: maxTokens,
        ...(fast ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
        messages: [{ role: "user" as const, content: user }],
        output_config: { format: betaZodOutputFormat(schema), ...(effort && !fast ? { effort } : {}) },
      };
      // Long outputs stream (no HTTP timeout); short ones use a plain request.
      response = maxTokens > 16000 ? await this.client.beta.messages.stream(params).finalMessage() : await this.client.beta.messages.parse(params);
    } catch (err) {
      throw this.mapError(err);
    }
    this.logger?.info("ai.call", { durationMs: Date.now() - started, status: response.stop_reason ?? "unknown", model });
    if (response.stop_reason === "refusal") {
      throw new CareerFiendError("VALIDATION_FAILED", "The AI provider declined this request.");
    }
    if (response.stop_reason === "max_tokens" || response.parsed_output === null || response.parsed_output === undefined) {
      throw new CareerFiendError("VALIDATION_FAILED", "The AI provider returned output that did not match the schema.");
    }
    // Re-validate: the policy layer depends on these shapes.
    return schema.parse(response.parsed_output);
  }

  private run<T extends z.ZodType>(t: StructuredTask<T>, effort?: "low" | "medium" | "high"): Promise<z.infer<T>> {
    return this.structured(t.schema, t.system, t.user, t.maxTokens, effort ?? t.effort, t.tier ?? "strong");
  }

  async draftCoverLetter(req: CoverLetterRequest): Promise<CoverLetterDraft> {
    return this.run(TASKS.coverLetter(req));
  }

  async proposeMappings(req: Parameters<AiProvider["proposeMappings"]>[0]): Promise<MappingProposal> {
    return this.run(TASKS.mappings(req));
  }

  async splitRequirements(req: { pageText: string }): Promise<RequirementSplit> {
    return this.run(TASKS.split(req));
  }

  async mapDemand(req: DemandRequest): Promise<DemandMap> {
    return this.run(TASKS.demand(req), "medium");
  }

  async decomposeRequirements(req: RequirementDecompositionRequest): Promise<RequirementDecompositionOutput> {
    return this.run(TASKS.decomposeRequirements(req));
  }

  async extractExperience(req: ExperienceExtractionRequest): Promise<ExperienceExtractionOutput> {
    return this.run(TASKS.extractExperience(req));
  }

  async rerankEvidence(req: EvidenceRerankRequest): Promise<EvidenceRerankOutput> {
    return this.run(TASKS.rerankEvidence(req));
  }

  async generateBullets(req: GroundedBulletRequest): Promise<GroundedBulletsOutput> {
    return this.run(TASKS.generateBullets(req));
  }

  async proposeTransfers(req: TransferRequest): Promise<TransferProposal> {
    return this.run(TASKS.transfers(req), "low");
  }

  async draftFreeResponse(req: Parameters<AiProvider["draftFreeResponse"]>[0]): Promise<FreeResponseDraft> {
    return this.run(TASKS.freeResponse(req));
  }

  async mapProjectAsks(req: ProjectMappingRequest): Promise<ProjectMapping> {
    return this.run(TASKS.projectMapping(req), "medium");
  }

  async synthesizeProjectIdeas(req: ProjectIdeasRequest): Promise<ProjectIdea[]> {
    return (await this.run(TASKS.projectIdeas(req), "medium")).ideas;
  }

  async classifyEmail(req: Parameters<AiProvider["classifyEmail"]>[0]): Promise<EmailClassificationDraft> {
    return this.run(TASKS.email(req));
  }

  async structureResume(req: { text: string }): Promise<ResumeStructure> {
    return this.run(TASKS.structureResume(req));
  }
}

export interface ProviderConfig {
  AI_PROVIDER: string;
  AI_MODEL: string;
  AI_FAST_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL: string;
  DEEPSEEK_BASE_URL: string;
  DEEPSEEK_MAX_TOKENS?: number;
}

/** anthropic: Claude for everything. deepseek: DeepSeek for everything. No key for the chosen provider: deterministic. */
export function createProvider(config: ProviderConfig, logger?: Logger): AiProvider {
  const claude = config.ANTHROPIC_API_KEY
    ? new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.AI_MODEL, fastModel: config.AI_FAST_MODEL, logger })
    : undefined;
  if (config.AI_PROVIDER === "anthropic" && claude) return claude;
  if (config.AI_PROVIDER === "deepseek" && config.DEEPSEEK_API_KEY) {
    return new DeepSeekProvider({
      apiKey: config.DEEPSEEK_API_KEY,
      model: config.DEEPSEEK_MODEL,
      baseUrl: config.DEEPSEEK_BASE_URL,
      maxTokens: config.DEEPSEEK_MAX_TOKENS,
      logger,
    });
  }
  // No key: run fully deterministic (fallback letters, free-text questions go to NEEDS_INPUT).
  return new NullProvider();
}
