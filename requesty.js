import fs from "node:fs";
import path from "node:path";

import { authJsonPath, modelsJsonPath, readStoredApiKey, resolveConfigValue } from "./credentials.js";

const PROVIDER = "requesty";
const DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
const DEFAULT_NAME = "Requesty";
const DEFAULT_API = "openai-completions";
// The router turns on Anthropic auto caching from the first turn for this referer.
const DEFAULT_HEADERS = { "HTTP-Referer": "https://pi.dev", "X-Title": "Pi" };
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const DISCOVERY_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error("Requesty base URL must be a full URL, for example https://router.eu.requesty.ai/v1");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Requesty base URL must use HTTP(S), without credentials, query parameters, or a fragment");
  }
  if (url.pathname === "/") url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Read models.json.
 *
 * A missing file is not an error: a stored `auth.json` credential is enough to
 * discover models, and the write path creates the provider entry if needed. A
 * malformed one still is: nothing here may quietly replace configuration it did
 * not understand, because `/requesty-models-sync` writes this file back.
 */
function readModelsJson() {
  const modelsPath = modelsJsonPath();
  if (!fs.existsSync(modelsPath)) {
    return { providers: {} };
  }

  const data = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  if (!data.providers || typeof data.providers !== "object" || Array.isArray(data.providers)) {
    throw new Error(`${modelsPath} does not define providers as an object`);
  }

  const configured = data.providers[PROVIDER];
  if (configured !== undefined && (typeof configured !== "object" || configured === null || Array.isArray(configured))) {
    throw new Error(`providers.${PROVIDER} in ${modelsPath} is not an object`);
  }

  return data;
}

/**
 * The key for model discovery: a stored `auth.json` credential first, then
 * `providers.requesty.apiKey`. Either may be a `!command`, `$VAR` or a literal.
 */
function resolveRequestyKey(provider, options = {}) {
  const stored = readStoredApiKey(PROVIDER, options);
  if (stored.key) {
    return stored;
  }

  const fromModelsJson = resolveConfigValue(provider?.apiKey, options.env);
  if (fromModelsJson) {
    return { key: fromModelsJson, source: `providers.${PROVIDER}.apiKey in ${modelsJsonPath()}` };
  }

  return { reason: stored.reason };
}

/**
 * The provider settings plus the key used to reach `<baseUrl>/models`. A key that
 * came from `auth.json` stays out of `provider`, so it cannot reach the registered
 * provider or a `models.json` write.
 */
function withDefaultHeaders(headers) {
  const configured = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  const names = new Set(Object.keys(configured).map((name) => name.toLowerCase()));
  const missing = Object.entries(DEFAULT_HEADERS).filter(([name]) => !names.has(name.toLowerCase()));
  return { ...Object.fromEntries(missing), ...configured };
}

function getRequestyConfig(options = {}) {
  const data = readModelsJson();
  const provider = data.providers[PROVIDER] ?? {};

  const name = typeof provider.name === "string" && provider.name.length > 0 ? provider.name : DEFAULT_NAME;

  const baseUrl = normalizeBaseUrl(
    process.env.REQUESTY_BASE_URL ||
      (typeof provider.baseUrl === "string" && provider.baseUrl.length > 0 ? provider.baseUrl : DEFAULT_BASE_URL),
  );

  // pi rejects a provider without `api`, which is what a missing models.json gives.
  const api = typeof provider.api === "string" && provider.api.length > 0 ? provider.api : DEFAULT_API;

  const resolved = resolveRequestyKey(provider, options);

  return {
    data,
    provider: { ...provider, name, baseUrl, api, headers: withDefaultHeaders(provider.headers) },
    key: resolved.key,
    keySource: resolved.source,
    keyProblem: resolved.key ? undefined : resolved.reason,
  };
}

async function fetchModelList({ baseUrl, apiKey }, path) {
  let response;

  try {
    // Bounded on purpose: this runs while pi is still starting up, and pi awaits
    // the extension while loading it, so an endpoint that accepts and never
    // answers would otherwise keep the TUI from ever appearing.
    response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`no response from ${baseUrl}${path} within ${DISCOVERY_TIMEOUT_MS}ms`);
    }
    throw error;
  }

  if (!response.ok) {
    if (response.status === 403) {
      const body = await response.json().catch(() => null);
      if (typeof body?.message === "string" && /regional domain/i.test(body.message)) {
        throw new Error(
          `Requesty requires a regional endpoint. Set providers.requesty.baseUrl in ~/.pi/agent/models.json ` +
          `or REQUESTY_BASE_URL (for example https://router.eu.requesty.ai/v1). Current endpoint: ${provider.baseUrl}`,
        );
      }
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Expected OpenAI-compatible response with a data array");
  }

  return payload.data;
}

async function discoverModels(connection) {
  const [plainResult, managedResult] = await Promise.allSettled([
    fetchModelList(connection, "/models"),
    fetchModelList(connection, "/models/managed"),
  ]);

  // /models is required; managed policies are optional so a failure there doesn't drop every model.
  if (plainResult.status === "rejected") {
    throw plainResult.reason;
  }

  const plain = plainResult.value;
  let managed = [];
  if (managedResult.status === "fulfilled") {
    managed = managedResult.value;
  } else {
    const reason = managedResult.reason instanceof Error ? managedResult.reason.message : String(managedResult.reason);
    console.warn(`[pi-requesty-model-discovery] managed policies discovery failed: ${reason}`);
  }

  const byId = new Map();
  for (const model of [...plain, ...managed]) {
    if (model && typeof model.id === "string" && model.id.length > 0 && !byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }

  return [...byId.values()]
    .map((model) => {
      const reasoning = model.supports_reasoning === true;
      return {
        id: model.id,
        name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
        reasoning,
        // pi exposes the extended `max` thinking level only when a model declares it in
        // `thinkingLevelMap`; standard levels (`minimal`..`high`) are implicit via pi's
        // provider default mapping. `max` is a global Requesty effort value normalized
        // per backend (OpenAI -> high, Anthropic/Gemini -> token budget), so it is safe
        // to advertise `max` for every reasoning-capable model.
        thinkingLevelMap: reasoning ? { max: "max" } : undefined,
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
    });
}

function pricePerMillionTokens(value) {
  return (value ?? 0) * 1_000_000;
}

function writeModelsJson(data) {
  const modelsPath = modelsJsonPath();
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${modelsPath}.tmp`;
  // models.json can hold a literal apiKey: the replacement must stay owner-only.
  // `mode` only applies when the file is created, so drop a leftover tmp first.
  fs.rmSync(tmpPath, { force: true });
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, modelsPath);
}

/**
 * Write the discovered models back to models.json.
 *
 * Only `models` is replaced: a key that came from `auth.json` stays out of the
 * file, and a malformed or hand-edited provider entry keeps its other fields.
 */
function updateModelsJson(data, models) {
  data.providers = data.providers && typeof data.providers === "object" ? data.providers : {};
  const existing = data.providers[PROVIDER] ?? {};
  data.providers[PROVIDER] = {
    ...existing,
    // pi needs both to load models.json custom models, and a fresh file has neither.
    baseUrl: existing.baseUrl || DEFAULT_BASE_URL,
    api: existing.api || DEFAULT_API,
    headers: withDefaultHeaders(existing.headers),
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  };
  writeModelsJson(data);
}

const KEY_HELP = [
  "Set the Requesty key in either place:",
  `  ${authJsonPath()}`,
  '    { "requesty": { "type": "api_key", "key": "!secret-tool lookup requesty api-key" } }',
  `  ${modelsJsonPath()}`,
  '    { "providers": { "requesty": { "apiKey": "rqsty-sk-..." } } }',
  'Both accept a "!command", a "$VARIABLE" reference, or a literal value.',
].join("\n");

export default async function (pi) {
  pi.registerCommand("requesty-models-sync", {
    description: "Dynamically discover Requesty models and update the local models.json.",
    async handler(_args, ctx) {
      ctx.ui.setStatus("requesty-models-sync", "Discovering Requesty models...");

      try {
        const { data, provider, key, keySource, keyProblem } = getRequestyConfig();

        if (!key) {
          ctx.ui.notify(`No Requesty credential available.\n\n${keyProblem}\n\n${KEY_HELP}`, "error");
          return;
        }

        const models = await discoverModels({ baseUrl: provider.baseUrl, apiKey: key });
        updateModelsJson(data, models);
        ctx.ui.notify(
          `Discovered ${models.length} Requesty model(s) using the key from ${keySource}. Run /reload to use models.json changes.`,
          "success",
        );
      } catch (error) {
        ctx.ui.notify(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        ctx.ui.setStatus("requesty-models-sync", undefined);
      }
    },
  });

  try {
    const { provider, key } = getRequestyConfig();

    // No credential is not a failure: Pi resolves credentials for inference
    // itself, and models already listed in models.json keep working. Discovery
    // is the only thing that needs the key, so skip it quietly.
    if (!key) {
      return;
    }

    const models = await discoverModels({ baseUrl: provider.baseUrl, apiKey: key });

    if (models.length > 0) {
      pi.registerProvider(PROVIDER, {
        ...provider,
        models,
      });
    }
  } catch (error) {
    console.warn(
      `[pi-requesty-model-discovery] startup discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
