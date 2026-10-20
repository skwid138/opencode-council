import { describe, expect, it } from "vitest";

import { COUNCIL_TEXT } from "./aggregator-prompt.mjs";
import { evaluate, fixtureFor, summarizeEvidence } from "./scenarios.mjs";

type Fam = "v1" | "v2";
type Entry = Record<string, any>;
type E = Record<string, any>;

const N = "abc123def456";
const REV = "council-plugin-reviewer";
const AGG = "council-plugin-aggregator";
const L = (model: string) => `fake/${model}`;

/** Ledger builder with monotonic ticks (received < completed). */
function ledgerBuilder() {
  let tick = 0;
  let seq = 0;
  const entries: Entry[] = [];
  const add = (fields: Entry) => {
    const receivedTick = ++tick;
    const entry = { seq: ++seq, kind: "model", parentSessionID: null, step: 0, outcome: "text", stream: true, tools: [], systemMarkers: [], nonces: [], status: 200, released: null, disconnected: false, toolResults: [], toolCallIds: [], aggregator: null, scriptKey: null, receivedTick, completedTick: null, ...fields };
    if (entry.completedTick === null && !(entry.outcome === "hold" && entry.disconnected)) entry.completedTick = ++tick;
    entries.push(entry);
    return entry;
  };
  return { entries, add, tick: () => ++tick };
}

const child = (id: string, parentID: string, modelID: string, agent = REV, extra: Entry = {}) => ({ id, parentID, agent, model: { providerID: "fake", modelID }, ...extra });
const call = (callID: string, fields: Entry = {}) => ({ callID, name: "council_review", status: "completed", markers: [], errorClass: null, textIs: null, interrupted: false, invalidTarget: null, messageCompleted: 5, ...fields });
const view = (fields: Entry = {}) => ({ responded: [], failed: [], abortedParticipation: [], sections: [], abortedSection: [], ...fields });
const section = (index: number, model: string, markers: string[], optional = false) => ({ index, label: L(model), optional, markers });
/** Host interruption evidence for a council-stopped child, per family. */
function stopped(ev: E, id: string) {
  if (ev.family === "v2") ev.finals[id] = "interrupted";
  else {
    ev.finals[id] = "idle";
    ev.sessionErrors[id] = ["MessageAbortedError"];
  }
}
const ok = (ev: E) => (ev.family === "v2" ? "succeeded" : "idle");
/** Every listed child joined to exactly one host session.created naming its parent (plan: creation-event join). */
function withJoin(ev: E) {
  for (const kid of ev.children) if (!ev.created.some((event: Entry) => event.sessionID === kid.id)) ev.created.push({ sessionID: kid.id, parentID: kid.parentID });
  return ev;
}

function baseEvidence(scenario: string, family: Fam, extra: Entry = {}) {
  const fx = fixtureFor(scenario, { nonce: N, family, project: "/scratch/rh/project", hostVersion: family === "v1" ? "1.19.3" : "2.0.32" });
  return { fx, ev: { scenario, family, expected: fx.expected, parentSessionID: "P", roles: { parent: "P" }, children: [] as Entry[], created: [] as Entry[], finals: {} as Record<string, string>, sessionErrors: {} as Record<string, string[]>, persistedErrors: {} as Record<string, string | null>, persistedCompleted: {} as Record<string, number | null>, parentTools: {} as Record<string, Entry[]>, childTools: {} as Record<string, Entry[]>, permissionEvents: { asked: [] as Entry[], replied: [] as Entry[] }, actions: [] as Entry[], hostNonces: {}, preconditions: {} as Record<string, Entry>, marks: {} as Entry, observations: {}, ...extra } as E };
}

/** A parent that called council_review once (step 0) and finished (step 1). */
function parentRequests(add: (fields: Entry) => Entry, id = "P", token = N) {
  add({ sessionID: id, model: "parent", tools: ["council_review", "read"], outcome: "tool_call", toolCallIds: [`call_${id}_0`], scriptKey: token });
  return () => add({ sessionID: id, model: "parent", tools: ["council_review", "read"], step: 1, scriptKey: token });
}

function goodS3(family: Fam) {
  const { ev, fx } = baseEvidence("s3", family);
  const x = fx.expected;
  const { entries, add } = ledgerBuilder();
  const finishParent = parentRequests(add);
  ev.children = [child("ra", "P", "reviewer-a"), child("rb", "P", "reviewer-b"), child("rc", "P", "reviewer-c"), child("ro", "P", "reviewer-o"), child("agg", "P", "aggregator", AGG)];
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a", outcome: "hold", released: true });
  add({ sessionID: "ro", parentSessionID: "P", model: "reviewer-o", outcome: "hold", released: true });
  add({ sessionID: "rc", parentSessionID: "P", model: "reviewer-c", outcome: "hold", released: false, disconnected: true });
  add({ sessionID: "rb", parentSessionID: "P", model: "reviewer-b", outcome: "hold", released: true });
  add({ sessionID: "agg", parentSessionID: "P", model: "aggregator", aggregator: view({ responded: [L("reviewer-a"), `${L("reviewer-o")} (optional)`, L("reviewer-b")], abortedParticipation: [L("reviewer-c")], abortedSection: [L("reviewer-c")], sections: [section(1, "reviewer-a", [x.marker.a]), section(2, "reviewer-o", [x.marker.o], true), section(3, "reviewer-b", [x.marker.b])] }) });
  finishParent();
  ev.ledger = entries;
  for (const id of ["P", "ra", "rb", "ro", "agg"]) ev.finals[id] = ok(ev);
  stopped(ev, "rc");
  ev.parentTools.P = [call("call_P_0", { markers: [x.aggregator.marker] })];
  ev.preconditions.allHeld = { met: true };
  return withJoin(ev);
}

const ids = (result: { checks: { id: string; ok: boolean }[] }) => result.checks.filter((entry) => !entry.ok).map((entry) => entry.id);

/** good(family) passes; each mutation fails exactly `id` (and the verdict is FAIL, or INVALID-FIXTURE for preconditions). */
function suite(name: string, good: (family: Fam) => E, families: Fam[], mutations: [string, (ev: E) => void, Fam[]?][]) {
  describe(name, () => {
    for (const family of families) {
      it(`${family}: the good evidence passes`, () => {
        const result = evaluate(good(family));
        expect(ids(result)).toEqual([]);
        expect(result.verdict).toBe("PASS");
      });
      it.each(mutations.filter(([, , only]) => !only || only.includes(family)))(`${family}: %s fails when mutated`, (id, mutate) => {
        const ev = good(family);
        mutate(ev);
        const result = evaluate(ev);
        expect(ids(result)).toContain(id);
        expect(result.verdict).toBe(result.checks.some((entry: { ok: boolean; precondition?: boolean }) => !entry.ok && entry.precondition) ? "INVALID-FIXTURE" : "FAIL");
      });
    }
  });
}

const aggOf = (ev: E) => ev.ledger.find((entry: Entry) => entry.model === "aggregator" && entry.aggregator);

suite("S3 quorum (required + optional, laggard aborted)", goodS3, ["v1", "v2"], [
  ["s3.precondition-all-held", (ev) => (ev.preconditions.allHeld = { met: false, detail: "only 3 holds" })],
  ["s3.required-sections", (ev) => (aggOf(ev).aggregator.sections[2].label = L("reviewer-c"))],
  ["s3.required-sections", (ev) => aggOf(ev).aggregator.sections.push(section(4, "reviewer-c", [ev.expected.marker.c]))],
  ["s3.required-sections", (ev) => (aggOf(ev).aggregator.sections[0].markers = [])],
  ["s3.required-sections", (ev) => (aggOf(ev).aggregator.sections[0].markers = [ev.expected.marker.a, ev.expected.marker.b])],
  ["s3.optional-section", (ev) => (aggOf(ev).aggregator.sections[1].optional = false)],
  ["s3.optional-section", (ev) => (aggOf(ev).aggregator.responded[1] = L("reviewer-o"))],
  ["s3.optional-section", (ev) => aggOf(ev).aggregator.sections[0].markers.push(ev.expected.marker.o)],
  ["s3.aborted-listed", (ev) => (aggOf(ev).aggregator.abortedSection = [])],
  ["s3.aborted-listed", (ev) => (aggOf(ev).aggregator.abortedParticipation = [])],
  ["s3.aborted-listed", (ev) => aggOf(ev).aggregator.responded.push(L("reviewer-c"))],
  ["s3.laggard-stopped", (ev) => (ev.ledger.find((entry: Entry) => entry.sessionID === "rc").released = true)],
  ["s3.laggard-stopped", (ev) => (ev.ledger.find((entry: Entry) => entry.sessionID === "rc").disconnected = false)],
  ["s3.laggard-stopped", (ev) => (ev.family === "v2" ? (ev.finals.rc = "succeeded") : (ev.sessionErrors.rc = []))],
  ["s3.aggregator-after-b", (ev) => (aggOf(ev).receivedTick = 1)],
  ["s3.result-marker", (ev) => (ev.parentTools.P[0].markers = [])],
  ["s3.result-marker", (ev) => ev.parentTools.P.push(call("again", { markers: [ev.expected.aggregator.marker] }))],
  ["attribution", (ev) => ev.ledger.push({ ...ev.ledger[0], seq: 99, sessionID: "STRANGER" })],
  ["aux-suppressed", (ev) => ev.ledger.push({ ...ev.ledger[0], seq: 98, kind: "auxiliary", auxiliary: "title" })],
  ["children-joined", (ev) => (ev.created = ev.created.filter((event: Entry) => event.sessionID !== "rb"))],
  ["children-joined", (ev) => ev.created.push({ sessionID: "rb", parentID: "P" })],
  ["children-joined", (ev) => (ev.created.find((event: Entry) => event.sessionID === "rb").parentID = "OTHER")],
  ["children-joined", (ev) => ev.created.push({ sessionID: "unlisted", parentID: "P" })],
  ["children-joined", (ev) => (ev.children = ev.children.filter((kid: Entry) => kid.id !== "ra"))],
  ["children-joined", (ev) => (ev.children.find((kid: Entry) => kid.id === "ro").model.modelID = "reviewer-x")],
  ["children-joined", (ev) => {
    // A cleanly missing child (no listing, no creation event, no requests): only the cardinality catches it.
    ev.children = ev.children.filter((kid: Entry) => kid.id !== "ra");
    ev.created = ev.created.filter((event: Entry) => event.sessionID !== "ra");
    ev.ledger = ev.ledger.filter((entry: Entry) => entry.sessionID !== "ra");
  }],
  ["s3.required-sections", (ev) => aggOf(ev).aggregator.sections.push(section(5, "reviewer-x", [], true))],
]);

it("S3/V1: a persisted MessageAbortedError (no session.error event) is accepted as abort evidence", () => {
  const ev = goodS3("v1");
  ev.sessionErrors.rc = [];
  ev.persistedErrors.rc = "MessageAbortedError";
  expect(evaluate(ev).verdict).toBe("PASS");
});

function goodS4(family: Fam) {
  const { ev, fx } = baseEvidence("s4", family);
  const x = fx.expected;
  const { entries, add } = ledgerBuilder();
  const finishParent = parentRequests(add);
  ev.children = [1, 2, 3, 4, 5].map((index) => child(`r${index}`, "P", `reviewer-${index}`)).concat([child("agg", "P", "aggregator", AGG)]);
  add({ sessionID: "r1", parentSessionID: "P", model: "reviewer-1", status: 500 });
  add({ sessionID: "r1", parentSessionID: "P", model: "reviewer-1", status: 500 });
  add({ sessionID: "r2", parentSessionID: "P", model: "reviewer-2", outcome: "empty" });
  add({ sessionID: "r3", parentSessionID: "P", model: "reviewer-3", outcome: "partial-error", released: true });
  add({ sessionID: "r4", parentSessionID: "P", model: "reviewer-4" });
  add({ sessionID: "r5", parentSessionID: "P", model: "reviewer-5" });
  add({ sessionID: "agg", parentSessionID: "P", model: "aggregator", aggregator: view({ responded: [L("reviewer-4"), L("reviewer-5")], failed: [{ label: L("reviewer-1"), error: { kind: "known", prefix: "prompt failed:" } }, { label: L("reviewer-2"), error: { kind: "known", prefix: "empty response" } }, { label: L("reviewer-3"), error: { kind: "other", length: 9, sha256: "a".repeat(64) } }], sections: [section(1, "reviewer-4", [x.marker[4]]), section(2, "reviewer-5", [x.marker[5]])] }) });
  finishParent();
  ev.ledger = entries;
  for (const id of ["P", "r1", "r2", "r4", "r5", "agg"]) ev.finals[id] = ok(ev);
  if (family === "v2") ev.finals.r3 = "failed";
  else {
    ev.finals.r3 = "idle";
    ev.sessionErrors.r3 = ["UnknownError"];
  }
  ev.parentTools.P = [call("call_P_0", { markers: [x.aggregator.marker] })];
  ev.preconditions.partialSeen = { met: true };
  return withJoin(ev);
}

suite("S4 failures (500 / empty / partial-then-error)", goodS4, ["v1", "v2"], [
  ["s4.precondition-partial-seen", (ev) => (ev.preconditions.partialSeen = { met: false, detail: "P not observed in host" })],
  ["s4.successes", (ev) => aggOf(ev).aggregator.sections.push(section(3, "reviewer-3", [ev.expected.partial]))],
  ["s4.successes", (ev) => aggOf(ev).aggregator.sections.pop()],
  ["s4.failures-not-timeouts", (ev) => (aggOf(ev).aggregator.failed[0].error = { kind: "timeout", text: "fake/reviewer-1 timed out after 60s" })],
  ["s4.failures-not-timeouts", (ev) => aggOf(ev).aggregator.failed.pop()],
  ["s4.partial-absent", (ev) => aggOf(ev).aggregator.sections[0].markers.push(ev.expected.partial)],
  ["s4.partial-host-failure", (ev) => (ev.family === "v2" ? (ev.finals.r3 = "succeeded") : (ev.sessionErrors.r3 = []))],
  ["s4.partial-host-failure", (ev) => (ev.family === "v2" ? (ev.finals.r3 = "interrupted") : (ev.sessionErrors.r3 = ["MessageAbortedError"]))],
  ["s4.retries-accounted", (ev) => (ev.ledger.find((entry: Entry) => entry.sessionID === "r1").status = 200)],
  ["s4.retries-accounted", (ev) => (ev.ledger = ev.ledger.filter((entry: Entry) => entry.sessionID !== "r1"))],
  ["s4.retries-accounted", (ev) => ev.ledger.push({ ...ev.ledger.find((entry: Entry) => entry.sessionID === "r3"), seq: 70, kind: "script-exhausted", outcome: null })],
  ["s4.retries-accounted", (ev) => ev.ledger.push({ ...ev.ledger.find((entry: Entry) => entry.sessionID === "r1"), seq: 69, kind: "budget-exceeded", status: 429 })],
  ["s4.result-marker", (ev) => (ev.parentTools.P[0].status = "error")],
  ["s4.successes", (ev) => aggOf(ev).aggregator.sections.push(section(3, "reviewer-3", [], true))],
  ["s4.empty-response", (ev) => (ev.ledger = ev.ledger.filter((entry: Entry) => entry.sessionID !== "r2"))],
  ["s4.empty-response", (ev) => (ev.ledger.find((entry: Entry) => entry.sessionID === "r2").parentSessionID = "OTHER")],
  ["s4.empty-response", (ev) => (aggOf(ev).aggregator.failed[1].error = { kind: "known", prefix: "failed to create child session:" })],
  ["s4.empty-response", (ev) => (aggOf(ev).aggregator.failed[1].error = { kind: "other", length: 1, sha256: "f".repeat(64) })],
  ["children-joined", (ev) => (ev.children = ev.children.filter((kid: Entry) => kid.id !== "r2"))],
]);

function goodS5(family: Fam) {
  const { ev, fx } = baseEvidence("s5", family);
  const x = fx.expected;
  const { entries, add } = ledgerBuilder();
  const finishParent = parentRequests(add);
  ev.children = [child("ra", "P", "reviewer-a"), child("rb", "P", "reviewer-b"), child("rc", "P", "reviewer-c"), child("agg", "P", "aggregator", AGG)];
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a" });
  add({ sessionID: "rb", parentSessionID: "P", model: "reviewer-b" });
  add({ sessionID: "rc", parentSessionID: "P", model: "reviewer-c", outcome: "hold", released: false, disconnected: true });
  add({ sessionID: "agg", parentSessionID: "P", model: "aggregator", aggregator: view({ responded: [L("reviewer-a"), L("reviewer-b")], failed: [{ label: L("reviewer-c"), error: { kind: "timeout", text: `${L("reviewer-c")} timed out after 20s` } }], sections: [section(1, "reviewer-a", [x.marker.a]), section(2, "reviewer-b", [x.marker.b])] }) });
  finishParent();
  ev.ledger = entries;
  for (const id of ["P", "ra", "rb", "agg"]) ev.finals[id] = ok(ev);
  stopped(ev, "rc");
  ev.parentTools.P = [call("call_P_0", { markers: [x.aggregator.marker] })];
  ev.preconditions.targetHeld = { met: true };
  return withJoin(ev);
}

suite("S5 councillor timeout", goodS5, ["v1", "v2"], [
  ["s5.precondition-held", (ev) => (ev.preconditions.targetHeld = { met: false, detail: "hold after the councillor timeout" })],
  ["s5.timeout-label", (ev) => (aggOf(ev).aggregator.failed[0].error.text = `${L("reviewer-c")} timed out after 19s`)],
  ["s5.timeout-label", (ev) => (aggOf(ev).aggregator.failed[0].error = { kind: "known", prefix: "prompt failed:" })],
  ["s5.timeout-label", (ev) => (aggOf(ev).aggregator.failed[0].label = L("reviewer-b"))],
  ["s5.timeout-label", (ev) => aggOf(ev).aggregator.failed.push({ label: L("reviewer-a"), error: { kind: "known", prefix: "empty response" } })],
  ["s5.successes", (ev) => aggOf(ev).aggregator.sections.pop()],
  ["s5.held-stopped", (ev) => (ev.ledger.find((entry: Entry) => entry.sessionID === "rc").disconnected = false)],
  ["s5.held-stopped", (ev) => (ev.family === "v2" ? (ev.finals.rc = "failed") : (ev.sessionErrors.rc = ["UnknownError"]))],
  ["s5.result-marker", (ev) => (ev.parentTools.P = [])],
  ["s5.successes", (ev) => aggOf(ev).aggregator.sections.push(section(3, "reviewer-c", [], true))],
]);

function goodS6(family: Fam) {
  const { ev } = baseEvidence("s6", family);
  const { entries, add } = ledgerBuilder();
  const finishParent = parentRequests(add);
  ev.children = [child("ra", "P", "reviewer-a"), child("rb", "P", "reviewer-b"), child("rc", "P", "reviewer-c"), child("agg", "P", "aggregator", AGG)];
  for (const [id, model] of [["ra", "reviewer-a"], ["rb", "reviewer-b"], ["rc", "reviewer-c"]]) add({ sessionID: id, parentSessionID: "P", model });
  add({ sessionID: "agg", parentSessionID: "P", model: "aggregator", outcome: "hold", released: false, disconnected: true });
  finishParent();
  ev.ledger = entries;
  for (const id of ["P", "ra", "rb", "rc"]) ev.finals[id] = ok(ev);
  stopped(ev, "agg");
  ev.parentTools.P = [call("call_P_0", { textIs: "aggregatorTimeout" })];
  ev.preconditions.targetHeld = { met: true };
  return withJoin(ev);
}

suite("S6 aggregator timeout", goodS6, ["v1", "v2"], [
  ["s6.precondition-held", (ev) => (ev.preconditions = {})],
  ["s6.timeout-label", (ev) => (ev.parentTools.P[0].textIs = null)],
  ["s6.timeout-label", (ev) => (ev.parentTools.P[0].status = "error")],
  ["s6.timeout-label", (ev) => ev.parentTools.P.push(call("x", { textIs: "aggregatorTimeout" }))],
  ["s6.held-stopped", (ev) => (ev.ledger.find((entry: Entry) => entry.sessionID === "agg").released = true)],
  ["s6.held-stopped", (ev) => (ev.family === "v2" ? (ev.finals.agg = "succeeded") : (ev.sessionErrors.agg = []))],
]);

it("S6: the expected aggregator-timeout text is exactly the plugin's failure string", () => {
  expect(fixtureFor("s6", { nonce: N }).expected.exactTexts.aggregatorTimeout).toBe("Error: council_review failed: aggregator synthesis timed out after 20s");
});

function goodS7(family: Fam) {
  const { ev } = baseEvidence("s7", family);
  const { entries, add } = ledgerBuilder();
  parentRequests(add);
  ev.children = [child("ra", "P", "reviewer-a"), child("rb", "P", "reviewer-b"), child("rc", "P", "reviewer-c")];
  for (const [id, model] of [["ra", "reviewer-a"], ["rb", "reviewer-b"], ["rc", "reviewer-c"]]) {
    add({ sessionID: id, parentSessionID: "P", model, outcome: "hold", released: false, disconnected: true });
    stopped(ev, id);
  }
  ev.ledger = entries;
  ev.actions = [{ kind: "cancel", target: "P", ok: true, status: 200, order: 1 }];
  if (family === "v1") {
    ev.finals.P = "idle";
    ev.parentTools.P = [call("call_P_0", { status: "completed", textIs: "cancelled", messageCompleted: 77 })];
  } else {
    ev.finals.P = "interrupted";
    ev.parentTools.P = [call("call_P_0", { status: "error", errorClass: "interrupted" })];
  }
  ev.preconditions.allHeld = { met: true };
  return withJoin(ev);
}

suite("S7 cancel (parent only; two V1 terminal forms; V2 interruption)", goodS7, ["v1", "v2"], [
  ["s7.precondition-all-held", (ev) => (ev.preconditions.allHeld.met = false)],
  ["s7.cancel-accepted", (ev) => (ev.actions[0].ok = false)],
  ["s7.cancel-accepted", (ev) => ev.actions.push({ kind: "cancel", target: "P", ok: true, order: 2 })],
  ["s7.harness-parent-only", (ev) => ev.actions.push({ kind: "cancel", target: "ra", ok: true, order: 2 })],
  ["s7.parent-terminal", (ev) => (ev.parentTools.P[0].callID = "other")],
  ["s7.parent-terminal", (ev) => (ev.parentTools.P[0].textIs = null), ["v1"]],
  ["s7.parent-terminal", (ev) => (ev.parentTools.P[0] = call("call_P_0", { status: "error", textIs: "v1Aborted", interrupted: false, messageCompleted: 5 })), ["v1"]],
  ["s7.parent-terminal", (ev) => (ev.parentTools.P[0].messageCompleted = null), ["v1"]],
  ["s7.parent-terminal", (ev) => delete ev.finals.P, ["v1"]],
  ["s7.parent-terminal", (ev) => (ev.finals.P = "succeeded"), ["v2"]],
  ["s7.parent-terminal", (ev) => (ev.parentTools.P[0].status = "running"), ["v2"]],
  ["s7.parent-terminal", (ev) => ev.parentTools.P.push(call("x"))],
  ["s7.children-stopped", (ev) => (ev.ledger.find((entry: Entry) => entry.sessionID === "rb").disconnected = false)],
  ["s7.children-stopped", (ev) => (ev.children = ev.children.slice(0, 2))],
  ["s7.no-aggregator", (ev) => ev.children.push(child("agg", "P", "aggregator", AGG))],
  ["s7.no-aggregator", (ev) => ev.ledger.push({ ...ev.ledger[1], seq: 90, sessionID: "ra", model: "aggregator" })],
]);

it("S7/V1: the error form (exactly 'Tool execution aborted' + metadata.interrupted) is the second accepted terminal", () => {
  const ev = goodS7("v1");
  ev.parentTools.P[0] = call("call_P_0", { status: "error", textIs: "v1Aborted", interrupted: true, messageCompleted: 9 });
  expect(evaluate(ev).verdict).toBe("PASS");
});

function goodS8(family: Fam) {
  const { ev, fx } = baseEvidence("s8", family);
  const x = fx.expected;
  const shell = x.shellName;
  const { entries, add } = ledgerBuilder();
  ev.roles.control = "U";
  add({ sessionID: "U", model: "parent", tools: [shell], outcome: "tool_call", toolCallIds: ["call_U_0"] });
  const finishParent = parentRequests(add);
  ev.children = [child("ra", "P", "reviewer-a"), child("rb", "P", "reviewer-b"), child("rc", "P", "reviewer-c"), child("agg", "P", "aggregator", AGG)];
  if (family === "v2") for (const kid of ev.children) kid.permissions = [x.parentDenyRule, { action: "council_review", resource: "*", effect: "deny" }];
  const tools = [shell, "read"];
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a", tools, outcome: "tool_call", toolCallIds: ["call_ra_0"] });
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a", tools, step: 1 });
  add({ sessionID: "rb", parentSessionID: "P", model: "reviewer-b", tools, outcome: "tool_call", toolCallIds: ["call_rb_0"] });
  add({ sessionID: "rb", parentSessionID: "P", model: "reviewer-b", tools, step: 1, outcome: "tool_call", toolCallIds: ["call_rb_1"] });
  add({ sessionID: "rb", parentSessionID: "P", model: "reviewer-b", tools, step: 2 });
  add({ sessionID: "rc", parentSessionID: "P", model: "reviewer-c", tools, outcome: family === "v2" ? "tool_call" : "text", toolCallIds: family === "v2" ? ["call_rc_0"] : [] });
  if (family === "v2") add({ sessionID: "rc", parentSessionID: "P", model: "reviewer-c", tools, step: 1, outcome: "tool_call", toolCallIds: ["call_rc_1"] });
  add({ sessionID: "agg", parentSessionID: "P", model: "aggregator" });
  finishParent();
  ev.ledger = entries;
  const c = x.commands;
  ev.childTools.ra = [family === "v2" ? call("call_ra_0", { name: shell, status: "error", errorClass: "hook-denied" }) : call("call_ra_0", { name: shell, status: "completed", markers: [c.ask.output] })];
  ev.childTools.rb = [call("call_rb_1", { name: shell, status: "completed", markers: [c.sibling.output] }), call("call_rb_0", { name: shell, status: "error", errorClass: "static-denied" })];
  if (family === "v2") ev.childTools.rc = [call("call_rc_0", { name: shell, status: "error", errorClass: "static-denied" }), call("call_rc_1", { name: shell, status: "completed", markers: [c.sibling2.output] })];
  ev.permissionEvents.asked = [{ kind: "permission-asked", requestID: "q1", sessionID: "U", permission: family === "v1" ? "bash" : "shell", patterns: [], callID: "call_U_0" }];
  ev.actions = [{ kind: "reply", target: "U", ok: true, status: 200, order: 1 }];
  ev.parentSession = family === "v2" ? { read: true, permissions: [x.parentDenyRule] } : undefined;
  ev.pluginLog = family === "v1" ? { read: true, stripWarnings: 1 } : undefined;
  for (const id of ["P", "U", "ra", "rb", "rc", "agg"]) ev.finals[id] = ok(ev);
  ev.parentTools.P = [call("call_P_0", { markers: [x.aggregator.marker] })];
  return withJoin(ev);
}

suite("S8 permissions (would-ask control, hook vs static deny vs hidden, parent-only deny)", goodS8, ["v1", "v2"], [
  ["s8.control-asked", (ev) => (ev.permissionEvents.asked = [])],
  ["s8.control-asked", (ev) => (ev.permissionEvents.asked[0].permission = "read")],
  ["s8.no-council-ask", (ev) => ev.permissionEvents.asked.push({ sessionID: "ra", permission: "shell" })],
  ["s8.no-council-ask", (ev) => ev.permissionEvents.asked.push({ sessionID: "P", permission: "shell" })],
  ["s8.would-ask", (ev) => (ev.childTools.ra[0].errorClass = "static-denied"), ["v2"]],
  ["s8.would-ask", (ev) => (ev.childTools.ra[0].markers = [ev.expected.commands.ask.output]), ["v2"]],
  ["s8.would-ask", (ev) => ev.ledger.filter((entry: Entry) => entry.sessionID === "ra").forEach((entry: Entry) => (entry.tools = ["read"])), ["v2"]],
  ["s8.would-ask", (ev) => (ev.childTools.ra[0].markers = []), ["v1"]],
  ["s8.would-ask", (ev) => (ev.childTools.ra[0].status = "error"), ["v1"]],
  ["s8.would-ask", (ev) => (ev.pluginLog.stripWarnings = 0), ["v1"]],
  ["s8.would-ask", (ev) => (ev.childTools.ra = [])],
  ["s8.resource-deny", (ev) => (ev.childTools.rb[1].errorClass = "hook-denied")],
  ["s8.resource-deny", (ev) => (ev.childTools.rb[1].markers = [ev.expected.commands.deny.output])],
  ["s8.resource-deny", (ev) => (ev.childTools.rb[0].status = "error")],
  ["s8.resource-deny", (ev) => (ev.childTools.rb[0].markers = [])],
  ["s8.resource-deny", (ev) => ev.ledger.filter((entry: Entry) => entry.sessionID === "rb").forEach((entry: Entry) => (entry.tools = ["read"]))],
  ["s8.parent-only-deny", (ev) => (ev.parentSession.permissions = []), ["v2"]],
  ["s8.parent-only-deny", (ev) => (ev.parentSession.read = false), ["v2"]],
  ["s8.parent-only-deny", (ev) => (ev.children[2].permissions = []), ["v2"]],
  ["s8.parent-only-deny", (ev) => (ev.childTools.rc[0].errorClass = "hook-denied"), ["v2"]],
  ["s8.parent-only-deny", (ev) => (ev.childTools.rc[1].status = "error"), ["v2"]],
  ["s8.result-marker", (ev) => (ev.parentTools.P[0].markers = [])],
]);

it("S8 fixture: the V1 strip warning is the plugin's exact workspace-strip message for the ask pattern; outputs are never in commands or patterns", () => {
  const fx = fixtureFor("s8", { nonce: N, family: "v1" });
  expect(fx.expected.stripWarning).toBe(COUNCIL_TEXT.workspaceAskStripped("bash", `echo ASK-${N}*`));
  for (const cmd of Object.values(fx.expected.commands) as { command: string; output: string; pattern: string }[]) {
    expect(cmd.command).not.toContain(cmd.output);
    expect(cmd.pattern).not.toContain(cmd.output);
    expect(cmd.command.startsWith(cmd.pattern.slice(0, -1))).toBe(true);
  }
  expect(fixtureFor("s8", { nonce: N, family: "v2" }).sessionPermissions).toEqual([{ action: "shell", resource: `echo PAR-${N}*`, effect: "deny" }]);
  expect(fx.sessionPermissions).toBeNull();
});

function goodS9(family: Fam) {
  const { ev } = baseEvidence("s9", family);
  const { entries, add } = ledgerBuilder();
  const finishParent = parentRequests(add);
  ev.children = [child("ra", "P", "reviewer-a"), child("rb", "P", "reviewer-b"), child("rc", "P", "reviewer-c"), child("agg", "P", "aggregator", AGG)];
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a", tools: ["read"], outcome: "tool_call", toolCallIds: ["call_ra_0"] });
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a", tools: ["read"], step: 1 });
  finishParent();
  ev.ledger = entries;
  ev.childTools.ra = [family === "v2" ? call("call_ra_0", { status: "error", errorClass: "no-such-tool" }) : call("call_ra_0", { name: "invalid", invalidTarget: "council_review", errorClass: "no-such-tool" })];
  ev.grandchildren = { ra: 0, rb: 0, rc: 0, agg: 0 };
  ev.created = ev.children.map((kid: Entry) => ({ sessionID: kid.id, parentID: "P" }));
  return withJoin(ev);
}

suite("S9 recursion (host dispatch refusal + zero descendants)", goodS9, ["v1", "v2"], [
  ["s9.dispatch-refused", (ev) => (ev.childTools.ra = [])],
  ["s9.dispatch-refused", (ev) => (ev.childTools.ra[0].status = "completed"), ["v2"]],
  ["s9.dispatch-refused", (ev) => (ev.childTools.ra[0].errorClass = "static-denied"), ["v2"]],
  ["s9.dispatch-refused", (ev) => (ev.childTools.ra[0].invalidTarget = "read"), ["v1"]],
  ["s9.dispatch-refused", (ev) => (ev.childTools.ra[0].name = "council_review"), ["v1"]],
  ["s9.zero-descendants", (ev) => (ev.grandchildren.ra = 1)],
  ["s9.zero-descendants", (ev) => delete ev.grandchildren.rb],
  ["s9.zero-descendants", (ev) => ev.created.push({ sessionID: "gc", parentID: "ra" })],
]);

function goodS10(family: Fam) {
  const { ev, fx } = baseEvidence("s10", family);
  const { entries, add } = ledgerBuilder();
  const finishParent = parentRequests(add);
  ev.children = [child("ra", "P", "reviewer-a"), child("rb", "P", "reviewer-b"), child("rc", "P", "reviewer-c"), child("agg", "P", "aggregator", AGG)];
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a", tools: ["read"], outcome: "tool_call", toolCallIds: ["call_ra_0"] });
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a", tools: ["read"], step: 1, toolResults: [{ callId: "call_ra_0", markers: [], length: 3, sha256: "b".repeat(64) }] });
  finishParent();
  ev.ledger = entries;
  ev.childTools.ra = [call("call_ra_0", { name: fx.expected.shellName, status: "error", errorClass: "no-such-tool" })];
  return withJoin(ev);
}

suite("S10 reviewer_permission bash deny (hidden and/or refused, never executed)", goodS10, ["v1", "v2"], [
  ["s10.not-executed", (ev) => (ev.ledger[2].toolResults[0].markers = [ev.expected.output])],
  ["s10.not-executed", (ev) => (ev.childTools.ra[0].markers = [ev.expected.output])],
  ["s10.hidden-or-refused", (ev) => {
    ev.ledger.filter((entry: Entry) => entry.sessionID === "ra").forEach((entry: Entry) => entry.tools.push(ev.expected.shellName));
    ev.childTools.ra[0] = call("call_ra_0", { name: ev.expected.shellName, status: "completed" });
  }],
]);

it("S10: hidden alone (tool never offered) or refusal alone each satisfy the claim", () => {
  const hiddenOnly = goodS10("v2");
  hiddenOnly.childTools.ra = [];
  expect(evaluate(hiddenOnly).verdict).toBe("PASS");
  const refusedOnly = goodS10("v1");
  refusedOnly.ledger.filter((entry: Entry) => entry.sessionID === "ra").forEach((entry: Entry) => entry.tools.push("bash"));
  refusedOnly.childTools.ra = [call("call_ra_0", { name: "bash", status: "error", errorClass: "static-denied" })];
  expect(evaluate(refusedOnly).verdict).toBe("PASS");
});

function goodS11(family: Fam) {
  const { ev, fx } = baseEvidence("s11", family);
  const x = fx.expected;
  const { entries, add } = ledgerBuilder();
  const finishParent = parentRequests(add);
  ev.children = [child("ra", "P", "reviewer-a", x.agentName), child("rb", "P", "reviewer-b", x.agentName), child("rc", "P", "reviewer-c", x.agentName), child("agg", "P", "aggregator", AGG)];
  const sys = [x.systemMarker];
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a", systemMarkers: sys, outcome: "tool_call", toolCallIds: ["call_ra_0"] });
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a", systemMarkers: sys, step: 1, outcome: "tool_call", toolCallIds: ["call_ra_1"], toolResults: [{ callId: "call_ra_0", markers: [], length: 5, sha256: "c".repeat(64) }] });
  add({ sessionID: "ra", parentSessionID: "P", model: "reviewer-a", systemMarkers: sys, step: 2, toolResults: [{ callId: "call_ra_0", markers: [], length: 5, sha256: "c".repeat(64) }, { callId: "call_ra_1", markers: [x.okContent], length: 20, sha256: "d".repeat(64) }] });
  add({ sessionID: "rb", parentSessionID: "P", model: "reviewer-b", systemMarkers: sys });
  add({ sessionID: "rc", parentSessionID: "P", model: "reviewer-c", systemMarkers: sys });
  finishParent();
  ev.ledger = entries;
  ev.childTools.ra = [call("call_ra_1", { name: "read", markers: [x.okContent] }), call("call_ra_0", { name: "read", status: "error", errorClass: "static-denied" })];
  return withJoin(ev);
}

suite("S11 custom file-defined reviewer agent", goodS11, ["v1", "v2"], [
  ["s11.custom-agent", (ev) => (ev.children[1].agent = REV)],
  ["s11.custom-agent", (ev) => (ev.children = ev.children.filter((kid: Entry) => kid.id !== "rc"))],
  ["s11.system-marker", (ev) => (ev.ledger.find((entry: Entry) => entry.sessionID === "rb").systemMarkers = [])],
  ["s11.denied-read", (ev) => (ev.childTools.ra[1].status = "completed")],
  ["s11.denied-read", (ev) => (ev.ledger[2].toolResults[0].markers = [ev.expected.denyContent])],
  ["s11.denied-read", (ev) => ev.ledger[3].nonces.push(ev.expected.denyContent)],
  ["s11.sibling-read", (ev) => (ev.childTools.ra[0].status = "error")],
  ["s11.sibling-read", (ev) => (ev.childTools.ra[0].markers = [])],
  ["s11.sibling-read", (ev) => (ev.ledger[3].toolResults[1].markers = [])],
]);

it("S11 fixture: agent file with the system marker and an absolute in-project read deny; the deny / ok files are written into the project", () => {
  const fx = fixtureFor("s11", { nonce: N, family: "v1", project: "/scratch/rh/project", hostVersion: "1.18.29" });
  const [agent, deny, okFile] = fx.projectFiles.slice(3);
  expect(agent.path).toBe(`.opencode/agent/${fx.expected.agentName}.md`);
  expect(agent.content).toContain(fx.expected.systemMarker);
  // Radagast M3: the rule resource is host-relative (project-relative by default; the V1 driver
  // re-renders it against the host's worktree); the tool input stays absolute.
  expect(agent.content).toContain(`"custom-deny-${N}.txt": deny`);
  expect(fx.renderAgent("scratch/rh/project/custom-deny-x.txt").content).toContain(`"scratch/rh/project/custom-deny-x.txt": deny`);
  expect(fx.renderAgent("x").path).toBe(agent.path);
  expect(fx.models["reviewer-a"][0].args).toEqual({ filePath: `/scratch/rh/project/custom-deny-${N}.txt` });
  expect(agent.content).toContain(`"*": allow`);
  expect(deny).toEqual({ path: `custom-deny-${N}.txt`, content: `DENYCONTENT-${N}\n` });
  expect(okFile).toEqual({ path: `custom-ok-${N}.txt`, content: `OKCONTENT-${N}\n` });
  expect(fx.council.reviewer).toBe(fx.expected.agentName);
});

describe("S11 diagnostic amendment: V1 S11 seeds the project .opencode config-install skip-marker", () => {
  it("V1 S11: an empty node_modules dir + package.json / package-lock.json naming @opencode-ai/plugin at the HOST version, first, in package-stage's exact shape", () => {
    for (const hostVersion of ["1.18.29", "1.19.3"]) {
      const fx = fixtureFor("s11", { nonce: N, family: "v1", project: "/scratch/rh/project", hostVersion });
      const deps = { "@opencode-ai/plugin": hostVersion };
      expect(fx.projectFiles.slice(0, 3)).toEqual([
        { path: ".opencode/node_modules", type: "dir" },
        { path: ".opencode/package.json", content: `${JSON.stringify({ dependencies: deps }, null, 2)}\n` },
        { path: ".opencode/package-lock.json", content: `${JSON.stringify({ name: "opencode", lockfileVersion: 3, requires: true, packages: { "": { dependencies: deps } } }, null, 2)}\n` },
      ]);
      expect(fx.projectFiles.slice(3).map((file: Entry) => file.path)).toEqual([`.opencode/agent/${fx.expected.agentName}.md`, `custom-deny-${N}.txt`, `custom-ok-${N}.txt`]);
    }
  });

  it("the V1 S11 marker is the V1 XDG config-dir preseed marker of package-stage (same bytes, only the dir differs)", async () => {
    const { planPluginCache } = await import("./package-stage.mjs");
    const plan = planPluginCache({ family: "v1", hostVersion: "1.18.29", manifest: { name: "@skwid138/opencode-council", version: "0.3.0" }, files: new Map() });
    const fx = fixtureFor("s11", { nonce: N, family: "v1", project: "/p", hostVersion: "1.18.29" });
    expect(fx.projectFiles.slice(0, 3)).toEqual(plan.config.map((entry: Entry) => (entry.type === "dir" ? { path: entry.rel.replace(/^opencode\//, ".opencode/"), type: "dir" } : { path: entry.rel.replace(/^opencode\//, ".opencode/"), content: entry.data.toString("utf8") })));
  });

  it("V1 S11 without an exact host version refuses to build (never a marker naming no version)", () => {
    expect(() => fixtureFor("s11", { nonce: N, family: "v1", project: "/p" })).toThrow(/exact host version/);
  });

  it("V2 S11 and every other cell get no .opencode marker (V2 S11 keeps only its agent file under .opencode)", () => {
    const v2 = fixtureFor("s11", { nonce: N, family: "v2", project: "/p", hostVersion: "2.0.32" });
    expect(v2.projectFiles.map((file: Entry) => file.path)).toEqual([`.opencode/agent/${v2.expected.agentName}.md`, `custom-deny-${N}.txt`, `custom-ok-${N}.txt`]);
    for (const scenario of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s12", "s13", "obs-ask"]) {
      for (const [family, hostVersion] of [["v1", "1.18.29"], ["v2", "2.0.32"]] as const) {
        if (scenario === "obs-ask" && family === "v2") continue;
        const fx = fixtureFor(scenario, { nonce: N, family, project: "/p", hostVersion });
        expect((fx.projectFiles ?? []).filter((file: Entry) => file.path.startsWith(".opencode"))).toEqual([]);
      }
    }
  });
});

function goodS12(family: Fam) {
  const { ev, fx } = baseEvidence("s12", family);
  const x = fx.expected;
  const { entries, add } = ledgerBuilder();
  ev.parentSessionID = "A";
  ev.roles = { parent: "A", parentA: "A", parentB: "B", control: "U" };
  add({ sessionID: "A", model: "parent", tools: ["council_review"], outcome: "tool_call", toolCallIds: ["call_A_0"], nonces: [x.tokens.a] });
  add({ sessionID: "B", model: "parent", tools: ["council_review"], outcome: "tool_call", toolCallIds: ["call_B_0"], nonces: [x.tokens.b] });
  add({ sessionID: "U", model: "parent", tools: ["shell"], outcome: "tool_call", toolCallIds: ["call_U_0"], nonces: [x.tokens.u] });
  ev.children = [];
  ["a", "b", "c"].forEach((letter, index) => {
    ev.children.push(child(`a${letter}`, "A", `reviewer-${letter}`), child(`b${letter}`, "B", `reviewer-${letter}`));
    add({ sessionID: `a${letter}`, parentSessionID: "A", model: `reviewer-${letter}`, outcome: "hold", released: false, disconnected: true, nonces: [x.tokens.a] });
    add({ sessionID: `b${letter}`, parentSessionID: "B", model: `reviewer-${letter}`, outcome: "hold", released: true, nonces: [x.tokens.b, x.markers.b[index]] });
    stopped(ev, `a${letter}`);
    ev.finals[`b${letter}`] = ok(ev);
  });
  ev.children.push(child("bagg", "B", "aggregator", AGG));
  add({ sessionID: "bagg", parentSessionID: "B", model: "aggregator", nonces: [x.tokens.b, ...x.markers.b], aggregator: view({ responded: ["a", "b", "c"].map((letter) => L(`reviewer-${letter}`)), sections: ["a", "b", "c"].map((letter, index) => section(index + 1, `reviewer-${letter}`, [x.markers.b[index]])) }) });
  add({ sessionID: "B", model: "parent", step: 1, tools: ["council_review"], nonces: [x.tokens.b] });
  add({ sessionID: "U", model: "parent", step: 1, tools: ["shell"], nonces: [x.tokens.u], toolResults: [{ callId: "call_U_0", markers: [x.uOutput], length: 9, sha256: "e".repeat(64) }] });
  ev.ledger = entries;
  ev.actions = [{ kind: "cancel", target: "A", ok: true, status: 200, order: 1 }, { kind: "release", target: "B", ok: true, order: 2 }, { kind: "reply", target: "U", ok: true, status: 204, order: 3 }];
  if (family === "v1") {
    ev.finals.A = "idle";
    ev.parentTools.A = [call("call_A_0", { textIs: "cancelled", messageCompleted: 3 })];
  } else {
    ev.finals.A = "interrupted";
    ev.parentTools.A = [call("call_A_0", { status: "error", errorClass: "interrupted" })];
  }
  ev.finals.B = ok(ev);
  ev.finals.bagg = ok(ev);
  ev.finals.U = ok(ev);
  ev.parentTools.B = [call("call_B_0", { markers: [x.aggregate.b] })];
  ev.permissionEvents.asked = [{ kind: "permission-asked", requestID: "q", sessionID: "U", permission: family === "v1" ? "bash" : "shell" }];
  ev.marks = { aFinalBeforeBRelease: true, uRepliedBeforeHarness: false, uFinalBeforeReply: false, uRequestsBeforeReply: 1, uReplyAfterBFinal: true };
  ev.preconditions.ready = { met: true };
  return withJoin(ev);
}

suite("S12 concurrency (two councils + unrelated pending ask)", goodS12, ["v1", "v2"], [
  ["s12.precondition-ready", (ev) => (ev.preconditions.ready.met = false)],
  ["s12.isolation", (ev) => ev.ledger[3].nonces.push(ev.expected.tokens.b)],
  ["s12.isolation", (ev) => (aggOf(ev).aggregator.sections[0].markers = [ev.expected.markers.a[0]])],
  ["s12.isolation", (ev) => ev.parentTools.B[0].markers.push(ev.expected.aggregate.a)],
  ["s12.a-cancelled", (ev) => (ev.ledger.find((entry: Entry) => entry.sessionID === "ab").disconnected = false)],
  ["s12.a-cancelled", (ev) => ev.children.push(child("aagg", "A", "aggregator", AGG))],
  ["s12.a-cancelled", (ev) => (ev.parentTools.A[0].callID = "nope")],
  ["s12.harness-parent-only", (ev) => ev.actions.push({ kind: "cancel", target: "aa", ok: true, order: 4 })],
  ["s12.b-completes-after-a", (ev) => (ev.marks.aFinalBeforeBRelease = false)],
  ["s12.b-completes-after-a", (ev) => (ev.parentTools.B[0].markers = [])],
  ["s12.unrelated-ask-pending", (ev) => (ev.marks.uRepliedBeforeHarness = true)],
  ["s12.unrelated-ask-pending", (ev) => (ev.marks.uFinalBeforeReply = true)],
  ["s12.unrelated-ask-pending", (ev) => (ev.marks.uRequestsBeforeReply = 2)],
  ["s12.unrelated-ask-pending", (ev) => (ev.marks.uReplyAfterBFinal = false)],
  ["s12.unrelated-ask-pending", (ev) => (ev.actions = ev.actions.filter((action: Entry) => action.kind !== "reply"))],
  ["s12.unrelated-ask-pending", (ev) => (ev.ledger.at(-1).toolResults = [])],
  ["s12.unrelated-ask-pending", (ev) => delete ev.finals.U],
  ["s12.unrelated-ask-pending", (ev) => ev.permissionEvents.asked.push({ sessionID: "U", permission: "shell" })],
  ["children-joined", (ev) => (ev.children = ev.children.filter((kid: Entry) => kid.id !== "bagg"))],
  ["children-joined", (ev) => ev.created.push({ sessionID: "ucx", parentID: "U" })],
]);

it("S12 fixture: council / unrelated tokens never contain one another (per-nonce script selection is unambiguous)", () => {
  const { tokens } = fixtureFor("s12", { nonce: N, family: "v2" }).expected;
  for (const a of Object.values(tokens) as string[]) for (const b of Object.values(tokens) as string[]) if (a !== b) expect(a.includes(b)).toBe(false);
});

function goodS13(family: Fam) {
  const { ev, fx } = baseEvidence("s13", family);
  const x = fx.expected;
  const { entries, add } = ledgerBuilder();
  const finishParent = parentRequests(add);
  ev.roles.fresh = "F";
  ev.children = [child("ra", "P", "reviewer-a"), child("rb", "P", "reviewer-b"), child("rc", "P", "reviewer-c")];
  for (const [id, model] of [["ra", "reviewer-a"], ["rb", "reviewer-b"], ["rc", "reviewer-c"]]) add({ sessionID: id, parentSessionID: "P", model, outcome: "hold", released: family === "v2", disconnected: family === "v1" });
  if (family === "v2") {
    ev.children.push(child("agg", "P", "aggregator", AGG));
    add({ sessionID: "agg", parentSessionID: "P", model: "aggregator" });
    finishParent();
    for (const id of ["P", "ra", "rb", "rc", "agg"]) ev.finals[id] = "succeeded";
    ev.parentTools.P = [call("call_P_0", { markers: [x.aggregate.original] })];
    ev.actions = [{ kind: "reload", target: null, ok: true, status: 204, order: 1 }];
    ev.inventory = { before: { active: true, fingerprint: "f1" }, after: { active: true, fingerprint: "f1" }, fingerprintChanged: false };
    ev.marks = { pluginUpdatedAfterReload: 1 };
  } else {
    for (const id of ["ra", "rb", "rc"]) {
      ev.finals[id] = "idle";
      ev.persistedCompleted[id] = 10;
    }
    ev.finals.P = "idle";
    ev.parentTools.P = [call("call_P_0", { textIs: "cancelled", messageCompleted: 11 })];
    ev.actions = [{ kind: "dispose", target: null, ok: true, status: 200, order: 1 }];
    ev.marks = { disposedEvent: true, teardown: "instance-dispose" };
  }
  ev.children.push(child("fa", "F", "reviewer-a"), child("fb", "F", "reviewer-b"), child("fc", "F", "reviewer-c"), child("fagg", "F", "aggregator", AGG));
  add({ sessionID: "F", model: "parent", tools: ["council_review"], outcome: "tool_call", toolCallIds: ["call_F_0"] });
  for (const [id, model] of [["fa", "reviewer-a"], ["fb", "reviewer-b"], ["fc", "reviewer-c"]]) add({ sessionID: id, parentSessionID: "F", model });
  add({ sessionID: "fagg", parentSessionID: "F", model: "aggregator" });
  ev.finals.F = ok(ev);
  ev.parentTools.F = [call("call_F_0", { markers: [x.aggregate.fresh] })];
  ev.ledger = entries;
  ev.preconditions.allHeld = { met: true };
  return withJoin(ev);
}

suite("S13 reload continuity (V2) / dispose teardown (V1)", goodS13, ["v1", "v2"], [
  ["s13.precondition-all-held", (ev) => (ev.preconditions.allHeld.met = false)],
  ["s13.reload-accepted", (ev) => (ev.actions[0].status = 200), ["v2"]],
  ["s13.activation", (ev) => (ev.inventory.after.active = false), ["v2"]],
  ["s13.generation", (ev) => (ev.marks.pluginUpdatedAfterReload = 0), ["v2"]],
  ["s13.original-completes", (ev) => (ev.parentTools.P[0].markers = [ev.expected.aggregate.fresh]), ["v2"]],
  ["s13.original-completes", (ev) => (ev.parentTools.P[0].callID = "other"), ["v2"]],
  ["s13.children-terminal", (ev) => delete ev.finals.rb, ["v2"]],
  ["s13.disposed", (ev) => (ev.marks.disposedEvent = false), ["v1"]],
  ["s13.disposed", (ev) => (ev.actions[0].ok = false), ["v1"]],
  ["s13.teardown-labeled", (ev) => (ev.marks.teardown = null), ["v1"]],
  ["s13.parent-terminal", (ev) => (ev.parentTools.P[0].textIs = null), ["v1"]],
  ["s13.children-settled", (ev) => (ev.persistedCompleted.rb = null), ["v1"]],
  ["s13.children-settled", (ev) => {
    delete ev.finals.rc;
    ev.marks.disposedEvent = false;
  }, ["v1"]],
  ["s13.fresh-review", (ev) => (ev.parentTools.F[0].markers = [ev.expected.aggregate.original])],
  ["s13.fresh-review", (ev) => delete ev.roles.fresh],
  ["children-joined", (ev) => (ev.children = ev.children.filter((kid: Entry) => kid.id !== "fb"))],
]);

it("S13/V2 (Radagast M7): an inventory-state change alone is NOT generation evidence; a post-reload plugin.updated is required", () => {
  const ev = goodS13("v2");
  ev.marks.pluginUpdatedAfterReload = 0;
  ev.inventory.fingerprintChanged = true;
  expect(ids(evaluate(ev))).toContain("s13.generation");
});

it("S13/V1 (Radagast M10): terminal SSE not retained across the dispose -> durable completed/aborted state + the dispose event settle the old sessions", () => {
  const ev = goodS13("v1");
  for (const id of ["P", "ra", "rb", "rc"]) delete ev.finals[id];
  expect(evaluate(ev).verdict).toBe("PASS");
  ev.marks.disposedEvent = false;
  expect(ids(evaluate(ev))).toEqual(expect.arrayContaining(["s13.parent-terminal", "s13.children-settled"]));
});

/** A complete obs-ask council (3 reviewers + aggregator), built on the S6 evidence shape (round-3 Must 1 counterexample). */
function goodObs() {
  const ev = goodS6("v1");
  ev.scenario = "obs-ask";
  ev.expected = fixtureFor("obs-ask", { nonce: N, family: "v1" }).expected;
  ev.preconditions = {};
  ev.finals.P = "idle";
  ev.marks = { observation: { childAsks: 1 } };
  return ev;
}

describe("obs-ask (observational, V1 only)", () => {
  it("passes once the observation is collected; otherwise fails", () => {
    const ev = goodObs();
    expect(evaluate(ev).verdict).toBe("PASS");
    delete ev.finals.P;
    expect(ids(evaluate(ev))).toEqual(["obs.collected"]);
  });

  it.each([
    ["a duplicate listed child", "cell.integrity.children-joined", (ev: E) => (ev.children = ev.children.map((kid: Entry) => (kid.id === "rb" ? { ...ev.children.find((other: Entry) => other.id === "ra") } : kid)))],
    ["a child request whose parent header is OTHER", "cell.integrity.attribution", (ev: E) => (ev.ledger.find((entry: Entry) => entry.sessionID === "ra").parentSessionID = "OTHER")],
    ["a request from an unlisted child session", "cell.integrity.attribution", (ev: E) => ev.ledger.push({ ...ev.ledger.find((entry: Entry) => entry.sessionID === "ra"), seq: 90, sessionID: "ghost" })],
    ["an auxiliary request", "cell.integrity.aux-suppressed", (ev: E) => ev.ledger.push({ ...ev.ledger[0], seq: 91, kind: "auxiliary", auxiliary: "title" })],
  ])("round-3 Must 1: %s FAILS the observational cell as an infrastructure (cell.*) failure", (_label, id, mutate) => {
    const ev = goodObs();
    mutate(ev);
    const result = evaluate(ev);
    expect(result.verdict).toBe("FAIL");
    expect(ids(result)).toContain(id);
    expect(ids(result)).not.toContain("obs.collected");
  });

  it("refuses a V2 fixture", () => {
    expect(() => fixtureFor("obs-ask", { nonce: N, family: "v2" })).toThrow(/V1-only/);
  });
});

describe("P1b fixtures (budgets, nonces, markers)", () => {
  it("timing scenarios have short TARGET budgets and generous non-target ones", () => {
    expect(fixtureFor("s5", { nonce: N }).council.timeouts).toMatchObject({ councillor_ms: 20_000, aggregator_ms: 60_000 });
    expect(fixtureFor("s6", { nonce: N }).council.timeouts).toMatchObject({ councillor_ms: 60_000, aggregator_ms: 20_000 });
    const s3 = fixtureFor("s3", { nonce: N }).council;
    expect(s3.quorum).toBe(2);
    expect(s3.models.filter((model: { optional?: boolean }) => model.optional)).toEqual([{ providerID: "fake", modelID: "reviewer-o", optional: true }]);
  });

  it("S4 per-session scripts: 500 / empty / partial (barrier'd) / two successes", () => {
    const { models, expected } = fixtureFor("s4", { nonce: N });
    expect(models["reviewer-1"]).toEqual([{ type: "status", status: 500 }]);
    expect(models["reviewer-2"]).toEqual([{ type: "empty" }]);
    // M5: repeats across V2 continuations and V1 retries (never script-exhausted for this actor).
    expect(models["reviewer-3"]).toEqual([{ type: "partial-error", text: expected.partial, barrier: expected.partialBarrier, repeat: true }]);
  });

  it("every P1b fixture builds for its families and lists its models for the host config", () => {
    for (const scenario of ["s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13"]) {
      for (const family of ["v1", "v2"] as const) {
        const fx = fixtureFor(scenario, { nonce: N, family, hostVersion: family === "v1" ? "1.19.3" : "2.0.32" });
        expect(Object.keys(fx.models)).toContain("parent");
        expect(fx.spec).toBe("@skwid138/opencode-council@0.3.0");
        for (const model of fx.council.models) expect(Object.keys(fx.models)).toContain(model.modelID);
      }
    }
  });
});

it("S4: retries and continuations of the faulting actors are counted separately in the check detail (failure path shows them)", () => {
  const ev = goodS4("v2");
  const r3 = ev.ledger.find((entry: Entry) => entry.sessionID === "r3");
  ev.ledger.push({ ...r3, seq: 71, attempt: "retry" }, { ...r3, seq: 72, attempt: "continuation" }, { ...r3, seq: 73, attempt: "continuation", outcome: "text" });
  const detail = evaluate(ev).checks.find((check: { id: string }) => check.id === "s4.retries-accounted").detail;
  expect(detail).toMatch(/reviewer-3 requests .* attempts \{"retry":1,"continuation":2\}$/);
});

describe("summarizeEvidence keeps P1b details bounded and text-free", () => {
  it("persists the classified details and P1b request fields; never raw text", () => {
    const ev = goodS8("v2");
    ev.ledger[0].secretText = "RAW-TEXT";
    const summary = summarizeEvidence(ev);
    expect(summary.details.childTools.rb).toHaveLength(2);
    expect(summary.details.permissionEvents.asked).toHaveLength(1);
    expect(summary.requests[0]).toMatchObject({ outcome: "tool_call", released: null });
    expect(JSON.stringify(summary)).not.toContain("RAW-TEXT");
  });
});

describe("claim (b) with host retries", () => {
  it("a retried held request where one attempt was RELEASED by its barrier is not a held stop", () => {
    const ev = goodS3("v2");
    const rc = ev.ledger.find((entry: Entry) => entry.sessionID === "rc");
    ev.ledger.push({ ...rc, seq: 77, released: true, disconnected: false });
    expect(ids(evaluate(ev))).toContain("s3.laggard-stopped");
  });
});

describe("per-nonce script selection never shadows (real fake provider)", () => {
  /** The script a request carrying `text` gets for `model`, as the provider selects it. */
  async function selected(fx: Any, family: Fam, model: string, text: string) {
    const { createFakeProvider, sessionHeaders } = await import("./fake-provider.mjs");
    const provider = createFakeProvider({ family, identityToken: "identity-token-123", models: fx.models, nonces: fx.providerNonces });
    provider.registerParent("S");
    const chunks: string[] = [];
    const res = { writeHead: () => {}, write: () => {}, end: (chunk?: string) => chunks.push(chunk ?? ""), destroy: () => {}, onClose: () => {} };
    await provider.handle({ method: "POST", path: "/v1/chat/completions", headers: { [sessionHeaders(family).session]: "S" }, body: { model, stream: false, messages: [{ role: "user", content: text }] } }, res);
    return { key: provider.ledger()[0].scriptKey, message: JSON.parse(chunks.join("")).choices[0].message };
  }
  type Any = Record<string, any>;

  it.each(["v1", "v2"] as const)("%s: S8 control vs council, S12 A / B / U, S13 original vs fresh", async (family) => {
    const s8 = fixtureFor("s8", { nonce: N, family });
    expect((await selected(s8, family, "parent", `rh council cell ${s8.expected.controlToken}`)).message.tool_calls[0].function.name).toBe(s8.expected.shellName);
    expect((await selected(s8, family, "parent", `rh council cell ${N}`)).message.tool_calls[0].function.name).toBe("council_review");
    const s12 = fixtureFor("s12", { nonce: N, family });
    for (const [token, tool] of [[s12.expected.tokens.u, family === "v1" ? "bash" : "shell"], [s12.expected.tokens.a, "council_review"], [s12.expected.tokens.b, "council_review"]]) {
      const picked = await selected(s12, family, "parent", `rh council cell ${token}`);
      expect(picked.key).toBe(token);
      expect(picked.message.tool_calls[0].function.name).toBe(tool);
    }
    const s13 = fixtureFor("s13", { nonce: N, family });
    expect((await selected(s13, family, "parent", `rh council cell ${s13.expected.freshToken}`)).key).toBe(s13.expected.freshToken);
    expect((await selected(s13, family, "aggregator", `x council-review-${s13.expected.freshToken}`)).message.content).toBe(s13.expected.aggregate.fresh);
    expect((await selected(s13, family, "parent", `rh council cell ${N}`)).key).toBe(N);
  });
});

describe("S4 budget option B (user-approved 2026-10-19)", () => {
  it("S4 councillor_ms = 150 s on both families; other scenarios unchanged", () => {
    for (const family of ["v1", "v2"] as const) expect(fixtureFor("s4", { nonce: N, family }).council.timeouts).toEqual({ councillor_ms: 150_000, aggregator_ms: 60_000 });
    expect(fixtureFor("s5", { nonce: N }).council.timeouts.councillor_ms).toBe(20_000);
    expect(fixtureFor("s3", { nonce: N }).council.timeouts.councillor_ms).toBe(90_000);
  });

  it("every scenario's councillor + aggregator phases fit inside its driver work deadline (no clipping); the plugin's derived hard cap covers them", async () => {
    const { cellDeadlines } = await import("./cells.mjs");
    const { WORK_MARGIN_MS } = await import("./driver.mjs");
    for (const scenario of ["s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13"]) {
      const { council } = fixtureFor(scenario, { nonce: N, family: "v2" });
      const t = council.timeouts;
      expect(t.hard_cap_ms).toBeUndefined();
      expect(t.councillor_ms + t.aggregator_ms).toBeLessThanOrEqual(cellDeadlines(scenario).driverMs - WORK_MARGIN_MS);
    }
  });
});

describe("P1b re-audit round 2 (Must 1 / Must 2)", () => {
  it("Must 1: a child request whose parent header conflicts with the child's listed parent FAILS attribution (goodS12 v2: aa A -> B)", () => {
    const ev = goodS12("v2");
    ev.ledger.find((entry: Entry) => entry.sessionID === "aa").parentSessionID = "B";
    expect(ids(evaluate(ev))).toContain("attribution");
  });

  it("Must 1: a child request whose model conflicts with the child's metadata model FAILS attribution", () => {
    const ev = goodS5("v1");
    ev.ledger.find((entry: Entry) => entry.sessionID === "ra").model = "reviewer-b";
    expect(ids(evaluate(ev))).toContain("attribution");
  });

  it("Must 1: a child request with NO parent header is a conflict too", () => {
    const ev = goodS9("v2");
    ev.ledger.find((entry: Entry) => entry.sessionID === "ra").parentSessionID = null;
    expect(ids(evaluate(ev))).toContain("attribution");
  });

  it("Must 2: duplicate listed child ids never satisfy the cardinality (goodS6: [ra, ra, rc, agg], rb gone)", () => {
    const ev = goodS6("v2");
    const ra = ev.children.find((kid: Entry) => kid.id === "ra");
    ev.children = ev.children.map((kid: Entry) => (kid.id === "rb" ? { ...ra } : kid));
    ev.created = ev.created.filter((event: Entry) => event.sessionID !== "rb");
    ev.ledger = ev.ledger.filter((entry: Entry) => entry.sessionID !== "rb");
    const result = evaluate(ev);
    expect(ids(result)).toContain("children-joined");
    expect(result.checks.find((check: { id: string }) => check.id === "children-joined").detail).toMatch(/duplicate listed child ra/);
    // Only DISTINCT ids count toward the cardinality (3 distinct children, not 4).
    expect(result.checks.find((check: { id: string }) => check.id === "children-joined").detail).toMatch(/parent has 3 children \(0 optional\); expected 4/);
  });
});
