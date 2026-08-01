# pi-requesty (Requesty extension for Pi)

A [Pi Coding Agent](https://github.com/earendil-works/pi-mono) extension that registers [Requesty](https://requesty.ai) as an OpenAI-compatible model provider.

The model catalog is discovered from the Requesty `/models` endpoint and cached through Pi's standard provider model store, so it refreshes automatically on startup and when the model picker opens. No manual `models.json` edits are required.

## Install

### From GitHub

```bash
pi install git:github.com/requestyai/pi-requesty
```

To run once without installing:

```bash
pi -e ./pi-requesty
```

### Locally

```bash
pi install ./pi-requesty
```

## Configuration

Set your Requesty API key via either of these two methods:

**Option 1 — `/login` (recommended):** inside Pi, run

```text
/login requesty
```

and paste your API key.

**Option 2 — environment variable:**

```bash
export REQUESTY_API_KEY="rqsty-sk-..."
```

The endpoint and model list are handled automatically — there is no need to add a `requesty` provider block to `~/.pi/agent/models.json`. Models are discovered and cached at runtime.

## How model loading works

The extension registers the provider with an empty baseline catalog and a
`refreshModels` hook. Pi invokes that hook:

- on startup (first offline, restoring the cached catalog, then online),
- whenever the model picker or a model refresh runs.

Discovered models are written to Pi's provider model store and reused on the
next launch, so the catalog is available even when offline or before the first
network refresh completes. This is the same mechanism Pi uses for its built-in
dynamic providers.

## Notes

- API: `openai-completions` (Requesty is OpenAI-compatible).
- Endpoint: `https://router.requesty.ai/v1` (`/models` for discovery, `/chat/completions` for streaming).

## Development

### Tests

Unit tests use Node's built-in test runner (no external dependencies):

```bash
npm test
```

Coverage includes price/context mapping, `/models` discovery (HTTP + parsing), the
`refreshModels` caching/auth-gating behavior, and `registerProvider` config.

### Changelog

- **v0.3.0** (breaking):
  - Replaced hand-rolled `models.json` reading/writing with Pi's standard `refreshModels` + provider model store caching.
  - Removed the `/requesty-models-sync` command; models now refresh automatically (startup + model picker).
  - Authentication is now configured via `/login requesty` or `REQUESTY_API_KEY` environment variable; a `requesty` block in `models.json` is no longer used.
- **v0.2.x**: earlier versions read/wrote `providers.requesty.models` directly in `~/.pi/agent/models.json` and exposed `/requesty-models-sync`.

