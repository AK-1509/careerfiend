import { z } from "zod/v4";
import { CareerFiendError, type Logger } from "@careerfiend/shared";
import {
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

/**
 * Any OpenAI-compatible chat-completions API in JSON mode: OpenAI, Google
 * Gemini, OpenRouter, Groq, DeepSeek, Mistral, Together, a local Ollama... These
 * have no schema-enforced output in common, so every answer is parsed and
 * checked against the same zod schema the policy layer relies on, with one
 * corrective retry that lists the problems.
 */

export interface DeepSeekProviderOptions {
  /** Shown in errors and logs, e.g. "OpenAI". Default "DeepSeek". */
  label?: string;
  /** Provider id reported as `name`. Default "deepseek". */
  name?: string;
  /** OpenAI's newer models take max_completion_tokens instead of max_tokens. */
  tokenParam?: "max_tokens" | "max_completion_tokens";
  /** Send response_format json_object (default true). */
  jsonMode?: boolean;
  apiKey: string;
  /** e.g. "deepseek-chat". */
  model: string;
  /** e.g. "https://api.deepseek.com". */
  baseUrl: string;
  /** Output cap per request (the chat model allows about 8K tokens). */
  maxTokens?: number;
  logger?: Logger;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string };
}

export class DeepSeekProvider implements AiProvider {
  readonly name: string;
  readonly available = true;
  private readonly fetchImpl: typeof fetch;
  private readonly maxTokens: number;
  private readonly label: string;

  constructor(private readonly opts: DeepSeekProviderOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxTokens = opts.maxTokens ?? 8192;
    this.label = opts.label ?? "DeepSeek";
    this.name = opts.name ?? "deepseek";
  }

  /** One tiny request: confirms the address, key and model work. Null when fine, else the reason. */
  async checkCredentials(): Promise<string | null> {
    try {
      const { content } = await this.chat(
        [
          { role: "system", content: 'Reply with the JSON object {"ok": true} and nothing else.' },
          { role: "user", content: "ping" },
        ],
        64,
        30_000,
      );
      return content.trim() ? null : `${this.label} answered with an empty reply.`;
    } catch (err) {
      return (err as Error).message;
    }
  }

  private async chat(messages: ChatMessage[], maxTokens: number, timeoutMs?: number): Promise<{ content: string; finish: string }> {
    let res: Response;
    const L = this.label;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          ...(this.opts.jsonMode === false ? {} : { response_format: { type: "json_object" } }),
          [this.opts.tokenParam ?? "max_tokens"]: maxTokens,
          stream: false,
        }),
        // Never follow redirects: the address was checked when it was saved.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs ?? 240_000),
      });
    } catch (err) {
      throw new CareerFiendError("NETWORK_TRANSIENT", `${L} could not be reached.`, { cause: err });
    }
    const body = (await res.json().catch(() => ({}))) as ChatResponse;
    if (!res.ok) {
      const detail = (body.error?.message ?? `HTTP ${res.status}`).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new CareerFiendError("FATAL_CONFIGURATION", `${L} rejected the API key (${detail}).`);
      if (res.status === 402) throw new CareerFiendError("FATAL_CONFIGURATION", `The ${L} account has insufficient balance.`);
      if (res.status === 404) throw new CareerFiendError("FATAL_CONFIGURATION", `${L} does not know model ${this.opts.model} (${detail}).`);
      if (res.status === 429 || res.status >= 500) throw new CareerFiendError("NETWORK_TRANSIENT", `${L} is busy (${detail}).`);
      throw new CareerFiendError("VALIDATION_FAILED", `${L} rejected the request: ${detail}`);
    }
    const choice = body.choices?.[0];
    return { content: choice?.message?.content ?? "", finish: choice?.finish_reason ?? "unknown" };
  }

  /** JSON-mode request validated against the task's schema; one retry with the problems listed. */
  private async run<T extends z.ZodType>(task: StructuredTask<T>): Promise<z.infer<T>> {
    const started = Date.now();
    const schema = JSON.stringify(z.toJSONSchema(task.schema));
    const messages: ChatMessage[] = [
      { role: "system", content: `${task.system}\n\nReply with one JSON object only, matching this JSON Schema exactly:\n${schema}` },
      { role: "user", content: task.user },
    ];
    let problem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const { content, finish } = await this.chat(messages, Math.min(task.maxTokens, this.maxTokens));
      if (finish === "length") problem = "The answer was cut off at the token limit; answer more briefly.";
      else if (!content.trim()) problem = "The answer was empty.";
      else {
        let json: unknown;
        try {
          json = JSON.parse(content);
        } catch {
          json = undefined;
          problem = "The answer was not valid JSON.";
        }
        if (json !== undefined) {
          const parsed = task.schema.safeParse(json);
          if (parsed.success) {
            this.opts.logger?.info("ai.call", { durationMs: Date.now() - started, status: this.name });
            return parsed.data;
          }
          problem = `The JSON did not match the schema: ${parsed.error.issues
            .slice(0, 8)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}.`;
        }
      }
      if (content.trim()) messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: `${problem} Reply again with one corrected JSON object.` });
    }
    throw new CareerFiendError("VALIDATION_FAILED", `${this.label} returned output that did not match the schema. ${problem}`);
  }

  draftCoverLetter(req: CoverLetterRequest): Promise<CoverLetterDraft> {
    return this.run(TASKS.coverLetter(req));
  }

  proposeMappings(req: Parameters<AiProvider["proposeMappings"]>[0]): Promise<MappingProposal> {
    return this.run(TASKS.mappings(req));
  }

  splitRequirements(req: { pageText: string }): Promise<RequirementSplit> {
    return this.run(TASKS.split(req));
  }

  mapDemand(req: DemandRequest): Promise<DemandMap> {
    return this.run(TASKS.demand(req));
  }

  decomposeRequirements(req: RequirementDecompositionRequest): Promise<RequirementDecompositionOutput> {
    return this.run(TASKS.decomposeRequirements(req));
  }

  extractExperience(req: ExperienceExtractionRequest): Promise<ExperienceExtractionOutput> {
    return this.run(TASKS.extractExperience(req));
  }

  rerankEvidence(req: EvidenceRerankRequest): Promise<EvidenceRerankOutput> {
    return this.run(TASKS.rerankEvidence(req));
  }

  generateBullets(req: GroundedBulletRequest): Promise<GroundedBulletsOutput> {
    return this.run(TASKS.generateBullets(req));
  }

  proposeTransfers(req: TransferRequest): Promise<TransferProposal> {
    return this.run(TASKS.transfers(req));
  }

  draftFreeResponse(req: Parameters<AiProvider["draftFreeResponse"]>[0]): Promise<FreeResponseDraft> {
    return this.run(TASKS.freeResponse(req));
  }

  classifyEmail(req: Parameters<AiProvider["classifyEmail"]>[0]): Promise<EmailClassificationDraft> {
    return this.run(TASKS.email(req));
  }

  async mapProjectAsks(req: ProjectMappingRequest): Promise<ProjectMapping> {
    return this.run(TASKS.projectMapping(req));
  }

  async synthesizeProjectIdeas(req: ProjectIdeasRequest): Promise<ProjectIdea[]> {
    // One fewer idea at most than Claude's cap: chat models' output limits are smaller.
    return (await this.run(TASKS.projectIdeas(req, req.minimum + 1))).ideas;
  }

  structureResume(req: { text: string }): Promise<ResumeStructure> {
    return this.run(TASKS.structureResume(req));
  }
}

/** The same client under the name the public edition uses for every OpenAI-compatible provider. */
export const OpenAICompatibleProvider = DeepSeekProvider;
