import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Run the unchanged extension entrypoint with an isolated home and mocked HTTP.
// No pi installation, third-party dependencies, real keys, or network needed.
const runner = `
  const scenario = JSON.parse(process.env.REQUESTY_TEST_SCENARIO);
  const urls = [], warnings = [], providers = [], commands = {}, notifications = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.endsWith("/models/managed")) {
      if (scenario.managedFailure) return new Response("Unavailable", { status: 503 });
      return Response.json({ data: [{ id: "policy/team" }] });
    }
    return Response.json({ data: [{ id: "chat/model", supports_tool_calling: false }] });
  };
  const { default: extension } = await import(scenario.entrypoint);
  await extension({
    registerCommand: (name, command) => { commands[name] = command; },
    registerProvider: (id, config) => providers.push({ id, config }),
  });
  if (scenario.sync) await commands["requesty-models-sync"].handler("", {
    ui: { setStatus() {}, notify: (message) => notifications.push(message) },
  });
  const { readFileSync } = await import("node:fs");
  const stored = JSON.parse(readFileSync(scenario.configPath, "utf8"));
  process.stdout.write(JSON.stringify({ urls, warnings, providers, notifications, stored }));
`;

const STUB = new URL("../test-support/pi-stub.mjs", import.meta.url).href;

function run(scenario = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "requesty-endpoint-"));
  try {
    const configPath = path.join(directory, ".pi", "agent", "models.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ providers: { requesty: {
      apiKey: "test-key", api: scenario.api ?? "openai-completions", models: [],
      headers: { "HTTP-Referer": "https://pi.dev", "X-Title": "Pi" },
      ...(scenario.configured ? { baseUrl: scenario.configured } : {}),
    } } }));
    const env = { ...process.env, HOME: directory };
    delete env.REQUESTY_BASE_URL;
    delete env.PI_CODING_AGENT_DIR;
    if (scenario.override !== undefined) env.REQUESTY_BASE_URL = scenario.override;
    env.REQUESTY_TEST_SCENARIO = JSON.stringify({ ...scenario, configPath, entrypoint: new URL("../requesty.js", import.meta.url).href });
    return JSON.parse(execFileSync(process.execPath, ["--import", STUB, "--input-type=module", "-e", runner], { env, encoding: "utf8" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [name, scenario, expected] of [
  ["global default", {}, "https://router.requesty.ai/v1"],
  ["configured EU", { configured: "https://router.eu.requesty.ai/v1/" }, "https://router.eu.requesty.ai/v1"],
  ["environment overrides configuration", { configured: "https://router.requesty.ai/v1", override: "https://router.eu.requesty.ai/v1" }, "https://router.eu.requesty.ai/v1"],
  ["bare regional domain", { configured: " https://router.eu.requesty.ai/ " }, "https://router.eu.requesty.ai/v1"],
  ["custom proxy path", { configured: "http://localhost:8080/gateway/v1///" }, "http://localhost:8080/gateway/v1"],
]) {
  test(name, () => {
    const result = run(scenario);
    assert.deepEqual(result.urls, [`${expected}/models`, `${expected}/models/managed`]);
    assert.equal(result.providers[0].config.baseUrl, expected);
    assert.deepEqual(result.providers[0].config.headers, { "HTTP-Referer": "https://pi.dev", "X-Title": "Pi" });
    assert.deepEqual(result.providers[0].config.models.map((model) => model.id), ["chat/model", "policy/team"]);
  });
}

test("invalid endpoint fails before HTTP", () => {
  for (const configured of ["not-a-url", "ftp://example.com", "https://user:secret@example.com/v1", "https://example.com/v1?secret=value", "https://example.com/v1#fragment"]) {
    const result = run({ configured });
    assert.deepEqual(result.urls, []);
    assert.deepEqual(result.providers, []);
    assert.match(result.warnings[0], /base URL/);
  }
});

test("anthropic-messages keeps a bare domain for inference but discovers under /v1", () => {
  const result = run({ configured: "https://router.requesty.ai/", api: "anthropic-messages" });
  assert.deepEqual(result.urls, ["https://router.requesty.ai/v1/models", "https://router.requesty.ai/v1/models/managed"]);
  assert.equal(result.providers[0].config.baseUrl, "https://router.requesty.ai");
});

test("managed endpoint failure preserves ordinary models", () => {
  const result = run({ configured: "https://router.eu.requesty.ai/v1", managedFailure: true });
  assert.deepEqual(result.providers[0].config.models.map((model) => model.id), ["chat/model"]);
});

test("sync keeps credentials and headers without persisting the environment override", () => {
  const result = run({ configured: "https://router.requesty.ai/v1", override: "https://router.eu.requesty.ai/v1", sync: true });
  const provider = result.stored.providers.requesty;
  assert.equal(provider.baseUrl, "https://router.requesty.ai/v1");
  assert.equal(provider.apiKey, "test-key");
  assert.equal(provider.headers["X-Title"], "Pi");
  assert.deepEqual(provider.models.map((model) => model.id), ["chat/model", "policy/team"]);
  assert.ok(result.urls.every((url) => url.startsWith("https://router.eu.requesty.ai/v1/")));
});
