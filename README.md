# @skwid138/opencode-council

**Multi-model adversarial review plugin for [opencode](https://opencode.ai)**

Sends the same review prompt to multiple LLMs in parallel, then aggregates their responses into a single structured synthesis. Designed for adversarial code review workflows where diverse model perspectives catch issues that a single model misses.

## Why

A single reviewer model has blind spots. By fanning out the same prompt to 2+ models from different providers (e.g., GPT-5.5 + Claude Opus), you get:

- **Broader coverage** — different models catch different classes of issues
- **Reduced false confidence** — disagreement between models surfaces genuine ambiguity
- **Structured output** — an aggregator synthesizes responses without injecting its own verdict

If fewer than 2 reviewers respond (timeouts, errors), the tool returns an error string so the calling agent can gracefully fall back to a single reviewer.

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
          "reviewer_permission": { "bash": "deny" },
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
| `council.reviewer_permission` | Bundled agent permission, or inherited rules for custom agents | Session-level permission override for reviewer child sessions. Use only `allow` or `deny` values. |
| `council.aggregator_permission` | Bundled agent permission, or inherited rules for custom agents | Session-level permission override for the aggregator child session. Use only `allow` or `deny` values. |
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

## Security

- Bundled reviewer and aggregator permissions are defined on the injected agents and contain no `ask` values.
- Custom reviewer and aggregator sessions keep the existing child-session bash rules workaround unless you provide explicit `reviewer_permission` or `aggregator_permission` overrides.
- Explicit permission overrides are applied at session level and should use only `allow` or `deny` values.
- The aggregator prompt runs with all tools disabled as defense-in-depth.
- Sessions are aborted after use; server-side TTL handles edge cases.

## Known Issues & Limitations

### Permission prompts from plugin-spawned child sessions hang the TUI

**Status:** Workaround implemented; upstream fix pending
**Tracking:** [anomalyco/opencode#28037](https://github.com/anomalyco/opencode/issues/28037)

When a councillor session triggers a bash command not on the allow-list, the opencode TUI displays a permission prompt that cannot be resolved — clicking Allow/Reject does nothing, and the session hangs indefinitely.

**Root cause:** The opencode server uses separate in-memory permission service instances for the plugin SDK client vs. the TUI listener. Permission replies from either surface land on a different instance than the one holding the pending request, so they're silently dropped.

**Workaround (already implemented):** Bundled agents are injected with permissions that contain no `ask` values. Custom agent child sessions receive a session-level ruleset that mirrors your `opencode.json` bash allow-list and appends a catch-all `deny`, unless you provide an explicit permission override. Councillors never trigger `ask` prompts — unknown commands fail fast with a `PermissionDeniedError` (which the LLM handles gracefully) instead of hanging.

**Implications for consumers:**
- Bundled agents work without requiring you to create reviewer or aggregator agents
- Custom-agent child sessions still read your `opencode.json` `permission.bash` rules automatically
- Commands not explicitly allowed by the custom-agent workaround will be denied (not prompted)
- If you add new bash allow rules to your config, councillor sessions pick them up on next invocation
- Once the upstream bug is fixed, this workaround becomes redundant but harmless

## License

MIT
