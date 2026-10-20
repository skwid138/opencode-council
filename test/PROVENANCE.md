# Test harness provenance

Files under `test/` copied from **skwid138/opencode-command-normalizer** at commit
`7ddab8d6d0d23a67b7dcc753248e4673885e2120` (verified with
`git -C /Users/hunter/code/opencode-command-normalizer rev-parse HEAD` and a clean
`git status` on 2026-10-18). Each copied file carries a provenance header naming
its source path and local modifications.

| Council path | Source path | Local modifications |
|---|---|---|
| `test/pack-artifact.mjs` | `test/pack-artifact.mjs` | 1. `PACKAGE_ROOT_FILES` = LICENSE, README.md, package.json (no SECURITY.md); `PACK_LIMITS.maxEntries` 64 → 128. 2. Recursive src discovery: nested production modules map to nested `dist/<path>.js` + `.d.ts`; symlinks under src refused. 3. Recursive dist inspection: rejects compiled test artifacts (`*.test.*`, `*.test-d.*`) at any depth (including stale leftovers), symlinks at any depth, and any file/directory not on the expected path set. New export `isCompiledTestArtifact`. |
| `test/pack-artifact.test.ts` | `test/pack-artifact.test.ts` | Council-shaped fixture (no SECURITY.md; nested `src/core`/`dist/core` module; nested test sources). Added: recursive discovery, real-repo expectation, nested stale/missing/symlinked-dir, compiled test artifact (top-level, nested, stale-only directory) cases. Two bound tests re-sized for the larger fixture (maxEntries 7 → 8, aggregate cap 300 KB → 500 KB). |
| `test/real-host/artifacts.mjs` | `test/real-host/artifacts.mjs` | Removed the normalizer host `MATRIX` export (council's separate real-host plan defines its own host matrix). Everything else unchanged. |
| `test/real-host/artifacts.test.ts` | `test/real-host/artifacts.test.ts` | "version matrix" suite replaced by an assertion that `MATRIX` is not carried. |
| `test/isolated-env.mjs` | `test/isolated-env.mjs` | `ROOT_VAR` = `COUNCIL_TEST_ROOT` (must not match `/^OPENCODE/i`, which is stripped); root prefix `opencode-council-test-`. |
| `test/isolated-env.d.mts` | `test/isolated-env.d.mts` | Provenance header only. |
| `test/isolated-env.test.ts` | `test/isolated-env.test.ts` | Added council naming and full environment-pinning assertions (HOME, all XDG_*, TMPDIR/TMP/TEMP, npm cache/config, stripped `OPENCODE_*` / npm overrides, os.homedir()/os.tmpdir() detection); created parent directories are removed in `afterEach`. |
| `test/run-isolated.mjs` | `test/run-isolated.mjs` | Optional absolute `COUNCIL_ISOLATION_PARENT` selects the parent of the disposable root (default `os.tmpdir()`). |
| `test/setup-isolation.mjs` | `test/setup-isolation.mjs` | Provenance header only. Wired as the Vitest `setupFiles` worker guard. |
| `test/isolation.test.ts` | `test/isolation.test.ts` | Council `ROOT_VAR`; normalizer audit-log default-path case dropped (no council equivalent). |
| `test/consumer-compile.mjs` | `test/consumer-compile.mjs` | Provenance header only. |
| `test/consumer-compile.d.mts` | `test/consumer-compile.d.mts` | Provenance header only. |
| `test/consumer-compile.test.ts` | `test/consumer-compile.test.ts` | `OWN` fixture path renamed to this package. |

## Adapted (rewritten, not copied)

| Council path | Basis | Notes |
|---|---|---|
| `test/verify-pack.mjs` | normalizer `test/verify-pack.mjs` | Council exports/named API/id; static checks in `test/pack-checks.mjs`; runtime probes (import with no host packages, deferred `server()` load of `@opencode-ai/plugin`, a stub `@opencode-ai/plugin` that records evaluation to prove import does not load it and `server()` does, `setup()` against a structural V2 context); doctored-archive negative controls on every run; four-host consumer-compile matrix (`--consumer-types`, network, separately approved); `--print-consumer-plan` dry listing. |
| `test/pack-checks.mjs` (+ test) | specifier scan in normalizer `test/verify-pack.mjs` | Pure static checks: V2 SDK references (static/dynamic/type), `effect`, eager vs deferred `@opencode-ai/plugin`, entry-graph closure, exports map, manifest dependencies. |
| `test/run-isolated.test.ts` | — | New: launcher isolation + `COUNCIL_ISOLATION_PARENT`. |

## Isolation wiring (same pattern as the normalizer)

- `package.json` `test`: `node test/run-isolated.mjs vitest run` (normalizer `package.json` `test` script).
- `vitest.config.mts` calls `assertIsolated()` at config load and registers `test/setup-isolation.mjs` as a `setupFiles` worker guard (normalizer `vitest.config.mts`, minus its typecheck block: council type-checks `src/v2.test-d.ts` with `npm run typecheck`).

## Real-host harness, P1a (plan `.project-plans/2026-10-18_council-real-host-qualification.md`)

Same normalizer commit `7ddab8d6d0d23a67b7dcc753248e4673885e2120` (re-verified clean on 2026-10-18).

### COPIED (verbatim + provenance header)

| Council path | Source path | Local modifications |
|---|---|---|
| `test/real-host/env.mjs` | `test/real-host/env.mjs` | Header only. |
| `test/real-host/supervisor.mjs` | `test/real-host/supervisor.mjs` | Header only. |
| `test/real-host/http.mjs` | `test/real-host/http.mjs` | Header + post-p1a02 modifications: raw `node:http` auth handshake, coded `HarnessError`s (see the "Post Gate C p1a02" section). |
| `test/real-host/signals.mjs` | `test/real-host/signals.mjs` | Header only. Wired (unmodified) into `run.mjs` for every executed gate: first SIGINT/SIGTERM aborts the run signal + `stopAll()` (kills the attached client; Gate C then removes the owned container by exact id and verifies absence, writes `gate-<g>-cancelled-<run>.json` with `cleanupConfirmed`, exits 130 via `exitCodeFor`); second signal: `stopAll()` records cleanup as unconfirmed, then `signals.mjs` exits 130. |
| `test/real-host/provider-startup.mjs` | `test/real-host/provider-startup.mjs` | Header only (reused as the host startup wait). |
| `test/real-host/listener-ownership.mjs` | `test/real-host/listener-ownership.mjs` | Header only. |
| `test/real-host/stage.mjs` | `test/real-host/stage.mjs` | Header only (manual inspect/extract helper). |
| `test/real-host/provider-evidence.mjs` | `test/real-host/provider-evidence.mjs` | Sandbox-profile capture made optional (`profilePath` omitted -> `profile: null`, nothing read). Not used by the P1a runner (the fake provider is in-process; no provider launch to evidence). |

### ADAPTED (rewritten; ancestry noted, not copied)

| Council path | Ancestor | Retained / replaced / deleted |
|---|---|---|
| `test/real-host/host-v1.mjs` | `host-v1.mjs` | Retained adapter shape (routes, config, event normalizer). Replaced contracts.mjs gating and bash/permission focus with council routes/events (research §5). Deleted plugin remove/restore. Unverified shapes listed in `candidates`. |
| `test/real-host/host-v2.mjs` | `host-v2.mjs` (2.0.28-based) | Same. Fixed wait route to `POST /api/experimental/session/:id/wait`; interrupt `?resume=false`. Deleted reviewed provider template. |
| `test/real-host/fake-provider.mjs` | `fake-provider.mjs` | Retained OpenAI-compatible JSON/SSE shapes, identity endpoint, route/model rejection, budget, bounded ledger. Replaced single script with per-(session, model) scripts and outcomes (text, tool_call, empty, status, partial-then-error, hold), session-header attribution, in-process barriers. Deleted CLI/port-file mode. |
| `test/real-host/package-stage.mjs` | `package-stage.mjs` | Retained exact-SemVer check, safe segments, own-tarball reading. Replaced normalizer identity and stage-into-fixture with a pure V1/V2 exact-spec preseed plan + no-overwrite tree writer. Added `unresolvedPeers`. |
| `test/real-host/report.mjs` | `report.mjs` | Retained `sanitize`, "complete only when everything ran and passed". Replaced MATRIX rows with council cells + qualification receipts. |
| `test/real-host/gates.mjs` | `gates.mjs` | Retained "refuse until every gate passes; linked provenance". Replaced Darwin/sandbox-exec/MATRIX gates with Linux container gates (base-image inspection, COPY-only Dockerfile, run contract, Docker authority/env, deadlines, caps). |
| `test/real-host/runner.mjs` | `runner.mjs` + `runtime.mjs` | See the runtime.mjs inventory below. |

**`runtime.mjs` responsibility inventory** (normalizer 887 lines):

- *Retained (in `runner.mjs`)*: fixture creation, host env from scratch (`env.mjs`), owned host launch via `supervisor.mjs`, startup wait, auth challenge before any request, SSE subscription before prompting, event-driven waits, cleanup order (stop owned -> close streams/listeners -> remove fixture only if nothing survived).
- *Replaced*: per-row scenario execution (now one cell per container; `driver.mjs` + `controller.mjs`), provider subprocess (now in-process), plugin staging (now baked into the image via `image-context.mjs` and seeded per cell).
- *Deleted*: Darwin preflight and `sandbox-exec` profile, socket-path canary, normalizer audit/debug/decision logs, plugin remove/restore lifecycle, dependency tripwire regions.

### COUNCIL-ONLY (new)

`cells.mjs`, `frame.mjs`, `scenarios.mjs` (S1/S2 + probe; normalizer `scenarios.mjs`/`contracts.mjs` NOT used), `driver.mjs`, `controller.mjs`, `proc-runner.mjs`, `acquire.mjs`, `image-context.mjs`, `hosts.mjs`, `host-common.mjs`, `run.mjs`, and `test/no-docker-guard.mjs` (Vitest worker guard).

### Amendment A2 (frozen V1 peer closure, Gate P): council-only

- `test/real-host/closure.mjs` (+ `closure.test.ts`): council-only, new. Gate P command/env (pinned), npm version check by reading npm's `package.json`, fresh closure dir with `.npmrc` refusal, lockfile + node_modules inspection (registry-only resolved URLs, integrity, no link/git/file specs, no symlink/hardlink/special/unsafe paths, linux/arm64 platform packages only, acceptance limits, exact `@opencode-ai/plugin@1.19.3`), install-script allowlist pinned to exactly `msgpackr-extract@3.0.4` (any other install-script package or version → STOP), expected `@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4` recorded but not required, installed `name` and version compared to the lockfile, fresh distinct empty npmrc files (`$S/closure-config/npmrc-{user,global}`; mechanical correction of the `/dev/null` + `/dev/null` plan defect), receipt, Gate B receipt checks, closure re-hash that hands back the same buffers it hashed.
- Changed for A2: `package-stage.mjs` (`extraTree`: verified closure as council siblings, nested paths kept, V1 only), `image-context.mjs` (V1 `closure` input, manifest `closure` record), `driver.mjs` / `controller.mjs` / `report.mjs` (closure receipt id in every V1 result/receipt; `V1_RESULT_SCOPE`), `run.mjs` (`--gate P`; Gate B requires `--gate-p-receipt` / `--gate-p-approval`, checked before any docker call), `proc-runner.mjs` (`cwd`, `COUNCIL_RH_FORBID_SPAWN` tripwire), `test/no-docker-guard.mjs` (npm / npx / `node …/npm-cli.js` forbidden).

### P1a + A2 audit fixes (multi-frame REVISE): council-only

- `test/real-host/docker-session.mjs` (+ test): new. Fresh per-gate Docker CLI dirs (`docker-config-<g>`, `docker-home-<g>`): refused if present in any form, created 0700, verified empty right before the first docker call.
- `gates.mjs`: `classifyTagAbsence` (only exit 1 + a single "No such image: <ref>" line is absent), `verifyBuiltImage` (id + owner/host/archive/image-manifest labels), explicit `--entrypoint /usr/local/bin/node … /opt/council-rh/driver.mjs <cellId>` in `runArgv`. `image-context.mjs`: archive and image-manifest sha256 labels.
- `run.mjs`: injected deps (`createRunner`, `readNpmVersion`, `proc`); Gate B failure receipts; Gate C requires an accepted Gate B receipt (`--gate-b-receipt` / `--gate-b-approval`) and verifies both images by inspection before any `docker run`; `signals.mjs` wiring. `controller.mjs`: abort signal (no new cell; targeted removal + absence still run; `cleanupConfirmed` in receipts). `proc-runner.mjs`: abort signal, `killAttached()`.
- `scenarios.mjs`: per-child request attribution (model + parent header), known-session auxiliary requests, exact V2 aggregator permission sequence, aggregator tool inventory (V1 mirror of `src/aggregator.ts` `AGGREGATOR_TOOLS`, pinned by test; V2 empty), V1 persisted `time.completed`, bounded `summarizeEvidence` (result frame → receipt). `runner.mjs`: parent permissions, persisted completion, candidate-shape observations, exact version probe. `fake-provider.mjs`: positive auxiliary signature (unidentified tool-less → 400). `test/no-docker-guard.mjs`: curl forbidden too.
- `test/real-host/no-docker.test.ts`: spawn-level guard tests use only stub `npm`/`npx`/`docker`/`curl` executables and a fake `npm-cli.js` in a temp dir (marker files), with `PATH` = that dir only and a precondition that aborts before any spawn whose target would resolve elsewhere.

### Test ancestry

- Copied with their modules (header only): `env`, `supervisor`, `http`, `signals`, `provider-startup`, `listener-ownership`, `stage` tests.
- `provider-evidence.test.ts`: copied + one added no-profile case.
- `tar-fixture.ts`: in-memory tar.gz builder adapted from the helpers in `artifacts.test.ts`.
- New: `cells`, `frame`, `report`, `gates`, `acquire`, `package-stage`, `fake-provider`, `hosts`, `scenarios`, `driver`, `runner`, `controller`, `proc-runner`, `image-context`, `run`, `no-docker`, `closure`, `docker-session` tests.

## Not copied

Normalizer `test/real-host/` modules not used: `scenarios.mjs`, `contracts.mjs`
(normalizer-specific), `sandbox.mjs`, `probe.mjs`, `socket-path.mjs` (macOS-only),
`executor.mjs`, `plugin-decl.mjs`, `runtime.mjs`/`runner.mjs` (superseded by the adapted
`runner.mjs`, see inventory), `run.mjs` (superseded by council `run.mjs`).

### P1a round-2 re-audit fixes: council-only

- `proc-runner.mjs`: `run()` honors an AbortSignal (SIGTERM, SIGKILL after a bounded grace; `cancelled` result; never launches when already aborted). `run.mjs`: signal handlers installed before any preparation; cancellation checkpoints between preparation steps and before/after every spawn; cancelled Gate A/B/C/P write cancelled receipts (never accepted); Gate B requires an accepted Gate A receipt. `closure.mjs` `runGateP`: cancellation-aware (cancelled receipt with stage). `controller.mjs`: signal re-read after removal + absence check and after the result write.
- `runner.mjs` / `scenarios.mjs`: V2 absent parent permissions preserved as `null` and treated as `[]` (mirror of `src/v2-permissions.ts` `parentDenyRules`); unreadable / malformed parent permissions FAIL.
- `fake-provider.mjs`: source-verified auxiliary signatures (research §12), known-session MAIN classification, source-verified header pairs with alias-conflict rejection, sha256 + classification only (no prompt text). `host-v1.mjs` / `host-v2.mjs`: suppression config; auxiliary signatures removed from the UNVERIFIED candidates. S1/S2 FAIL on any auxiliary request.

### P1a round-3 re-audit fixes: council-only

- `test/real-host/receipts.mjs` (+ test): new. Atomic receipt writes (temp file + rename) and marking an `accepted` / `completed` (or unreadable) receipt `cancelled` (fields kept, `previousStatus` recorded), async and synchronous (signal handler).
- `run.mjs`: signal handlers installed first (synchronously, before receipt loads and directory creation); final receipts of Gates A/B/C written atomically and re-checked for cancellation after the write; the signal handler synchronously marks already-written receipts cancelled; `cancelledExit` overwrites atomically, reports write errors (never swallowed) and removes a receipt it cannot mark; settlement reported honestly (no "reaped" claim; `cleanupConfirmed` false when a process group did not settle). Injected `writeReceipt` / `acquireHost` deps. `closure.mjs` `runGateP`: atomic writes and a re-check after the accepted write.
- `proc-runner.mjs`: every child is its own process group (`detached`); timeout, cap, cancellation, escalation and `killAttached()` signal the group; after SIGKILL the wait for `close` is bounded (`closeBoundMs`) and an unsettled child is reported `cleanupUncertain`. `controller.mjs`: an unsettled attached client fails the cell and is never reported as clean cleanup (targeted `docker rm` still runs; verified with a node fake CLI under the real runner).
- `runner.mjs` / `scenarios.mjs`: `parentPermissionsPresent` records absence explicitly; the evaluator mirrors `parentDenyRules` exactly (absent → `[]`, `null` → malformed). `summarizeEvidence` bounds the whole object (largest fields replaced by `{ truncated, bytes, sha256 }` markers listed in `truncatedFields`).

### P1a round-4 re-audit fixes: council-only

- `receipts.mjs`: per-invocation receipt guard (`createReceiptGuard`). The signal handler calls `cancelSync()` synchronously (first signal included): it sets the cancelled flag, unlinks pending temp files, and marks every receipt this invocation published cancelled, deleting it if marking throws. The publish decision is synchronous (flag check + `renameSync`), so an accepted / completed receipt can never be published after the first signal, even if a second signal exits immediately. Ownership set: only receipts this invocation wrote are ever touched.
- `run.mjs`: guard wiring (`receiptHooks`, `markReceiptSync` deps); a rerun whose receipts or cancellation record for the same run id already exist is refused synchronously before any work.
- `proc-runner.mjs`: when termination was requested, a leader close is not proof; the group is probed (`kill(-pid, 0)`), escalated to group SIGKILL and polled within the bound, and only ESRCH reports clean (otherwise `cleanupUncertain`). `signalGroup` never signals pid <= 1 / undefined or a group confirmed gone. Gate A/P cancellation receipts carry `cleanupConfirmed: false` when settlement was uncertain.
- `frame.mjs` / `scenarios.mjs` / `driver.mjs`: check details bounded to 2 KiB with a sha256 marker; the driver marks the frame written only after a successful encode and otherwise emits a bounded fallback FAIL frame (`driver.frame-encode`).

Residuals (also in the plan's residual section):
- **Hard-crash orphans:** detached process groups and no parent-death handling. A hard-killed harness leaves its child groups unsignalled, which can include an attached `docker run` client and its container. Recovery: owner label + exact-id removal.
- **PID-reuse window:** between the leader being reaped and the final ESRCH probe, a reused pid could theoretically name an unrelated group. It is narrowed (no signalling after ESRCH, never pid <= 1), but not closed.

### P1a round-5 (narrow process-group audit) fixes: council-only

- `proc-runner.mjs`: after EVERY leader close, including a normal exit, the original group is probed (`kill(-pid, 0)`); only ESRCH is clean. Survivors get group SIGTERM, then SIGKILL after the grace, then polling within the bound, and are reported as `survivorsKilled`; still alive or ambiguous at the bound gives `cleanupUncertain`. Exit status and stdout are the leader's own. Every result carries `cleanupScope: "original-process-group"`.
- Scoped claims: `closure.mjs` cancelled receipts (`cleanupScope` + `cleanupScopeNote`; `processSettled` removed), `controller.mjs` / `report.mjs` cell receipts and cancelled summaries (`"original-process-group+owned-container"`; an unsettled `docker rm` / `ps` group means cleanup is not confirmed), and `run.mjs` cancellation records.

Residual: **escaped descendants**. A process that leaves the original group (setsid / new process group) without holding the pipes is not tracked, because portable process-tree tracking isn't available on macOS. Claims are scoped accordingly (also in the plan's §8 residuals).

### Post Gate C p1a01: per-family version probe (council-only)

- `runner.mjs`: `expectedVersionStdout(family, version)` (V1 `<v>\n`, V2 `opencode v<v>\n`; source-verified, research §12) replaces the single bare-version rule. The check is still exact (with or without the single trailing LF) and the expected string is recorded in `summary.probe.expected` and in failure details. The probe env comes from `probeEnv` (from scratch; no `OPENCODE_*`, no color variables, `NO_COLOR` deliberately unset), and its output fds are asserted non-TTY (`assertNotTty`).
- Follow-up (probe-fix audit Shoulds): `defaultDeps` accepts an injected `supervisor` / `isatty`, so the TTY refusal is tested on the real probe path, before any spawn. `PROBE_STDIO` is asserted in every position. The env-poisoning test restores pre-existing values exactly. Residual: the probe's output files are bounded only by the `/scratch` tmpfs (512 MiB) and the timeout; the 4 KiB cap applies to retained evidence.

### Post Gate C p1a02: V2 auth handshake, readiness, diagnostics (council-only changes to copied `http.mjs`)

- `http.mjs` (COPIED, now locally modified; header updated): the auth handshake (anonymous challenge + authenticated probe) uses raw `node:http` (`rawRequest`: loopback numeric host, no agent, no redirects, timeout, bounded body), because V2 omits `WWW-Authenticate` for requests carrying `Sec-Fetch-Mode` (always sent by Undici fetch). Source-verified: research §12. `HarnessError` gives every throw a stable code (`EAUTHCHALLENGE`, `EAUTHREJECTED`, `EEVENTSTREAM`, `EHTTP*`) and a bounded, sanitized detail; `routeLabel` records query keys only.
- `runner.mjs`: coded collection failures (`EPLUGININVENTORY`, `EAGENTS`, `ESESSIONCREATE`, `EPROMPT`, `EWAIT`, `ECHILDREN`, `ESESSIONGET`, `EMESSAGES`, `EHOSTSTARTUP`, `EEVENTWAIT`) whose detail reaches the result frame; the host-log tail is captured after the processes stop and before fixture removal, redacted (`redactHostLog`) and bounded. `host-common.mjs` / `host-v1.mjs` / `host-v2.mjs`: family readiness (`isListening`): V2 matches the exact source-verified line, V1 matches `127.0.0.1:<port>` with a digit boundary (not source-verified).
- Audit follow-up: `EAUTHCHALLENGE` records only header presence and whether it is the exact challenge, never the header text. `errorTag` keeps only a validated name and code. `client.request()` codes fetch and body-read failures (`EHTTPTRANSPORT` / `EHTTPREAD`) with an operation label. `host-common.mjs` readiness counts only newline-terminated lines. `redactHostLog` covers base64/base64url (padded and unpadded) of the password and of `opencode:<password>`, JSON `"authorization"` values, and case-insensitive Basic/Bearer. `tailFile` does one positioned read of the last N bytes.

### Post Gate C p1a03: durable parent tool result, V1 shape alignment, SSE diagnostics (council-only)

- Source-verified shapes (research §12, "Tool results, messages, agents and session events"; V2 2.0.28 `026b106b` / 2.0.32 `843a6c51`, V1 1.18.29 `16747470` / 1.19.3 `e3c4eb24`).
- `host-v2.mjs`: `session.tool.input.started` / `success` / `failed` mapped to the verified `data` fields (name only on input.started; text from `content[]`; `error.message`); paginated `messages` route (`order=desc` first page, `cursor` pages without `order`), `messagePageFrom`, `toolCallsFromMessages` (durable tool content), `agentNamesFrom`. `v2.toolOutputSource` removed from `candidates`.
- `host-v1.mjs`: `toolCallsFromMessages` (tool part `state.output` / `state.error`, truncation from `state.metadata.truncated` / `outputPath`), `agentNamesFrom` (bare array, `name` only), `session.status` idle, tool-part session fallback to `properties.sessionID`. `candidates` is now empty.
- `runner.mjs`: S2 reads the parent's durable record (V2 ≤ 10 pages, `EMESSAGES` on a bad page; V1 one parent messages read shared with settlement), V1 child identity from `info.agent` + top-level `providerID` / `modelID`, `createEventDiagnostics` (bounded `observations["sse.events"]`), and the JSON `"authorization"` redaction now spans escaped quotes / backslashes.
- `scenarios.mjs`: `s2.result-marker` evaluates `parentToolCalls` strictly (exactly one completed call with the marker; page bound / truncated details); `summarizeEvidence` keeps status / sizes only, never the result text.

### P1b: S3-S13, the observational V1 cells, and Gate D (council-only)

Approved plan §4 "Scenarios" / "Global evidence rules", research §5, §11, §12. Nothing here is copied; the normalizer's `contracts.mjs` is used only as a cited SOURCE of host texts / shapes (V1 deny / reject / abort texts, V2 static-deny `{type:"permission.rejected"}`, V2 config `permissions`, `permission.asked` shapes, shell/bash inputs; source-verified there at V1 `16747470` / V2 2.0.28 `026b106b`, runtime-observed by its batches) — every such shape this harness relies on at other pins is listed per scenario as UNVERIFIED (`candidatesFor`).

- New modules: `aggregator-prompt.mjs` (pure, bounded parser of the plugin's aggregator prompt: labels, constant error prefixes, fixture markers per section; mirrored council strings pinned to `src` by test), `scenario-checks.mjs` (S1/S2 check helpers moved out of `scenarios.mjs` unchanged; `attribution` also knows harness-created role sessions), `scenarios-p1b.mjs` (S3-S13 + obs-ask fixtures and evaluators; one mutation-style negative per predicate), `host-ops.mjs` (host reads moved out of `runner.mjs` unchanged, plus the session-generic V2 read), `drive.mjs` (event-driven drivers; preconditions -> INVALID-FIXTURE; harness actions recorded; classifications only).
- `fake-provider.mjs`: per-invocation-nonce scripts (`byNonce`), parallel `tool_calls`, `partial-error` held on a barrier after the partial chunk, aggregator-prompt structure and tool-result marker classes in the ledger, received / completed / disconnected ticks, provider events with an event-driven `waitFor`, `releaseAll`.
- `host-v1.mjs` / `host-v2.mjs` / `host-common.mjs`: permission reply routes, `permission.asked` / `replied`, V1 `session.error` (name only), V2 `plugin.updated` and interruption reason, durable tool entries (all tools), abstract permission rules rendered per family, fixture tool calls, custom agent file rendering, scenario-scoped `candidatesFor`.
- `runner.mjs`: P1b dispatch after the shared bootstrap, family/project-aware fixtures, project files written before launch, config permission rules, bounded plugin-log reads, watched fixture nonces in raw SSE events, re-subscribe, provider close that cannot hang on held requests. `scenarios.mjs`: dispatch, INVALID-FIXTURE verdict, bounded P1b `details` in the summary. `cells.mjs` / `driver.mjs`: every scenario implemented. `run.mjs`: Gate D (all four images verified against the Gate B' receipt, four probes, the 94 cells as `qualification`, exit decided by `report.mjs` `verifyQualification`).
- New tests: `aggregator-prompt.test.ts`, `scenarios-p1b.test.ts`, `drive.test.ts` (scripted hosts over the real fake provider: drive -> evaluate end to end, preconditions, non-ideal hosts); P1b additions to `fake-provider`, `hosts`, `runner`, `run`, `cells`, `driver` tests.

### Post-P1b audit fixes (council-only; plan "Mechanical correction (post P1b audit)")

- `scenarios-p1b.mjs`: `children-joined` common check (creation-event join + strict per-parent cardinality from `expected.childCounts`), exact full section set (required + optional), S4 `s4.empty-response`, S4 retries vs continuations reported separately, S13 V2 requires `plugin.updated` (no inventory fallback), S13 V1 durable settlement after the dispose, S11 host-relative read rule (`renderAgent`).
- `fake-provider.mjs`: `repeat` on a script's last step (never script-exhausted) and per-request `attempt` (`first` / `retry` / `continuation`).
- `host-v1.mjs` / `host-v2.mjs`: `verifiedShapes` (Radagast source-verified contract notes, never also UNVERIFIED), V1 bash `{command}`, V2 read `{path}`, V1 `projectCurrent` route (UNVERIFIED), pruned candidate lists.
- `drive.mjs`: deadline-bounded, signal-aware waits and host requests; S3 advisory checkpoint naming; S11 V1 worktree read + re-render + dispose; bounded strip-warning poll; S13 V2 `plugin.updated` waiter armed before the reload; V1 durable-settle reads (M9); V1 S13 durable settlement (M10).
- `runner.mjs` / `http.mjs` (COPIED, further locally modified: client-level and per-request abort signals) / `driver.mjs`: cell signal + `deadlineAt` plumbing (`WORK_MARGIN_MS`), stage checkpoints, explicit exit after the frame (`exitAfterFlush`), listener close outcomes inspected, `opencode.log` reader, confined `rewriteProjectFile`.
- `controller.mjs` (infrastructure failures in valid frames are harness failures), `report.mjs` (`cleanupConfirmed` required; `PLAN_RESIDUALS`), `receipts.mjs` (`complete` is cancel-markable), `run.mjs` (stop on unsettled tracked commands; Gate D report residuals + host-shape candidates; batch-end exact-id image removal with absence check; `--retain-images`), `closure.mjs` (npm cleanup uncertainty rejects the Gate P receipt).

### S4 budget option B (user-approved 2026-10-19; council-only)

- `cells.mjs`: `CELL_DEADLINES` / `cellDeadlines(scenario)` -- the single per-scenario table of driver (`driverMs`) and controller (`controllerMs`) deadlines; only S4 differs (240 s / 270 s). `gates.mjs` `DEADLINES.dockerRun` / `driverWork` are the table's defaults. `driver.mjs`, `controller.mjs`, `run.mjs` (Gate C/D plans) read the table.
- `scenarios-p1b.mjs`: S4 `councillor_ms` 150 000. `fake-provider.mjs`: `receivedAt` per ledger entry (injectable `now`); default retry behavior kept (no retry-suppression headers). `drive.mjs`: `retryStats` and `observations["s4.retries"]` for reviewer-1 / reviewer-3.

### P1b re-audit round 2 (council-only)

- `scenario-checks.mjs` `attribution({ joinChildren })` (P1b: child requests joined to the child's parent and metadata model); `scenarios-p1b.mjs` duplicate-id / distinct-id cardinality and the S11 `agentReloaded` precondition; `drive.mjs` S11 V1 dispose confirmation (response + `server.instance.disposed`) and the 20 s S4 partial-observation cap (`S4_PARTIAL_OBSERVE_MS`); `host-v1.mjs` `v1.projectCurrentRoute` verified; `run.mjs` gate-level absorption of unconfirmed cell cleanup (no further docker commands; cancellation records unconfirmed) and the incrementally persisted Gate D image ledger; `http.mjs` (COPIED, further locally modified) cell signal in `rawRequest` / `handshake` and in `openEventStream` (already-aborted refused; abort forwarded until the stream closes).

### P1b re-audit round 3 (council-only)

- `scenarios-p1b.mjs`: obs-ask runs the integrity checks as `cell.integrity.*` (infrastructure failures). `controller.mjs`: `runBatch({ onCleanupUnconfirmed })` fires before any fallible await. `run.mjs`: gate state set through that callback; a published Gate D report is rewritten (`incomplete`, `cleanupUncertain`) when batch-end image removal cleanup is uncertain.

### S11 diagnostic amendment (plan Amendment A3; council-only)

- `package-stage.mjs`: `v1ConfigInstallMarker(dir, hostVersion)` -- the V1 config-install skip-marker (empty `node_modules`, `package.json` / `package-lock.json` naming `@opencode-ai/plugin` at the host version), now shared by the XDG config preseed (bytes unchanged) and V1 S11's project `.opencode` (`scenarios-p1b.mjs`). `runner.mjs`: `writeProjectFiles` accepts `{ path, type: "dir" }` (exclusive, so empty); `runCell` passes the cell's host version to the fixture.
- `http.mjs` (COPIED, further locally modified): handshake transport failures name their leg (`auth handshake anonymous|authenticated leg <route>`), code kept, foreign errors reduced to name + code.
- New `diagnostic.mjs` (+ `diagnostic.test.ts`, host side, not in the image): terminal outcome classifier and interpretation note. `cells.mjs` `DIAGNOSTIC_HOST` / `DIAGNOSTIC_CELLS`; `controller.mjs` run kind `diagnostic`; `receipts.mjs` `terminal` is cancel-markable; `run.mjs` `--gate DIAG` (receipts `gate-diag-{probes,diagnostic}-<run>.json` + terminal `gate-diag-<run>.json`; no Gate D report, no image removal) and the Gate A `runId` (written; checked by Gate B before any docker call).
