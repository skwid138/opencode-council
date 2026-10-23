// Council-only (not copied; the normalizer scenarios/contracts are not used).
// P1a fixtures and evaluators for S1 (load/registration) and S2 (happy path).
// Evaluators are pure functions over collected evidence; every predicate has a
// mutation-style negative test. Strict cardinality everywhere (no .find()).
//
// Evidence (assembled by the cell runner):
//   { scenario, family, parentSessionID, expected,
//     plugin: { entries[] } | null (V2 inventory; V1 has none),
//     agents: string[] | null,
//     children: [{ id, parentID, agent, model: { providerID, modelID }, permissions? }],
//     created: [{ sessionID, parentID }],         // host session.created events
//     ledger: fake-provider ledger entries,
//     parentToolCalls: [{ callID, status, text, error, truncated }], // parent council_review calls (durable record)
//     parentToolPagesExceeded?: boolean,           // V2 message pagination bound hit
//     finals: { [sessionID]: "terminal" },         // claim (a): execution settled
//     parentPermissions?: rule[],                  // V2: parent session permissions read back
//     persistedCompleted?: { [sessionID]: number|null }, // V1: last assistant time.completed
//     observations?: { [candidate | runtime record]: value } } // what each UNVERIFIED host shape looked
//                                                   // like, runtime records of source-verified ones, and
//                                                   // the bounded SSE diagnostics ("sse.events")
import { createHash } from "node:crypto";

import { MAX_DETAIL_BYTES } from "./frame.mjs";
import { PACKAGE_NAME } from "./package-stage.mjs";
import { AGGREGATOR_AGENT, attribution, auxiliarySuppressed, check, count, modelEntries, PROVIDER, requestsOf, REVIEWER_AGENT } from "./scenario-checks.mjs";
import { P1B_EVALUATORS, P1B_SCENARIOS, p1bFixture } from "./scenarios-p1b.mjs";

export { MAX_DETAIL_BYTES };

export const PLUGIN_VERSION = "0.3.0";
export const PLUGIN_SPEC = `${PACKAGE_NAME}@${PLUGIN_VERSION}`;
export { AGGREGATOR_AGENT, REVIEWER_AGENT };

/**
 * V1: the bundled aggregator's tools map (src/aggregator.ts AGGREGATOR_TOOLS) disables every
 * entry, so the only allowed provider-facing tool inventory is EMPTY. Mirrored here because
 * the image harness may only import node: builtins and relative harness files; a unit test
 * pins this mirror to the enabled entries of the real map. Source-verified (research §12):
 * an all-false map omits wire `tools` (no `_noop` for non-github-copilot providers; `invalid`
 * is not advertised).
 */
export const V1_AGGREGATOR_ALLOWED_TOOLS = Object.freeze([]);
/**
 * V2: host-intrinsic tools an aggregator child is still offered under `*` deny. Source-verified
 * (research §12): none -- `tools` is omitted without tool history and `[]` with it; `execute`
 * itself is permission-filtered (no intrinsic escape). Anything offered fails S2.
 */
export const V2_AGGREGATOR_INTRINSIC_TOOLS = Object.freeze([]);
const STAR_DENY = Object.freeze({ action: "*", resource: "*", effect: "deny" });
const FINAL_DENY = Object.freeze({ action: "council_review", resource: "*", effect: "deny" });

/** Bounds for the result-frame evidence object (frame cap 512 KiB; stdout cap 1 MiB). */
export const EVIDENCE_LIMITS = Object.freeze({ maxBytes: 192 * 1024, maxRequests: 512, maxString: 160, minRequestBytes: 32 * 1024 });

/** Fake-provider scripts, council options, and expectations for a cell (`family` / `project` / `hostVersion`: P1b scenarios). */
export function fixtureFor(scenario, { nonce, family, project, hostVersion }) {
  if (P1B_SCENARIOS.includes(scenario)) return { spec: PLUGIN_SPEC, ...p1bFixture(scenario, { nonce, family, project, hostVersion }) };
  if (scenario !== "s1" && scenario !== "s2") throw new Error(`no fixture for scenario ${scenario}`);
  const parentModel = "parent";
  const reviewers = ["reviewer-a", "reviewer-b", "reviewer-c"].map((modelID, index) => ({ modelID, marker: `REVIEW-${index + 1}-${nonce}` }));
  const aggregator = { modelID: "aggregator", marker: `AGGREGATE-${nonce}` };
  const models = {
    [parentModel]:
      scenario === "s1"
        ? [{ type: "text", text: `parent-s1-${nonce}` }]
        : [{ type: "tool_call", name: "council_review", args: { prompt: `council-review-${nonce}` } }, { type: "text", text: `parent-done-${nonce}` }],
    ...Object.fromEntries(reviewers.map((reviewer) => [reviewer.modelID, [{ type: "text", text: reviewer.marker }]])),
    // The aggregator's request is MAIN (known session) even with `tools` omitted (V1 all-false
    // tools map; V2 `*` deny without tool history) or `tools: []` (V2 with history).
    [aggregator.modelID]: [{ type: "text", text: aggregator.marker }],
  };
  return {
    scenario,
    nonce,
    spec: PLUGIN_SPEC,
    parentModel,
    models,
    providerNonces: [nonce, ...reviewers.map((reviewer) => reviewer.marker), aggregator.marker],
    providerMarkers: [],
    council: {
      models: reviewers.map((reviewer) => ({ providerID: PROVIDER, modelID: reviewer.modelID })),
      aggregator_model: { providerID: PROVIDER, modelID: aggregator.modelID },
    },
    expected: { reviewers, aggregator, parentModel, spec: PLUGIN_SPEC },
  };
}


/** S2: every reviewer and aggregator child has >= 1 request; each request's model == the child's metadata model and its parent header == the parent id. */
function requestAttribution(evidence, councilChildren) {
  const problems = [];
  for (const child of councilChildren) {
    const requests = requestsOf(evidence, child.id);
    if (requests.length === 0) problems.push(`no provider request attributed to ${child.agent} child ${child.id}`);
    for (const entry of requests) {
      if (entry.model !== child.model?.modelID) problems.push(`request #${entry.seq} model ${entry.model} != ${child.id} metadata model ${child.model?.modelID}`);
      if (entry.parentSessionID !== evidence.parentSessionID) problems.push(`request #${entry.seq} parent header ${entry.parentSessionID} != parent ${evidence.parentSessionID}`);
    }
  }
  return check("s2.request-attribution", councilChildren.length > 0 && problems.length === 0, problems.length ? problems.join("; ") : "no council children");
}

const sameRule = (a, b) => a?.action === b?.action && a?.resource === b?.resource && a?.effect === b?.effect;

const EFFECTS = new Set(["allow", "deny", "ask"]);

/**
 * EXACT mirror of src/v2-permissions.ts parentDenyRules: absent (undefined) -> []; any
 * non-array (null included), or any entry that is not a well-formed {action, resource,
 * effect}, is malformed (src throws; here -> null = FAIL); otherwise the deny rules, in order.
 */
export function parentDenyRules(permissions) {
  if (permissions === undefined) return [];
  if (!Array.isArray(permissions)) return null;
  const rules = [];
  for (const entry of permissions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.action !== "string" || typeof entry.resource !== "string" || !EFFECTS.has(entry.effect)) return null;
    if (entry.effect === "deny") rules.push({ action: entry.action, resource: entry.resource, effect: "deny" });
  }
  return rules;
}

/** V2 aggregator: exactly parent denies (in order) -> `*` deny -> final council_review deny (no aggregator_permission in S2). */
function v2AggregatorPermissions(evidence, aggregator) {
  const actual = Array.isArray(aggregator?.permissions) ? aggregator.permissions : null;
  if (evidence.parentSessionRead === false) return check("s2.v2-aggregator-permissions", false, "parent session could not be read back");
  // parentPermissionsPresent: false is the collector's explicit record of an absent field.
  const parentDenies = parentDenyRules(evidence.parentPermissionsPresent === false ? undefined : evidence.parentPermissions);
  if (parentDenies === null) return check("s2.v2-aggregator-permissions", false, `malformed parent session permissions: ${JSON.stringify(evidence.parentPermissions)}`);
  const expected = [...parentDenies, STAR_DENY, FINAL_DENY];
  const star = actual ? actual.findIndex((rule) => sameRule(rule, STAR_DENY)) : -1;
  const allowAfterStar = star >= 0 && actual.slice(star + 1).some((rule) => rule?.effect === "allow");
  const exact = actual !== null && actual.length === expected.length && expected.every((rule, index) => sameRule(rule, actual[index]));
  return check("s2.v2-aggregator-permissions", exact && !allowAfterStar, `${allowAfterStar ? "allow after * deny; " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Provider-facing aggregator tools: every aggregator request offers only the allowed set (empty on both hosts). */
function aggregatorToolsRestricted(evidence, aggregatorRequests) {
  const allowed = new Set(evidence.family === "v2" ? V2_AGGREGATOR_INTRINSIC_TOOLS : V1_AGGREGATOR_ALLOWED_TOOLS);
  const bad = aggregatorRequests.filter((entry) => !Array.isArray(entry.tools) || entry.tools.some((tool) => !allowed.has(tool)));
  return check("s2.aggregator-tools-restricted", aggregatorRequests.length > 0 && bad.length === 0, aggregatorRequests.length === 0 ? "no aggregator request" : `aggregator offered tools: ${bad.map((entry) => `#${entry.seq} ${JSON.stringify(entry.tools)}`).join("; ")}`);
}


/** Every tool-bearing parent request lists council_review exactly once, directly (not only via Code Mode `execute`). */
function parentPositiveControl(evidence, id) {
  const parent = requestsOf(evidence, evidence.parentSessionID).filter((entry) => entry.tools.length > 0);
  const bad = parent.filter((entry) => count(entry.tools, "council_review") !== 1);
  return check(id, parent.length > 0 && bad.length === 0, parent.length === 0 ? "no tool-bearing parent request" : `parent requests without a single direct council_review: ${bad.map((entry) => entry.seq).join(",")}`);
}

function evaluateS1(evidence) {
  const checks = [];
  if (evidence.family === "v2") {
    const entries = Array.isArray(evidence.plugin?.entries) ? evidence.plugin.entries : [];
    const ours = entries.filter((entry) => entry?.source?.type === "package" && entry.source.target === evidence.expected.spec);
    checks.push(check("s1.plugin-active", ours.length === 1 && ours[0].state?.status === "active", `inventory entries for ${evidence.expected.spec}: ${JSON.stringify(ours)}`));
  } else {
    checks.push(check("s1.plugin-active", true));
  }
  checks.push(parentPositiveControl(evidence, "s1.parent-positive-control"));
  const agents = Array.isArray(evidence.agents) ? evidence.agents : [];
  checks.push(check("s1.bundled-agents", count(agents, REVIEWER_AGENT) === 1 && count(agents, AGGREGATOR_AGENT) === 1, `agents: ${JSON.stringify(agents)}`));
  checks.push(attribution(evidence));
  checks.push(auxiliarySuppressed(evidence));
  return checks;
}

/**
 * STRICT, on the parent's DURABLE record (V2 assistant messages / V1 message parts; never the
 * volatile SSE): exactly one council_review call, completed, whose result text contains the
 * aggregator marker. An error / running call, zero or several calls, an unproven count (page
 * bound hit), or a missing marker FAIL; a V1 truncated output is named in the detail.
 */
function resultMarker(evidence, marker) {
  const calls = evidence.parentToolCalls;
  const fail = (detail) => check("s2.result-marker", false, detail);
  if (!Array.isArray(calls)) return fail("parent council_review calls were not read");
  if (evidence.parentToolPagesExceeded === true) return fail("parent message pages exceeded the read bound; the council_review count is not proven");
  if (calls.length !== 1) return fail(`${calls.length} council_review calls in the parent's durable record (expected exactly 1)`);
  const [call] = calls;
  if (call.status !== "completed") return fail(`council_review call ${call.callID} status ${call.status}${call.error ? `: ${call.error}` : ""}`);
  if (typeof call.text !== "string" || !call.text.includes(marker)) {
    return fail(`aggregator marker ${marker} absent from the completed council_review result (${call.callID})${call.truncated ? "; output truncated by the host (state.metadata.truncated / outputPath)" : ""}`);
  }
  return check("s2.result-marker", true);
}

function evaluateS2(evidence) {
  const { expected, parentSessionID } = evidence;
  const checks = [];
  const children = evidence.children;
  const childIDs = children.map((child) => child.id);
  const createdFor = (id) => evidence.created.filter((event) => event.sessionID === id);
  checks.push(
    check(
      "s2.children-cardinality",
      children.length === expected.reviewers.length + 1 &&
        new Set(childIDs).size === childIDs.length &&
        children.every((child) => child.parentID === parentSessionID) &&
        children.every((child) => createdFor(child.id).length === 1 && createdFor(child.id)[0].parentID === parentSessionID),
      `children: ${JSON.stringify(children.map((child) => [child.id, child.parentID, createdFor(child.id).length]))}`,
    ),
  );

  const reviewerChildren = children.filter((child) => child.agent === REVIEWER_AGENT);
  const aggregatorChildren = children.filter((child) => child.agent === AGGREGATOR_AGENT);
  const identityProblems = [];
  for (const reviewer of expected.reviewers) {
    const matches = reviewerChildren.filter((child) => child.model?.providerID === PROVIDER && child.model?.modelID === reviewer.modelID);
    if (matches.length !== 1) identityProblems.push(`${matches.length} reviewer children for ${reviewer.modelID}`);
  }
  if (reviewerChildren.length !== expected.reviewers.length) identityProblems.push(`${reviewerChildren.length} reviewer children`);
  if (aggregatorChildren.length !== 1 || aggregatorChildren[0].model?.modelID !== expected.aggregator.modelID || aggregatorChildren[0].model?.providerID !== PROVIDER) {
    identityProblems.push(`aggregator children: ${JSON.stringify(aggregatorChildren.map((child) => child.model))}`);
  }
  if (reviewerChildren.length + aggregatorChildren.length !== children.length) identityProblems.push("child with an unexpected agent");
  checks.push(check("s2.child-identity", identityProblems.length === 0, identityProblems.join("; ")));

  const positive = parentPositiveControl(evidence, "s2.parent-positive-control");
  const leaking = modelEntries(evidence).filter((entry) => childIDs.includes(entry.sessionID) && entry.tools.includes("council_review"));
  checks.push(check("s2.tool-hidden", positive.ok && leaking.length === 0, positive.ok ? `council_review advertised to child requests ${leaking.map((entry) => entry.seq).join(",")}` : `no parent positive control: ${positive.detail}`));

  const aggregator = aggregatorChildren.length === 1 ? aggregatorChildren[0] : null;
  const aggregatorRequests = aggregator ? requestsOf(evidence, aggregator.id) : [];
  checks.push(check("s2.aggregator-tools-recorded", aggregatorRequests.length > 0 && aggregatorRequests.every((entry) => Array.isArray(entry.tools)), "no recorded aggregator request"));
  checks.push(aggregatorToolsRestricted(evidence, aggregatorRequests));
  checks.push(requestAttribution(evidence, [...reviewerChildren, ...aggregatorChildren]));

  if (evidence.family === "v2") checks.push(v2AggregatorPermissions(evidence, aggregator));

  const seen = new Set(aggregatorRequests.flatMap((entry) => entry.nonces));
  const missingMarkers = expected.reviewers.filter((reviewer) => !seen.has(reviewer.marker)).map((reviewer) => reviewer.marker);
  checks.push(check("s2.reviewer-markers", aggregatorRequests.length > 0 && missingMarkers.length === 0, `aggregator input missing ${missingMarkers.join(", ")}`));

  checks.push(resultMarker(evidence, expected.aggregator.marker));

  // Claim (a). V1 additionally needs persisted corroboration: the last assistant message of
  // the parent and of every child has a numeric time.completed (not only the idle event).
  const unsettled = [parentSessionID, ...childIDs].filter((id) => evidence.finals?.[id] !== "terminal");
  const unpersisted = evidence.family === "v1" ? [parentSessionID, ...childIDs].filter((id) => typeof evidence.persistedCompleted?.[id] !== "number") : [];
  checks.push(check("s2.settled", unsettled.length === 0 && unpersisted.length === 0, [unsettled.length ? `not terminal: ${unsettled.join(", ")}` : "", unpersisted.length ? `no persisted time.completed: ${unpersisted.join(", ")}` : ""].filter(Boolean).join("; ")));
  checks.push(attribution(evidence));
  checks.push(auxiliarySuppressed(evidence));
  return checks;
}

const EVALUATORS = { s1: evaluateS1, s2: evaluateS2, ...P1B_EVALUATORS };

const clip = (value) => (typeof value === "string" ? value.slice(0, EVIDENCE_LIMITS.maxString) : value ?? null);
const clipList = (list) => (Array.isArray(list) ? list.slice(0, 64).map(clip) : []);

/**
 * Bounded evidence for the result frame (and, via the controller, the receipt): sessions with
 * parent links / agents / models, per-request attribution (session, model, tool names, matched
 * markers and nonces; never message bodies), aggregator permissions + tools, the reviewer
 * markers the aggregator saw, creation events, and the candidate-shape observations.
 */
export function summarizeEvidence(evidence) {
  const aggregator = (evidence.children ?? []).filter((child) => child.agent === AGGREGATOR_AGENT);
  const aggregatorRequests = aggregator.length === 1 ? requestsOf(evidence, aggregator[0].id) : [];
  const ledger = Array.isArray(evidence.ledger) ? evidence.ledger : [];
  // Never message bodies or prompt text: unidentified / auxiliary requests carry only a
  // classification and a sha256 of the system prefix.
  const p1b = P1B_SCENARIOS.includes(evidence.scenario);
  const request = (entry) => ({
    seq: entry.seq,
    kind: entry.kind,
    sessionID: clip(entry.sessionID),
    parentSessionID: clip(entry.parentSessionID),
    model: clip(entry.model),
    tools: clipList(entry.tools),
    nonces: clipList(entry.nonces),
    systemMarkers: clipList(entry.systemMarkers),
    status: entry.status ?? null,
    classification: clip(entry.classification),
    systemPrefixSha256: clip(entry.systemPrefixSha256),
    // P1b (structure / markers / ordering only; never text).
    ...(!p1b ? {} : { outcome: clip(entry.outcome), scriptKey: clip(entry.scriptKey ?? null), attempt: clip(entry.attempt ?? null), released: entry.released ?? null, disconnected: entry.disconnected ?? null, receivedTick: entry.receivedTick ?? null, completedTick: entry.completedTick ?? null }),
    ...(p1b && entry.aggregator ? { aggregator: entry.aggregator } : {}),
    ...(p1b && Array.isArray(entry.toolResults) && entry.toolResults.length > 0 ? { toolResults: entry.toolResults.slice(0, 8).map((result) => ({ callId: clip(result.callId), markers: clipList(result.markers), length: result.length })) } : {}),
  });
  const summary = {
    scenario: evidence.scenario,
    family: evidence.family,
    parentSessionID: clip(evidence.parentSessionID),
    sessions: [
      { id: evidence.parentSessionID, parentID: null, agent: null, model: null },
      ...(evidence.children ?? []).map((child) => ({ id: clip(child.id), parentID: clip(child.parentID), agent: clip(child.agent), model: child.model ? { providerID: clip(child.model.providerID), modelID: clip(child.model.modelID) } : null })),
    ],
    created: (evidence.created ?? []).slice(0, 64).map((event) => ({ sessionID: clip(event.sessionID), parentID: clip(event.parentID) })),
    parentPermissionsPresent: evidence.parentPermissionsPresent ?? null,
    parentPermissions: evidence.parentPermissions === undefined ? null : evidence.parentPermissions,
    persistedCompleted: evidence.persistedCompleted ?? null,
    aggregator: aggregator.length === 1 ? { sessionID: aggregator[0].id, permissions: aggregator[0].permissions ?? null, tools: aggregatorRequests.map((entry) => clipList(entry.tools)) } : null,
    reviewerMarkers: {
      expected: (evidence.expected?.reviewers ?? []).map((reviewer) => reviewer.marker),
      seenByAggregator: (evidence.expected?.reviewers ?? []).map((reviewer) => reviewer.marker).filter((marker) => aggregatorRequests.some((entry) => entry.nonces?.includes(marker))),
    },
    // The parent's council_review calls: status / sizes / flags only (never the result text).
    parentTool: Array.isArray(evidence.parentToolCalls)
      ? { pagesExceeded: evidence.parentToolPagesExceeded === true, calls: evidence.parentToolCalls.slice(0, 8).map((call) => ({ callID: clip(call.callID), status: clip(call.status), textBytes: Buffer.byteLength(String(call.text ?? "")), markerSeen: typeof call.text === "string" && call.text.includes(evidence.expected?.aggregator?.marker ?? "\u0000"), truncated: call.truncated === true, error: clip(call.error) })) }
      : null,
    observations: evidence.observations ?? {},
    // P1b: roles, finals, classified durable calls, permission events, actions, preconditions, marks.
    details: p1b ? p1bDetails(evidence) : null,
    requestCount: ledger.length,
    auxiliaryCount: ledger.filter((entry) => entry.kind === "auxiliary").length,
    requests: [],
    truncated: false,
    truncatedFields: [],
  };
  // Bound the WHOLE object: replace the largest variable-size fields with a recorded marker
  // ({ truncated, bytes, sha256 }) until the non-request part fits, then fill `requests`.
  const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value) ?? "");
  const fields = [
    ["aggregator.permissions", () => summary.aggregator?.permissions, (value) => (summary.aggregator.permissions = value)],
    ["aggregator.tools", () => summary.aggregator?.tools, (value) => (summary.aggregator.tools = value)],
    ["parentPermissions", () => summary.parentPermissions, (value) => (summary.parentPermissions = value)],
    ["observations", () => summary.observations, (value) => (summary.observations = value)],
    ["details", () => summary.details, (value) => (summary.details = value)],
    ["created", () => summary.created, (value) => (summary.created = value)],
    ["sessions", () => summary.sessions, (value) => (summary.sessions = value)],
    ["persistedCompleted", () => summary.persistedCompleted, (value) => (summary.persistedCompleted = value)],
    ["reviewerMarkers", () => summary.reviewerMarkers, (value) => (summary.reviewerMarkers = value)],
  ];
  const fixedLimit = EVIDENCE_LIMITS.maxBytes - EVIDENCE_LIMITS.minRequestBytes;
  while (bytesOf(summary) > fixedLimit) {
    const candidates = fields.filter(([path, get]) => get() !== undefined && get() !== null && !summary.truncatedFields.includes(path));
    if (candidates.length === 0) break;
    const [path, get, set] = candidates.reduce((largest, entry) => (bytesOf(entry[1]()) > bytesOf(largest[1]()) ? entry : largest));
    const json = JSON.stringify(get());
    set({ truncated: true, bytes: Buffer.byteLength(json), sha256: createHash("sha256").update(json).digest("hex") });
    summary.truncatedFields.push(path);
  }
  if (summary.truncatedFields.length > 0) summary.truncated = true;
  const budget = EVIDENCE_LIMITS.maxBytes - bytesOf(summary) - 64;
  let used = 0;
  for (const entry of ledger) {
    const item = request(entry);
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (summary.requests.length >= EVIDENCE_LIMITS.maxRequests || used + size > budget) {
      summary.truncated = true;
      break;
    }
    summary.requests.push(item);
    used += size;
  }
  // Never silently exceed: if the bound still cannot be met, return an explicit marker instead.
  if (bytesOf(summary) > EVIDENCE_LIMITS.maxBytes) return { scenario: clip(evidence.scenario), family: clip(evidence.family), truncated: true, error: `evidence exceeds ${EVIDENCE_LIMITS.maxBytes} bytes even after truncation`, truncatedFields: summary.truncatedFields };
  return summary;
}

/** The P1b evidence fields that are already bounded classifications (no raw text by construction). */
function p1bDetails(evidence) {
  const pick = ["roles", "finals", "sessionErrors", "persistedErrors", "parentTools", "childTools", "permissionEvents", "actions", "hostNonces", "preconditions", "marks", "grandchildren", "parentSession", "inventory", "pluginLog"];
  return Object.fromEntries(pick.filter((key) => evidence[key] !== undefined).map((key) => [key, evidence[key]]));
}

export function evaluate(evidence) {
  const evaluator = EVALUATORS[evidence?.scenario];
  if (!evaluator) throw new Error(`no evaluator for scenario ${evidence?.scenario}`);
  const checks = evaluator(evidence);
  // A failed target-phase fixture precondition is INVALID-FIXTURE (= FAIL for the gate).
  if (checks.some((entry) => !entry.ok && entry.precondition === true)) return { verdict: "INVALID-FIXTURE", checks };
  return { verdict: checks.length > 0 && checks.every((entry) => entry.ok) ? "PASS" : "FAIL", checks };
}
