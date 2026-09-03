/**
 * pi-requesty: Requesty provider extension for the Pi Coding Agent.
 *
 * Registers the Requesty router (https://router.requesty.ai) as an
 * OpenAI-compatible provider. The model catalog is discovered from
 * <baseUrl>/models and cached through pi's standard provider model store.
 * The catalog is surfaced via the RefreshModelsContext: `context.stored` (the
 * last persisted catalog, restored by pi before each refresh phase) and
 * `context.publish({ persist })` (which writes the refreshed catalog back to
 * pi's store). pi refreshes it automatically on startup (offline restore
 * first, then online) and when the model picker opens. No manual models.json
 * writes are performed.
 *
 * Authentication is resolved by pi in the standard way:
 *   - /login requesty  (stored credential), or
 *   - REQUESTY_API_KEY environment variable
 *
 * Do not configure the provider in ~/.pi/agent/models.json; the extension
 * defines the endpoint and (optionally) the account's allowed models are
 * discovered at runtime.
 */

const PROVIDER = "requesty";
const DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
const DEFAULT_NAME = "Requesty";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;

export function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

/** Requesty prices are per-token; pi expects per-million-token rates. */
export function pricePerMillionTokens(value) {
  return (value ?? 0) * 1_000_000;
}

/** Map a Requesty model descriptor to pi's ProviderModelConfig shape. */
export function toModel(model) {
  return {
    id: model.id,
    name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
    reasoning: model.supports_reasoning === true,
    input: model.supports_vision === true ? ["text", "image"] : ["text"],
    cost: {
      input: pricePerMillionTokens(model.input_price),
      output: pricePerMillionTokens(model.output_price),
      cacheRead: pricePerMillionTokens(model.cached_price),
      cacheWrite: pricePerMillionTokens(model.caching_price),
    },
    contextWindow: model.context_window || DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_output_tokens || DEFAULT_MAX_TOKENS,
  };
}

/**
 * Discover models from the Requesty /models endpoint.
 * The endpoint is OpenAI-compatible ({ data: [...] }).
 */
export async function discoverModels(baseUrl, apiKey, signal) {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Expected OpenAI-compatible response with a data array");
  }

  return payload.data
    .filter((model) => model && typeof model.id === "string" && model.id.length > 0)
    .map(toModel);
}

export default function (pi) {
  const baseUrl = normalizeBaseUrl(DEFAULT_BASE_URL);

  pi.registerProvider(PROVIDER, {
    name: DEFAULT_NAME,
    baseUrl,
    apiKey: "$REQUESTY_API_KEY",
    api: "openai-completions",
    // Baseline catalog is empty; models are populated dynamically by
    // refreshModels and persisted in pi's provider model store.
    models: [],

    /**
     * Standard pi model refresh with caching. pi calls this automatically:
     *   - on startup, first offline (cache restore) then online (refresh)
     *   - whenever the model picker / model refresh runs
     *
     * The returned list replaces this provider's extension-provided models and
     * is captured by pi's provider composer. On failure we rethrow so pi
     * retains the previous list and surfaces the error; the cache from the
     * last successful refresh is always restored first (via `context.stored`)
     * so models remain available offline.
     *
     * Caching uses pi's standard provider model store, surfaced through the
     * RefreshModelsContext:
     *   - `context.stored`  — the last persisted catalog ({ models, checkedAt }),
     *                          restored for us by pi before each refresh phase.
     *   - `context.publish({ persist })` — writes the new catalog back to the
     *                          store so it is reused on the next launch, even
     *                          offline or before the next refresh completes.
     * (There is no `context.store` object to read/write directly.)
     *
     * The API key is required for discovery: an unauthenticated /models call
     * returns Requesty's full public catalog (~hundreds of models), while the
     * authenticated call returns only the models this account has enabled.
     * We never want the unscoped list, so without a key we return the cached
     * catalog (possibly empty on first run) and skip the network entirely.
     */
    async refreshModels(context) {
      const cached = Array.isArray(context.stored?.models) ? context.stored.models : [];

      // Offline restore, or already aborted: serve the cached catalog only.
      if (!context.allowNetwork || context.signal?.aborted) {
        return cached;
      }

      const apiKey =
        context.credential?.type === "api_key" && typeof context.credential.key === "string"
          ? context.credential.key
          : undefined;

      // No key resolved: pi normally skips refresh in this case, but guard
      // defensively so we never fall back to the unauthenticated (unscoped)
      // catalog. Return the cached list (possibly empty on first run).
      if (!apiKey) {
        return cached;
      }

      const discovered = await discoverModels(baseUrl, apiKey, context.signal);
      if (context.signal?.aborted) {
        return cached;
      }

      // Persist the refreshed catalog; the returned list updates the in-memory
      // provider model set. (Aborted publishes are rejected by pi, so the
      // previous catalog remains untouched.)
      await context.publish({ persist: { models: discovered, checkedAt: Date.now() } });
      return discovered;
    },
  });
}
