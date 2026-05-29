## Plan: Issue #11 quorum-based early aggregation

> **Status:** Council-approved for persistence (plan v4)
> **Created:** 2026-05-28
> **Source:** GitHub issue #11 — "feat: quorum-based early aggregation to reduce wall-clock time"

### Goal

GitHub issue #11: "feat: quorum-based early aggregation to reduce wall-clock time."

Once `quorum` councillors succeed, abort still-pending laggards and proceed to aggregation. Optional `quorum_grace_ms` gives stragglers a window to join after quorum before the abort sweep. Default behavior MUST be byte-identical to current (wait-for-all) — user opts into early aggregation explicitly by setting `quorum: N`.

Single atomic `feat:` commit to `main` with `Closes #11` in message body. Semantic-release will produce a minor bump.

### Constraints

- Do NOT touch `src/prompts.ts` or `package.json`.
- Preserve `validateCouncilConfig === parseCouncilConfig` reference identity at `src/index.ts` (re-export).
- Tests must use vitest fake timers.
- Default `quorum = models.length` (NOT `Math.ceil(N/2)`). This is locked from round 3-4 discussion: avoids "where did 2 of my 5 reviewers go?" UX confusion.

### Repo state

Post-issue-#15 modular split. Source files:

```text
src/
├── index.ts          # plugin shell, re-exports
├── types.ts          # CouncilConfig, TimeoutConfig, ReviewState, CouncillorSuccess/Failure, type guards
├── config.ts         # parseCouncilConfig, composeCouncilConfig, resolveDebug, councilOptions, readTimeoutMs
├── permissions.ts    # buildReviewerRuleset
├── session.ts        # createChildSession, promptAndExtract
├── timeout.ts        # raceWithTimeout, formatSeconds
├── councillor.ts     # runCouncillorAttempt, runCouncillor
├── orchestrator.ts   # runCouncilReview, runCouncilReviewInner — PRIMARY CHANGE SITE
├── aggregator.ts     # buildAggregatorPrompt, synthesizeWithAggregator, formatFailureSummary, AGGREGATOR_TOOLS
├── logging.ts
└── prompts.ts        # DO NOT TOUCH
```

Test files exist for all source modules.

### File change matrix

#### `src/types.ts`

Add to existing types:

```ts
// New top-level type
export type CouncillorAborted = {
  model: ModelConfig;
};

// Extend CouncilConfig
export type CouncilConfig = {
  // ... existing fields ...
  quorum: number;
  // ... existing fields ...
};

// Extend TimeoutConfig
export type TimeoutConfig = {
  councillor_ms: number;
  councillor_retry_ms: number;
  aggregator_ms: number;
  quorum_grace_ms: number;  // NEW
  hard_cap_ms: number;
};

// Extend ReviewState
export type ReviewState = {
  activeSessions: Set<string>;
  hardCapTimedOut: boolean;
  quorumReached: boolean;  // NEW
};
```

#### `src/config.ts`

1. Add new helper `readNonNegativeMs` parallel to existing `readTimeoutMs`:

```ts
/**
 * Reads a non-negative millisecond value from a config source.
 * Floors at 0 (vs readTimeoutMs which floors at 1).
 * Use for timeouts that legitimately accept 0 (e.g. quorum_grace_ms).
 */
function readNonNegativeMs(source: Record<string, unknown>, key: string, fallback: number): number {
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.round(raw));
}
```

2. Parse `quorum_grace_ms` in `parseCouncilConfig`:

```ts
const quorumGraceMs = readNonNegativeMs(timeoutSource, "quorum_grace_ms", 0);
```

3. Parse `quorum`:

```ts
const quorum = (() => {
  const raw = councilSource.quorum;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 2 && raw <= models.length) {
    return raw;
  }
  if (raw !== undefined) {
    warn(`Invalid council.quorum: ${JSON.stringify(raw)}. Must be integer in [2, ${models.length}]. Falling back to ${models.length}.`);
  }
  return models.length;
})();
```

4. Include `quorum_grace_ms` in `computedHardCapMs`:

```ts
const computedHardCapMs = councillorMs + councillorRetryMs + aggregatorMs + quorumGraceMs + 30_000;
```

5. Include `quorum_grace_ms` in the under-cap warning debug payload.

6. Add `quorum` and `quorum_grace_ms` (inside `timeouts`) to the returned object.

#### `src/session.ts`

Add an optional parameter `abortIfQuorumReached: boolean` (default `false`) to `createChildSession`. Add a post-create check that mirrors the existing `hardCapTimedOut` post-create check but is gated by this new flag.

```ts
export async function createChildSession(
  ctx: CouncilPluginContext,
  parentSessionID: string,
  title: string,
  directory: string,
  permission?: PermissionConfig,
  reviewState?: ReviewState,
  abortIfQuorumReached: boolean = false,  // NEW
): Promise<string> {
  // existing hardCapTimedOut pre-create short-circuit STAYS AS-IS
  // existing session.create call STAYS AS-IS
  // existing activeSessions.add STAYS AS-IS
  // existing hardCapTimedOut post-create check STAYS AS-IS

  // NEW: scoped post-create quorumReached check
  if (abortIfQuorumReached && reviewState?.quorumReached) {
    void ctx.client.session.abort({ path: { id: session.id } }).catch(() => {});
    reviewState.activeSessions.delete(session.id);
    throw new Error("Council quorum reached; aborting late reviewer session.");
  }

  return session.id;
}
```

**Critical:** DO NOT add a pre-create short-circuit on `quorumReached`. Earlier plan versions had one; round 3 council flagged it would block aggregator session creation (the aggregator runs *after* quorum is reached). Only the scoped post-create check.

#### `src/councillor.ts`

In `runCouncillorAttempt`, pass `abortIfQuorumReached: true` to `createChildSession`.

In `runCouncillor`, extend retry suppression condition from `input.reviewState.hardCapTimedOut` to `input.reviewState.hardCapTimedOut || input.reviewState.quorumReached`. Suppresses retry when laggard is aborted because quorum was reached.

#### `src/aggregator.ts`

1. Add `aborted: CouncillorAborted[]` parameter to `buildAggregatorPrompt` input.

2. Add `formatAbortedSummary(aborted: CouncillorAborted[]): string` helper that returns formatted `- ${modelLabel}` lines, parallel to existing `formatFailureSummary`.

3. In `buildAggregatorPrompt`, render an `"## Aborted (quorum reached)"` section in the prompt body **ONLY when `aborted.length > 0`**. Same for the participation summary section. When `aborted.length === 0`, the prompt MUST be byte-identical to the current implementation.

4. Add `aborted: CouncillorAborted[]` parameter to `synthesizeWithAggregator`; pass through to `buildAggregatorPrompt`.

5. `synthesizeWithAggregator` calls `createChildSession` WITHOUT passing `abortIfQuorumReached` (defaults to `false`) — the aggregator must be allowed to start even though `quorumReached === true`.

#### `src/orchestrator.ts`

Replace the `Promise.allSettled` block in `runCouncilReviewInner` with a per-index state tracker, quorum race, cancellable grace timer, and laggard abort sweep.

```ts
// states[i] corresponds 1:1 with models[i] — same index throughout
type CouncillorState = "pending" | "success" | "failure" | "aborted";
const states: CouncillorState[] = councilConfig.models.map(() => "pending");
const successes: CouncillorSuccess[] = [];
const failures: CouncillorFailure[] = [];
const aborted: CouncillorAborted[] = [];

let resolveQuorum: () => void = () => {};
const quorumPromise = new Promise<void>((r) => { resolveQuorum = r; });

const councillorPromises = councilConfig.models.map((model, i) =>
  runCouncillor(ctx, councilConfig, log, { /* existing args */ })
);

// Per-promise handlers never throw — allFinished is therefore a non-rejecting Promise.all
const tracked = councillorPromises.map((p, i) => p.then(
  (value) => {
    if (states[i] !== "pending") return;
    states[i] = "success";
    successes.push(value);
    if (successes.length === councilConfig.quorum) resolveQuorum();
  },
  (error) => {
    if (states[i] !== "pending") return;
    states[i] = "failure";
    failures.push({ model: councilConfig.models[i], error: errorMessage(error) });
  }
));
const allFinished = Promise.all(tracked);

await Promise.race([quorumPromise, allFinished]);

if (successes.length >= councilConfig.quorum && states.some((s) => s === "pending")) {
  reviewState.quorumReached = true;

  if (councilConfig.timeouts.quorum_grace_ms > 0) {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        allFinished,
        new Promise<void>((r) => { graceTimer = setTimeout(r, councilConfig.timeouts.quorum_grace_ms); }),
      ]);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
    }
  }

  // Finalize state BEFORE issuing aborts so late createChildSession calls see quorumReached
  states.forEach((s, i) => {
    if (s === "pending") {
      states[i] = "aborted";
      aborted.push({ model: councilConfig.models[i] });
    }
  });

  for (const sessionID of reviewState.activeSessions) {
    void ctx.client.session.abort({ path: { id: sessionID } }).catch(() => {});
  }
}

if (successes.length < 2) {
  // existing < 2 fallback — extend to mention aborted models only when aborted.length > 0
  return /* fallback message */;
}

return await synthesizeWithAggregator(ctx, councilConfig, log, {
  parentSessionID,
  originalPrompt: prompt,
  successes,
  failures,
  aborted,  // NEW
  directory,
  reviewState,
  aggregatorPermission: aggregatorSessionPermission(councilConfig),
});
```

### Test plan

#### `src/config.test.ts` additions

- **quorum default**: N=2 → 2, N=3 → 3, N=5 → 5, N=8 → 8 (default is models.length).
- **quorum valid explicit**: 2 ≤ quorum ≤ models.length accepted.
- **quorum invalid**: reject `1`, reject `models.length + 1`, reject non-integer (e.g. `2.5`), reject non-number (e.g. `"3"`), reject negative; emit warning and fall back to `models.length`.
- **quorum_grace_ms default**: omitted → 0.
- **quorum_grace_ms explicit**: positive value preserved.
- **quorum_grace_ms negative**: coerced to 0 via `readNonNegativeMs`.
- **computedHardCapMs includes quorum_grace_ms**: assert sum of councillor + retry + aggregator + grace + 30_000.

#### `src/orchestrator.test.ts` additions (5 new cases)

Test setup uses existing `createSessionMocks()`, `createContext()`, `councilConfig()`, `deferred<T>()` helpers and vitest fake timers.

1. **Full quorum invariance** (`quorum === N`, N=2, all succeed):
   - Both deferred promises resolve.
   - Assert: aggregator's prompt body (captured via `session.prompt` mock args) does NOT contain "Aborted".
   - Assert: no abort calls for reviewer sessions (only the standard finally-cleanup aborts that already exist for completed sessions).

2. **Early abort, no retry** (`quorum=2, N=3, grace=0`):
   - Models 0 and 1 settle.
   - Model 2 remains pending at the time of quorum.
   - Assert: model 2 is in `aborted` list rendered in aggregator prompt.
   - Assert: `session.abort` called for model 2's session ID.
   - Assert: NO `session.create` call with `body.title` containing "attempt 2" for model 2 (retry suppressed).

3. **Grace window late arrival** (`quorum=2, N=3, grace=50ms`):
   - Models 0 and 1 settle.
   - Quorum reached, grace timer starts.
   - Model 2 settles within grace window.
   - Assert: model 2 is in `successes` (not aborted), `aborted` list is empty.
   - Assert: aggregator prompt does NOT contain "Aborted" section.

4. **Grace timer cleared on race win**:
   - `quorum=2, N=3, grace=10s`.
   - Models 0 and 1 settle, quorum reached.
   - Model 2 settles immediately within grace.
   - Assert: no dangling timer (vitest fake-timer state or `vi.getTimerCount() === 0` after test completes).

5. **Hard cap during grace** (`quorum=2, N=3, quorum_grace_ms=10000, hard_cap_ms=5000`):
   - **Test implementation discipline** (round 4 council finding): use `vi.useFakeTimers()`. Sequence deterministically:
     ```ts
     vi.advanceTimersByTime(1000); await vi.runOnlyPendingTimersAsync(); // model 0 settles
     vi.advanceTimersByTime(1000); await vi.runOnlyPendingTimersAsync(); // model 1 settles, quorum reached, grace timer scheduled
     // assert quorumReached === true at this point
     vi.advanceTimersByTime(3000); await vi.runOnlyPendingTimersAsync(); // hard cap at t=5s during grace
     ```
   - Do NOT use a single `advanceTimersByTime(5000)` — risks collapsing timing and exercising hard-cap-before-quorum instead.
   - Assert: all sessions in `activeSessions` aborted.
   - Assert: aggregator NOT called (its `session.create` not invoked).
   - Assert: `hardCapTimedOut === true`, `quorumReached === true`.
   - Assert: returned value is the hard-cap fallback message, not aggregator output.

### Acceptance criteria

1. `bun test` passes (all existing + new tests).
2. `bun run build` produces working dist.
3. Default behavior (no `quorum` configured) is byte-identical to current behavior for users with existing configs.
4. `quorum: N` with `quorum_grace_ms: 10000` triggers early aggregation after N successes with up-to-10s grace window for stragglers.
5. Aggregator prompt is byte-identical to current implementation when `aborted.length === 0`.
6. No retry attempt 2 fires for sessions aborted due to quorum.
7. Hard cap continues to work; takes precedence over grace window.

### Deferred (out of scope)

- `quorum=1` support (conflicts with existing `< 2 → fallback` rule; needs contract redesign).
- Hard-cap fallback path convergence (filed as issue #17).
- Retry collapse into single extended budget (filed as issue #18).

### Workflow note for implementer

This plan is the result of 4 council review rounds (rounds 1–2 had REVISE verdicts with material design changes; round 3 introduced the default-quorum and aggregator-block fixes; round 4 produced 2 APPROVE + 1 REVISE where the only REVISE item was the test-timing discipline for case 5 above, now captured in the test plan).

Implementation should be a single atomic commit to `main`:

```text
feat: quorum-based early aggregation

Closes #11
```

Body of commit should briefly describe the new `quorum` and `quorum_grace_ms` config knobs and that default behavior is preserved when quorum is unset.
