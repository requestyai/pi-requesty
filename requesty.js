// Pi exposes this entrypoint to extensions in both Node and bundled builds.
import { createProvider, envApiKeyAuth, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { fetchModels } from "./models.js";
import { DEFAULT_BASE_URL, EU_BASE_URL, normalizeBaseUrl } from "./endpoint.js";

export function requestyProvider() {
  const apiKey = envApiKeyAuth("Requesty API key", ["REQUESTY_API_KEY"]);
  const login = apiKey.login;
  const resolve = apiKey.resolve;
  apiKey.login = async (interaction) => {
    interaction.notify({
      type: "info",
      message: "Create an API key in the Requesty dashboard.",
      links: [{ url: "https://app.requesty.ai/api-keys", label: "Requesty API keys" }],
    });
    const credential = await login(interaction);
    credential.key = credential.key.trim();
    if (!credential.key) throw new Error("Requesty API key must not be empty.");
    const endpoint = await interaction.prompt({
      type: "select",
      message: "Which Requesty endpoint does your organization use?",
      options: [
        { id: "default", label: "Default / configured", description: "Use REQUESTY_BASE_URL or models.json; otherwise the global endpoint" },
        { id: "eu", label: "EU", description: EU_BASE_URL },
        { id: "custom", label: "Custom URL", description: "Another regional endpoint or proxy" },
      ],
    });
    interaction.signal.throwIfAborted();
    if (endpoint === "eu" || endpoint === "custom") {
      const value = endpoint === "eu" ? EU_BASE_URL : await interaction.prompt({
        type: "text",
        message: "Requesty base URL",
        placeholder: EU_BASE_URL,
      });
      interaction.signal.throwIfAborted();
      credential.env = { REQUESTY_BASE_URL: normalizeBaseUrl(value) };
    } else if (endpoint !== "default") {
      throw new Error("Invalid Requesty endpoint selection.");
    }
    return credential;
  };

  apiKey.resolve = async (input) => {
    const result = await resolve(input);
    if (!result) return undefined;
    const endpoint = input.credential?.env?.REQUESTY_BASE_URL ?? await input.ctx.env("REQUESTY_BASE_URL");
    input.signal.throwIfAborted();
    if (!endpoint) return result;
    const baseUrl = normalizeBaseUrl(endpoint);
    return {
      ...result,
      auth: { ...result.auth, baseUrl },
      env: { ...result.env, REQUESTY_BASE_URL: baseUrl },
    };
  };

  return createProvider({
    id: "requesty",
    name: "Requesty",
    baseUrl: DEFAULT_BASE_URL,
    auth: { apiKey },
    models: [],
    fetchModels,
    api: openAICompletionsApi(),
  });
}

export default function (pi) {
  pi.registerProvider(requestyProvider());

  const refresh = {
    description: "Refresh Requesty's model catalog and update available models immediately",
    async handler(_args, ctx) {
      ctx.ui.setStatus("requesty-refresh", "Refreshing Requesty models…");
      try {
        if (!(await ctx.modelRegistry.getApiKeyForProvider("requesty"))) {
          ctx.ui.notify("Run /login requesty or set REQUESTY_API_KEY first.", "warning");
          return;
        }
        const result = await ctx.modelRegistry.refresh({
          providers: ["requesty"],
          allowNetwork: true,
          force: true,
        });
        const error = result.errors.get("requesty");
        if (error) throw error;
        if (result.aborted) throw new Error("Model refresh was cancelled.");
        const count = ctx.modelRegistry.getAll().filter((model) => model.provider === "requesty").length;
        ctx.ui.notify(`Registered ${count} Requesty model(s). Select one with /model.`, "info");
      } catch (error) {
        ctx.ui.notify(`Requesty refresh failed: ${error.message}`, "error");
      } finally {
        ctx.ui.setStatus("requesty-refresh", undefined);
      }
    },
  };
  pi.registerCommand("requesty-refresh", refresh);
  // Preserve the existing command without rewriting models.json or requiring /reload.
  pi.registerCommand("requesty-models-sync", refresh);
}
