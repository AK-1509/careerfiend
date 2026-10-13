import type { Logger } from "@careerfiend/shared";
import type { AiProvider } from "./common";
import { DeepSeekProvider } from "./deepseek";
import { AnthropicProvider } from "./index";

/**
 * Bring-your-own language model (public edition). Each person connects the
 * provider of their choice from the dashboard; the key is stored encrypted in
 * their own data and used only for their requests. Anthropic uses its SDK
 * (schema-enforced output); every other provider goes through the
 * OpenAI-compatible client with schema checks and one corrective retry.
 */

export type LmProviderId = "anthropic" | "openai" | "gemini" | "openrouter" | "groq" | "deepseek" | "mistral" | "custom";

export interface LmPreset {
  id: LmProviderId;
  label: string;
  /** OpenAI-compatible base URL (not used for Anthropic; required from the user for "custom"). */
  baseUrl?: string;
  /** Example model id shown as a placeholder. */
  modelHint: string;
  /** Prefilled model id when the provider has a sensible default. */
  defaultModel?: string;
  /** Where to create an API key. */
  keyUrl?: string;
  tokenParam?: "max_tokens" | "max_completion_tokens";
  /** Data-handling note shown next to the choice. */
  note?: string;
}

export const LM_PRESETS: LmPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    modelHint: "claude-sonnet-5-5",
    defaultModel: "claude-sonnet-5-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    modelHint: "a chat model id from your OpenAI account",
    keyUrl: "https://platform.openai.com/api-keys",
    tokenParam: "max_completion_tokens",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelHint: "a Gemini model id, e.g. from Google AI Studio",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    label: "OpenRouter (many models)",
    baseUrl: "https://openrouter.ai/api/v1",
    modelHint: "provider/model as listed on openrouter.ai/models",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    modelHint: "a model id from console.groq.com",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    modelHint: "deepseek-chat",
    defaultModel: "deepseek-chat",
    keyUrl: "https://platform.deepseek.com/api_keys",
    note: "DeepSeek's privacy policy says data is processed and stored in China.",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    modelHint: "a model id from console.mistral.ai",
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "custom",
    label: "Other OpenAI-compatible API",
    modelHint: "the model id your server expects",
    note: "Any service with an OpenAI-style /chat/completions endpoint (Together, Fireworks, a self-hosted server...). A local Ollama works only when you run CareerFiend yourself.",
  },
];

export function lmPreset(id: string): LmPreset | undefined {
  return LM_PRESETS.find((p) => p.id === id);
}

export interface LmConnection {
  provider: LmProviderId;
  model: string;
  /** Optional cheaper model for extraction steps (defaults to `model`). */
  fastModel?: string;
  /** Only for "custom" (OpenAI-compatible base URL, e.g. https://api.together.xyz/v1). */
  baseUrl?: string;
  apiKey: string;
}

/** A provider for one person's connection. Throws on an unknown provider or a missing base URL. */
export function createConnectedProvider(conn: LmConnection, logger?: Logger): AiProvider {
  const preset = lmPreset(conn.provider);
  if (!preset) throw new Error(`Unknown language model provider "${conn.provider}".`);
  if (conn.provider === "anthropic") {
    return new AnthropicProvider({ apiKey: conn.apiKey, model: conn.model, fastModel: conn.fastModel || undefined, logger });
  }
  const baseUrl = conn.provider === "custom" ? conn.baseUrl : preset.baseUrl;
  if (!baseUrl) throw new Error("Enter the API base URL of your provider.");
  return new DeepSeekProvider({
    name: conn.provider,
    label: preset.id === "custom" ? new URL(baseUrl).hostname : preset.label.replace(/ \(.*\)$/, ""),
    apiKey: conn.apiKey,
    model: conn.model,
    baseUrl,
    tokenParam: preset.tokenParam,
    logger,
  });
}
