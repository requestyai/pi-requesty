import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import extension, { requestyProvider } from "../requesty.js";
import { assembleModels } from "../models.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const entry = {
  id: "anthropic/test",
  supports_tool_calling: true,
  supports_reasoning: true,
  supports_vision: true,
  context_window: 200000,
  max_output_tokens: 64000,
  input_price: 0.000003,
  output_price: 0.000015,
  cached_price: 0.0000003,
};
const catalog = (data = [entry]) => Response.json({ data });

async function runtime({ credentials = new InMemoryCredentialStore(), modelsStore = new InMemoryModelsStore(), env = {} } = {}) {
  const models = createModels({ credentials, modelsStore, authContext: {
    env: async (name) => env[name], fileExists: async () => false,
  } });
  models.setProvider(requestyProvider());
  return { models, credentials, modelsStore };
}

async function login(models, key = "test-key") {
  return models.login("requesty", "api_key", { prompt: async (prompt) => prompt.type === "select" ? "default" : key, notify() {} });
}

test("native login prompts for a secret, stores the trimmed key, and logout removes it", async () => {
  const { models, credentials } = await runtime({ env: { REQUESTY_API_KEY: "env-key" } });
  assert.equal((await models.getAuth("requesty")).auth.apiKey, "env-key");
  const notices = [];
  await models.login("requesty", "api_key", {
    prompt: async (prompt) => {
      if (prompt.type === "select") return "default";
      assert.equal(prompt.type, "secret"); return "  stored-key  ";
    },
    notify: (notice) => notices.push(notice),
  });
  assert.equal(notices[0].links[0].url, "https://app.requesty.ai/api-keys");
  assert.deepEqual(await credentials.read("requesty"), { type: "api_key", key: "stored-key" });
  assert.equal((await models.getAuth("requesty")).auth.apiKey, "stored-key");
  await models.logout("requesty");
  assert.equal(await credentials.read("requesty"), undefined);
  assert.equal((await models.getAuth("requesty")).auth.apiKey, "env-key");
});

test("empty and cancelled logins preserve existing credentials", async () => {
  const { models, credentials } = await runtime();
  await login(models);
  await assert.rejects(login(models, "  "), /must not be empty/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(models.login("requesty", "api_key", {
    signal: controller.signal, prompt: async () => { assert.fail("prompted after abort"); }, notify() {},
  }));
  assert.equal((await credentials.read("requesty")).key, "test-key");
});

test("authenticated discovery persists, restores offline, and replaces removed models", async () => {
  const { models, credentials, modelsStore } = await runtime();
  await login(models);
  globalThis.fetch = async (url, options) => {
    assert.ok(["https://router.requesty.ai/v1/models", "https://router.requesty.ai/v1/models/managed"].includes(url));
    assert.equal(options.headers.Authorization, "Bearer test-key");
    assert.ok(options.signal instanceof AbortSignal);
    return catalog();
  };
  assert.equal((await models.refresh()).errors.size, 0);
  assert.equal(models.getModels("requesty").length, 1);
  const stored = await modelsStore.read("requesty");
  assert.equal(stored.models[0].id, entry.id);
  assert.ok(!JSON.stringify(stored).includes("test-key"));
  const offline = (await runtime({ credentials, modelsStore })).models;
  globalThis.fetch = async () => { assert.fail("network during offline refresh"); };
  await offline.refresh({ allowNetwork: false });
  assert.equal(offline.getModels("requesty").length, 1);
  globalThis.fetch = async () => catalog([]);
  await models.refresh();
  assert.deepEqual(models.getModels("requesty"), []);
});

test("bad responses and cancellation retain the previous catalog", async () => {
  const { models, modelsStore } = await runtime();
  await login(models);
  globalThis.fetch = async () => catalog();
  await models.refresh();
  for (const response of [new Response("secret server detail", { status: 403 }), Response.json({ error: "bad" })]) {
    globalThis.fetch = async () => response;
    const result = await models.refresh();
    assert.equal(result.errors.size, 1);
    assert.ok(!result.errors.get("requesty").message.includes("secret server detail"));
    assert.equal(models.getModels("requesty").length, 1);
    assert.equal((await modelsStore.read("requesty")).models.length, 1);
  }
  const controller = new AbortController();
  globalThis.fetch = async (_url, options) => {
    controller.abort();
    options.signal.throwIfAborted();
  };
  assert.equal((await models.refresh({ signal: controller.signal })).aborted, true);
  assert.equal(models.getModels("requesty").length, 1);
});

test("catalog maps capabilities, per-token and tiered prices, and safe limits", () => {
  const models = assembleModels({ data: [entry, null, { id: "" }, { id: "embedding", api: "embedding" },
    { id: "no-tools", supports_tool_calling: false }, { id: "fallback", context_window: -1, max_output_tokens: "oops", input_price: "NaN" },
    { ...entry, id: "tiered", pricing: [
      { prompt_tokens_threshold: 200000, input_price: 0.000006, output_price: 0.0000225 },
      { prompt_tokens_threshold: 0, input_price: 0.000003, output_price: 0.000015 },
    ] },
  ] });
  assert.equal(models.length, 3);
  assert.deepEqual(models[0].input, ["text", "image"]);
  assert.equal(models[0].reasoning, true);
  assert.equal(models[0].compat.supportsDeveloperRole, false);
  assert.deepEqual(models[0].cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
  assert.equal(models[1].contextWindow, 128000);
  assert.equal(models[1].maxTokens, 4096);
  assert.equal(models[1].cost.input, 0);
  assert.equal(models[2].cost.tiers[0].inputTokensAbove, 200000);
  assert.equal(models[2].cost.tiers[0].input, 6);
});

test("pi's runtime composes regional endpoint overrides with native auth and discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-requesty-test-"));
  try {
    const modelsPath = join(directory, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { requesty: { baseUrl: "https://router.eu.requesty.ai/v1" } } }));
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(modelRuntime);
    registry.registerProvider(requestyProvider());
    assert.equal(registry.getProviderDisplayName("requesty"), "Requesty");
    await modelRuntime.login("requesty", "api_key", { prompt: async (prompt) => prompt.type === "select" ? "default" : "regional-key", notify() {} });
    globalThis.fetch = async (url, options) => {
      assert.ok(["https://router.eu.requesty.ai/v1/models", "https://router.eu.requesty.ai/v1/models/managed"].includes(url));
      assert.equal(options.headers.Authorization, "Bearer regional-key");
      return catalog();
    };
    const result = await registry.refresh({ providers: ["requesty"], allowNetwork: true });
    assert.equal(result.errors.size, 0);
    assert.equal(registry.find("requesty", entry.id).baseUrl, "https://router.eu.requesty.ai/v1");
    assert.equal(await registry.getApiKeyForProvider("requesty"), "regional-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("extension registers native auth immediately and refresh aliases update live", async () => {
  const commands = new Map();
  let provider;
  extension({ registerProvider: (value) => { provider = value; }, registerCommand: (name, command) => commands.set(name, command) });
  assert.equal(provider.id, "requesty");
  assert.ok(provider.auth.apiKey.login);
  assert.equal(commands.get("requesty-refresh"), commands.get("requesty-models-sync"));
  const notifications = [];
  const statuses = [];
  const { models } = await runtime();
  await login(models);
  globalThis.fetch = async () => catalog();
  await commands.get("requesty-refresh").handler("", {
    modelRegistry: { getApiKeyForProvider: async () => "test-key", refresh: (options) => models.refresh(options), getAll: () => models.getModels() },
    ui: { setStatus: (...args) => statuses.push(args), notify: (...args) => notifications.push(args) },
  });
  assert.match(notifications[0][0], /Registered 1/);
  assert.deepEqual(statuses.at(-1), ["requesty-refresh", undefined]);
});

test("built-in streaming handles tool calls, tool results, reasoning effort, and usage", async () => {
  const { models } = await runtime();
  await login(models);
  globalThis.fetch = async () => catalog();
  await models.refresh();
  const model = models.getModels("requesty")[0];
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const first = requests.length === 1;
    const chunks = [
      { choices: [{ index: 0, delta: first
        ? { role: "assistant", tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }] }
        : { role: "assistant", content: "Checked ✓" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const { Type } = await import("@earendil-works/pi-ai");
  const context = {
    systemPrompt: "You are a coding assistant.",
    messages: [{ role: "user", content: "Read README.md", timestamp: Date.now() }],
    tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
  };
  const first = await models.completeSimple(model, context, { reasoning: "minimal" });
  assert.equal(first.stopReason, "toolUse", first.errorMessage);
  const toolCall = first.content.find((part) => part.type === "toolCall");
  assert.deepEqual(toolCall.arguments, { path: "README.md" });
  assert.equal(requests[0].reasoning_effort, "min");
  assert.equal(requests[0].messages[0].role, "system");
  assert.equal(first.usage.cacheRead, 40);
  assert.equal(first.usage.input, 60);
  assert.ok(first.usage.cost.total > 0);
  const second = await models.completeSimple(model, { ...context, messages: [
    ...context.messages, first,
    { role: "toolResult", toolCallId: toolCall.id, toolName: "read", content: [{ type: "text", text: "# README" }], isError: false, timestamp: Date.now() },
  ] });
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(second.content.find((part) => part.type === "text").text, "Checked ✓");
  assert.ok(requests[1].messages.some((message) => message.role === "tool"));
});

for (const scenario of [
  { name: "EU login", selection: "eu", expected: "https://router.eu.requesty.ai/v1" },
  { name: "custom login", selection: "custom", url: " https://router.eu.requesty.ai/ ", expected: "https://router.eu.requesty.ai/v1" },
  { name: "environment", env: { REQUESTY_BASE_URL: "https://router.eu.requesty.ai/v1/" }, expected: "https://router.eu.requesty.ai/v1" },
  { name: "stored endpoint takes priority over environment", selection: "eu", env: { REQUESTY_BASE_URL: "https://router.requesty.ai/v1" }, expected: "https://router.eu.requesty.ai/v1" },
]) {
  test(`${scenario.name} routes discovery and cached-model inference to the same endpoint`, async () => {
    const { models, credentials } = await runtime({ env: scenario.env });
    await models.login("requesty", "api_key", {
      prompt: async (prompt) => prompt.type === "secret" ? "regional-key"
        : prompt.type === "select" ? scenario.selection ?? "default" : scenario.url,
      notify() {},
    });
    if (scenario.selection) {
      assert.equal((await credentials.read("requesty")).env.REQUESTY_BASE_URL, scenario.expected);
    }
    // Simulate a selected model restored from an earlier global-endpoint session.
    const cachedModel = assembleModels({ data: [entry] })[0];
    const seen = [];
    globalThis.fetch = async (url, options) => {
      seen.push(String(url));
      if (String(url).includes("/models")) {
        assert.equal(options.headers.Authorization, "Bearer regional-key");
        return catalog();
      }
      return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const result = await models.refresh();
    assert.equal(result.errors.size, 0);
    assert.equal(models.getModels("requesty")[0].baseUrl, scenario.expected);
    const answer = await models.completeSimple(cachedModel, {
      messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
    });
    assert.equal(answer.stopReason, "stop", answer.errorMessage);
    assert.deepEqual(seen, [`${scenario.expected}/models`, `${scenario.expected}/models/managed`, `${scenario.expected}/chat/completions`]);
  });
}

test("invalid custom endpoints and cancelled region selection preserve credentials", async () => {
  const { models, credentials } = await runtime();
  await login(models);
  for (const url of ["bad url", "ftp://example.com/v1", "https://user:password@example.com/v1", "https://example.com/v1?key=secret"]) {
    await assert.rejects(models.login("requesty", "api_key", {
      prompt: async (prompt) => prompt.type === "secret" ? "new-key" : prompt.type === "select" ? "custom" : url,
      notify() {},
    }), /base URL/);
    assert.deepEqual(await credentials.read("requesty"), { type: "api_key", key: "test-key" });
  }
  await assert.rejects(models.login("requesty", "api_key", {
    prompt: async (prompt) => {
      if (prompt.type === "secret") return "new-key";
      throw new Error("Cancelled");
    }, notify() {},
  }), /Cancelled/);
  assert.deepEqual(await credentials.read("requesty"), { type: "api_key", key: "test-key" });
});

test("regional policy errors explain endpoint setup without exposing the server response", async () => {
  const { models } = await runtime();
  await login(models);
  globalThis.fetch = async () => Response.json({
    origin: "router", message: "Your organization's policy requires requests via its regional domain", secret: "private server data",
  }, { status: 403 });
  const result = await models.refresh();
  const message = result.errors.get("requesty").message;
  assert.match(message, /https:\/\/router.requesty.ai\/v1/);
  assert.match(message, /choose EU/);
  assert.match(message, /REQUESTY_BASE_URL/);
  assert.ok(!message.includes("private server data"));
});

test("managed policies merge with ordinary models without overriding duplicate IDs", async () => {
  const { models } = await runtime();
  await login(models);
  globalThis.fetch = async (url) => String(url).endsWith("/models/managed")
    ? catalog([{ ...entry, name: "Duplicate policy" }, { id: "policy/team", name: "Team router" }])
    : catalog([{ ...entry, name: "Ordinary model" }]);
  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.deepEqual(models.getModels("requesty").map((model) => [model.id, model.name]), [
    [entry.id, "Ordinary model"], ["policy/team", "Team router"],
  ]);
});

test("managed endpoint failures leave ordinary models available", async () => {
  const { models } = await runtime();
  await login(models);
  for (const failure of [
    () => new Response("Not found", { status: 404 }),
    () => Response.json({ unexpected: [] }),
    () => { throw new Error("Network failure"); },
  ]) {
    globalThis.fetch = async (url) => String(url).endsWith("/models/managed") ? failure() : catalog();
    const result = await models.refresh();
    assert.equal(result.errors.size, 0);
    assert.deepEqual(models.getModels("requesty").map((model) => model.id), [entry.id]);
  }
});
