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

The extension resolves the `requesty` key from the same two sources pi falls back
through, in this order:

1. a stored `api_key` credential in the agent directory's `auth.json`
2. `providers.requesty.apiKey` in `models.json`

(A runtime `--api-key` is not consulted: model discovery calls `<baseUrl>/models`
directly, outside pi's request pipeline. A stored credential that cannot be
resolved — a failing command, an unset variable — falls through to `models.json`
rather than failing, which is friendlier than pi's own behaviour for inference.)

Both accept a literal value, a `$VARIABLE` reference, or a `!command` that prints
the key — so the key can stay in your secret manager:

```json
{
  "requesty": {
    "type": "api_key",
    "key": "!secret-tool lookup requesty api-key"
  }
}
```

Only the provider settings are read from `~/.pi/agent/models.json`; when the file
does not exist yet, defaults are used (`https://router.requesty.ai/v1` with the
`openai-completions` API).

The provider always sends `HTTP-Referer: https://pi.dev` and `X-Title: Pi`, which
turn on Requesty's automatic prompt caching for Pi and label the traffic as Pi in
analytics. Headers set in `models.json` take precedence, and `/requesty-models-sync`
writes the defaults into the file when they are missing.

A `!command` runs with the same shell pi uses (on Windows, pi's configured shell,
usually Git Bash). It runs twice at startup: once for model discovery and once
when pi resolves the key for inference.

Example using a literal key instead:

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

On startup, the extension fetches both `<baseUrl>/models` and `<baseUrl>/models/managed`
using the resolved key as the bearer token, merges the two lists (deduplicated by model
ID), and registers the discovered models with pi. Each request is bounded by a 10s
timeout, because it runs before pi finishes loading. Without a credential discovery is
skipped silently: pi resolves credentials for inference itself, and the models already
listed in `models.json` keep working. The key is never written to `models.json`.

## Command

Inside pi:

```text
/requesty-models-sync
```

The command resolves the key as described above, fetches the Requesty models and
writes the discovered model IDs back to `~/.pi/agent/models.json`. The file is
rewritten owner-only (`0600`), because it can hold a literal key.
Run `/reload` after syncing.

## Tests

```bash
npm test
```
