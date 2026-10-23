// Council-only (not copied). P1b fixtures and evaluators for S3-S13 and the observational V1
// non-bash-ask cell, per the approved plan (.project-plans/2026-10-18_council-real-host-qualification.md
// §4 "Scenarios"). Evaluators are pure functions over evidence assembled by drive.mjs; every
// predicate has a mutation-style negative test (scenarios-p1b.test.ts). Strict cardinality.
//
// Evidence (drive.mjs), beyond the S1/S2 fields (scenario, family, parentSessionID, expected,
// children[], created[], ledger[]):
//   roles:            { parent, control?, parentA?, parentB?, fresh? } harness-created sessions
//   finals:           { [sessionID]: "succeeded"|"failed"|"interrupted" (V2) | "idle" (V1) }
//   sessionErrors:    { [sessionID]: [errorName] }           V1 session.error names
//   persistedErrors:  { [sessionID]: errorName|null }        V1 last assistant info.error.name
//   persistedCompleted: { [sessionID]: number|null }         V1 last assistant time.completed
//   parentTools:      { [sessionID]: classified council_review calls }
//   childTools:       { [sessionID]: classified tool calls }
//     classified call = { callID, name, status, markers[], errorClass, textIs, interrupted,
//                         invalidTarget, messageCompleted }  (never raw text)
//   permissionEvents: { asked: [...], replied: [...] }       normalized host events, in order
//   actions:          [{ kind, target, ok, status, order }]  harness control requests, in order
//   hostNonces:       { [nonce]: { seen, type } }            fixture nonces seen in raw host events
//   preconditions:    { [name]: { met, detail } }            target-phase fixture preconditions
//   marks:            scenario-specific ordering facts (see each driver)
//   grandchildren / parentSession / inventory / pluginLog:   S9 / S8 / S13 / S8
import { COUNCIL_TEXT, timeoutLabel } from "./aggregator-prompt.mjs";
import { hostAdapter } from "./hosts.mjs";
import { AGGREGATOR_AGENT, attribution, auxiliarySuppressed, check, modelEntries, PROVIDER, requestsOf, REVIEWER_AGENT } from "./scenario-checks.mjs";
import { v1ConfigInstallMarker } from "./package-stage.mjs";

export const P1B_SCENARIOS = Object.freeze(["s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13", "obs-ask"]);

const label = (modelID) => `${PROVIDER}/${modelID}`;
const ref = (modelID, extra = {}) => ({ providerID: PROVIDER, modelID, ...extra });
const reviewerMarker = (index, token) => `REVIEW-${index}-${token}`;
const aggregateMarker = (token) => `AGGREGATE-${token}`;
const councilCall = (token) => ({ type: "tool_call", name: "council_review", args: { prompt: `council-review-${token}` } });
const parentSteps = (token) => [councilCall(token), { type: "text", text: `parent-done-${token}` }];
const text = (value) => ({ type: "text", text: value });
const hold = (barrier, then) => ({ type: "hold", barrier, then });
/** `echo <WORD>-<n> $((6*7))` prints `<WORD>-<n> 42`: the output marker never appears in the command (or a deny rule). */
const command = (word, n) => ({ command: `echo ${word}-${n} $((6*7))`, output: `${word}-${n} 42`, pattern: `echo ${word}-${n}*` });

/** Generous non-target budgets; short target budgets only where the scenario measures them. */
const TIMEOUTS = Object.freeze({
  s3: { councillor_ms: 90_000, optional_councillor_ms: 90_000, aggregator_ms: 60_000 },
  // S4 budget option B (user-approved 2026-10-19): the councillor budget covers the hosts'
  // DEFAULT provider-retry worst case (V2 ~101 s incl. jitter; V1 ~78 s -- its 30 s cap is
  // skipped when response headers exist), so the 500 / partial-error councillors end as
  // non-timeout failures. The plugin's derived hard cap (councillor + aggregator + 30 s) never
  // clips; the cell deadlines are cells.mjs CELL_DEADLINES.s4 (240 s driver / 270 s controller).
  s4: { councillor_ms: 150_000, aggregator_ms: 60_000 },
  s5: { councillor_ms: 20_000, aggregator_ms: 60_000 },
  s6: { councillor_ms: 60_000, aggregator_ms: 20_000 },
  s7: { councillor_ms: 90_000, aggregator_ms: 60_000 },
  s8: { councillor_ms: 60_000, aggregator_ms: 60_000 },
  s9: { councillor_ms: 60_000, aggregator_ms: 60_000 },
  s10: { councillor_ms: 60_000, aggregator_ms: 60_000 },
  s11: { councillor_ms: 60_000, aggregator_ms: 60_000 },
  s12: { councillor_ms: 90_000, aggregator_ms: 60_000 },
  s13: { councillor_ms: 90_000, aggregator_ms: 60_000 },
  "obs-ask": { councillor_ms: 20_000, aggregator_ms: 60_000 },
});

const REVIEWERS3 = ["reviewer-a", "reviewer-b", "reviewer-c"];

/** Base fixture: one council with `reviewers` (models) and the aggregator; scripts supplied per scenario. */
function base(scenario, n, { reviewers = REVIEWERS3, optional = [], quorum, extraCouncil = {}, timeouts = TIMEOUTS[scenario] } = {}) {
  return {
    scenario,
    nonce: n,
    parentModel: "parent",
    council: {
      models: [...reviewers.map((modelID) => ref(modelID)), ...optional.map((modelID) => ref(modelID, { optional: true }))],
      aggregator_model: ref("aggregator"),
      ...(quorum === undefined ? {} : { quorum }),
      timeouts,
      ...extraCouncil,
    },
    timeouts,
    optionalModels: optional,
  };
}

/** Exact strings a classified call may equal (`textIs`). */
const exactTexts = (timeouts) => ({ cancelled: COUNCIL_TEXT.cancelled, aggregatorTimeout: `${COUNCIL_TEXT.failedPrefix}${timeoutLabel(COUNCIL_TEXT.aggregatorLabel, timeouts.aggregator_ms)}`, v1Aborted: "Tool execution aborted" });

/**
 * `childCounts`: { <role>: { total, optional } } -- strict per-parent child cardinality (the
 * plan's "strict cardinality"); `optional` counts children running an optional council model.
 */
function finish(fx, { models, expected, nonces = [], outputMarkers = [], providerMarkers = [], childCounts = { parent: { total: 4, optional: 0 } }, ...rest }) {
  const resultMarkers = expected.resultMarkers ?? [];
  return {
    ...fx,
    ...rest,
    models,
    providerNonces: [...new Set([...nonces, ...resultMarkers])],
    providerMarkers,
    outputMarkers: [...new Set([...outputMarkers, ...resultMarkers, COUNCIL_TEXT.v2AskDenied, COUNCIL_TEXT.cancelled])],
    expected: { exactTexts: exactTexts(fx.timeouts), timeouts: fx.timeouts, childCounts, optionalModels: fx.optionalModels, ...expected },
  };
}

const FIXTURES = {
  s3(n) {
    const fx = base("s3", n, { optional: ["reviewer-o"], quorum: 2 });
    const barrier = { a: `mA-${n}`, b: `mB-${n}`, c: `mC-${n}`, o: `mO-${n}` };
    const marker = { a: reviewerMarker(1, n), b: reviewerMarker(2, n), c: reviewerMarker(3, n), o: `REVIEW-O-${n}` };
    return finish(fx, {
      models: {
        parent: parentSteps(n),
        "reviewer-a": [hold(barrier.a, text(marker.a))],
        "reviewer-b": [hold(barrier.b, text(marker.b))],
        "reviewer-c": [hold(barrier.c, text(marker.c))],
        "reviewer-o": [hold(barrier.o, text(marker.o))],
        aggregator: [text(aggregateMarker(n))],
      },
      nonces: [n, ...Object.values(marker)],
      childCounts: { parent: { total: 5, optional: 1 } },
      expected: { token: n, barrier, marker, models: { a: "reviewer-a", b: "reviewer-b", c: "reviewer-c", o: "reviewer-o" }, aggregator: { modelID: "aggregator", marker: aggregateMarker(n) }, resultMarkers: [aggregateMarker(n)] },
    });
  },

  s4(n) {
    const reviewers = ["reviewer-1", "reviewer-2", "reviewer-3", "reviewer-4", "reviewer-5"];
    const fx = base("s4", n, { reviewers });
    const partial = `PARTIAL-${n}`;
    const marker = { 4: reviewerMarker(4, n), 5: reviewerMarker(5, n) };
    return finish(fx, {
      models: {
        parent: parentSteps(n),
        "reviewer-1": [{ type: "status", status: 500 }],
        "reviewer-2": [{ type: "empty" }],
        // Radagast M5: repeats across V2 continuations and V1 retries (never script-exhausted).
        "reviewer-3": [{ type: "partial-error", text: partial, barrier: `partial-${n}`, repeat: true }],
        "reviewer-4": [text(marker[4])],
        "reviewer-5": [text(marker[5])],
        aggregator: [text(aggregateMarker(n))],
      },
      nonces: [n, partial, ...Object.values(marker)],
      childCounts: { parent: { total: 6, optional: 0 } },
      expected: { token: n, partial, partialBarrier: `partial-${n}`, marker, models: reviewers, aggregator: { modelID: "aggregator", marker: aggregateMarker(n) }, resultMarkers: [aggregateMarker(n)] },
    });
  },

  s5(n) {
    const fx = base("s5", n);
    const marker = { a: reviewerMarker(1, n), b: reviewerMarker(2, n) };
    return finish(fx, {
      models: { parent: parentSteps(n), "reviewer-a": [text(marker.a)], "reviewer-b": [text(marker.b)], "reviewer-c": [hold(`held-${n}`, text(reviewerMarker(3, n)))], aggregator: [text(aggregateMarker(n))] },
      nonces: [n, ...Object.values(marker)],
      expected: { token: n, target: "reviewer-c", barrier: `held-${n}`, marker, aggregator: { modelID: "aggregator", marker: aggregateMarker(n) }, resultMarkers: [aggregateMarker(n)] },
    });
  },

  s6(n) {
    const fx = base("s6", n);
    return finish(fx, {
      models: { parent: parentSteps(n), "reviewer-a": [text(reviewerMarker(1, n))], "reviewer-b": [text(reviewerMarker(2, n))], "reviewer-c": [text(reviewerMarker(3, n))], aggregator: [hold(`held-${n}`, text(aggregateMarker(n)))] },
      nonces: [n, reviewerMarker(1, n), reviewerMarker(2, n), reviewerMarker(3, n)],
      expected: { token: n, target: "aggregator", barrier: `held-${n}`, aggregator: { modelID: "aggregator", marker: aggregateMarker(n) }, resultMarkers: [aggregateMarker(n)] },
    });
  },

  s7(n) {
    const fx = base("s7", n);
    return finish(fx, {
      models: { parent: parentSteps(n), ...Object.fromEntries(REVIEWERS3.map((model, index) => [model, [hold(`held-${index + 1}-${n}`, text(reviewerMarker(index + 1, n)))]])), aggregator: [text(aggregateMarker(n))] },
      nonces: [n],
      childCounts: { parent: { total: 3, optional: 0 } },
      expected: { token: n, barriers: REVIEWERS3.map((_, index) => `held-${index + 1}-${n}`), aggregator: { modelID: "aggregator", marker: aggregateMarker(n) }, resultMarkers: [aggregateMarker(n)] },
    });
  },

  s8(n, { family }) {
    const host = hostAdapter(family);
    const fx = base("s8", n);
    const control = `K${n}`;
    const ask = command("ASK", n);
    const deny = command("DENY", n);
    const sibling = command("SIB", n);
    const parentDeny = command("PAR", n);
    const sibling2 = command("SIBTWO", n);
    const shell = (cmd) => ({ type: "tool_call", ...host.toolCall("shell", cmd.command) });
    const reviewerC = family === "v2" ? [shell(parentDeny), shell(sibling2), text(reviewerMarker(3, n))] : [text(reviewerMarker(3, n))];
    return finish(fx, {
      models: {
        // The control token is matched first (it contains the council nonce).
        parent: { byNonce: { [control]: [shell(ask), text(`control-done-${n}`)], [n]: parentSteps(n) } },
        "reviewer-a": [shell(ask), text(reviewerMarker(1, n))],
        "reviewer-b": [shell(deny), shell(sibling), text(reviewerMarker(2, n))],
        "reviewer-c": reviewerC,
        aggregator: [text(aggregateMarker(n))],
      },
      permissionRules: [
        { action: "shell", resource: ask.pattern, effect: "ask" },
        { action: "shell", resource: deny.pattern, effect: "deny" },
      ],
      sessionPermissions: family === "v2" ? [{ action: "shell", resource: parentDeny.pattern, effect: "deny" }] : null,
      nonces: [n, control],
      childCounts: { control: { total: 0, optional: 0 }, parent: { total: 4, optional: 0 } },
      outputMarkers: [ask.output, deny.output, sibling.output, parentDeny.output, sibling2.output],
      expected: {
        token: n,
        controlToken: control,
        shellName: host.toolCall("shell", "x").name,
        commands: { ask, deny, sibling, parentDeny, sibling2 },
        askPattern: ask.pattern,
        parentDenyRule: { action: "shell", resource: parentDeny.pattern, effect: "deny" },
        stripWarning: COUNCIL_TEXT.workspaceAskStripped("bash", ask.pattern),
        aggregator: { modelID: "aggregator", marker: aggregateMarker(n) },
        resultMarkers: [aggregateMarker(n)],
      },
    });
  },

  s9(n) {
    const fx = base("s9", n);
    return finish(fx, {
      models: { parent: parentSteps(n), "reviewer-a": [{ type: "tool_call", name: "council_review", args: { prompt: `nested-${n}` } }, text(reviewerMarker(1, n))], "reviewer-b": [text(reviewerMarker(2, n))], "reviewer-c": [text(reviewerMarker(3, n))], aggregator: [text(aggregateMarker(n))] },
      nonces: [n],
      expected: { token: n, recursing: "reviewer-a", aggregator: { modelID: "aggregator", marker: aggregateMarker(n) }, resultMarkers: [aggregateMarker(n)] },
    });
  },

  s10(n, { family }) {
    const host = hostAdapter(family);
    const fx = base("s10", n, { extraCouncil: { reviewer_permission: { bash: "deny" } } });
    const cmd = command("RTEN", n);
    return finish(fx, {
      models: { parent: parentSteps(n), "reviewer-a": [{ type: "tool_call", ...host.toolCall("shell", cmd.command) }, text(reviewerMarker(1, n))], "reviewer-b": [text(reviewerMarker(2, n))], "reviewer-c": [text(reviewerMarker(3, n))], aggregator: [text(aggregateMarker(n))] },
      nonces: [n],
      outputMarkers: [cmd.output],
      expected: { token: n, shellName: host.toolCall("shell", "x").name, output: cmd.output, actor: "reviewer-a", aggregator: { modelID: "aggregator", marker: aggregateMarker(n) }, resultMarkers: [aggregateMarker(n)] },
    });
  },

  s11(n, { family, project, hostVersion }) {
    const host = hostAdapter(family);
    // S11 diagnostic amendment (V1 only): the agent file makes the project's `.opencode` a V1
    // config dir, which V1 would try to install @opencode-ai/plugin into (no network in the
    // cell). Seed package-stage's config-install skip-marker there first, naming the HOST version.
    const configMarker = family === "v1" ? v1ConfigInstallMarker(".opencode", hostVersion).map((entry) => (entry.type === "dir" ? { path: entry.rel, type: "dir" } : { path: entry.rel, content: entry.data.toString("utf8") })) : [];
    const name = `rh-reviewer-${n.slice(0, 12).toLowerCase()}`;
    const systemMarker = `CUSTOM-SYS-${n}`;
    const denyPath = `${project}/custom-deny-${n}.txt`;
    const okPath = `${project}/custom-ok-${n}.txt`;
    const denyContent = `DENYCONTENT-${n}`;
    const okContent = `OKCONTENT-${n}`;
    const fx = base("s11", n, { extraCouncil: { reviewer: name } });
    const read = (path) => ({ type: "tool_call", ...host.toolCall("read", path) });
    // Radagast M3: rule resources are host-relative ('/'-normalized) -- V2 relative to
    // location.directory (= project), V1 relative to instance.worktree (the V1 driver asks the
    // host and re-renders if it is not the project); the read tool input stays ABSOLUTE.
    const renderAgent = (denyPattern) => host.agentFile({ name, description: "real-host custom reviewer", prompt: `You are a code reviewer. ${systemMarker}`, permission: { read: { "*": "allow", [denyPattern]: "deny" } } });
    const agent = renderAgent(`custom-deny-${n}.txt`);
    return finish(fx, {
      models: { parent: parentSteps(n), "reviewer-a": [read(denyPath), read(okPath), text(reviewerMarker(1, n))], "reviewer-b": [text(reviewerMarker(2, n))], "reviewer-c": [text(reviewerMarker(3, n))], aggregator: [text(aggregateMarker(n))] },
      projectFiles: [...configMarker, agent, { path: `custom-deny-${n}.txt`, content: `${denyContent}\n` }, { path: `custom-ok-${n}.txt`, content: `${okContent}\n` }],
      renderAgent,
      nonces: [n, denyContent, okContent],
      providerMarkers: [systemMarker],
      outputMarkers: [denyContent, okContent],
      expected: { token: n, agentName: name, systemMarker, denyContent, okContent, denyPath, denyPattern: `custom-deny-${n}.txt`, actor: "reviewer-a", aggregator: { modelID: "aggregator", marker: aggregateMarker(n) }, resultMarkers: [aggregateMarker(n)] },
    });
  },

  s12(n, { family }) {
    const host = hostAdapter(family);
    const fx = base("s12", n);
    const tokens = { a: `A${n}`, b: `B${n}`, u: `U${n}` };
    const u = command("UASK", n);
    const marker = (index, token) => reviewerMarker(index, token);
    const reviewer = (index) => ({ byNonce: { [tokens.a]: [hold(`A-${index}-${n}`, text(marker(index, tokens.a)))], [tokens.b]: [hold(`B-${index}-${n}`, text(marker(index, tokens.b)))] } });
    return finish(fx, {
      models: {
        parent: { byNonce: { [tokens.u]: [{ type: "tool_call", ...host.toolCall("shell", u.command) }, text(`u-done-${n}`)], [tokens.a]: parentSteps(tokens.a), [tokens.b]: parentSteps(tokens.b) } },
        "reviewer-a": reviewer(1),
        "reviewer-b": reviewer(2),
        "reviewer-c": reviewer(3),
        aggregator: { byNonce: { [tokens.a]: [text(aggregateMarker(tokens.a))], [tokens.b]: [text(aggregateMarker(tokens.b))] } },
      },
      permissionRules: [{ action: "shell", resource: u.pattern, effect: "ask" }],
      childCounts: { parentA: { total: 3, optional: 0 }, parentB: { total: 4, optional: 0 }, control: { total: 0, optional: 0 } },
      nonces: [...Object.values(tokens), ...[1, 2, 3].flatMap((index) => [marker(index, tokens.a), marker(index, tokens.b)])],
      outputMarkers: [u.output, aggregateMarker(tokens.a), aggregateMarker(tokens.b)],
      expected: {
        tokens,
        barriers: { a: [1, 2, 3].map((index) => `A-${index}-${n}`), b: [1, 2, 3].map((index) => `B-${index}-${n}`) },
        markers: { a: [1, 2, 3].map((index) => marker(index, tokens.a)), b: [1, 2, 3].map((index) => marker(index, tokens.b)) },
        aggregate: { a: aggregateMarker(tokens.a), b: aggregateMarker(tokens.b) },
        uOutput: u.output,
        aggregator: { modelID: "aggregator", marker: aggregateMarker(tokens.b) },
        resultMarkers: [aggregateMarker(tokens.a), aggregateMarker(tokens.b)],
      },
    });
  },

  s13(n, { family }) {
    const fx = base("s13", n);
    const fresh = `F${n}`;
    const reviewer = (index) => ({ byNonce: { [fresh]: [text(reviewerMarker(index, fresh))], [n]: [hold(`held-${index}-${n}`, text(reviewerMarker(index, n)))] } });
    return finish(fx, {
      models: {
        // The fresh token is matched first (it contains the original nonce).
        parent: { byNonce: { [fresh]: parentSteps(fresh), [n]: parentSteps(n) } },
        "reviewer-a": reviewer(1),
        "reviewer-b": reviewer(2),
        "reviewer-c": reviewer(3),
        aggregator: { byNonce: { [fresh]: [text(aggregateMarker(fresh))], [n]: [text(aggregateMarker(n))] } },
      },
      nonces: [n, fresh],
      // V1 dispose tears the original council down before its aggregator (3); V2 reload continues (4).
      childCounts: { parent: { total: family === "v1" ? 3 : 4, optional: 0 }, fresh: { total: 4, optional: 0 } },
      expected: { token: n, freshToken: fresh, barriers: [1, 2, 3].map((index) => `held-${index}-${n}`), aggregate: { original: aggregateMarker(n), fresh: aggregateMarker(fresh) }, aggregator: { modelID: "aggregator", marker: aggregateMarker(n) }, resultMarkers: [aggregateMarker(n), aggregateMarker(fresh)] },
    });
  },

  "obs-ask"(n, { family }) {
    if (family !== "v1") throw new Error("the observational non-bash-ask cell is V1-only");
    const host = hostAdapter(family);
    const fx = base("obs-ask", n);
    return finish(fx, {
      models: { parent: parentSteps(n), "reviewer-a": [{ type: "tool_call", ...host.toolCall("webfetch", `http://127.0.0.1:9/obs-${n}`) }, text(reviewerMarker(1, n))], "reviewer-b": [text(reviewerMarker(2, n))], "reviewer-c": [text(reviewerMarker(3, n))], aggregator: [text(aggregateMarker(n))] },
      permissionRules: [{ action: "webfetch", resource: "*", effect: "ask" }],
      nonces: [n],
      expected: { token: n, actor: "reviewer-a", aggregator: { modelID: "aggregator", marker: aggregateMarker(n) }, resultMarkers: [aggregateMarker(n)] },
    });
  },
};

/** P1b fixture for `scenario` (`family` and `project` are needed by S8 / S10 / S11 / S12 / obs-ask; `hostVersion` by V1 S11). */
export function p1bFixture(scenario, { nonce, family = "v2", project = "/scratch/project", hostVersion = null }) {
  const build = FIXTURES[scenario];
  if (!build) throw new Error(`no P1b fixture for scenario ${scenario}`);
  return build(nonce, { family, project, hostVersion });
}

// ---------------------------------------------------------------------------
// Evaluator helpers.

const childrenOf = (ev, parentID) => ev.children.filter((child) => child.parentID === parentID);
/** The single child of `parentID` running `modelID` (null unless exactly one). */
function childFor(ev, parentID, modelID, agent = null) {
  const matches = childrenOf(ev, parentID).filter((child) => child.model?.modelID === modelID && (agent === null || child.agent === agent));
  return matches.length === 1 ? matches[0] : null;
}
const aggregatorChildOf = (ev, parentID) => {
  const matches = childrenOf(ev, parentID).filter((child) => child.agent === AGGREGATOR_AGENT);
  return matches.length === 1 ? matches[0] : null;
};
/** The aggregator prompt structure the plugin sent (last aggregator request carrying one). */
function aggregatorView(ev, parentID) {
  const child = aggregatorChildOf(ev, parentID);
  const views = child ? requestsOf(ev, child.id).filter((entry) => entry.aggregator) : [];
  return views.length > 0 ? views.at(-1).aggregator : null;
}
const sorted = (list) => [...list].sort();
const sameSet = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** Host interruption / abort evidence for a session (V2 execution.interrupted; V1 MessageAbortedError, UNVERIFIED v1.abortEvidence). */
export function interruptionEvidence(ev, sessionID) {
  if (ev.family === "v2") return ev.finals?.[sessionID] === "interrupted" ? "execution.interrupted" : null;
  if ((ev.sessionErrors?.[sessionID] ?? []).includes("MessageAbortedError")) return "session.error:MessageAbortedError";
  if (ev.persistedErrors?.[sessionID] === "MessageAbortedError") return "persisted:MessageAbortedError";
  return null;
}

/**
 * Claim (b), held execution stopped: a request of `sessionID` was held by the provider, the
 * host disconnected it while its barrier was still closed (released false, disconnected true,
 * never released), AND the host recorded an interruption / abort for that session.
 */
export function heldStoppedProblems(ev, sessionID) {
  if (!sessionID) return ["no such session"];
  const held = requestsOf(ev, sessionID).filter((entry) => entry.outcome === "hold" || entry.outcome === "partial-error");
  const problems = [];
  if (held.length === 0) problems.push(`no held provider request for ${sessionID}`);
  else {
    if (held.some((entry) => entry.released === true)) problems.push(`a held request of ${sessionID} was released by its barrier`);
    if (!held.some((entry) => entry.disconnected === true && entry.released === false)) problems.push(`no held request of ${sessionID} was disconnected by the host while held`);
  }
  if (interruptionEvidence(ev, sessionID) === null) problems.push(`no host interruption/abort evidence for ${sessionID}`);
  return problems;
}

/** Strict: exactly one completed council_review call in `parentID`'s durable record containing `marker`. */
export function councilResultProblems(ev, parentID, marker) {
  const calls = ev.parentTools?.[parentID];
  if (!Array.isArray(calls)) return [`council_review calls of ${parentID} were not read`];
  if (calls.length !== 1) return [`${calls.length} council_review calls in ${parentID} (expected exactly 1)`];
  const [call] = calls;
  if (call.status !== "completed") return [`council_review call ${call.callID} status ${call.status}${call.errorClass ? ` (${call.errorClass})` : ""}`];
  if (!(call.markers ?? []).includes(marker)) return [`aggregator marker ${marker} absent from ${parentID}'s council_review result`];
  return [];
}

/** The provider tool-call id the parent's first (council_review) step produced. */
const providerCallId = (ev, sessionID, step = 0) => {
  const entries = requestsOf(ev, sessionID).filter((entry) => entry.step === step && entry.toolCallIds?.length > 0);
  return entries.length > 0 ? entries[0].toolCallIds[0] : null;
};

/**
 * S7 two-form predicate (also S12 council A, S13 V1). V1: exactly one council_review part with
 * the provider's call id, terminal as EITHER completed exactly "Council review cancelled." OR
 * error exactly "Tool execution aborted" with metadata.interrupted; its assistant message
 * completed; parent idle. V2: parent execution interrupted + exactly one settled call (same id).
 */
export function cancelledParentProblems(ev, parentID, { durableAfterDispose = false } = {}) {
  const calls = ev.parentTools?.[parentID];
  if (!Array.isArray(calls) || calls.length !== 1) return [`${Array.isArray(calls) ? calls.length : "unread"} council_review calls in ${parentID} (expected exactly 1)`];
  const [call] = calls;
  const problems = [];
  const expectedId = providerCallId(ev, parentID);
  if (expectedId === null || call.callID !== expectedId) problems.push(`council_review call id ${call.callID} != provider call id ${expectedId}`);
  if (ev.family === "v1") {
    const completedForm = call.status === "completed" && call.textIs === "cancelled";
    const errorForm = call.status === "error" && call.textIs === "v1Aborted" && call.interrupted === true;
    if (!completedForm && !errorForm) problems.push(`council_review terminal is neither completed "${COUNCIL_TEXT.cancelled}" nor error "Tool execution aborted" + interrupted (status ${call.status}, text ${call.textIs}, interrupted ${call.interrupted})`);
    if (typeof call.messageCompleted !== "number") problems.push("the parent assistant message has no time.completed");
    // Radagast M10: across a V1 dispose the terminal SSE may not be retained; the durable
    // completed message (checked above) + the dispose event then settle the parent.
    if (ev.finals?.[parentID] !== "idle" && !(durableAfterDispose && ev.marks?.disposedEvent === true)) problems.push("no parent idle event");
  } else {
    if (ev.finals?.[parentID] !== "interrupted") problems.push(`parent execution outcome ${ev.finals?.[parentID] ?? "none"} (expected interrupted)`);
    if (call.status !== "completed" && call.status !== "error") problems.push(`council_review call not settled (status ${call.status})`);
  }
  return problems;
}

const pre = (ev, name, id) => check(id, ev.preconditions?.[name]?.met === true, ev.preconditions?.[name]?.detail ?? `precondition ${name} not recorded`, { precondition: true });
const problemsCheck = (id, problems) => check(id, problems.length === 0, problems.join("; "));
const resultCheck = (ev, id, parentID, marker) => problemsCheck(id, councilResultProblems(ev, parentID, marker));
/**
 * Plan "Global evidence rules": every child is joined to host session metadata -- listed under
 * its parent AND exactly one host session.created naming that parent (missing / duplicate /
 * conflicting -> FAIL); no session.created under a harness session that is not listed; and
 * strict per-parent cardinality (total and optional children) from the fixture.
 */
export function childrenJoinedProblems(ev) {
  const problems = [];
  const counts = ev.expected?.childCounts ?? {};
  const optionalModels = ev.expected?.optionalModels ?? [];
  const listed = new Set(ev.children.map((child) => child.id));
  // Re-audit round 2: a child id listed twice is a host-metadata conflict, and only DISTINCT ids count.
  const seen = new Set();
  for (const child of ev.children) {
    if (seen.has(child.id)) problems.push(`duplicate listed child ${child.id}`);
    seen.add(child.id);
  }
  for (const [role, want] of Object.entries(counts)) {
    const id = ev.roles?.[role] ?? null;
    if (id === null) {
      problems.push(`no ${role} session`);
      continue;
    }
    const kids = [...new Map(childrenOf(ev, id).map((child) => [child.id, child])).values()];
    const optional = kids.filter((child) => optionalModels.includes(child.model?.modelID)).length;
    if (kids.length !== want.total || optional !== want.optional) problems.push(`${role} has ${kids.length} children (${optional} optional); expected ${want.total} (${want.optional} optional)`);
    for (const event of (ev.created ?? []).filter((created) => created.parentID === id)) if (!listed.has(event.sessionID)) problems.push(`session.created ${event.sessionID} under ${role} is not a listed child`);
  }
  for (const child of ev.children) {
    const created = (ev.created ?? []).filter((event) => event.sessionID === child.id);
    if (created.length !== 1 || created[0].parentID !== child.parentID) problems.push(`child ${child.id}: ${created.length} session.created event(s) ${JSON.stringify(created.map((event) => event.parentID))} (expected exactly one naming ${child.parentID})`);
  }
  return problems;
}

const common = (ev) => [attribution(ev, { joinChildren: true }), auxiliarySuppressed(ev), problemsCheck("children-joined", childrenJoinedProblems(ev))];
/** Classified tool calls of `sessionID` whose call id is the provider's id for `step` (strict: exactly one). */
function callAtStep(ev, sessionID, step) {
  const id = providerCallId(ev, sessionID, step);
  const calls = (ev.childTools?.[sessionID] ?? []).filter((call) => call.callID === id);
  return id !== null && calls.length === 1 ? calls[0] : null;
}
/**
 * The FULL section set is exact: non-optional sections are exactly `expected` [{ label, marker }],
 * each with only its own reviewer marker, and the optional sections' labels are exactly
 * `expectedOptional` (none unless the fixture configures optional councillors).
 */
function sectionProblems(view, expected, allMarkers, expectedOptional = []) {
  if (!view) return ["no aggregator prompt structure recorded"];
  const required = view.sections.filter((section) => !section.optional);
  const problems = [];
  const optional = view.sections.filter((section) => section.optional).map((section) => section.label);
  if (!sameSet(optional, expectedOptional) || optional.length !== expectedOptional.length) problems.push(`optional success sections ${JSON.stringify(optional)} != ${JSON.stringify(expectedOptional)}`);
  if (!sameSet(required.map((section) => section.label), expected.map((entry) => entry.label)) || required.length !== expected.length) problems.push(`required success sections ${JSON.stringify(required.map((section) => section.label))} != ${JSON.stringify(expected.map((entry) => entry.label))}`);
  for (const entry of expected) {
    const section = required.find((candidate) => candidate.label === entry.label);
    const reviewerMarkers = (section?.markers ?? []).filter((marker) => allMarkers.includes(marker));
    if (!section || JSON.stringify(reviewerMarkers) !== JSON.stringify([entry.marker])) problems.push(`section ${entry.label} markers ${JSON.stringify(section?.markers ?? null)} (expected only ${entry.marker})`);
  }
  return problems;
}
const shellAdvertised = (ev, sessionID, shellName) => {
  const requests = requestsOf(ev, sessionID);
  return requests.length > 0 && requests.every((entry) => entry.tools.includes(shellName));
};
const anyToolResultMarker = (ev, marker) => modelEntries(ev).some((entry) => (entry.toolResults ?? []).some((result) => result.markers.includes(marker)));

// ---------------------------------------------------------------------------
// Evaluators.

function evaluateS3(ev) {
  const { expected: x } = ev;
  const P = ev.parentSessionID;
  const view = aggregatorView(ev, P);
  const child = (key) => childFor(ev, P, x.models[key], REVIEWER_AGENT);
  const all = Object.values(x.marker);
  const checks = [pre(ev, "allHeld", "s3.precondition-all-held")];
  checks.push(problemsCheck("s3.required-sections", sectionProblems(view, [{ label: label(x.models.a), marker: x.marker.a }, { label: label(x.models.b), marker: x.marker.b }], all, [label(x.models.o)])));
  const optional = view ? view.sections.filter((section) => section.optional) : [];
  const optionalProblems = [];
  if (!view) optionalProblems.push("no aggregator prompt structure recorded");
  else {
    if (optional.length !== 1 || optional[0].label !== label(x.models.o) || JSON.stringify(optional[0].markers.filter((marker) => all.includes(marker))) !== JSON.stringify([x.marker.o])) optionalProblems.push(`optional sections ${JSON.stringify(optional)}`);
    if (!view.responded.includes(`${label(x.models.o)} (optional)`) || view.responded.includes(label(x.models.o))) optionalProblems.push(`Responded ${JSON.stringify(view.responded)} lacks exactly "${label(x.models.o)} (optional)"`);
    if (view.sections.some((section) => !section.optional && section.markers.includes(x.marker.o))) optionalProblems.push("the optional marker appears in a required section");
  }
  checks.push(problemsCheck("s3.optional-section", optionalProblems));
  const abortedProblems = [];
  const c = label(x.models.c);
  if (!view) abortedProblems.push("no aggregator prompt structure recorded");
  else {
    if (JSON.stringify(view.abortedSection) !== JSON.stringify([c])) abortedProblems.push(`## Aborted (quorum reached) lists ${JSON.stringify(view.abortedSection)}`);
    if (JSON.stringify(view.abortedParticipation) !== JSON.stringify([c])) abortedProblems.push(`Aborted (quorum reached): lists ${JSON.stringify(view.abortedParticipation)}`);
    if (view.responded.some((entry) => entry.startsWith(c)) || view.failed.some((entry) => entry.label.startsWith(c)) || view.sections.some((section) => section.label === c)) abortedProblems.push(`${c} also listed as responded / failed / a section`);
  }
  checks.push(problemsCheck("s3.aborted-listed", abortedProblems));
  checks.push(problemsCheck("s3.laggard-stopped", heldStoppedProblems(ev, child("c")?.id)));
  const b = child("b");
  const aggregator = aggregatorChildOf(ev, P);
  const bDone = b ? requestsOf(ev, b.id).filter((entry) => typeof entry.completedTick === "number").map((entry) => entry.completedTick) : [];
  const aggReceived = aggregator ? requestsOf(ev, aggregator.id).map((entry) => entry.receivedTick) : [];
  checks.push(check("s3.aggregator-after-b", bDone.length > 0 && aggReceived.length > 0 && Math.min(...aggReceived) > Math.max(...bDone), `B responses completed at ticks ${JSON.stringify(bDone)}; aggregator requests received at ${JSON.stringify(aggReceived)}`));
  checks.push(resultCheck(ev, "s3.result-marker", P, x.aggregator.marker));
  return [...checks, ...common(ev)];
}

function evaluateS4(ev) {
  const { expected: x } = ev;
  const P = ev.parentSessionID;
  const view = aggregatorView(ev, P);
  const child = (model) => childFor(ev, P, model, REVIEWER_AGENT);
  const checks = [pre(ev, "partialSeen", "s4.precondition-partial-seen")];
  checks.push(problemsCheck("s4.successes", sectionProblems(view, [{ label: label("reviewer-4"), marker: x.marker[4] }, { label: label("reviewer-5"), marker: x.marker[5] }], [...Object.values(x.marker), x.partial])));
  const failedProblems = [];
  if (!view) failedProblems.push("no aggregator prompt structure recorded");
  else {
    const labels = view.failed.map((entry) => entry.label);
    if (!sameSet(labels, ["reviewer-1", "reviewer-2", "reviewer-3"].map(label)) || labels.length !== 3) failedProblems.push(`failed councillors ${JSON.stringify(labels)}`);
    const timeouts = view.failed.filter((entry) => entry.error?.kind === "timeout" || entry.error?.kind === "none");
    if (timeouts.length > 0) failedProblems.push(`timeout / unlabelled failures: ${JSON.stringify(timeouts)}`);
  }
  checks.push(problemsCheck("s4.failures-not-timeouts", failedProblems));
  // MA1: the empty-response councillor really ran (child + attributed request) and failed as EMPTY,
  // not as a create / admission failure.
  const r2 = child("reviewer-2");
  const r2Requests = r2 ? requestsOf(ev, r2.id) : [];
  const r2Failure = view ? view.failed.filter((entry) => entry.label === label("reviewer-2")) : [];
  checks.push(check("s4.empty-response", r2 !== null && r2Requests.length >= 1 && r2Requests.every((entry) => entry.parentSessionID === P) && r2Failure.length === 1 && r2Failure[0].error?.kind === "known" && r2Failure[0].error.prefix === "empty response", `reviewer-2 child ${r2?.id ?? "missing"}, requests ${JSON.stringify(r2Requests.map((entry) => [entry.seq, entry.parentSessionID]))}, failure ${JSON.stringify(r2Failure)}`));
  checks.push(check("s4.partial-absent", view !== null && !view.sections.some((section) => section.markers.includes(x.partial)), "the partial nonce appears in a success section"));
  const r3 = child("reviewer-3");
  const r3Failure = !r3 ? null : ev.family === "v2" ? (ev.finals?.[r3.id] === "failed" ? "execution.failed" : null) : [...(ev.sessionErrors?.[r3.id] ?? []), ev.persistedErrors?.[r3.id]].find((name) => typeof name === "string" && name !== "MessageAbortedError") ?? null;
  checks.push(check("s4.partial-host-failure", r3Failure !== null, `no host terminal failure for reviewer-3 (${r3?.id ?? "no child"}): finals ${JSON.stringify(ev.finals?.[r3?.id] ?? null)}, errors ${JSON.stringify(ev.sessionErrors?.[r3?.id] ?? [])}`));
  const r1 = child("reviewer-1");
  const r1Requests = r1 ? requestsOf(ev, r1.id) : [];
  const r3Requests = r3 ? requestsOf(ev, r3.id) : [];
  // Transparent retries (identical transcript) and continuations (grown transcript) are counted
  // separately; every attempt of both faulting actors is served its fault (none exhausted).
  const attempts = (requests) => ({ retry: requests.filter((entry) => entry.attempt === "retry").length, continuation: requests.filter((entry) => entry.attempt === "continuation").length });
  const r3All = r3 ? ev.ledger.filter((entry) => entry.sessionID === r3.id) : [];
  const r1All = r1 ? ev.ledger.filter((entry) => entry.sessionID === r1.id) : [];
  checks.push(check("s4.retries-accounted", r1Requests.length >= 1 && r1All.length === r1Requests.length && r1Requests.every((entry) => entry.status === 500) && r3Requests.length >= 1 && r3All.length === r3Requests.length && r3Requests.every((entry) => entry.outcome === "partial-error"), `reviewer-1 requests ${JSON.stringify(r1All.map((entry) => [entry.kind, entry.status]))} attempts ${JSON.stringify(attempts(r1Requests))}; reviewer-3 requests ${JSON.stringify(r3All.map((entry) => [entry.kind, entry.outcome]))} attempts ${JSON.stringify(attempts(r3Requests))}`));
  checks.push(resultCheck(ev, "s4.result-marker", P, x.aggregator.marker));
  return [...checks, ...common(ev)];
}

function evaluateS5(ev) {
  const { expected: x } = ev;
  const P = ev.parentSessionID;
  const view = aggregatorView(ev, P);
  const target = label(x.target);
  const want = timeoutLabel(target, x.timeouts.councillor_ms);
  const checks = [pre(ev, "targetHeld", "s5.precondition-held")];
  const failures = view ? view.failed : [];
  checks.push(check("s5.timeout-label", view !== null && failures.length === 1 && failures[0].label === target && failures[0].error?.kind === "timeout" && failures[0].error.text === want, `failures ${JSON.stringify(failures)}; expected exactly ${target}: "${want}"`));
  checks.push(problemsCheck("s5.successes", sectionProblems(view, [{ label: label("reviewer-a"), marker: x.marker.a }, { label: label("reviewer-b"), marker: x.marker.b }], Object.values(x.marker))));
  checks.push(problemsCheck("s5.held-stopped", heldStoppedProblems(ev, childFor(ev, P, x.target, REVIEWER_AGENT)?.id)));
  checks.push(resultCheck(ev, "s5.result-marker", P, x.aggregator.marker));
  return [...checks, ...common(ev)];
}

function evaluateS6(ev) {
  const P = ev.parentSessionID;
  const calls = ev.parentTools?.[P];
  const checks = [pre(ev, "targetHeld", "s6.precondition-held")];
  const want = ev.expected.exactTexts.aggregatorTimeout;
  checks.push(check("s6.timeout-label", Array.isArray(calls) && calls.length === 1 && calls[0].status === "completed" && calls[0].textIs === "aggregatorTimeout", `parent council_review calls ${JSON.stringify(calls ?? null)}; expected exactly one completed with "${want}"`));
  checks.push(problemsCheck("s6.held-stopped", heldStoppedProblems(ev, aggregatorChildOf(ev, P)?.id)));
  return [...checks, ...common(ev)];
}

const cancelActions = (ev) => (ev.actions ?? []).filter((action) => action.kind === "cancel");
function harnessParentOnly(ev, id) {
  const parents = new Set([ev.parentSessionID, ...Object.values(ev.roles ?? {})]);
  const bad = (ev.actions ?? []).filter((action) => (action.kind === "cancel" || action.kind === "dispose") && action.target !== null && !parents.has(action.target));
  return check(id, bad.length === 0, `harness stopped non-parent sessions: ${JSON.stringify(bad)}`);
}

function evaluateS7(ev) {
  const P = ev.parentSessionID;
  const reviewers = childrenOf(ev, P).filter((child) => child.agent === REVIEWER_AGENT);
  const checks = [pre(ev, "allHeld", "s7.precondition-all-held")];
  const cancels = cancelActions(ev);
  checks.push(check("s7.cancel-accepted", cancels.length === 1 && cancels[0].target === P && cancels[0].ok === true, `cancel actions ${JSON.stringify(cancels)}`));
  checks.push(harnessParentOnly(ev, "s7.harness-parent-only"));
  checks.push(problemsCheck("s7.parent-terminal", cancelledParentProblems(ev, P)));
  checks.push(problemsCheck("s7.children-stopped", reviewers.length !== 3 ? [`${reviewers.length} reviewer children (expected 3)`] : reviewers.flatMap((child) => heldStoppedProblems(ev, child.id))));
  const aggregatorRequests = modelEntries(ev).filter((entry) => entry.model === "aggregator");
  checks.push(check("s7.no-aggregator", aggregatorChildOf(ev, P) === null && childrenOf(ev, P).every((child) => child.agent !== AGGREGATOR_AGENT) && aggregatorRequests.length === 0, `aggregator children ${childrenOf(ev, P).filter((child) => child.agent === AGGREGATOR_AGENT).length}, aggregator requests ${aggregatorRequests.length}`));
  return [...checks, ...common(ev)];
}

function evaluateS8(ev) {
  const { expected: x } = ev;
  const P = ev.parentSessionID;
  const U = ev.roles?.control ?? null;
  const askedPermission = ev.family === "v1" ? "bash" : "shell";
  const asked = ev.permissionEvents?.asked ?? [];
  const councilIDs = new Set([P, ...ev.children.map((child) => child.id)]);
  const checks = [];
  const uAsks = asked.filter((event) => event.sessionID === U && event.permission === askedPermission);
  checks.push(check("s8.control-asked", U !== null && uAsks.length >= 1, `control session ${U} asks: ${JSON.stringify(asked.filter((event) => event.sessionID === U))}`));
  const councilAsks = asked.filter((event) => councilIDs.has(event.sessionID));
  checks.push(check("s8.no-council-ask", councilAsks.length === 0, `permission.asked in council sessions: ${JSON.stringify(councilAsks)}`));
  const a = childFor(ev, P, "reviewer-a", REVIEWER_AGENT);
  const askCall = a ? callAtStep(ev, a.id, 0) : null;
  const askProblems = [];
  if (!askCall) askProblems.push("reviewer-a's would-ask call was not found in its durable record");
  else if (ev.family === "v2") {
    if (askCall.errorClass !== "hook-denied") askProblems.push(`would-ask call class ${askCall.errorClass} (status ${askCall.status}); expected the council hook denial`);
    if (askCall.markers.includes(x.commands.ask.output)) askProblems.push("the would-ask command produced output");
    if (!shellAdvertised(ev, a.id, x.shellName)) askProblems.push(`${x.shellName} not advertised to reviewer-a (hidden, not hook-denied)`);
  } else {
    if (askCall.status !== "completed" || !askCall.markers.includes(x.commands.ask.output)) askProblems.push(`stripped ask did not run for real (status ${askCall.status}, markers ${JSON.stringify(askCall.markers)})`);
    if (!(ev.pluginLog?.stripWarnings >= 1)) askProblems.push(`no strip warning "${x.stripWarning}" in the plugin log (${JSON.stringify(ev.pluginLog ?? null)})`);
  }
  checks.push(problemsCheck("s8.would-ask", askProblems));
  const b = childFor(ev, P, "reviewer-b", REVIEWER_AGENT);
  const denyCall = b ? callAtStep(ev, b.id, 0) : null;
  const siblingCall = b ? callAtStep(ev, b.id, 1) : null;
  const denyProblems = [];
  if (!denyCall || denyCall.status !== "error" || denyCall.errorClass !== "static-denied" || denyCall.markers.includes(x.commands.deny.output)) denyProblems.push(`resource deny call: ${JSON.stringify(denyCall)}`);
  if (!siblingCall || siblingCall.status !== "completed" || !siblingCall.markers.includes(x.commands.sibling.output)) denyProblems.push(`allowed sibling call: ${JSON.stringify(siblingCall)}`);
  if (b && !shellAdvertised(ev, b.id, x.shellName)) denyProblems.push(`${x.shellName} not advertised to reviewer-b (a resource-specific deny must not hide the tool)`);
  checks.push(problemsCheck("s8.resource-deny", denyProblems));
  if (ev.family === "v2") {
    const rule = x.parentDenyRule;
    const has = (list) => Array.isArray(list) && list.some((entry) => entry?.action === rule.action && entry?.resource === rule.resource && entry?.effect === rule.effect);
    const parentProblems = [];
    if (ev.parentSession?.read !== true || !has(ev.parentSession?.permissions)) parentProblems.push(`parent session permissions read back: ${JSON.stringify(ev.parentSession ?? null)}`);
    const children = childrenOf(ev, P);
    if (children.length === 0 || !children.every((child) => has(child.permissions))) parentProblems.push(`children without the inherited parent deny: ${children.filter((child) => !has(child.permissions)).map((child) => child.id).join(",")}`);
    const c = childFor(ev, P, "reviewer-c", REVIEWER_AGENT);
    const parDeny = c ? callAtStep(ev, c.id, 0) : null;
    const parSibling = c ? callAtStep(ev, c.id, 1) : null;
    if (!parDeny || parDeny.status !== "error" || parDeny.errorClass !== "static-denied" || parDeny.markers.includes(x.commands.parentDeny.output)) parentProblems.push(`parent-deny call: ${JSON.stringify(parDeny)}`);
    if (!parSibling || parSibling.status !== "completed" || !parSibling.markers.includes(x.commands.sibling2.output)) parentProblems.push(`parent-deny sibling call: ${JSON.stringify(parSibling)}`);
    checks.push(problemsCheck("s8.parent-only-deny", parentProblems));
  }
  checks.push(resultCheck(ev, "s8.result-marker", P, x.aggregator.marker));
  return [...checks, ...common(ev)];
}

function evaluateS9(ev) {
  const P = ev.parentSessionID;
  const a = childFor(ev, P, ev.expected.recursing, REVIEWER_AGENT);
  const call = a ? callAtStep(ev, a.id, 0) : null;
  const refused = call !== null && (ev.family === "v2" ? call.name === "council_review" && call.status === "error" && call.errorClass === "no-such-tool" : call.name === "invalid" && call.invalidTarget === "council_review");
  const checks = [check("s9.dispatch-refused", refused, `attempted council_review call in reviewer-a: ${JSON.stringify(call)}`)];
  const childIDs = new Set(ev.children.map((child) => child.id));
  const createdUnder = (ev.created ?? []).filter((event) => childIDs.has(event.parentID));
  const counts = ev.grandchildren ?? {};
  const listedAll = [...childIDs].every((id) => counts[id] === 0);
  checks.push(check("s9.zero-descendants", childIDs.size > 0 && listedAll && createdUnder.length === 0, `descendant listing ${JSON.stringify(counts)}; created under children ${JSON.stringify(createdUnder)}`));
  return [...checks, ...common(ev)];
}

function evaluateS10(ev) {
  const { expected: x } = ev;
  const P = ev.parentSessionID;
  const a = childFor(ev, P, x.actor, REVIEWER_AGENT);
  const executed = anyToolResultMarker(ev, x.output) || Object.values(ev.childTools ?? {}).some((calls) => calls.some((call) => call.markers.includes(x.output)));
  const checks = [check("s10.not-executed", !executed, `${x.output} appeared in a tool result`)];
  const requests = a ? requestsOf(ev, a.id) : [];
  const hidden = requests.length > 0 && requests.every((entry) => !entry.tools.includes(x.shellName));
  const call = a ? callAtStep(ev, a.id, 0) : null;
  const refused = call !== null && ((call.status === "error" && (call.errorClass === "static-denied" || call.errorClass === "no-such-tool")) || (call.name === "invalid" && call.invalidTarget === x.shellName));
  checks.push(check("s10.hidden-or-refused", hidden || refused, `reviewer-a tools ${JSON.stringify(requests.map((entry) => entry.tools))}; call ${JSON.stringify(call)}`));
  return [...checks, ...common(ev)];
}

function evaluateS11(ev) {
  const { expected: x } = ev;
  const P = ev.parentSessionID;
  const reviewers = childrenOf(ev, P).filter((child) => child.agent !== AGGREGATOR_AGENT);
  // Re-audit round 2 (Should a): when the V1 driver re-rendered the agent, the instance reload is a precondition.
  const reload = ev.preconditions?.agentReloaded ? [pre(ev, "agentReloaded", "s11.precondition-agent-reloaded")] : [];
  const checks = [...reload, check("s11.custom-agent", reviewers.length === 3 && reviewers.every((child) => child.agent === x.agentName), `reviewer children agents ${JSON.stringify(reviewers.map((child) => child.agent))} (expected 3 x ${x.agentName})`)];
  const reviewerRequests = reviewers.flatMap((child) => requestsOf(ev, child.id));
  checks.push(check("s11.system-marker", reviewerRequests.length > 0 && reviewerRequests.every((entry) => entry.systemMarkers.includes(x.systemMarker)), `reviewer requests without ${x.systemMarker}: ${reviewerRequests.filter((entry) => !entry.systemMarkers.includes(x.systemMarker)).map((entry) => entry.seq).join(",")}`));
  const a = childFor(ev, P, x.actor);
  const denied = a ? callAtStep(ev, a.id, 0) : null;
  const sibling = a ? callAtStep(ev, a.id, 1) : null;
  const leaked = anyToolResultMarker(ev, x.denyContent) || modelEntries(ev).some((entry) => entry.nonces.includes(x.denyContent)) || Object.values(ev.childTools ?? {}).some((calls) => calls.some((call) => call.markers.includes(x.denyContent)));
  checks.push(check("s11.denied-read", denied !== null && denied.status === "error" && !leaked, `denied read ${JSON.stringify(denied)}; deny content leaked: ${leaked}`));
  checks.push(check("s11.sibling-read", sibling !== null && sibling.status === "completed" && sibling.markers.includes(x.okContent) && (a ? requestsOf(ev, a.id).some((entry) => (entry.toolResults ?? []).some((result) => result.markers.includes(x.okContent))) : false), `sibling read ${JSON.stringify(sibling)}`));
  return [...checks, ...common(ev)];
}

function evaluateS12(ev) {
  const { expected: x } = ev;
  const A = ev.roles?.parentA ?? null;
  const B = ev.roles?.parentB ?? null;
  const U = ev.roles?.control ?? null;
  const marks = ev.marks ?? {};
  const checks = [pre(ev, "ready", "s12.precondition-ready")];
  const mixed = modelEntries(ev).filter((entry) => entry.nonces.includes(x.tokens.a) && entry.nonces.includes(x.tokens.b));
  const bView = B ? aggregatorView(ev, B) : null;
  const isolation = [];
  if (mixed.length > 0) isolation.push(`requests carrying both councils' nonces: ${mixed.map((entry) => entry.seq).join(",")}`);
  // Only the two councils' REVIEWER markers count (a council token is a substring of its own markers).
  const reviewerMarkers = [...x.markers.a, ...x.markers.b];
  const bSectionMarkers = bView ? bView.sections.flatMap((section) => section.markers.filter((marker) => reviewerMarkers.includes(marker))) : null;
  if (!bView || !sameSet(bSectionMarkers, x.markers.b) || bSectionMarkers.length !== 3) isolation.push(`council B aggregator saw ${JSON.stringify(bSectionMarkers)}`);
  const bCalls = B ? ev.parentTools?.[B] : null;
  if (Array.isArray(bCalls) && bCalls.some((call) => call.markers.includes(x.aggregate.a))) isolation.push("council A's aggregate marker reached council B's result");
  checks.push(problemsCheck("s12.isolation", isolation));
  const aChildren = A ? childrenOf(ev, A).filter((child) => child.agent === REVIEWER_AGENT) : [];
  const aProblems = A ? [...cancelledParentProblems(ev, A), ...(aChildren.length === 3 ? aChildren.flatMap((child) => heldStoppedProblems(ev, child.id)) : [`${aChildren.length} council A reviewer children`])] : ["no council A session"];
  if (A && (aggregatorChildOf(ev, A) !== null || modelEntries(ev).some((entry) => entry.model === "aggregator" && entry.nonces.includes(x.tokens.a)))) aProblems.push("council A reached its aggregator");
  checks.push(problemsCheck("s12.a-cancelled", aProblems));
  checks.push(harnessParentOnly(ev, "s12.harness-parent-only"));
  const bProblems = B ? councilResultProblems(ev, B, x.aggregate.b) : ["no council B session"];
  if (marks.aFinalBeforeBRelease !== true) bProblems.push("council B's barriers were released before council A settled");
  checks.push(problemsCheck("s12.b-completes-after-a", bProblems));
  const uProblems = [];
  const uAsked = (ev.permissionEvents?.asked ?? []).filter((event) => event.sessionID === U);
  if (U === null || uAsked.length !== 1) uProblems.push(`unrelated session asks: ${uAsked.length}`);
  if (marks.uRepliedBeforeHarness === true) uProblems.push("the unrelated ask was replied before the harness replied");
  if (marks.uFinalBeforeReply === true) uProblems.push("the unrelated session settled before the harness replied");
  if (marks.uRequestsBeforeReply !== 1) uProblems.push(`unrelated session provider requests before the reply: ${marks.uRequestsBeforeReply}`);
  if (marks.uReplyAfterBFinal !== true) uProblems.push("the harness reply was not after council B completed (pending window not shown)");
  const reply = (ev.actions ?? []).filter((action) => action.kind === "reply" && action.target === U);
  if (reply.length !== 1 || reply[0].ok !== true) uProblems.push(`harness replies ${JSON.stringify(reply)}`);
  if (U !== null && !requestsOf(ev, U).some((entry) => (entry.toolResults ?? []).some((result) => result.markers.includes(x.uOutput)))) uProblems.push("the unrelated session did not continue with its command output");
  if (U !== null && ev.finals?.[U] === undefined) uProblems.push("the unrelated session did not settle after the reply");
  checks.push(problemsCheck("s12.unrelated-ask-pending", uProblems));
  return [...checks, ...common(ev)];
}

function evaluateS13(ev) {
  const { expected: x } = ev;
  const P = ev.parentSessionID;
  const F = ev.roles?.fresh ?? null;
  const checks = [pre(ev, "allHeld", "s13.precondition-all-held")];
  const children = childrenOf(ev, P);
  if (ev.family === "v2") {
    const reloads = (ev.actions ?? []).filter((action) => action.kind === "reload");
    checks.push(check("s13.reload-accepted", reloads.length === 1 && reloads[0].status === 204, `reload actions ${JSON.stringify(reloads)}`));
    checks.push(check("s13.activation", ev.inventory?.after?.active === true, `post-reload inventory ${JSON.stringify(ev.inventory?.after ?? null)}`));
    // Radagast M7: a post-reload plugin.updated is REQUIRED (no inventory-state fallback).
    checks.push(check("s13.generation", (ev.marks?.pluginUpdatedAfterReload ?? 0) >= 1, `plugin.updated after reload: ${ev.marks?.pluginUpdatedAfterReload ?? 0}`));
    const original = councilResultProblems(ev, P, x.aggregate.original);
    const calls = ev.parentTools?.[P] ?? [];
    if (calls.length === 1 && calls[0].callID !== providerCallId(ev, P)) original.push(`original call id ${calls[0].callID} != provider call id ${providerCallId(ev, P)}`);
    checks.push(problemsCheck("s13.original-completes", original));
    checks.push(check("s13.children-terminal", children.length === 4 && children.every((child) => typeof ev.finals?.[child.id] === "string"), `original children finals ${JSON.stringify(children.map((child) => [child.id, ev.finals?.[child.id] ?? null]))}`));
  } else {
    const disposes = (ev.actions ?? []).filter((action) => action.kind === "dispose");
    checks.push(check("s13.disposed", disposes.length === 1 && disposes[0].ok === true && ev.marks?.disposedEvent === true, `dispose actions ${JSON.stringify(disposes)}; server.instance.disposed observed: ${ev.marks?.disposedEvent ?? false}`));
    checks.push(check("s13.teardown-labeled", ev.marks?.teardown === "instance-dispose", `teardown label ${ev.marks?.teardown ?? null}`));
    checks.push(problemsCheck("s13.parent-terminal", cancelledParentProblems(ev, P, { durableAfterDispose: true })));
    const reviewers = children.filter((child) => child.agent === REVIEWER_AGENT);
    const settled = (id) => (ev.finals?.[id] === "idle" || ev.marks?.disposedEvent === true) && typeof ev.persistedCompleted?.[id] === "number";
    checks.push(check("s13.children-settled", reviewers.length === 3 && reviewers.every((child) => settled(child.id)), `original reviewer children: ${JSON.stringify(reviewers.map((child) => [child.id, ev.finals?.[child.id] ?? null, ev.persistedCompleted?.[child.id] ?? null]))}`));
  }
  checks.push(check("s13.fresh-review", F !== null && councilResultProblems(ev, F, x.aggregate.fresh).length === 0, F === null ? "no fresh review session" : councilResultProblems(ev, F, x.aggregate.fresh).join("; ")));
  return [...checks, ...common(ev)];
}

/**
 * Observational (non-gating): PASS when the observation was collected; the permission outcome is
 * recorded, not judged. Round-3 Must 1: the evidence INTEGRITY checks (attribution joined to the
 * children, children-joined, aux-suppressed) still run; they are named `cell.integrity.*` so the
 * controller classifies a failure as an infrastructure (harness) failure and stops the batch --
 * an observational class never hides corrupt evidence.
 */
function evaluateObsAsk(ev) {
  const P = ev.parentSessionID;
  const integrity = common(ev).map((entry) => ({ ...entry, id: `cell.integrity.${entry.id}` }));
  return [check("obs.collected", typeof ev.finals?.[P] === "string" && ev.marks?.observation !== undefined, "the parent did not settle; no observation"), ...integrity];
}

export const P1B_EVALUATORS = Object.freeze({ s3: evaluateS3, s4: evaluateS4, s5: evaluateS5, s6: evaluateS6, s7: evaluateS7, s8: evaluateS8, s9: evaluateS9, s10: evaluateS10, s11: evaluateS11, s12: evaluateS12, s13: evaluateS13, "obs-ask": evaluateObsAsk });
