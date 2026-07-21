import assert from "node:assert/strict";
import test from "node:test";

import { modelsUrl, normalizeBaseUrl } from "./requesty.js";

test("normalizeBaseUrl strips trailing slashes", () => {
  const cases = [
    ["https://router.requesty.ai", "https://router.requesty.ai"],
    ["https://router.requesty.ai/", "https://router.requesty.ai"],
    ["https://router.requesty.ai///", "https://router.requesty.ai"],
    ["https://router.requesty.ai/v1", "https://router.requesty.ai/v1"],
    ["https://router.requesty.ai/v1/", "https://router.requesty.ai/v1"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeBaseUrl(input), expected);
  }
});

test("modelsUrl always resolves to a single /v1/models endpoint", () => {
  const cases = [
    // Anthropic Messages config: baseUrl has no version segment.
    ["https://router.requesty.ai", "https://router.requesty.ai/v1/models"],
    ["https://router.requesty.ai/", "https://router.requesty.ai/v1/models"],
    // OpenAI Completions config: baseUrl already ends with a version segment.
    ["https://router.requesty.ai/v1", "https://router.requesty.ai/v1/models"],
    ["https://router.requesty.ai/v1/", "https://router.requesty.ai/v1/models"],
    // Other version segments are respected rather than doubled up.
    ["https://router.requesty.ai/v2", "https://router.requesty.ai/v2/models"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(modelsUrl(input), expected);
  }
});
