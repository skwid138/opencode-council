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
            { "providerID": "github-copilot", "modelID": "claude-opus-4.6" }
          ],
          "reviewer": "my-reviewer",
          "aggregator": "my-aggregator",
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
            "councillor_ms": 180000,
            "councillor_retry_ms": 90000,
            "aggregator_ms": 60000,
            "hard_cap_ms": 360000
          }
        }
      }
    ]
  ]
}
```

### Required fields

| Field | Description |
|-------|-------------|
| `council.models` | Array of 2+ model configs (`providerID` + `modelID`) to fan out to |

### Optional fields

| Field | Default | Description |
|-------|---------|-------------|
| `council.reviewer` | `council-plugin-reviewer` | Name of the opencode agent to use as each reviewer |
| `council.aggregator` | `council-plugin-aggregator` | Name of the opencode agent to use as the aggregator |
| `council.reviewer_permission` | Catch-all `bash`/`external_directory` allows plus workspace inherited rules | Extra session-level reviewer rules. Values may be flat (`"bash": "deny"`) or nested pattern maps (`"bash": { "sudo *": "deny" }`). Use only `allow` or `deny`; `ask` entries are stripped. |
| `council.aggregator_permission` | none | Optional session-level aggregator rules. No workspace inheritance or catch-all allows are applied to the aggregator. Use only `allow` or `deny`; `ask` entries are stripped. |
| `council.aggregator_model` | First available model | Specific model for the aggregator agent |
| `council.timeouts.councillor_ms` | `180000` (3 min) | Timeout for each reviewer's first attempt |
| `council.timeouts.councillor_retry_ms` | `90000` (90s) | Timeout for automatic retry on first failure |
| `council.timeouts.aggregator_ms` | `60000` (60s) | Timeout for the aggregation step |
| `council.timeouts.hard_cap_ms` | `360000` (6 min) | Absolute maximum wall time for the entire operation |

## Bundled and custom agents

If `reviewer` or `aggregator` is omitted, the plugin injects hidden `mode: "subagent"` bundled agents into `config.agent` during opencode startup:

- `council-plugin-reviewer` — an adversarial reviewer that tiers findings as Must Address, Should Address, or Unrelated Observations and returns APPROVE / REVISE / REJECT.
- `council-plugin-aggregator` — a structural aggregator that deduplicates reviewer responses by agreement level without issuing its own verdict.

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
2. **Retry** — If a reviewer fails or times out, it gets one automatic retry with a shorter timeout.
3. **Gate** — At least 2 successful responses are required. Otherwise, an error is returned for fallback handling.
4. **Aggregate** — Successful responses are passed to the `aggregator` agent, which performs structural synthesis without issuing its own verdict.
5. **Return** — The aggregated result is returned to the calling agent.

## Tool exposed

The plugin registers a single tool:

### `council_review`

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | `string` | The complete review prompt to send to each reviewer |

**Returns:** The aggregator's structural synthesis, or an error string if fewer than 2 reviewers responded.

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
│   • Missing null check on `user.preferences`   │
│     before destructuring (line 42)             │
│   • SQL query uses string interpolation —      │
│     switch to parameterized query              │
│                                                 │
│ ▸ Should Address (1/2 flagged):                │
│   • Function `processData` exceeds 80 lines — │
│     consider extracting validation logic       │
│                                                 │
│ ▸ Unrelated Observations:                      │
│   • Unused import `lodash` on line 3           │
│                                                 │
└─────────────────────────────────────────────────┘
```

*Output format depends on the aggregator agent. The bundled aggregator produces Markdown with tiered findings.*

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
