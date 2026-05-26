# Bundled Default Agents for @skwid138/opencode-council

**Status:** Approved (council-reviewed, 3x REVISE → addressed)
**Date:** 2026-05-26

## Problem

Plugin currently requires users to define their own `reviewer` and `aggregator` agents. New users hit errors immediately. Coworkers ask "who are saruman and elrond?" — onboarding barrier.

## Solution

Ship `council-plugin-reviewer` and `council-plugin-aggregator` as bundled agents injected via config hook. Users get working council reviews out of the box.

## Architecture

### Config Hook Injection (mutating callback)

```typescript
const CouncilToolPlugin: Plugin = async (ctx, options?: PluginOptions) => {
  const councilConfig = parseCouncilConfig(options); // non-throwing, sets defaults
  const userSpecifiedReviewer = !!options?.reviewer;
  const userSpecifiedAggregator = !!options?.aggregator;

  return {
    config: async (config) => {
      config.agent ??= {};

      if (!userSpecifiedReviewer) {
        config.agent["council-plugin-reviewer"] = {
          description: "Council plugin adversarial code reviewer",
          mode: "subagent",
          hidden: true,
          prompt: REVIEWER_PROMPT,
          permission: REVIEWER_PERMISSION,
        };
      }

      if (!userSpecifiedAggregator) {
        config.agent["council-plugin-aggregator"] = {
          description: "Council plugin structural aggregator",
          mode: "subagent",
          hidden: true,
          prompt: AGGREGATOR_PROMPT,
          permission: AGGREGATOR_PERMISSION,
        };
      }
    },
    tool: { council_review: ... }
  };
};
```

### Key Design Decisions

1. **Derive `userSpecifiedReviewer`/`userSpecifiedAggregator` from raw plugin options** — not from merged config. Plugin options are available at plugin init, before config hook runs.

2. **`validateCouncilConfig()` becomes `parseCouncilConfig()`** — non-throwing, makes `reviewer`/`aggregator` optional with bundled defaults.

3. **Config key is singular `config.agent`** (not `agents`). Mutate in place, do not return.

4. **`hidden: true` + `mode: "subagent"`** — prevents user selection and hides from `@` autocomplete.

## Permissions

### Reviewer (permissive, NO `ask` values)

```typescript
const REVIEWER_PERMISSION = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  edit: "deny",
  bash: "allow",
  task: "deny",
  question: "deny",
  todowrite: "deny",
};
```

### Aggregator (deny-all)

```typescript
const AGGREGATOR_PERMISSION = {
  "*": "deny",
};
```

### Rationale

- **No `ask` values anywhere** — `ask` causes terminal hangs in plugin-spawned child sessions. This is a known opencode bug.
- **Reviewer gets broad access** — user's global bash restrictions still apply on top.
- **Aggregator needs zero tools** — only synthesizes text from councillor responses.
- **MCPs/external tools** — not explicitly denied; inherit user's existing config.
- **Defense-in-depth for aggregator** — keep existing `tools: AGGREGATOR_TOOLS` at prompt time alongside `"*": "deny"`.

### Permission Overrides (Two-Layer)

1. **Config hook layer:** Base agent definitions with permissions above
2. **Session creation layer:** `reviewer_permission`/`aggregator_permission` applied at session level

```typescript
// At session creation for reviewer — DO NOT use buildPermissionRuleset here
// Only apply user's explicit permission overrides to avoid carrying `ask` values
const sessionPermission = councilConfig.reviewer_permission
  ? Permission.fromConfig(councilConfig.reviewer_permission)
  : [];

await ctx.client.session.create({
  body: { agent: reviewerName, permission: sessionPermission }
});
```

**Important:** Don't pass `buildPermissionRuleset(ctx.directory)` into reviewer sessions — it can carry user `ask` permissions and cause hangs. Only apply explicit override permissions.

**Note:** `Permission.fromConfig` is internal to opencode, not exported from SDK. Construct session permission rules as flat arrays matching the existing pattern in the codebase.

## Config Schema

```json
{
  "council": {
    "models": [{ "providerID": "...", "modelID": "..." }],
    "reviewer": "saruman",
    "aggregator": "elrond",
    "reviewer_permission": { "bash": "deny" },
    "aggregator_permission": {},
    "aggregator_model": { "providerID": "...", "modelID": "..." },
    "timeouts": { "councillor_ms": 180000, "councillor_retry_ms": 90000, "aggregator_ms": 120000, "hard_cap_ms": 300000 }
  }
}
```

All fields except `models` are optional.

## Bundled Prompt Content

### Reviewer (`council-plugin-reviewer`)
Generic adversarial reviewer derived from saruman agent. Key elements:
- Must Address / Should Address / Unrelated Observations tiering
- APPROVE / REVISE / REJECT verdicts
- Attack checklist (assumptions, edge cases, data-shape tracing)
- No references to Gandalf/Aragorn/Legolas/Jira/wpromote
- No model specification (inherits from `models` array at call time)

### Aggregator (`council-plugin-aggregator`)
Structural deduplication derived from elrond agent. Key elements:
- Agreement levels: Consensus (3+), Majority (2), Unique (1)
- No verdict — pure synthesis
- Deduplicates findings across councillors
- No model specification (uses `aggregator_model` if provided)

## Implementation Steps

1. Create `src/prompts.ts` — REVIEWER_PROMPT and AGGREGATOR_PROMPT constants
2. Create permission constants (same file or `src/permissions.ts`)
3. Refactor `validateCouncilConfig()` → `parseCouncilConfig()` — non-throwing, optional reviewer/aggregator
4. Add `config` hook to plugin return object
5. Modify session creation to apply permission overrides at session level (not buildPermissionRuleset)
6. Keep `tools: AGGREGATOR_TOOLS` at prompt time as defense-in-depth
7. Update README with new optional config
8. Update/add tests

## SDK Type Gaps (known, work at runtime)

- `AgentConfig.permission` SDK type only exposes `edit`, `bash`, `webfetch`, `doom_loop`, `external_directory` — but runtime supports all keys via index signature (`read`, `glob`, `grep`, `list`, `task`, `question`, `todowrite`, `"*"`)
- `hidden` not in SDK `AgentConfig` type — works at runtime via index signature
- May need TypeScript casts for these fields
