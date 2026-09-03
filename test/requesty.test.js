import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import requestyModule, { discoverModels, normalizeBaseUrl, pricePerMillionTokens, toModel } from "../requesty.js";

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes", () => {
    assert.equal(normalizeBaseUrl("https://router.requesty.ai/v1///"), "https://router.requesty.ai/v1");
  });

  it("leaves a URL without trailing slash unchanged", () => {
    assert.equal(normalizeBaseUrl("https://router.requesty.ai/v1"), "https://router.requesty.ai/v1");
  });
});

describe("pricePerMillionTokens", () => {
  it("converts a per-token price to a per-million-token rate", () => {
    assert.equal(pricePerMillionTokens(0.000002), 2);
  });

  it("returns 0 when the price is missing", () => {
    assert.equal(pricePerMillionTokens(undefined), 0);
    assert.equal(pricePerMillionTokens(null), 0);
  });

  it("returns 0 when the price is 0", () => {
    assert.equal(pricePerMillionTokens(0), 0);
  });
});

describe("toModel", () => {
  it("maps a full model descriptor to the pi ProviderModelConfig shape", () => {
    const model = toModel({
      id: "vendor/model-1",
      name: "Model One",
      supports_reasoning: true,
      supports_vision: true,
      input_price: 0.000003,
      output_price: 0.000015,
      cached_price: 0.000001,
      caching_price: 0.000002,
      context_window: 200000,
      max_output_tokens: 16384,
    });

    assert.deepEqual(model, {
      id: "vendor/model-1",
      name: "Model One",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 1, cacheWrite: 2 },
      contextWindow: 200000,
      maxTokens: 16384,
    });
  });

  it("falls back to the id for the display name", () => {
    assert.equal(toModel({ id: "vendor/model-2" }).name, "vendor/model-2");
    assert.equal(toModel({ id: "vendor/model-3", name: "" }).name, "vendor/model-3");
  });

  it("defaults reasoning/vision to false and text-only input", () => {
    const model = toModel({ id: "vendor/model-4", supports_vision: false });
    assert.equal(model.reasoning, false);
    assert.deepEqual(model.input, ["text"]);
  });

  it("applies default context window and max tokens when absent", () => {
    const model = toModel({ id: "vendor/model-5" });
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxTokens, 4096);
  });

  it("zeroes missing cost fields", () => {
    const model = toModel({ id: "vendor/model-6" });
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("discoverModels", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it("sends the API key as a bearer token", async () => {
    let seenUrl;
    let seenHeaders;
    globalThis.fetch = async (url, opts) => {
      seenUrl = url;
      seenHeaders = opts.headers;
      return { ok: true, async json() { return { data: [{ id: "vendor/model-1" }] }; } };
    };

    const models = await discoverModels("https://router.requesty.ai/v1", "secret-key");

    assert.equal(seenUrl, "https://router.requesty.ai/v1/models");
    assert.equal(seenHeaders.Authorization, "Bearer secret-key");
    assert.equal(models.length, 1);
  });

  it("parses and maps the data array", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          data: [
            { id: "a/b", input_price: 0.000001 },
            { id: "c/d", name: "C D", supports_reasoning: true },
          ],
        };
      },
    });

    const models = await discoverModels("base", "key");
    assert.equal(models.length, 2);
    assert.equal(models[0].name, "a/b"); // falls back to id
    assert.equal(models[1].name, "C D"); // uses explicit name
    assert.equal(models[1].reasoning, true);
  });

  it("filters out entries without an id", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { data: [{ id: "ok/model" }, { name: "no-id" }, null] };
      },
    });

    const models = await discoverModels("base", "key");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "ok/model");
  });

  it("throws on a non-2xx response", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });

    await assert.rejects(discoverModels("base", "key"), /HTTP 401 Unauthorized/);
  });

  it("throws when the payload has no data array", async () => {
    globalThis.fetch = async () => ({ ok: true, async json() { return { object: "list" }; } });

    await assert.rejects(discoverModels("base", "key"), /Expected OpenAI-compatible response/);
  });
});

describe("extension registration and refreshModels", () => {
  it("registers the requesty provider with the expected config", async () => {
    const calls = [];
    const pi = { registerProvider: (name, config) => calls.push({ name, config }) };

    await requestyModule(pi);

    assert.equal(calls.length, 1);
    const { name, config } = calls[0];
    assert.equal(name, "requesty");
    assert.equal(config.name, "Requesty");
    assert.equal(config.baseUrl, "https://router.requesty.ai/v1");
    assert.equal(config.apiKey, "$REQUESTY_API_KEY");
    assert.equal(config.api, "openai-completions");
    assert.deepEqual(config.models, []);
    assert.equal(typeof config.refreshModels, "function");
  });

  async function captureConfig() {
    let config;
    await requestyModule({ registerProvider: (_name, c) => { config = c; } });
    return config;
  }

  /**
   * Build a RefreshModelsContext that mirrors how pi actually invokes
   * refreshModels: a `stored` snapshot (read from the provider's model store)
   * plus a `publish({ persist, update })` that writes the catalog back. There
   * is deliberately NO `store` object on the context — that was the bug.
   */
  function makeStore() {
    let entry; // ModelsStoreEntry | undefined
    const publishes = [];
    return {
      seed(models) {
        entry = { models, checkedAt: 1 };
      },
      peek: () => entry,
      publishes: () => publishes,
      context(overrides = {}) {
        const ctx = {
          credential: undefined,
          stored: entry ? structuredClone(entry) : undefined,
          async publish(publication) {
            publishes.push(publication);
            if (publication.persist !== undefined) {
              entry = publication.persist === null ? undefined : structuredClone(publication.persist);
            }
            publication.update?.();
            return true;
          },
          allowNetwork: true,
          signal: new AbortController().signal,
          ...overrides,
        };
        return ctx;
      },
    };
  }

  function okFetch(data) {
    globalThis.fetch = async () => ({ ok: true, async json() { return { data }; } });
  }

  it("does not fetch without a key and returns the cached list", async () => {
    const config = await captureConfig();
    const store = makeStore();
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { ok: true, async json() { return { data: [{ id: "nope/model" }] }; } }; };

    const result = await config.refreshModels(store.context({ allowNetwork: true, credential: undefined }));

    assert.deepEqual(result, []);
    assert.equal(fetched, false, "must not fetch (unscoped) without a key");
  });

  it("restores the cached list when network is disabled", async () => {
    const config = await captureConfig();
    const store = makeStore();
    store.seed([{ id: "vendor/cached", name: "Cached" }]);
    globalThis.fetch = async () => { throw new Error("should not fetch offline"); };

    const result = await config.refreshModels(store.context({ allowNetwork: false, credential: undefined }));

    assert.equal(result.length, 1);
    assert.equal(result[0].id, "vendor/cached");
  });

  it("fetches, caches, and returns discovered models when authenticated", async () => {
    const config = await captureConfig();
    const store = makeStore();
    okFetch([{ id: "vendor/live", name: "Live", input_price: 0.000005 }]);

    const result = await config.refreshModels(
      store.context({ allowNetwork: true, credential: { type: "api_key", key: "secret" } }),
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].id, "vendor/live");
    assert.equal(result[0].cost.input, 5);
    // Persisted with a checkedAt timestamp.
    const entry = store.peek();
    assert.equal(entry.models.length, 1);
    assert.equal(typeof entry.checkedAt, "number");
    // And the persist publication carried the models + checkedAt.
    const persisted = store.publishes().find((p) => p.persist);
    assert.ok(persisted, "should publish a persisted catalog");
    assert.equal(persisted.persist.models.length, 1);
    assert.equal(typeof persisted.persist.checkedAt, "number");
  });

  it("propagates fetch failures while retaining the previous list", async () => {
    const config = await captureConfig();
    const store = makeStore();
    store.seed([{ id: "vendor/prior", name: "Prior" }]);
    globalThis.fetch = async () => ({ ok: false, status: 503, statusText: "Service Unavailable" });

    await assert.rejects(
      config.refreshModels(store.context({ allowNetwork: true, credential: { type: "api_key", key: "secret" } })),
      /HTTP 503/,
    );
    // Nothing new was persisted; the prior catalog is untouched.
    assert.equal(store.peek().models[0].id, "vendor/prior");
    assert.equal(store.publishes().some((p) => p.persist), false, "must not persist on failure");
  });

  it("does not write to the store when aborted", async () => {
    const config = await captureConfig();
    const store = makeStore();
    store.seed([{ id: "vendor/prior", name: "Prior" }]);
    const controller = new AbortController();
    controller.abort();
    okFetch([{ id: "vendor/aborted" }]);

    const result = await config.refreshModels(
      store.context({
        allowNetwork: true,
        credential: { type: "api_key", key: "secret" },
        signal: controller.signal,
      }),
    );

    assert.deepEqual(result, [{ id: "vendor/prior", name: "Prior" }], "should serve the cached list when aborted");
    assert.equal(store.peek().models[0].id, "vendor/prior", "store must not be overwritten when aborted");
  });
});