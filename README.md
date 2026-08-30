# OpenCode Session Metrics

Renders a live session token usage and cost in the TUI sidebar.
Includes subagents by usage default.

![Plugin Preview](./.github/assets/screenshot.png)

## Installation

1. Add the plugin to `tui.json`:

   ```json
   {
     "plugin": ["opencode-session-metrics"]
   }
   ```

2. Restart OpenCode.

## Requirements

OpenCode `>=1.18.0 <2.0.0`

## Configuration

The plugin can be customized by modifying its entry in `tui.json`.

```jsonc
{
  "plugin": [
    [
      "opencode-session-metrics",
      {
        // Whether to include token usage from subagents.
        "include_subagents": true,

        // Configure the plugin's context usage, hidden by default.
        "context": {
          "show": true,
          // Renders the usage text with warning color
          // when context % usage reaches this value
          "warn_on_usage": 80,
          // Renders the usage text with warning color
          // when tokens in context reaches this value
          "warn_on_count": 120_000,
        },

        // Whether to show model usage in the session sidebar (shown by default).
        "models": {
          "show": true,
        },
      },
    ],
  ],
}
```

The `/metrics` TUI command always shows the Session context and Models sections,
regardless of `context.show` or `models.show`. In OpenCode 1.18, select
`metrics` from slash autocomplete; typing `/metrics` and pressing Enter may use
the server-command path instead of the TUI command.

## How It Works

- **Sources:** Prefers HTTP assistant messages, then loaded TUI messages, then
  session rollups. Subagents are included by default and can be controlled with
  `include_subagents`.
- **Metrics:** Reports total, input, output, reasoning, cache read/write tokens,
  and cost. If total is missing, it is derived as input + output + reasoning;
  cache tokens remain separate.
- **Cost:** Uses reported message cost; a zero cost is estimated from an exact
  `providerID/modelID` pricing match, preferring runtime pricing over local
  `models.json`.
- **Privacy:** The local fallback makes no network calls, touches no
  credentials, and does not alter messages.
- **Limitations:** Failed or empty requests fall back to the next source. A
  non-empty HTTP response that is silently truncated can still undercount.

## Development

These commands are for maintainers working from a source checkout. Bun is the
package manager, build tool, and test runner:

```sh
bun install
bun run check
bun run test
bun run test:ui
bun run build
bun pm pack --dry-run
```

`bun run test` uses Bun's `browser` condition so the OpenTUI Solid renderer is
used and the UI harness runs with the rest of the test suite. `bun run test:ui`
runs the UI tests directly.

Local testing imports the TypeScript source directly, so it does not require a
build. For example, use this in a local OpenCode configuration:

```json
{
  "plugin": ["./plugins/session-metrics/src/plugin.tsx"]
}
```

An installed npm package instead uses its compiled `dist/plugin.mjs` export.
Inspect the dry-run contents before a release. Release-please automatically
publishes releases created by the workflow. Use `bun publish` only for manual
recovery or to reproduce a release:

```sh
bun publish --access public
```
