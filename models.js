import { DEFAULT_BASE_URL, normalizeBaseUrl } from "./endpoint.js";

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function price(value) {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number * 1_000_000 : 0;
}

function rates(entry) {
  return {
    input: price(entry.input_price),
    output: price(entry.output_price),
    cacheRead: price(entry.cached_price),
    cacheWrite: price(entry.caching_price),
  };
}

function cost(model) {
  const tiers = Array.isArray(model.pricing)
    ? model.pricing.filter((tier) => tier && Number.isFinite(tier.prompt_tokens_threshold) && tier.prompt_tokens_threshold >= 0)
      .sort((a, b) => a.prompt_tokens_threshold - b.prompt_tokens_threshold)
    : [];
  const base = tiers.find((tier) => tier.prompt_tokens_threshold === 0) ?? model;
  const result = rates(base);
  const higher = tiers.filter((tier) => tier.prompt_tokens_threshold > 0);
  if (higher.length) {
    result.tiers = higher.map((tier) => ({ ...rates(tier), inputTokensAbove: tier.prompt_tokens_threshold }));
  }
  return result;
}

export function assembleModels(payload, baseUrl = DEFAULT_BASE_URL) {
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Invalid Requesty catalog: expected a data array.");
  }
  const models = new Map();
  for (const model of payload.data) {
    if (!model || typeof model.id !== "string" || !model.id.trim()) continue;
    if (model.api && model.api !== "chat") continue;
    if (model.supports_tool_calling === false) continue;
    const contextWindow = positiveInteger(model.context_window, 128000);
    models.set(model.id, {
      id: model.id,
      name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
      provider: "requesty",
      api: "openai-completions",
      baseUrl,
      reasoning: model.supports_reasoning === true,
      // Requesty normalizes these efforts across upstream providers. xhigh is
      // model-specific, so use high until the catalog advertises that capability.
      thinkingLevelMap: model.supports_reasoning === true
        ? { off: "none", minimal: "min", low: "low", medium: "medium", high: "high", xhigh: "high", max: "max" }
        : undefined,
      input: model.supports_vision === true ? ["text", "image"] : ["text"],
      cost: cost(model),
      contextWindow,
      maxTokens: Math.min(positiveInteger(model.max_output_tokens, 4096), contextWindow),
      compat: {
        supportsDeveloperRole: model.supports_role_developer === true,
        supportsReasoningEffort: model.supports_reasoning === true,
        supportsMidConvoSystemMessages: model.supports_system_mid_conversation === true,
      },
    });
  }
  return [...models.values()];
}

export async function fetchModels(context) {
  const baseUrl = normalizeBaseUrl(context.credential?.env?.REQUESTY_BASE_URL ?? context.baseUrl ?? DEFAULT_BASE_URL);
  const key = context.credential?.key;
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) {
    let regionalPolicy = false;
    if (response.status === 403) {
      const body = await response.json().catch(() => null);
      regionalPolicy = typeof body?.message === "string" && /regional domain/i.test(body.message);
    }
    const hint = regionalPolicy
      ? " Your organization requires a regional endpoint. Run /login requesty and choose EU or Custom URL, or set REQUESTY_BASE_URL (for example https://router.eu.requesty.ai/v1)."
      : response.status === 401 || response.status === 403 ? " Run /login requesty to check your API key and endpoint." : "";
    throw new Error(`Requesty model catalog at ${baseUrl} returned HTTP ${response.status}.${hint}`);
  }
  return assembleModels(await response.json(), baseUrl);
}
