# @skwid138/opencode-council

[![npm](https://img.shields.io/npm/v/@skwid138/opencode-council)](https://npmjs.com/package/@skwid138/opencode-council) [![CI](https://github.com/skwid138/opencode-council/actions/workflows/ci.yml/badge.svg)](https://github.com/skwid138/opencode-council/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Multi-model adversarial review plugin for [opencode](https://opencode.ai)**

Sends the same review prompt to multiple LLMs in parallel, then aggregates their responses into a single structured synthesis. Designed for adversarial code review workflows where diverse model perspectives catch issues that a single model misses.

## Why

A single reviewer model has blind spots. By fanning out the same prompt to 2+ models from different providers (e.g., GPT-5.5 + Claude Opus), you get:

- **Broader coverage** — different models catch different classes of issues
- **Reduced false confidence** — disagreement between models surfaces genuine ambiguity
- **Structured output** — an aggregator synthesizes responses without injecting its own verdict

If fewer than 2 reviewers respond (timeouts, errors), the tool returns an error string so the calling agent can gracefully fall back to a single reviewer.

## When to use

**Good use cases:**
- Pre-merge code review where catching subtle bugs justifies the extra latency
- Architecture and design document review
- Security-sensitive changes where multiple perspectives reduce risk
- Any review where you want structured disagreement, not just a single opinion

**Not ideal for:**
- Quick formatting or lint-only checks (overkill for the latency cost)
- Real-time interactive workflows where sub-second response matters
- Tasks where all models would give identical answers (e.g., simple factual lookups)

## Install

```sh
npm install @skwid138/opencode-council
```

Requires `@opencode-ai/plugin ^1.15.0` as a peer dependency.

## Configuration

Add the plugin to your `opencode.json`. The only required council option is a `models` array with at least two entries; the plugin injects bundled reviewer and aggregator agents automatically when you do not specify your own.

Minimal config:

```json
{
  "plugin": [
    [
      "@skwid138/opencode-council",
      {
        "council": {
          "models": [
            { "providerID": "openai", "modelID": "gpt-5.5" },
            { "providerID": "github-copilot", "modelID": "claude-opus-4.6" }
          ]
        }
      }
    ]
  ]
}
```

Full config with all options:

```json
{
  "plugin": [
    [
      "@skwid138/opencode-council",
      {
        "council": {
          "models": [
            { "providerID": "openai", "modelID": "gpt-5.5" },
            { "providerID": "github-copilot", "modelID": "claude-opus-4.6" },
            { "providerID": "google", "modelID": "gemini-3-pro" }
          ],
          "quorum": 2,
          "reviewer": "my-reviewer",
          "aggregator": "my-aggregator",
          "debug": false,
          "reviewer_temperature": 0.3,
          "reviewer_permission": {
            "bash": {
              "*": "allow",
              "sudo *": "deny",
              "git push --force*": "deny"
            },
            "external_directory": {
              "~/code/*": "allow",
              "~/secrets/*": "deny"
            }
          },
          "aggregator_permission": { "*": "deny" },
          "aggregator_model": { "providerID": "openai", "modelID": "gpt-5.5" },
          "timeouts": {
            "councillor_ms": 270000,
            "aggregator_ms": 120000,
            "quorum_grace_ms": 10000,
            "hard_cap_ms": 430000
          }
        }
      }
    ]
  ]
}
```

Note: `reviewer_temperature` is shown for option reference; it only affects the injected bundled reviewer, so omit `reviewer` or define temperature on your custom reviewer agent if you use one.

### Required fields

| Field | Description |
|-------|-------------|
| `council.models` | Array of 2+ model configs (`providerID` + `modelID`) to fan out to |

### Optional fields

| Field | Default | Description |
|-------|---------|-------------|
| `council.reviewer` | `council-plugin-reviewer` | Name of the opencode agent to use as each reviewer |
| `council.aggregator` | `council-plugin-aggregator` | Name of the opencode agent to use as the aggregator |
| `council.debug` | `false` | Enable structured debug logs through `ctx.client.app.log()` |
| `council.reviewer_temperature` | `null` (uses bundled default `0.3`) | Optional temperature for the injected bundled reviewer agent. Must be a finite number from `0` to `2`. Ignored when `council.reviewer` names a custom agent. |
| `council.reviewer_permission` | Catch-all `bash`/`external_directory` allows plus workspace inherited rules | Extra session-level reviewer rules. Values may be flat (`"bash": "deny"`) or nested pattern maps (`"bash": { "sudo *": "deny" }`). Use only `allow` or `deny`; `ask` entries are stripped. |
| `council.aggregator_permission` | none | Optional session-level aggregator rules. No workspace inheritance or catch-all allows are applied to the aggregator. Use only `allow` or `deny`; `ask` entries are stripped. |
| `council.aggregator_model` | First available model | Specific model for the aggregator agent |
| `council.quorum` | `models.length` | Number of successful councillor responses required before the aggregator can run. When `quorum < models.length`, the aggregator starts as soon as quorum is reached and pending councillors are aborted (after an optional grace window). Must be an integer in `[2, models.length]`. Default preserves wait-for-all behavior. |
| `council.timeouts.councillor_ms` | `270000` (4.5 min) | Timeout for each reviewer request |
| `council.timeouts.aggregator_ms` | `120000` (2 min) | Timeout for the aggregation step. This starts after the councillor phase completes, so the aggregator gets a fresh clock. |
| `council.timeouts.quorum_grace_ms` | `0` | Optional grace window in milliseconds after quorum is reached, during which stragglers can still join before the laggard abort sweep. Set to `0` (default) to abort pending councillors immediately on quorum. |
| `council.timeouts.hard_cap_ms` | computed (`420000` with defaults) | Absolute maximum wall time for the entire operation. By default this is `councillor_ms + aggregator_ms + quorum_grace_ms + 30000`. |

### Timeout behavior

Council review uses three timeout layers:

1. Each councillor request gets `councillor_ms`.
2. The aggregator gets a fresh `aggregator_ms` clock after the councillor phase completes.
3. When `quorum < models.length`, an optional layer kicks in: once `quorum` councillors succeed, the orchestrator waits up to `quorum_grace_ms` for stragglers to join, then aborts any still-pending councillor sessions before invoking the aggregator.

The outer `hard_cap_ms` is a safety net around the whole operation. When omitted, it is computed from the resolved phase timeouts plus a 30-second buffer: `councillor_ms + aggregator_ms + quorum_grace_ms + 30000`. With defaults (grace = 0), that is `270000 + 120000 + 0 + 30000 = 420000` (7 minutes).

If you explicitly set `hard_cap_ms`, the plugin honors it exactly. If the explicit hard cap is smaller than the computed phase budget, the plugin emits a structured warning but does not shrink the inner phase timeouts.

### Debug logging

Structured debug logging is resolved once when the plugin initializes, then the
same logger is reused for every `council_review` invocation. It can be enabled
from any of three sources:

- Set `COUNCIL_DEBUG=1` in the environment before starting opencode.
- Set top-level plugin option `"debug": true`.
- Set `"debug": true` in the plugin's `council` config.

Logs are emitted through opencode's app logger as `ctx.client.app.log({ body: { service: "council-plugin", level, message, extra } })`. Debug logs include councillor request start/completion, aggregator start/end, timeout events, and hard-cap triggers. Warnings, including stripped `ask` permissions, deprecated timeout keys, and undersized explicit hard caps, also use the same structured logger.

## Bundled and custom agents

If `reviewer` or `aggregator` is omitted, the plugin injects hidden `mode: "subagent"` bundled agents into `config.agent` during opencode startup:

- `council-plugin-reviewer` — an adversarial reviewer that tiers findings as Must Address, Should Address, or Unrelated Observations and returns APPROVE / REVISE / REJECT.
- `council-plugin-aggregator` — a structural aggregator that deduplicates reviewer responses by agreement level without issuing its own verdict.

Bundled agent temperatures are set explicitly: the reviewer defaults to `0.3` for some council diversity, and the aggregator uses `0` for deterministic synthesis. Set `council.reviewer_temperature` to override the injected bundled reviewer temperature; the aggregator temperature is not configurable. If you specify a custom `reviewer`, define any desired temperature on that agent instead.

If you specify `reviewer` or `aggregator`, that name must reference an opencode agent defined in your config (`~/.config/opencode/agent/` or `.opencode/agent/`). Custom agents fully replace the corresponding bundled agent.

**Reviewer** — An adversarial review agent. Its job is to find problems with the code or plan it receives. Design its system prompt for critical analysis, not helpfulness. The same reviewer agent is used for all models in the `models` array; model diversity comes from the fan-out, not from multiple agent definitions.

**Aggregator** — A synthesis agent. Its job is to structurally combine multiple reviewer responses into a unified summary. The plugin runs the aggregator prompt with all tools disabled, so its prompt should focus on structural synthesis rather than independent analysis.

### Permission override shape

`reviewer_permission` and `aggregator_permission` accept the same nested shape as opencode permission maps:

```json
{
  "reviewer_permission": {
    "read": "allow",
    "bash": {
      "*": "allow",
      "sudo *": "deny",
      "git push --force*": "deny"
    },
    "external_directory": {
      "~/code/*": "allow",
      "~/secrets/*": "deny"
    }
  }
}
```

Flat strings become a `*` pattern. Nested objects are emitted in object key order; opencode uses last-match-wins permission evaluation, so put broad patterns first and narrower patterns later.

Reviewer overrides are appended after the plugin's catch-all allows and after inherited workspace `bash` / `external_directory` rules, so they can tighten reviewer sessions by adding later `deny` rules. Allow-only overrides do not narrow access; because the workaround starts with broad allows, use explicit `deny` rules for restrictions.

Aggregator overrides are used only when explicitly configured. The aggregator never inherits workspace permissions and never receives the reviewer catch-all allows.

For working examples of reviewer and aggregator agent definitions, see:
- [config-opencode](https://github.com/skwid138/config-opencode) — personal opencode config with council agents
- [ai-dev-bootstrap-mac](https://github.com/skwid138/ai-dev-bootstrap-mac) — similar agent setup in a bootstrap config

## How it works

1. **Fan out** — The review prompt is sent to each configured model in parallel, each running as the specified `reviewer` agent in its own child session.
2. **Quorum** — As soon as `quorum` reviewers respond successfully (default: all of them), the orchestrator stops waiting on the rest. If `quorum_grace_ms > 0`, a grace window lets stragglers join before pending sessions are aborted.
3. **Gate** — At least 2 successful responses are required overall. Otherwise, an error is returned for fallback handling.
4. **Aggregate** — Successful responses are passed to the `aggregator` agent, which performs structural synthesis without issuing its own verdict. The aggregator prompt is byte-identical to the pre-quorum behavior when no councillors were aborted.
5. **Return** — The aggregated result is returned to the calling agent.

## Source structure

The runtime is split into focused internal modules under `src/`:

- `index.ts` — plugin registration, config hook, tool handler, public re-exports, default export
- `config.ts` — council option parsing, defaults, timeout constants, config warnings
- `permissions.ts` — permission override normalization and child-session ruleset construction
- `session.ts` — child-session creation, parent-directory lookup, prompt/response extraction
- `councillor.ts` — reviewer request lifecycle
- `aggregator.ts` — aggregator prompt formatting and synthesis session lifecycle
- `orchestrator.ts` — per-review fan-out, success threshold, hard-cap handling
- `timeout.ts` — timeout race helper and formatting
- `logging.ts` — structured logger factory and shared log helpers
- `types.ts` — shared types, bundled agent constants, and type guards
- `prompts.ts` — bundled reviewer and aggregator prompts/permissions

## Tool exposed

The plugin registers a single tool:

### `council_review`

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | `string` | The complete review prompt to send to each reviewer |

**Returns:** The aggregator's structural synthesis, or an error string if fewer than 2 reviewers succeeded (timeouts, failures, or quorum-aborts all count against the success threshold).

## Example output

A typical aggregated response:

```
┌─────────────────────────────────────────────────┐
│ Council Review — 2 of 2 reviewers responded     │
├─────────────────────────────────────────────────┤
│                                                 │
│ VERDICT: REVISE                                 │
│                                                 │
│ ▸ Must Address (agreed by 2/2):                 │
│   • Missing null check on `user.preferences`    │
│     before destructuring (line 42)              │
│   • SQL query uses string interpolation —       │
│     switch to parameterized query               │
│                                                 │
│ ▸ Should Address (1/2 flagged):                 │
│   • Function `processData` exceeds 80 lines —   │
│     consider extracting validation logic        │
│                                                 │
│ ▸ Unrelated Observations:                       │
│   • Unused import `lodash` on line 3            │
│                                                 │
└─────────────────────────────────────────────────┘
```

*Output format depends on the aggregator agent. The bundled aggregator produces Markdown with tiered findings.*

## Development

Install dependencies:

```sh
npm install
```

Run tests:

```sh
npm test
```

Run tests with coverage:

```sh
npm run test:coverage
```

Type-check:

```sh
npm run typecheck
```

Build the package:

```sh
npm run build
```

The build emits ESM artifacts and declaration files into `dist/`.

<!-- keep in sync with opencode-council and opencode-tui -->
### Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/). A local
[husky](https://typicode.github.io/husky/) hook runs
[commitlint](https://commitlint.js.org/) on every commit, and PR titles are validated
by GitHub Actions (`.github/workflows/pr-title.yml`) since this repo squash-merges
with the PR title as the commit subject.

Allowed types: `feat`, `fix`, `perf`, `refactor` (patch), `docs`, `chore`, `ci`,
`style`, `test`, `build`, `revert`.

Notes:
- Use `git commit --no-verify` to bypass the hook in unusual cases (e.g. WIP commits
  you'll squash later).
- A `BREAKING CHANGE:` footer in the commit body triggers a major release regardless
  of the type prefix — use deliberately.
- The conventional prefix governs the release type, but the human is responsible for
  matching prefix to actual change (a `feat:` whose diff is a README typo will still
  publish a minor release).

## Security

- Bundled reviewer and aggregator permissions are defined on the injected agents and contain no `ask` values.
- Reviewer child sessions always receive session-level catch-all allows for `bash` and `external_directory`, then inherited workspace `bash` / `external_directory` `allow` and `deny` rules, then explicit `reviewer_permission` overrides.
- The reviewer catch-all `bash` allow is an intentional security trade-off for the [anomalyco/opencode#28037](https://github.com/anomalyco/opencode/issues/28037) workaround. It prevents unanswerable child-session permission prompts from hanging the TUI. Tighten custom reviewer sessions by adding later `deny` rules in `reviewer_permission`.
- `external_directory` has no catch-all deny. The session starts with a catch-all allow to neutralize `ask`, then applies inherited workspace denies and explicit reviewer denies.
- Explicit permission overrides are applied at session level and should use only `allow` or `deny` values. Any `ask` entries are stripped with a warning because child sessions cannot prompt interactively.
- The aggregator prompt runs with all tools disabled as defense-in-depth.
- The aggregator never receives workspace permission inheritance or reviewer catch-all allows. If you need aggregator session rules, set `aggregator_permission` explicitly.
- Sessions are aborted after use; server-side TTL handles edge cases.

## Known Issues & Limitations

### Permission prompts from plugin-spawned child sessions hang the TUI

**Status:** Workaround implemented; upstream fix pending
**Tracking:** [anomalyco/opencode#28037](https://github.com/anomalyco/opencode/issues/28037)

When a councillor session triggers a bash command not on the allow-list, the opencode TUI displays a permission prompt that cannot be resolved — clicking Allow/Reject does nothing, and the session hangs indefinitely.

**Root cause:** The opencode server uses separate in-memory permission service instances for the plugin SDK client vs. the TUI listener. Permission replies from either surface land on a different instance than the one holding the pending request, so they're silently dropped.

**Workaround (already implemented):** Bundled agents are injected with permissions that contain no `ask` values. Reviewer child sessions receive a session-level ruleset with catch-all `allow` entries for `bash` and `external_directory`, followed by inherited workspace `allow` / `deny` rules and explicit reviewer overrides. Councillors never trigger `ask` prompts; configure later `deny` patterns in `reviewer_permission` to restrict risky commands or paths.

**Implications for consumers:**
- Bundled agents work without requiring you to create reviewer or aggregator agents
- Custom reviewer sessions read your parent workspace `opencode.json` `permission.bash` and `permission.external_directory` rules automatically
- Commands and external paths are broadly allowed by the workaround unless workspace rules or explicit reviewer overrides deny them later
- If you need stricter custom reviewer behavior, define `reviewer_permission` with explicit deny patterns such as `"sudo *": "deny"` or `"~/secrets/*": "deny"`
- If you add new bash or external-directory rules to your config, councillor sessions pick them up on next invocation
- Once the upstream bug is fixed, this workaround becomes redundant but harmless

## License

MIT
