import { createConnectedProvider, lmPreset, NullProvider, type AiProvider, type LmConnection, type LmProviderId } from "@careerfiend/ai";
import { assertPublicUrl, CareerFiendError, decrypt, encrypt } from "@careerfiend/shared";
import type { AppContext } from "./context";

/**
 * Bring-your-own language model (public edition). After sign-up each person is
 * asked to connect a model of their choice; it powers Project Recommendations
 * and sharpens tailoring (requirement splitting, job-specific bullets, cover
 * letters, reading a résumé PDF). They may skip: everything else runs on the
 * deterministic path. The connection, key included, is stored encrypted with
 * the account's own key and is never shown again in full.
 */

const KEY = "lm.connection";
const SKIPPED = "lm.skipped";

export type LmState =
  | {
      status: "connected";
      provider: LmProviderId;
      providerLabel: string;
      model: string;
      fastModel?: string;
      baseUrl?: string;
      keyHint: string;
      connectedAt: string;
    }
  | { status: "skipped"; at: string }
  | { status: "undecided" };

interface Stored extends LmConnection {
  connectedAt: string;
}

async function readStored(ctx: AppContext): Promise<Stored | null> {
  const row = await ctx.db.setting.findUnique({ where: { key: KEY } });
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.value, ctx.key())) as Stored;
  } catch {
    return null;
  }
}

export async function lmState(ctx: AppContext): Promise<LmState> {
  const stored = await readStored(ctx);
  if (stored) {
    const preset = lmPreset(stored.provider);
    return {
      status: "connected",
      provider: stored.provider,
      providerLabel: preset?.label ?? stored.provider,
      model: stored.model,
      ...(stored.fastModel ? { fastModel: stored.fastModel } : {}),
      ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
      keyHint: stored.apiKey ? `…${stored.apiKey.slice(-4)}` : "no key",
      connectedAt: stored.connectedAt,
    };
  }
  const skipped = await ctx.db.setting.findUnique({ where: { key: SKIPPED } });
  return skipped ? { status: "skipped", at: skipped.value } : { status: "undecided" };
}

/** The provider for this account's connection, or the deterministic NullProvider. */
export async function loadLmProvider(ctx: AppContext): Promise<AiProvider> {
  const stored = await readStored(ctx);
  if (!stored) return new NullProvider();
  try {
    return createConnectedProvider(stored, ctx.logger);
  } catch (err) {
    ctx.logger.warn("lm.unusable", { error: err });
    return new NullProvider();
  }
}

export interface LmConnectInput {
  provider: string;
  model: string;
  fastModel?: string;
  baseUrl?: string;
  apiKey: string;
}

/**
 * Check a connection with one tiny request, then store it. Throws with a
 * readable reason when the provider, address, key or model is not usable.
 */
export async function connectLm(ctx: AppContext, input: LmConnectInput, opts: { skipTest?: boolean } = {}): Promise<LmState> {
  const preset = lmPreset(input.provider);
  if (!preset) throw new CareerFiendError("VALIDATION_FAILED", "Choose a provider.");
  const model = input.model.trim() || preset.defaultModel || "";
  if (!model) throw new CareerFiendError("VALIDATION_FAILED", `Enter the model to use (${preset.modelHint}).`);
  if (!/^[\w.:/@+-]{1,120}$/.test(model)) throw new CareerFiendError("VALIDATION_FAILED", "That model id contains characters model ids never use.");
  const apiKey = input.apiKey.trim();
  if (!apiKey && preset.id !== "custom") throw new CareerFiendError("VALIDATION_FAILED", `Paste your ${preset.label} API key.`);
  let baseUrl: string | undefined;
  if (preset.id === "custom") {
    baseUrl = input.baseUrl?.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new CareerFiendError("VALIDATION_FAILED", "Enter the API base URL (the part before /chat/completions).");
    const hosted = ctx.config.CAREERFIEND_MODE === "hosted";
    const u = await assertPublicUrl(baseUrl, { allowLocalhost: !hosted });
    if (hosted && u.protocol !== "https:") throw new CareerFiendError("VALIDATION_FAILED", "Use an https:// address so your key is never sent in the clear.");
  }
  const conn: LmConnection = {
    provider: preset.id,
    model,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(input.fastModel?.trim() ? { fastModel: input.fastModel.trim() } : {}),
  };
  if (!opts.skipTest) {
    const provider = createConnectedProvider(conn, ctx.logger);
    const problem = provider.checkCredentials ? await provider.checkCredentials() : null;
    if (problem) throw new CareerFiendError("VALIDATION_FAILED", `Could not connect: ${problem}`);
  }
  const stored: Stored = { ...conn, connectedAt: ctx.now().toISOString() };
  const value = encrypt(JSON.stringify(stored), ctx.key());
  await ctx.db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  await ctx.db.setting.deleteMany({ where: { key: SKIPPED } });
  ctx.ai = createConnectedProvider(conn, ctx.logger);
  ctx.logger.info("lm.connected", { status: preset.id });
  return lmState(ctx);
}

/** "Skip for now": stop asking. Project Recommendations stays off until a model is connected. */
export async function skipLm(ctx: AppContext): Promise<void> {
  const at = ctx.now().toISOString();
  await ctx.db.setting.upsert({ where: { key: SKIPPED }, create: { key: SKIPPED, value: at }, update: { value: at } });
}

/** Forget the connection and its key. */
export async function disconnectLm(ctx: AppContext): Promise<void> {
  await ctx.db.setting.deleteMany({ where: { key: KEY } });
  await skipLm(ctx);
  ctx.ai = new NullProvider();
}
