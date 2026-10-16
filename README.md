# opencode-zai-usage

Z.ai GLM Coding Plan quota & usage for [OpenCode](https://opencode.ai) v2 — one
token-efficient tool plus a live status-line badge. No installer, no config
surgery, no extra agent round-trips, zero runtime dependencies.

## What you get

- **`zai_usage` tool** — compact, accurate quota report for the agent to call
  on demand: 5-hour token window, weekly limit, and monthly MCP tool usage,
  each with percentage, progress bar, and reset time. `detail: true` adds the
  24-hour model/tool breakdown.
- **Status-line badge** — `ZAI 21% · 2h 41m` in the prompt footer, always
  current (refreshed after every session goes idle), color-coded at 60% and
  90%. Zero model calls.
- **`/zai` command** — instant dialog with the full quota table. Zero model
  calls.

## Install

```sh
npm install -g opencode-zai-usage   # or: npm install opencode-zai-usage
```

Then add it to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-zai-usage"]
}
```

Or use a local checkout:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-zai-usage"]
}
```

Authenticate as usual with `/connect` → **Z.AI Coding Plan**. That's the whole
setup.

## How it works

```
Z.ai monitoring API            OpenCode server                TUI
────────────────────           ─────────────────              ─────────────────
 /api/monitor/usage/  ──fetch──▶ zai-usage plugin   ──RPC──▶  badge + /zai
 quota/limit               (credentials · TTL cache ·          dialog
 model-usage *             idle-refresh)
 tool-usage  *
```

- **Credentials** come from OpenCode's integration layer
  (`ctx.integration.connection`), never from parsing files. Falls back to
  `ZHIPU_API_KEY` (or legacy `ZAI_API_KEY`) when no connection exists.
- **One fetch, many consumers**: a shared TTL cache (60s default) backed by
  in-flight deduplication serves the tool, badge, and dialog. The badge also
  refreshes whenever a session goes idle, so it reflects real usage without
  polling.
- **The API key never leaves the server plugin.** The TUI talks to it over
  the plugin RPC channel and receives parsed snapshots only.
- **Only percentages are reported for token windows** — the monitoring API
  does not expose absolute plan limits, so none are invented.

## Platforms

Both Z.ai global (`api.z.ai`, integrations `zai-coding-plan`/`zai`) and China
(`open.bigmodel.cn`, integrations `zhipuai-coding-plan`/`zhipuai`) are
supported and detected from whichever integration you connected. For env-var
users on the China endpoint, set the platform:

```jsonc
{
  "plugins": [{ "package": "opencode-zai-usage", "options": { "platform": "cn" } }]
}
```

## Development

```sh
npm install
npm run check        # typecheck
npm run smoke        # live API smoke test (prints parsed quota, never the key)
```

`scripts/smoke.ts` reads credentials the same way the plugin does, minus the
integration layer.

**Local loading**: directory plugins need entry files at the package root, so
`index.ts` and `tui.tsx` re-export from `src/` (they are excluded from the npm
package via `files`, where `exports` takes over). Point `plugins` at this
directory, restart the service, and check with `opencode plugin list` or
`opencode api get /api/plugin`.

## License

MIT
