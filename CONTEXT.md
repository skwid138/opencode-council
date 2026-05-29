# Council Plugin

An opencode plugin that provides multi-model adversarial review via a `council_review` tool. Multiple reviewer models evaluate the same prompt in parallel; an aggregator synthesizes their findings.

## Language

**Councillor**:
A reviewer instance — one model executing the reviewer agent prompt against the review target.
_Avoid_: Reviewer instance, review agent

**Reviewer agent**:
The agent definition (prompt + permissions) that councillors execute. Either user-specified or the bundled `council-plugin-reviewer`.
_Avoid_: Review prompt, review template

**Aggregator agent**:
The agent that synthesizes councillor responses into deduplicated findings by agreement level. Either user-specified or the bundled `council-plugin-aggregator`.
_Avoid_: Synthesizer, merger

**Bundled agent**:
A default agent injected via config hook when the user doesn't specify a custom agent. Namespaced as `council-plugin-reviewer` or `council-plugin-aggregator`.
_Avoid_: Default agent, built-in agent

**Config hook injection**:
The pattern of injecting agent definitions at plugin startup via the opencode config hook, rather than installing files or passing inline prompts.
_Avoid_: Dynamic registration, runtime injection

**Models array**:
The list of `{ providerID, modelID }` pairs that councillors fan out to. Each model in the array spawns one councillor.
_Avoid_: Reviewer models, councillor models

**Permission override**:
User-specified permissions (`reviewer_permission`, `aggregator_permission`) that layer on top of the active agent's permissions, whether bundled or user-specified. Applied as the highest-priority rules in last-match-wins evaluation.
_Avoid_: Permission config, custom permissions

**Structured log**:
Plugin diagnostics written via `ctx.client.app.log()` to opencode's log system. TUI-safe and persisted to `~/.local/share/opencode/log/`.
_Avoid_: console output, stderr logging

**Phase timeout**:
The individual timeout governing one phase of the council operation (councillor request, aggregator, quorum grace). Independent of the hard cap.
_Avoid_: step timeout, inner timeout

**Computed hard cap**:
The default hard cap derived from `councillor + aggregator + quorum_grace + 30s buffer` when no explicit `hard_cap_ms` is configured.
_Avoid_: auto timeout, dynamic cap

**#28037 workaround (catch-all allows)**:
Child sessions cannot prompt the user interactively (anomalyco/opencode#28037) — `ask` permissions hang the TUI. The plugin prepends catch-all `{bash, *, allow}` and `{external_directory, *, allow}` rules as the lowest-priority base. Workspace `ask` values are stripped by `workspacePatternRules` before layering, so `ask` cannot re-emerge. This is intentionally permissive; workspace deny rules restrict access back down.

**Permission layering**:
Child-session permission rulesets are constructed in append order. OpenCode evaluates rules last-match-wins (confirmed in opencode source `config.ts`):
1. Catch-all allows (#28037 workaround) — lowest priority
2. Workspace deny/allow rules (from cached permission's `bash` and `external_directory`; `ask` values stripped)
3. User `reviewer_permission` / `aggregator_permission` overrides — highest priority

**Cached permission**:
Workspace permission config captured from the config hook at plugin startup. The config hook is guaranteed to run before any tool execution, so this value is always populated when `buildReviewerRuleset` is called. OpenCode does not hot-reload config; the value remains valid for the plugin's lifetime.

**Active session tracking**:
A `Set<string>` of child session IDs maintained during a council review. Sessions are added after creation and removed on completion. Used by the hard-cap timeout to abort all in-flight sessions, and by the quorum-abort sweep to terminate still-pending councillors once `quorum` successes have been reached. Abort calls are fire-and-forget and idempotent — double-aborts are tolerated.

**Quorum**:
The number of successful councillor responses required before the aggregator can run. Configured via `council.quorum`; valid range is `[2, models.length]`. Default is `models.length` (wait-for-all). When `quorum < models.length`, the orchestrator stops waiting on stragglers once quorum is reached.
_Avoid_: threshold, minimum, majority

**Quorum grace window**:
An optional wall-clock window after quorum is reached during which still-pending councillors may still complete and have their responses counted. Configured via `council.timeouts.quorum_grace_ms`; defaults to `0` (abort laggards immediately on quorum). Cancellable — if all councillors finish during the window, the timer is cleared.
_Avoid_: straggler window, late-arrival window

**Laggard abort sweep**:
The orchestrator-level operation that runs after quorum is reached (and after the optional grace window expires) to abort any councillor sessions still in `pending` state. Implemented as a non-blocking iteration over `reviewState.activeSessions` issuing fire-and-forget aborts. Pending councillor states are finalized to `aborted` BEFORE the sweep iterates, so any late-resolving `createChildSession` call sees `reviewState.quorumReached === true` and self-aborts.
_Avoid_: cleanup, cancellation

**Aborted councillor**:
A councillor whose session was terminated by the laggard abort sweep because quorum was reached without it. Tracked separately from failures and timeouts as `CouncillorAborted = { model }`. Rendered in the aggregator prompt under a conditional `"## Aborted (quorum reached)"` section; the section is omitted entirely when no councillors were aborted, preserving byte-identical aggregator prompt behavior in the default (`quorum === models.length`) configuration.
_Avoid_: cancelled councillor, timed-out councillor, failed councillor

## Relationships

- A **council_review** invocation spawns one **councillor** per entry in the **models array**.
- Each **councillor** executes the **reviewer agent** (bundled or user-specified).
- The **aggregator agent** receives all councillor responses and produces deduplicated findings.
- **Permission overrides** layer on top of the active agent's permissions (bundled or user-specified) as the highest-priority rules.
- The **hard cap** wraps the entire operation as a safety net; **phase timeouts** govern individual phases independently with fresh clocks.
- When **quorum** is reached before all councillors respond, the orchestrator optionally waits up to the **quorum grace window**, then runs the **laggard abort sweep** to terminate still-pending councillor sessions. Each terminated session becomes an **aborted councillor** in the aggregator's participation summary.

## Example dialogue

> **Dev:** "When I specify `reviewer: 'saruman'` in config, does the plugin still inject `council-plugin-reviewer`?"
> **Domain expert:** "No — user-specified agents fully override bundled agents. The plugin only injects bundled agents when the config omits `reviewer` or `aggregator`."

> **Dev:** "Can I use `reviewer_permission` to add permissions to my custom saruman agent?"
> **Domain expert:** "Yes — `reviewer_permission` layers on top of saruman's own permissions as highest-priority rules. This lets you tighten or loosen permissions for the council context without editing the agent definition."

> **Dev:** "If I set `quorum: 3` with 5 models, will the aggregator always get exactly 3 responses?"
> **Domain expert:** "Not necessarily. It gets at least 3 (the quorum threshold). If `quorum_grace_ms > 0`, stragglers that complete during the grace window are also included. The default is `quorum = models.length` which preserves wait-for-all behavior — early aggregation is opt-in."

## Flagged ambiguities

- "reviewer" was used to mean both the agent definition and a running instance — resolved: **reviewer agent** is the definition; **councillor** is a running instance.
- "default agent" could mean opencode's default agent or the plugin's bundled agent — resolved: use **bundled agent** for plugin-provided defaults.
