<div align="center">

# pi × Requesty

**Your models. Your region. One native pi experience.**

Connect the [Pi Coding Agent](https://github.com/earendil-works/pi) to [Requesty](https://requesty.ai) with native login, automatic model discovery, and usage tracking.

<p>
  <a href="https://github.com/earendil-works/pi"><img alt="pi 1.4+" src="https://img.shields.io/badge/pi-1.4%2B-8b5cf6?style=flat-square"></a>
  <a href="#development"><img alt="Node.js 22.19+" src="https://img.shields.io/badge/Node.js-22.19%2B-339933?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

[Quick start](#quick-start) · [Regions & endpoints](#regions--endpoints) · [Commands](#commands) · [Migration](#migrating-from-02x)

</div>

---

| | Built for your workflow |
| :--- | :--- |
| **Native login** | Paste your key in pi's secret prompt. Pi stores it and handles logout. |
| **Your region** | Choose EU or a custom endpoint during login. Both discovery and inference follow it. |
| **Automatic catalog** | Discover models available to your key, with context limits, vision, and reasoning capabilities. |
| **Usage & costs** | Track input, output, cached tokens, and prompt-length pricing tiers in pi. |
| **Offline startup** | Restore your last model catalog from pi's persistent cache. |
| **Live refresh** | Update available models without restarting or editing configuration files. |

## Quick start

### 1. Install

```bash
pi install git:github.com/requestyai/pi-requesty
```

From a checkout containing this version, you can also run `pi install .`, or try it with `pi -e ./requesty.js`.

**Requires pi 1.4+ and Node.js 22.19+.**

### 2. Log in

Start pi and run:

```text
/login requesty
```

Paste a key from [Requesty → API keys](https://app.requesty.ai/api-keys), then choose your endpoint:

| Choice | Connects to |
| :--- | :--- |
| **Default / configured** | Your existing configuration, or Requesty's global endpoint |
| **EU** | `https://router.eu.requesty.ai/v1` |
| **Custom URL** | Another regional endpoint or your proxy |

Pi saves your key and explicit endpoint selection in `auth.json`, then refreshes the model catalog.

### 3. Pick a model

```text
/model
```

Choose a model under **Requesty** and start coding.

> [!TIP]
> **Using Requesty in the EU?** Choose **EU** during login. Your region is saved with your key, including for requests using models cached with an older URL.

## Regions & endpoints

Choose your endpoint during `/login requesty`, or set it in your environment before starting pi:

```bash
export REQUESTY_API_KEY="rqsty-sk-..."
export REQUESTY_BASE_URL="https://router.eu.requesty.ai/v1"
pi
```

Stored API keys take priority over `REQUESTY_API_KEY`. Endpoint selection follows this order:

| Priority | Source |
| :--- | :--- |
| **1** | EU or Custom URL saved during login |
| **2** | `REQUESTY_BASE_URL` environment variable |
| **3** | Requesty's `baseUrl` in pi's `models.json` |
| **4** | Global default: `https://router.requesty.ai/v1` |

To clear a saved endpoint, log in again and choose **Default / configured**. After changing environment variables, restart pi and run `/requesty-refresh`.

Custom URLs must be full HTTP(S) URLs without embedded credentials, query parameters, or fragments. Trailing slashes are removed; a bare domain gets `/v1` appended.

<details>
<summary><strong>Prefer models.json?</strong></summary>

Choose **Default / configured** during login and leave `REQUESTY_BASE_URL` unset. Pi applies your provider override to discovery and inference:

```json
{
  "providers": {
    "requesty": {
      "baseUrl": "https://router.eu.requesty.ai/v1"
    }
  }
}
```

Pi manages credentials and configuration in its agent directory, including a custom directory set with `PI_CODING_AGENT_DIR`.

</details>

## Commands

| Command | What it does |
| :--- | :--- |
| `/login requesty` | Save an API key and choose an endpoint |
| `/model` | Select a Requesty model |
| `/requesty-refresh` | Fetch the latest catalog and update available models immediately |
| `/requesty-models-sync` | Alias for `/requesty-refresh` |
| `/logout` | Remove stored credentials through pi's logout menu |

## Catalog & caching

Pi refreshes models during interactive startup, when opening `/model`, and after login. The extension fetches `/models` from your selected endpoint using your resolved key, so your organization's approved models and key access lists apply.

Catalogs are stored in pi's `models-store.json` and restored without network access for offline, print, and RPC startup. First-time setup needs a successful fetch. For an unattended first run, set your environment variables and initialize the cache with:

```bash
pi update --models
```

A failed refresh keeps the previous catalog. A successful empty response clears it. Refresh commands update the live catalog without modifying `models.json` or requiring `/reload`.

<details>
<summary><strong>Model capabilities, pricing & reasoning</strong></summary>

- Entries explicitly marked as non-chat or without tool support are excluded. Missing capability flags use conservative defaults.
- Requesty's context limits, output limits, and vision and reasoning flags populate pi's model metadata.
- USD-per-token prices are converted to USD per million tokens, including prompt-length pricing tiers. Missing prices display as zero. Account-specific discounts and other billing adjustments can differ from pi's estimates.
- Pi's `minimal` reasoning level maps to Requesty's `min`. `xhigh` maps to `high` because the catalog does not advertise which models accept `xhigh`. Other levels map directly.

</details>

## Troubleshooting

| Symptom | What to do |
| :--- | :--- |
| **403: organization requires a regional domain** | Run `/login requesty` and choose **EU** or **Custom URL** for your organization's endpoint. |
| **401 or invalid API key** | Run `/login requesty` with a key valid for the selected endpoint. |
| **No models after first setup** | Run `/requesty-refresh`. Check your endpoint and the key's model access list. |
| **An old endpoint still wins** | Check the precedence above. Choose **Default / configured** to clear a saved endpoint. |
| **Old models remain after changing keys** | Restart pi if you changed an environment key, then run `/requesty-refresh`. Remove old explicit model overrides if they mask discovery. |

## Migrating from 0.2.x

You no longer need a Requesty API key or a generated model list in `models.json`.

1. Remove the old Requesty `apiKey` and generated `models` fields, keeping intentional endpoint overrides.
2. Run `/login requesty` to save your key and choose a region, or set `REQUESTY_API_KEY` and `REQUESTY_BASE_URL`.
3. Select your model with `/model`.

Explicit model overrides remain under pi's control and can mask the discovered catalog.

## Development

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

Tests use pi's real provider and authentication runtime with mocked HTTP responses. They cover login, cancellation, caching, regional endpoints, streaming tool calls, and usage accounting without requiring an API key or spending tokens.

---

<div align="center">

[Requesty](https://requesty.ai) · [Get an API key](https://app.requesty.ai/api-keys) · [Pi](https://github.com/earendil-works/pi) · [MIT license](LICENSE)

</div>
