# pi-requesty

The official [Requesty](https://requesty.ai) provider extension for the [Pi Coding Agent](https://github.com/earendil-works/pi).

- Native `/login requesty` API-key prompt, endpoint selection, and `/logout` support.
- Automatic discovery of models available to your API key.
- Persistent model catalogs managed by pi for offline startup.
- Model context limits, vision, reasoning, and tool capabilities from Requesty.
- Input, output, cached-token, and tiered pricing in pi's cost tracker.
- Live refresh with `/requesty-refresh`, without restarting pi.

Requires pi **1.4.0 or newer** (`@earendil-works/pi-coding-agent`) and Node.js 22.19 or newer.

## Install

From a checkout containing this version:

```bash
pi install ./pi-requesty
```

Or try it without installing, from this directory:

```bash
pi -e ./requesty.js
```

## Login and select a model

1. Start pi and run `/login requesty` (or choose **Requesty** in `/login`).
2. Paste an API key from the [Requesty dashboard](https://app.requesty.ai/api-keys) into pi's secret prompt.
3. Choose **EU** for `https://router.eu.requesty.ai/v1`, **Custom URL** for another endpoint, or **Default / configured** to use your existing configuration.
4. Pi saves the key and selected endpoint to its `auth.json` and refreshes the model catalog automatically. Use `/model` to select a Requesty model.

This uses Requesty's API-key authentication. A browser OAuth flow is not required. `/logout` removes the stored credential. Pi manages credential storage, including a custom agent directory configured with `PI_CODING_AGENT_DIR`.

For unattended use, set the environment variable instead:

```bash
export REQUESTY_API_KEY="rqsty-sk-..."
export REQUESTY_BASE_URL="https://router.eu.requesty.ai/v1"
pi
```

Stored credentials take priority over the environment variable. After changing an environment key, restart pi and run `/requesty-refresh` to fetch that key's available models.

## Model discovery and caching

Pi refreshes dynamic catalogs during interactive startup, when opening `/model`, and after login. Models are cached in pi's `models-store.json` and restored without network access for offline, print, and RPC startup. First-time setup needs a successful catalog fetch before models appear. For a first unattended run, initialize the cache with `pi update --models` while `REQUESTY_API_KEY` is set.

`/requesty-refresh` forces an authenticated catalog refresh and updates the available models immediately. `/requesty-models-sync` remains as an alias; neither command modifies `models.json` or requires `/reload`. Network errors retain the last cached catalog. A successful empty catalog clears it, for example when no models are allowed for the key.

The extension uses `GET https://router.requesty.ai/v1/models` with the resolved key, so organization and key access lists apply. Entries explicitly marked as non-chat or without tool support are excluded. Missing capability flags use conservative defaults. Prices are converted from USD per token to USD per million tokens, including prompt-length pricing tiers; missing prices display as zero. Pi's estimates do not account for account-specific discounts or other billing adjustments.

Requesty's reasoning effort normalization is used across providers. Pi's `minimal` maps to `min`, and `xhigh` maps to `high` because the catalog does not advertise which models accept `xhigh`. Other levels map directly.

## Regional endpoints and overrides

For EU organizations, run `/login requesty`, paste your key, and choose **EU**. The endpoint is saved with the credential, so you do not need to edit configuration files. Re-running login with **Default / configured** clears a previously saved endpoint selection.

For environment-based setup, set `REQUESTY_BASE_URL` before starting pi:

```bash
export REQUESTY_BASE_URL="https://router.eu.requesty.ai/v1"
pi
```

Endpoint precedence, from highest to lowest:

1. The endpoint explicitly selected during login (EU or Custom URL).
2. `REQUESTY_BASE_URL` in the environment.
3. The provider's `baseUrl` in `models.json`.
4. The global default, `https://router.requesty.ai/v1`.

The selected endpoint applies to both model discovery and inference, including requests using models cached with an older URL. Custom URLs are validated, trailing slashes are removed, and a bare domain gets `/v1` appended. After changing an environment variable, restart pi and run `/requesty-refresh`.

Existing pi configuration remains supported when login uses **Default / configured** and `REQUESTY_BASE_URL` is unset:

```json
{
  "providers": {
    "requesty": {
      "baseUrl": "https://router.eu.requesty.ai/v1"
    }
  }
}
```

If Requesty returns a regional-domain policy error, check the selected endpoint rather than replacing the API key. Catalog errors include the endpoint used and explain how to switch regions.

## Migrating from 0.2.x

The extension no longer requires a `requesty` entry in `~/.pi/agent/models.json`. Remove the old `apiKey` and generated `models` fields from that entry, retaining any intentional endpoint overrides, then run `/login requesty`. Move credentials into pi's native auth storage or `REQUESTY_API_KEY`. Old explicit model overrides remain under pi's control and can otherwise mask the discovered catalog.

## Development

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

Tests use pi's real provider and auth runtime with mocked HTTP responses; they do not require credentials or spend tokens.
