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

## Host support

One package serves both OpenCode plugin hosts from a single default export,
`{ id: "skwid138.opencode-council", server, setup }`, available from both `.` and
`./server`:

| Host | Entry | Claimed support | Verification status |
| --- | --- | --- | --- |
| OpenCode V1 | `server` (existing plugin function) | `>= 1.18.29` | Unit tested; consumer type-check against `@opencode-ai/plugin` 1.18.29 and 1.19.3 |
| OpenCode V2 | `setup(ctx)` | `>= 2.0.28` | Unit tested against a fake host; type-checked against `@opencode/plugin` 2.0.28 and 2.0.32 |

Real-host qualification on the four-host matrix (V1 1.18.29 and 1.19.3, V2
2.0.28 and 2.0.32) is **pending a separate plan**. So far only unit tests, type
contracts, and strict consumer compiles of the packed archive are verified;
treat V2 support as prepared, not proven.

The V2 adapter's host types are declared structurally, so neither the published
JavaScript nor the published declarations reference the V2 SDK (`@opencode/*`),
and V1-only installs do not pull in the V2 dependency tree. `@opencode-ai/plugin`
is loaded lazily inside `server()`, so V2 hosts never need it at runtime.

## Configuration

Add the plugin to your `opencode.json`. The only required council option is a `models` array with at least two required (non-optional) entries; the plugin injects bundled reviewer and aggregator agents automatically when you do not specify your own.

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
            { "providerID": "google", "modelID": "gemini-3-pro", "optional": true }
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
            "optional_councillor_ms": 60000,
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

### OpenCode V2

V2 takes the same `council` options block, passed through the plugin entry's
`options`. Pin an exact package version:

```json
{
  "plugins": [
    {
      "package": "@skwid138/opencode-council@X.Y.Z",
      "options": {
        "council": {
          "models": [
            { "providerID": "openai", "modelID": "gpt-5.5" },
            { "providerID": "github-copilot", "modelID": "claude-opus-4.6" }
          ]
        }
      }
    }
  ]
}
```

Replace `X.Y.Z` with an exact published version. See [OpenCode V2 differences](#opencode-v2-differences) for how permissions, logging, and models behave on V2.

### Required fields

| Field | Description |
|-------|-------------|
| `council.models` | Array of model configs (`providerID` + `modelID`) with 2+ required (non-optional) entries to fan out to |

### Optional fields

| Field | Default | Description |
|-------|---------|-------------|
| `council.reviewer` | `council-plugin-reviewer` | Name of the opencode agent to use as each reviewer |
| `council.aggregator` | `council-plugin-aggregator` | Name of the opencode agent to use as the aggregator |
| `council.debug` | `false` | Enable debug logs (V1: `ctx.client.app.log()`; V2: console plus a debug log file — see [Debug logging](#debug-logging)) |
| `council.reviewer_temperature` | `null` (uses bundled default `0.3`) | Optional temperature for the injected bundled reviewer agent. Must be a finite number from `0` to `2`. Ignored when `council.reviewer` names a custom agent. |
| `council.reviewer_permission` | V1: catch-all `bash`/`external_directory` allows plus inherited workspace rules. V2: parent session deny rules plus council denies | Extra session-level reviewer rules. Values may be flat (`"bash": "deny"`) or nested pattern maps (`"bash": { "sudo *": "deny" }`). On V1 use only `allow` or `deny` (`ask` entries are stripped); on V2 see [OpenCode V2 differences](#opencode-v2-differences). |
| `council.aggregator_permission` | none | Optional session-level aggregator rules. No catch-all allows are applied to the aggregator (V2 still copies the parent session's deny rules). On V1 use only `allow` or `deny` (`ask` entries are stripped; see also [Known Issues](#aggregator_permission-is-ineffective-on-v1)). |
| `council.aggregator_model` | none (V1: no model is sent and the host chooses; V2: the aggregator agent's own model, else the host default) | Specific model for the aggregator agent |
| `council.models[].optional` | `false` | Marks a councillor as optional. Optional councillors can enrich aggregation if they finish, but do not count toward required councillor quorum. |
| `council.quorum` | required councillor count | Number of successful required (non-optional) councillor responses required before the aggregator can run. When `quorum < requiredCount`, the aggregator starts as soon as required quorum is reached and pending councillors are aborted (after an optional grace window). Must be an integer in `[2, requiredCount]`. Default preserves wait-for-all-required behavior. |
| `council.timeouts.councillor_ms` | `270000` (4.5 min) | Timeout for each reviewer request |
| `council.timeouts.optional_councillor_ms` | `60000` (1 min) | Timeout for optional councillor requests. Values above `councillor_ms` are clamped to `councillor_ms`. |
| `council.timeouts.aggregator_ms` | `120000` (2 min) | Timeout for the aggregation step. This starts after the councillor phase completes, so the aggregator gets a fresh clock. |
| `council.timeouts.quorum_grace_ms` | `0` | Optional grace window in milliseconds after quorum is reached, during which stragglers can still join before the laggard abort sweep. Set to `0` (default) to abort pending councillors immediately on quorum. |
| `council.timeouts.hard_cap_ms` | computed (`420000` with defaults) | Absolute maximum wall time for the entire operation. By default this is `councillor_ms + aggregator_ms + quorum_grace_ms + 30000`. |

### Timeout behavior

Council review uses four timeout layers:

1. Each councillor request gets `councillor_ms`.
2. Optional councillor requests race a shorter `optional_councillor_ms` budget (clamped to `councillor_ms`).
3. The aggregator gets a fresh `aggregator_ms` clock after the councillor phase completes.
4. When `quorum < requiredCount`, an optional layer kicks in: once `quorum` required councillors succeed, the orchestrator waits up to `quorum_grace_ms` for stragglers to join, then aborts any still-pending councillor sessions before invoking the aggregator.

The outer `hard_cap_ms` is a safety net around the whole operation. When omitted, it is computed from the resolved phase timeouts plus a 30-second buffer: `councillor_ms + aggregator_ms + quorum_grace_ms + 30000`. With defaults (grace = 0), that is `270000 + 120000 + 0 + 30000 = 420000` (7 minutes).

If a councillor or aggregator times out while its child session is still being created, a stop is requested for that child as soon as it exists (detached; on V2 the stop may end unconfirmed) and it is never prompted (on V1 this is a behavior change: earlier versions prompted it).

If you explicitly set `hard_cap_ms`, the plugin honors it exactly. If the explicit hard cap is smaller than the computed phase budget, the plugin emits a structured warning but does not shrink the inner phase timeouts.

### Debug logging

Structured debug logging is resolved once when the plugin initializes, then the
same logger is reused for every `council_review` invocation. It can be enabled
from any of three sources:

- Set `COUNCIL_DEBUG=1` in the environment before starting opencode.
- Set top-level plugin option `"debug": true`.
- Set `"debug": true` in the plugin's `council` config.

On V1, logs are emitted through opencode's app logger as `ctx.client.app.log({ body: { service: "council-plugin", level, message, extra } })`. Debug logs include councillor request start/completion, aggregator start/end, timeout events, and hard-cap triggers. Warnings, including stripped `ask` permissions, deprecated timeout keys, and undersized explicit hard caps, also use the same structured logger. V1 logging is unchanged.

On V2, which has no persisted plugin logger yet ([#44](https://github.com/skwid138/opencode-council/issues/44)), warnings and errors go to `console.error` with a `[council-plugin]` prefix and metadata only: the fixed event message plus model label, session ID, role, duration, count, and an error kind/class. No prompt text, error message text, or raw config values. With debug enabled (any of the sources above), debug events are printed the same way and also appended to a debug log file:

- `$XDG_STATE_HOME/opencode-council/debug.log` when `XDG_STATE_HOME` is absolute, otherwise `~/.local/state/opencode-council/debug.log`
- directory `0700`, file `0600`; the `opencode-council` directory and the log file itself are checked (symlinks, FIFOs, hard links, and other-user ownership are refused and logging is disabled after one warning); ancestor directories above `opencode-council/` are not checked
- one rotation to `debug.log.1` at about 1 MiB; metadata only, same allowlist as the console
- not written on Windows (console only)

## Bundled and custom agents

If `reviewer` or `aggregator` is omitted, the plugin injects hidden `mode: "subagent"` bundled agents: on V1 into `config.agent` through the config hook at startup, on V2 as an `agent.transform` upsert (re-applied on every host reload):

- `council-plugin-reviewer` — an adversarial reviewer that tiers findings as Must Address, Should Address, or Unrelated Observations and returns APPROVE / REVISE / REJECT.
- `council-plugin-aggregator` — a structural aggregator that deduplicates reviewer responses by agreement level without issuing its own verdict.

Bundled agent temperatures are set explicitly: the reviewer defaults to `0.3` for some council diversity, and the aggregator uses `0` for deterministic synthesis. Set `council.reviewer_temperature` to override the injected bundled reviewer temperature; the aggregator temperature is not configurable. If you specify a custom `reviewer`, define any desired temperature on that agent instead.

If you specify `reviewer` or `aggregator`, that name must reference an opencode agent defined in your config (`~/.config/opencode/agent/` or `.opencode/agent/`). Custom agents fully replace the corresponding bundled agent.

**Reviewer** — An adversarial review agent. Its job is to find problems with the code or plan it receives. Design its system prompt for critical analysis, not helpfulness. The same reviewer agent is used for all models in the `models` array; model diversity comes from the fan-out, not from multiple agent definitions.

**Aggregator** — A synthesis agent. Its job is to structurally combine multiple reviewer responses into a unified summary. The aggregator gets no working tools by default (V1: its prompt disables all tools; V2: its session starts with a `*` deny, with only explicit `aggregator_permission` allows re-enabling anything, and `council_review` always denied), so its prompt should focus on structural synthesis rather than independent analysis.

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

On V1, reviewer overrides are appended after the plugin's catch-all allows and after inherited workspace `bash` / `external_directory` rules, so they can tighten reviewer sessions by adding later `deny` rules. Allow-only overrides do not narrow access; because the workaround starts with broad allows, use explicit `deny` rules for restrictions. On V2 there are no catch-all allows; see [OpenCode V2 differences](#opencode-v2-differences). On both hosts the final `council_review` deny comes after your overrides and cannot be overridden.

Aggregator overrides are used only when explicitly configured. The aggregator never receives the reviewer catch-all allows; on V1 it inherits no workspace permissions, while on V2 it gets the parent session's deny rules like the reviewer.

For working examples of reviewer and aggregator agent definitions, see:
- [config-opencode](https://github.com/skwid138/config-opencode) — personal opencode config with council agents
- [ai-dev-bootstrap-mac](https://github.com/skwid138/ai-dev-bootstrap-mac) — similar agent setup in a bootstrap config

## OpenCode V2 differences

The council contract is the same on both hosts: options block, `council_review`
name and argument, bundled agent names, quorum/timeout/grace/hard-cap math, and
participation reporting. The mechanics follow V2 where V2 differs:

- **Child permissions.** Each child session gets an explicit, ordered permission list (last match wins):
  - Reviewer: the parent session's **deny** rules (in order) → council denies for `edit`, `subagent`, `question`, `todowrite` → translated `reviewer_permission` → a final `council_review` deny.
  - Aggregator: the parent session's deny rules → `*` deny → translated `aggregator_permission` → a final `council_review` deny.
  - Council itself adds nothing broader than the parent session: parent allows are dropped and parent denies are kept. Because of that, a parent `*` deny with an allow exception becomes a plain deny (accepted over-restriction).
  - Your explicit `reviewer_permission` / `aggregator_permission` overrides are trusted grants: they come after the inherited parent denies, so an override **can** re-allow something the parent session denies. Only the final `council_review` deny cannot be overridden.
  - Parent **agent** restrictions are not inherited, same as V1 and the V2 built-in subagent ([#49](https://github.com/skwid138/opencode-council/issues/49)).
- **Action renames.** `reviewer_permission` / `aggregator_permission` keys are translated: `bash` → `shell`, `task` → `subagent`, `write`/`patch` → `edit`. `~`, `~/`, `$HOME`, `$HOME/` are expanded for `external_directory`, `read`, and `edit` resources only; shell patterns are left untouched.
- **Asks become denies.** V1 keeps its catch-all allows and strips `ask`. On V2, `ask` values (from your workspace, agents, or the overrides) are kept, and an evaluate hook turns any still-`ask` decision for a council child into a deny with a short message. Saved "always" approvals still apply. Plugins whose evaluate hooks run later can override this. See [#43](https://github.com/skwid138/opencode-council/issues/43) and [#46](https://github.com/skwid138/opencode-council/issues/46) for stricter follow-ups.
- **Reviewer write policy (both hosts).** The default is tool-level "no edit or delegation tools"; shell commands may still change files according to your workspace rules. For a fully read-only reviewer set `reviewer_permission: { "bash": "deny" }` (`shell` on V2 also works).
- **Tool registration.** `council_review` is registered with `codemode: false`, so it is a direct tool rather than a Code Mode catalog entry.
- **Models.** Children are created with an explicit agent. The model is the configured one (`models[i]` / `aggregator_model`); otherwise the selected agent's runtime model (looked up via the host's agent API); otherwise no model is sent and the host default applies. Council never passes the parent session's model, and no variant or reasoning setting is forwarded ([#42](https://github.com/skwid138/opencode-council/issues/42)).

## How it works

1. **Fan out** — The review prompt is sent to each configured model in parallel, each running as the specified `reviewer` agent in its own child session.
2. **Quorum** — As soon as `quorum` required reviewers respond successfully (default: all required councillors), the orchestrator stops waiting on the rest. If `quorum_grace_ms > 0`, a grace window lets stragglers join before pending sessions are aborted. Optional councillors do not count toward quorum and are aborted by the laggard sweep when required quorum is met.
3. **Gate** — At least 2 successful responses are required overall. Otherwise, an error is returned for fallback handling.
4. **Aggregate** — Successful responses are passed to the `aggregator` agent, which performs structural synthesis without issuing its own verdict. The aggregator prompt is byte-identical to the pre-quorum behavior when no councillors were aborted and all councillors are required; mixed councils tag optional councillors with `(optional)`.
5. **Return** — The aggregated result is returned to the calling agent.

### Failed replies (V1)

On V1, a child reply that the host marks as errored counts as a failure, even if it also contains partial text. That means the newest assistant message, or the assistant message in the prompt response, has an `error` set. A failed reviewer is listed under "Failed or timed out" as `assistant error: failed`. Failed replies do not count as successful participation: required failures do not advance quorum, and the quorum and two-success thresholds stay unchanged (optional councillors never count toward quorum). A failed aggregator makes `council_review` return `Error: council_review failed: assistant error: failed` instead of its partial text. The host's error details and the partial text are not copied into that message. The plugin only sees what the host reports, so an incomplete reply that the host does not mark as errored is still treated as a response. V1 0.10.0 and earlier accepted the partial text of an errored reply. V2 already treated an assistant error or a non-successful session outcome as a failure.

### Cancellation and recursion (both hosts)

- Cancelling the parent `council_review` tool call *requests* a stop for every tracked council child (V1 `session.abort`; V2 interrupt plus a wait bounded to 5 s per review, which may end unconfirmed) and returns `Council review cancelled.` without waiting for those stops to be confirmed. Children whose creation completes after cancellation are stopped as soon as they exist. The aggregator does not start after cancellation, and one that is already running is stopped.
- Council children cannot invoke `council_review`: on both hosts the tool refuses immediately when called from a council child session of the same plugin instance. It is also hidden by a final `council_review` deny rule on reviewer sessions (both hosts) and the V2 aggregator, and by the prompt tools map on the V1 aggregator.

## Source structure

The runtime is split into focused internal modules under `src/`:

- `index.ts` — public re-exports and the dual-host default export
- `v1.ts` — V1 host adapter: `server` plugin function, config hook, tool registration, SDK calls
- `v2.ts` — V2 host adapter: `setup`, agent/tool registration, evaluate hook, child stop, cleanup
- `v2-contract.ts` — structural V2 host types (no runtime SDK import)
- `v2-permissions.ts` — V2 permission translation and child permission composition
- `host.ts` — host seam used by the core modules
- `ownership.ts` — per-instance registry of council child sessions
- `cancellation.ts` — review cancellation
- `debug-file.ts` — V2 debug log file
- `config.ts` — council option parsing, defaults, timeout constants, config warnings
- `permissions.ts` — V1 permission override normalization and child-session ruleset construction
- `session.ts` — child-session creation guards and V1 response extraction
- `councillor.ts` — reviewer request lifecycle
- `aggregator.ts` — aggregator prompt formatting and synthesis session lifecycle
- `orchestrator.ts` — per-review fan-out, success threshold, hard-cap handling
- `timeout.ts` — timeout race helper and formatting
- `logging.ts` — V1 logger factory and shared log helpers
- `types.ts` — shared types, bundled agent constants, and type guards
- `prompts.ts` — bundled reviewer and aggregator prompts/permissions

## Tool exposed

The plugin registers a single tool:

### `council_review`

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | `string` | The complete review prompt to send to each reviewer |

**Returns:** The aggregator's structural synthesis, or an error string if fewer than 2 reviewers succeeded (timeouts and failures count against the success threshold; quorum-aborts happen only after required quorum is reached).

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

`npm test` runs Vitest through `test/run-isolated.mjs`, which gives the run a throwaway `HOME`, XDG directories, temp directory and npm cache, and strips inherited `OPENCODE*` and npm config variables. Running `npx vitest` directly is refused. To run one file, pass it through the same launcher:

```sh
npm test -- src/v2.test.ts
# or: node test/run-isolated.mjs vitest run src/v2.test.ts
```

Type-check `src/`, including the V2/V1 type-contract tests in `src/v2.test-d.ts` (checked against the real `@opencode/plugin` and `@opencode-ai/plugin` types):

```sh
npm run typecheck
```

There is no coverage script yet ([#51](https://github.com/skwid138/opencode-council/issues/51)).

Build the package:

```sh
npm run build
```

The build emits ESM artifacts and declaration files into `dist/`.

Verify the packed archive (script-free; no network). This builds, constructs the archive with the system `tar`, checks its contents, exports, and lazy host imports in a clean consumer, and runs doctored-archive negative controls:

```sh
npm run verify:pack
```

`npm run verify:consumer` additionally installs the archive into four throwaway consumers (V1 1.18.29 / 1.19.3, V2 2.0.28 / 2.0.32) and type-checks them strictly. It uses the network; installs run with `--ignore-scripts` and a disposable npm cache.

CI (and the release workflow) runs `typecheck`, `test`, and `build` only. Packed-archive verification (`verify:pack`), strict consumer compiles (`verify:consumer`), and real-host qualification are **not** run in CI.

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
- On V1, reviewer child sessions always receive session-level catch-all allows for `bash` and `external_directory`, then inherited workspace `bash` / `external_directory` `allow` and `deny` rules, then explicit `reviewer_permission` overrides.
- On V1 only, the reviewer catch-all `bash` allow is an intentional security trade-off: a workaround for the (since-fixed) [anomalyco/opencode#28037](https://github.com/anomalyco/opencode/issues/28037), where unanswerable child-session permission prompts hung the TUI. Tighten custom reviewer sessions by adding later `deny` rules in `reviewer_permission`.
- On V1 only, `external_directory` has no catch-all deny: the reviewer session starts with a catch-all allow to neutralize `ask`, then applies inherited workspace denies and explicit reviewer denies. V2 adds no such allow and keeps the parent session's deny rules.
- On V1, explicit permission overrides are applied at session level and should use only `allow` or `deny` values. Any `ask` entries are stripped with a warning because child sessions cannot prompt interactively.
- On V2, child sessions never inherit parent allows (parent denies are kept, but explicit overrides can re-allow them), and still-`ask` decisions for council children become denies (see [OpenCode V2 differences](#opencode-v2-differences)).
- The aggregator has no working tools by default: on V1 its prompt disables all tools (defense-in-depth on top of the bundled agent's `*` deny); on V2 its session starts with a `*` deny that only explicit `aggregator_permission` allows can relax.
- The aggregator never receives reviewer catch-all allows. On V1 it inherits no workspace permissions; on V2 it gets the parent session's deny rules. On V2, set `aggregator_permission` explicitly if you need aggregator session rules; on V1 those rules are currently replaced by the aggregator prompt's tools map and have no effect ([#50](https://github.com/skwid138/opencode-council/issues/50)).
- Child sessions are stopped after use (V1 abort; V2 interrupt plus a bounded wait); server-side TTL handles edge cases.

## Known Issues & Limitations

### Permission prompts from plugin-spawned child sessions hang the TUI

**Status:** Upstream fixed in V1 1.17.7; workaround retained pending retest ([#45](https://github.com/skwid138/opencode-council/issues/45)).
**Tracking:** [anomalyco/opencode#28037](https://github.com/anomalyco/opencode/issues/28037)

Before the upstream fix, when a councillor session triggered a bash command not on the allow-list, the opencode TUI displayed a permission prompt that could not be resolved — clicking Allow/Reject did nothing, and the session hung indefinitely.

**Root cause:** The opencode server used separate in-memory permission service instances for the plugin SDK client vs. the TUI listener. Permission replies from either surface landed on a different instance than the one holding the pending request, so they were silently dropped.

**Workaround (V1, still in place):** Bundled agents are injected with permissions that contain no `ask` values. Reviewer child sessions receive a session-level ruleset with catch-all `allow` entries for `bash` and `external_directory`, followed by inherited workspace `allow` / `deny` rules and explicit reviewer overrides. Councillors never trigger `ask` prompts; configure later `deny` patterns in `reviewer_permission` to restrict risky commands or paths.

**Implications for consumers:**
- Bundled agents work without requiring you to create reviewer or aggregator agents
- Custom reviewer sessions read your parent workspace `opencode.json` `permission.bash` and `permission.external_directory` rules automatically
- Commands and external paths are broadly allowed by the workaround unless workspace rules or explicit reviewer overrides deny them later
- If you need stricter custom reviewer behavior, define `reviewer_permission` with explicit deny patterns such as `"sudo *": "deny"` or `"~/secrets/*": "deny"`
- If you add new bash or external-directory rules to your config, councillor sessions pick them up on next invocation
- With the upstream bug fixed, this workaround is likely redundant but harmless; it stays until the retest ([#45](https://github.com/skwid138/opencode-council/issues/45)). V2 does not use it (see [OpenCode V2 differences](#opencode-v2-differences)).

### Plugin unload with unsettled council children (V2)

On unload, the V2 plugin cancels in-flight reviews and requests stops for its children, waiting at most 5 s for the stops (cleanup as a whole is bounded at about 9 s). A child whose stop is not confirmed in time keeps running, and after cleanup it no longer gets the ask-to-deny conversion or the recursion guard. The bounds stop the plugin from *waiting*; they do not cancel the underlying host operation.

### `aggregator_permission` is ineffective on V1

**Tracking:** [#50](https://github.com/skwid138/opencode-council/issues/50)

On V1 the aggregator prompt's tools map replaces its session ruleset, so `aggregator_permission` has no effect. The bundled aggregator agent's own `*` deny still applies. V2 is not affected.

### V2 permission follow-ups

- Auto-reject listener for council child permission asks: [#43](https://github.com/skwid138/opencode-council/issues/43)
- Optional strict permission snapshot mode: [#46](https://github.com/skwid138/opencode-council/issues/46)
- Parent-agent permission ceiling on council children: [#49](https://github.com/skwid138/opencode-council/issues/49)

## License

MIT
