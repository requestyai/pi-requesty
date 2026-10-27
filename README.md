# pi-requesty (Official Requesty extension for Pi)

The official Requesty extension for the Pi Coding Agent

## (Recommended) Install from Github Repo

```bash
pi install git:github.com/requestyai/pi-requesty
```

To get the latest version later, run `pi update --extensions`, then restart Pi or run `/reload`.

To stay on a fixed version, append a full 40 character commit SHA (`@<sha>`). `pi update` fails on short SHAs and never moves a pinned install.

## Install locally

Check out the code from the official code repository `https://github.com/requestyai/pi-requesty`, and then:

```bash
pi install ./pi-requesty
```

To run once without installing:

```bash
pi -e ./pi-requesty
```

## Configuration

The extension only reads the `requesty` provider from `~/.pi/agent/models.json`.

Example:

```json
{
  "providers": {
    "requesty": {
      "name": "Requesty",
      "baseUrl": "https://router.requesty.ai/v1",
      "apiKey": "rqsty-sk-...",
      "api": "openai-completions",
      "models": []
    }
  }
}
```

On startup, the extension fetches both `<baseUrl>/models` and `<baseUrl>/models/managed` using `apiKey` as the bearer token, merges the two lists (deduplicated by model ID), and registers the discovered models with pi.

### Regional and custom endpoints

For an EU organization, set `providers.requesty.baseUrl` to `https://router.eu.requesty.ai/v1` in the configuration above. The same setting supports another regional endpoint or an OpenAI-compatible proxy.

You can override the configured endpoint when launching pi:

```bash
REQUESTY_BASE_URL="https://router.eu.requesty.ai/v1" pi
```

Endpoint precedence is **`REQUESTY_BASE_URL` → `providers.requesty.baseUrl` → `https://router.requesty.ai/v1`**. Keep your API key in `models.json` as before. Your existing headers and other provider settings are preserved.

The selected endpoint is used for both catalog endpoints (`/models` and `/models/managed`) and registered inference requests. URLs must use HTTP(S), without embedded credentials, query parameters, or fragments. Trailing slashes are removed; a bare domain gets `/v1` appended.

After changing the configuration, restart pi or run `/reload`. If you set the environment override, keep it set when launching pi; it is not written to `models.json`.

If Requesty returns **403: your organization requires a regional domain**, select the endpoint required by your organization. The extension reports the endpoint it used and the settings to change.

## Command

Inside pi:

```text
/requesty-models-sync
```

The command fetches Requesty models using `~/.pi/agent/models.json` and writes the discovered model IDs back to the same file.
Run `/reload` after syncing.

## Tests

Run the endpoint regression tests without installing dependencies:

```bash
node --test test/endpoints.test.js
```
