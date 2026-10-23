import { describe, expect, it } from "vitest";

import { AGGREGATOR_TOOLS } from "../../src/aggregator";
import { evaluate, EVIDENCE_LIMITS, fixtureFor, summarizeEvidence, V1_AGGREGATOR_ALLOWED_TOOLS, V2_AGGREGATOR_INTRINSIC_TOOLS } from "./scenarios.mjs";

const NONCE = "n0nce";
const fx = fixtureFor("s2", { nonce: NONCE });
const AGG = fx.expected.aggregator;
const REVIEWERS = fx.expected.reviewers;

function ledger(entries: Record<string, unknown>[]) {
  return entries.map((entry, index) => ({ seq: index + 1, kind: "model", parentSessionID: null, step: 0, outcome: "text", stream: true, systemMarkers: [], nonces: [], status: 200, released: null, disconnected: false, ...entry }));
}

function s2Evidence(family: "v1" | "v2") {
  const children = [
    ...REVIEWERS.map((reviewer: { modelID: string }, index: number) => ({ id: `r${index}`, parentID: "P", agent: "council-plugin-reviewer", model: { providerID: "fake", modelID: reviewer.modelID } })),
    {
      id: "agg",
      parentID: "P",
      agent: "council-plugin-aggregator",
      model: { providerID: "fake", modelID: AGG.modelID },
      permissions: family === "v2" ? [{ action: "bash", resource: "rm *", effect: "deny" }, { action: "*", resource: "*", effect: "deny" }, { action: "council_review", resource: "*", effect: "deny" }] : undefined,
    },
  ];
  return {
    scenario: "s2",
    family,
    parentSessionID: "P",
    // V2: the parent session's permissions read back (its allow is dropped; its deny is inherited first).
    parentPermissions: family === "v2" ? [{ action: "read", resource: "*", effect: "allow" }, { action: "bash", resource: "rm *", effect: "deny" }] : undefined,
    // V1: last assistant message `time.completed` per session (GET /session/:id/message).
    persistedCompleted: family === "v1" ? { P: 11, r0: 12, r1: 13, r2: 14, agg: 15 } : undefined,
    observations: {},
    expected: fx.expected,
    plugin: family === "v2" ? { entries: [{ source: { type: "package", target: fx.spec }, state: { status: "active" } }] } : null,
    agents: ["build", "council-plugin-reviewer", "council-plugin-aggregator"],
    children,
    created: children.map((child) => ({ sessionID: child.id, parentID: "P" })),
    ledger: ledger([
      { sessionID: "P", model: fx.parentModel, tools: ["read", "council_review"], step: 0, outcome: "tool_call" },
      ...REVIEWERS.map((reviewer: { modelID: string }, index: number) => ({ sessionID: `r${index}`, parentSessionID: "P", model: reviewer.modelID, tools: ["read", "bash"] })),
      { sessionID: "agg", parentSessionID: "P", model: AGG.modelID, tools: [], nonces: REVIEWERS.map((reviewer: { marker: string }) => reviewer.marker) },
      { sessionID: "P", model: fx.parentModel, tools: ["read", "council_review"], step: 1 },
    ]),
    // The parent's council_review calls from the DURABLE record (V2 messages / V1 parts).
    parentToolCalls: [{ callID: "t1", status: "completed", text: `## Aggregated\n${AGG.marker}`, error: null, truncated: false }],
    parentToolPagesExceeded: false,
    finals: { P: "terminal", r0: "terminal", r1: "terminal", r2: "terminal", agg: "terminal" },
  };
}

function s1Evidence(family: "v1" | "v2") {
  const s1 = fixtureFor("s1", { nonce: NONCE });
  return {
    scenario: "s1",
    family,
    parentSessionID: "P",
    expected: s1.expected,
    plugin: family === "v2" ? { entries: [{ source: { type: "package", target: s1.spec }, state: { status: "active" } }] } : null,
    agents: ["build", "council-plugin-reviewer", "council-plugin-aggregator"],
    children: [],
    created: [],
    ledger: ledger([{ sessionID: "P", model: s1.parentModel, tools: ["read", "council_review"] }]),
    parentToolCalls: [],
    finals: { P: "terminal" },
  };
}

const failed = (result: { checks: { id: string; ok: boolean }[] }) => result.checks.filter((check) => !check.ok).map((check) => check.id);

describe("fixtures", () => {
  it("S1: parent answers with text; S2: parent calls council_review with the nonce, 3 required reviewers, distinct aggregator", () => {
    const s1 = fixtureFor("s1", { nonce: NONCE });
    expect(s1.models[s1.parentModel]).toEqual([{ type: "text", text: `parent-s1-${NONCE}` }]);
    expect(fx.models[fx.parentModel][0]).toEqual({ type: "tool_call", name: "council_review", args: { prompt: `council-review-${NONCE}` } });
    expect(fx.council.models).toHaveLength(3);
    expect(fx.council.aggregator_model).toEqual({ providerID: "fake", modelID: AGG.modelID });
    // The aggregator is a MAIN request (known session), even with tools omitted: a plain script.
    expect(fx.models[AGG.modelID]).toEqual([{ type: "text", text: AGG.marker }]);
    expect(new Set([fx.parentModel, ...REVIEWERS.map((r: { modelID: string }) => r.modelID), AGG.modelID]).size).toBe(5);
    expect(fx.spec).toBe("@skwid138/opencode-council@0.3.0");
    expect(() => fixtureFor("s99", { nonce: NONCE })).toThrow(/no fixture for scenario s99/);
  });
});

describe.each(["v1", "v2"] as const)("S1 evaluator (%s)", (family) => {
  it("passes on complete evidence", () => {
    const result = evaluate(s1Evidence(family));
    expect(failed(result)).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });

  it.each([
    ["s1.parent-positive-control", (e: ReturnType<typeof s1Evidence>) => (e.ledger[0].tools = ["read"])],
    ["s1.parent-positive-control", (e: ReturnType<typeof s1Evidence>) => (e.ledger[0].tools = ["execute"])],
    ["s1.parent-positive-control", (e: ReturnType<typeof s1Evidence>) => (e.ledger = [])],
    ["s1.bundled-agents", (e: ReturnType<typeof s1Evidence>) => (e.agents = ["build", "council-plugin-reviewer"])],
    ["attribution", (e: ReturnType<typeof s1Evidence>) => e.ledger.push({ ...e.ledger[0], sessionID: "stranger" })],
    ["attribution", (e: ReturnType<typeof s1Evidence>) => e.ledger.push({ ...e.ledger[0], kind: "unidentified", sessionID: null })],
    ["aux-suppressed", (e: ReturnType<typeof s1Evidence>) => e.ledger.push({ ...e.ledger[0], seq: 9, kind: "auxiliary", auxiliary: "title", classification: "title", tools: [] } as never)],
    ["aux-suppressed", (e: ReturnType<typeof s1Evidence>) => e.ledger.push({ ...e.ledger[0], seq: 9, kind: "auxiliary", auxiliary: "v2-compaction", classification: "v2-compaction" } as never)],
  ])("fails %s when mutated", (id, mutate) => {
    const evidence = s1Evidence(family);
    mutate(evidence);
    const result = evaluate(evidence);
    expect(result.verdict).toBe("FAIL");
    expect(failed(result)).toContain(id);
  });
});

it("S1 V2: requires exactly one active inventory entry for the exact spec", () => {
  for (const plugin of [{ entries: [] }, { entries: [{ source: { type: "package", target: "@skwid138/opencode-council@0.2.0" }, state: { status: "active" } }] }, { entries: [{ source: { type: "package", target: fixtureFor("s1", { nonce: NONCE }).spec }, state: { status: "failed" } }] }, null]) {
    const evidence = s1Evidence("v2");
    evidence.plugin = plugin as never;
    expect(failed(evaluate(evidence))).toContain("s1.plugin-active");
  }
});

describe.each(["v1", "v2"] as const)("S2 evaluator (%s)", (family) => {
  it("passes on complete evidence", () => {
    const result = evaluate(s2Evidence(family));
    expect(failed(result)).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });

  type E = ReturnType<typeof s2Evidence>;
  it.each([
    ["s2.children-cardinality", (e: E) => e.children.pop()],
    ["s2.children-cardinality", (e: E) => e.children.push({ ...e.children[0], id: "extra" })],
    ["s2.children-cardinality", (e: E) => (e.children[0].parentID = "OTHER")],
    ["s2.children-cardinality", (e: E) => e.created.push({ sessionID: "r0", parentID: "P" })],
    ["s2.child-identity", (e: E) => (e.children[0].agent = "build")],
    ["s2.child-identity", (e: E) => (e.children[1].model = { providerID: "fake", modelID: e.children[0].model.modelID })],
    ["s2.child-identity", (e: E) => (e.children[3].model = { providerID: "fake", modelID: "parent" })],
    ["s2.tool-hidden", (e: E) => (e.ledger[1].tools = ["read", "council_review"])],
    ["s2.tool-hidden", (e: E) => (e.ledger[4].tools = ["council_review"])],
    ["s2.tool-hidden", (e: E) => (e.ledger[0].tools = ["read"])],
    ["s2.aggregator-tools-recorded", (e: E) => e.ledger.splice(4, 1)],
    ["s2.reviewer-markers", (e: E) => (e.ledger[4].nonces = [REVIEWERS[0].marker])],
    ["s2.result-marker", (e: E) => (e.parentToolCalls[0].text = "no marker")],
    ["s2.result-marker", (e: E) => (e.parentToolCalls[0] = { ...e.parentToolCalls[0], status: "error", error: "x" } as never)],
    ["s2.result-marker", (e: E) => (e.parentToolCalls = [])],
    ["s2.result-marker", (e: E) => e.parentToolCalls.push({ ...e.parentToolCalls[0], callID: "t2" })],
    ["s2.result-marker", (e: E) => (e.parentToolCalls = undefined as never)],
    ["s2.result-marker", (e: E) => (e.parentToolPagesExceeded = true)],
    ["s2.settled", (e: E) => delete (e.finals as Record<string, string>).r1],
    ["s2.settled", (e: E) => delete (e.finals as Record<string, string>).P],
    ["attribution", (e: E) => e.ledger.push({ ...e.ledger[1], sessionID: "unknown" })],
    ["attribution", (e: E) => e.ledger.push({ ...e.ledger[1], kind: "budget-exceeded" })],
    ["attribution", (e: E) => e.ledger.push({ ...e.ledger[1], kind: "unidentified", sessionID: "P" })],
    // Suppression (title disabled, auto-compaction off, V2 warming off) is proven by the
    // ABSENCE of auxiliary requests: any one -- even from a known session -- FAILs S2.
    ["aux-suppressed", (e: E) => e.ledger.push({ ...e.ledger[5], seq: 50, kind: "auxiliary", auxiliary: "title", classification: "title", tools: [] } as never)],
    ["aux-suppressed", (e: E) => e.ledger.push({ ...e.ledger[1], seq: 51, kind: "auxiliary", auxiliary: "v1-compaction", classification: "v1-compaction", parentSessionID: null } as never)],
    ["attribution", (e: E) => e.ledger.push({ ...e.ledger[5], seq: 52, kind: "auxiliary", auxiliary: "title", sessionID: "stranger" } as never)],
    // Every reviewer / aggregator child needs >= 1 attributable request; each request's model
    // must match that child's metadata model and its parent header must be the parent id.
    ["s2.request-attribution", (e: E) => e.ledger.splice(2, 1)],
    ["s2.request-attribution", (e: E) => (e.ledger[1].model = REVIEWERS[1].modelID)],
    ["s2.request-attribution", (e: E) => (e.ledger[1].parentSessionID = "OTHER")],
    ["s2.request-attribution", (e: E) => (e.ledger[1].parentSessionID = null as never)],
    ["s2.request-attribution", (e: E) => e.ledger.push({ ...e.ledger[1], seq: 99, model: "aggregator" })],
    ["s2.request-attribution", (e: E) => (e.ledger[4].model = "parent")],
    ["s2.request-attribution", (e: E) => e.ledger.splice(4, 1)],
    // The aggregator's provider-facing tools: exactly the allowed set (empty on both hosts).
    ["s2.aggregator-tools-restricted", (e: E) => (e.ledger[4].tools = ["read"])],
    ["s2.aggregator-tools-restricted", (e: E) => (e.ledger[4].tools = family === "v2" ? ["shell"] : ["bash"])],
    ["s2.aggregator-tools-restricted", (e: E) => (e.ledger[4].tools = ["edit"])],
    ["s2.aggregator-tools-restricted", (e: E) => e.ledger.splice(4, 1)],
  ])("fails %s when mutated", (id, mutate) => {
    const evidence = s2Evidence(family);
    mutate(evidence);
    const result = evaluate(evidence);
    expect(result.verdict).toBe("FAIL");
    expect(failed(result)).toContain(id);
  });
});

it("S2 V2: aggregator permissions are exactly parent denies -> * deny -> final council_review deny (no allow after the wildcard)", () => {
  const PARENT_DENY = { action: "bash", resource: "rm *", effect: "deny" };
  const STAR = { action: "*", resource: "*", effect: "deny" };
  const FINAL = { action: "council_review", resource: "*", effect: "deny" };
  for (const permissions of [
    [FINAL],
    [STAR],
    [PARENT_DENY, STAR],
    [FINAL, STAR],
    [STAR, FINAL], // parent deny missing
    [PARENT_DENY, STAR, { action: "read", resource: "*", effect: "allow" }, FINAL], // allow after the wildcard
    [PARENT_DENY, STAR, { action: "edit", resource: "*", effect: "deny" }, FINAL], // extra rule
    [PARENT_DENY, STAR, FINAL, { action: "edit", resource: "*", effect: "deny" }], // trailing extra: the final deny is not last
    [STAR, PARENT_DENY, FINAL], // order
    [{ action: "read", resource: "*", effect: "allow" }, PARENT_DENY, STAR, FINAL], // parent allow must be dropped
    undefined,
  ]) {
    const evidence = s2Evidence("v2");
    evidence.children[3].permissions = permissions as never;
    expect(failed(evaluate(evidence))).toContain("s2.v2-aggregator-permissions");
  }
  expect(failed(evaluate(s2Evidence("v1")))).not.toContain("s2.v2-aggregator-permissions");
});

describe("S2 V2: parent permissions mirror src/v2-permissions.ts parentDenyRules EXACTLY (absent -> []; null -> malformed)", () => {
  const STAR = { action: "*", resource: "*", effect: "deny" };
  const FINAL = { action: "council_review", resource: "*", effect: "deny" };
  const PARENT_DENY = { action: "bash", resource: "rm *", effect: "deny" };
  type WithPresence = ReturnType<typeof s2Evidence> & { parentPermissionsPresent?: boolean };

  it.each([
    ["absent on the parent session (parentPermissionsPresent: false)", (e: WithPresence) => ((e.parentPermissionsPresent = false), (e.parentPermissions = undefined as never))],
    ["undefined (no presence flag)", (e: WithPresence) => (e.parentPermissions = undefined as never)],
  ])("parent permissions %s -> expected aggregator rules are exactly * deny -> council_review deny", (_label, mutate) => {
    const evidence = s2Evidence("v2") as WithPresence;
    mutate(evidence);
    evidence.children[3].permissions = [STAR, FINAL] as never;
    expect(evaluate(evidence).verdict).toBe("PASS");
    // ...and a parent deny that is not on the (absent) parent is rejected.
    evidence.children[3].permissions = [PARENT_DENY, STAR, FINAL] as never;
    expect(failed(evaluate(evidence))).toEqual(["s2.v2-aggregator-permissions"]);
  });

  it("an explicit `permissions: null` is MALFORMED (parentDenyRules throws on any non-array) -> FAIL", () => {
    const evidence = s2Evidence("v2") as WithPresence;
    evidence.parentPermissionsPresent = true;
    evidence.parentPermissions = null as never;
    evidence.children[3].permissions = [STAR, FINAL] as never;
    const result = evaluate(evidence);
    expect(failed(result)).toEqual(["s2.v2-aggregator-permissions"]);
    expect(result.checks.find((entry: { id: string }) => entry.id === "s2.v2-aggregator-permissions").detail).toMatch(/malformed parent session permissions: null/);
  });

  it("a parent with deny rules (and an allow, which is dropped) -> its denies, in order, come first", () => {
    const evidence = s2Evidence("v2");
    const second = { action: "edit", resource: "/x/*", effect: "deny" };
    evidence.parentPermissions = [PARENT_DENY, { action: "read", resource: "*", effect: "allow" }, second] as never;
    evidence.children[3].permissions = [PARENT_DENY, second, STAR, FINAL] as never;
    expect(evaluate(evidence).verdict).toBe("PASS");
    evidence.children[3].permissions = [second, PARENT_DENY, STAR, FINAL] as never;
    expect(failed(evaluate(evidence))).toEqual(["s2.v2-aggregator-permissions"]);
  });

  it.each([
    ["a non-array value", { action: "*" }],
    ["a malformed entry", [{ action: "bash", effect: "deny" }]],
    ["an unknown effect", [{ action: "bash", resource: "*", effect: "maybe" }]],
  ])("malformed parent permissions (%s) FAIL, as parentDenyRules throws", (_label, value) => {
    const evidence = s2Evidence("v2");
    evidence.parentPermissions = value as never;
    evidence.children[3].permissions = [STAR, FINAL] as never;
    expect(failed(evaluate(evidence))).toEqual(["s2.v2-aggregator-permissions"]);
  });

  it("an unreadable parent session FAILs (absence is only meaningful when the session was read)", () => {
    const evidence = s2Evidence("v2") as ReturnType<typeof s2Evidence> & { parentSessionRead?: boolean };
    evidence.parentPermissions = undefined as never;
    evidence.parentSessionRead = false;
    evidence.children[3].permissions = [STAR, FINAL] as never;
    expect(failed(evaluate(evidence))).toEqual(["s2.v2-aggregator-permissions"]);
  });
});

it("V1 aggregator tool inventory mirrors src AGGREGATOR_TOOLS (every bundled entry disabled -> empty); V2 has no source-justified intrinsic tool", () => {
  const enabled = Object.entries(AGGREGATOR_TOOLS).filter(([, on]) => on === true).map(([name]) => name);
  expect([...V1_AGGREGATOR_ALLOWED_TOOLS]).toEqual(enabled);
  expect([...V1_AGGREGATOR_ALLOWED_TOOLS]).toEqual([]);
  expect([...V2_AGGREGATOR_INTRINSIC_TOOLS]).toEqual([]);
});

describe("S2 V1 settlement needs persisted corroboration (last assistant message time.completed)", () => {
  it.each([
    ["a child without time.completed", (e: ReturnType<typeof s2Evidence>) => delete (e.persistedCompleted as Record<string, number>).r1],
    ["the parent without time.completed", (e: ReturnType<typeof s2Evidence>) => ((e.persistedCompleted as Record<string, unknown>).P = null)],
    ["no persisted record at all", (e: ReturnType<typeof s2Evidence>) => (e.persistedCompleted = undefined as never)],
    ["the aggregator with a non-numeric completed", (e: ReturnType<typeof s2Evidence>) => ((e.persistedCompleted as Record<string, unknown>).agg = "soon")],
  ])("FAILs s2.settled on %s even with every idle event", (_label, mutate) => {
    const evidence = s2Evidence("v1");
    mutate(evidence);
    const result = evaluate(evidence);
    expect(result.verdict).toBe("FAIL");
    expect(failed(result)).toEqual(["s2.settled"]);
  });

  it("does not require it on V2 (execution events are the V2 terminal record)", () => {
    const evidence = s2Evidence("v2");
    evidence.persistedCompleted = undefined as never;
    expect(evaluate(evidence).verdict).toBe("PASS");
  });
});

describe("bounded result evidence", () => {
  it("records sessions, per-request attribution (no bodies), aggregator permissions + tools, reviewer markers, creation events, and observations", () => {
    const evidence = s2Evidence("v2");
    evidence.observations = { "v2.agentsRoute": { status: 200, names: ["build"] } };
    const summary = summarizeEvidence(evidence);
    expect(summary.parentSessionID).toBe("P");
    expect(summary.sessions).toEqual([
      { id: "P", parentID: null, agent: null, model: null },
      ...evidence.children.map((child) => ({ id: child.id, parentID: "P", agent: child.agent, model: child.model })),
    ]);
    expect(summary.requests[1]).toEqual({ seq: 2, kind: "model", sessionID: "r0", parentSessionID: "P", model: REVIEWERS[0].modelID, tools: ["read", "bash"], nonces: [], systemMarkers: [], status: 200, classification: null, systemPrefixSha256: null });
    expect(summary.auxiliaryCount).toBe(0);
    expect(summary.aggregator).toEqual({ sessionID: "agg", permissions: evidence.children[3].permissions, tools: [[]] });
    expect(summary.reviewerMarkers).toEqual({ expected: REVIEWERS.map((r: { marker: string }) => r.marker), seenByAggregator: REVIEWERS.map((r: { marker: string }) => r.marker) });
    expect(summary.created).toEqual(evidence.created);
    expect(summary.observations).toEqual({ "v2.agentsRoute": { status: 200, names: ["build"] } });
    expect(summary.parentPermissions).toEqual(evidence.parentPermissions);
    expect(summary.truncated).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });

  it("bounds the WHOLE object: oversized permissions / observations / created are replaced by recorded truncation markers", () => {
    const evidence = s2Evidence("v2") as ReturnType<typeof s2Evidence> & Record<string, unknown>;
    const huge = (n: number) => Array.from({ length: n }, (_, i) => ({ action: `act-${i}`, resource: "r".repeat(120), effect: "deny" }));
    evidence.children[3].permissions = huge(2_000) as never;
    evidence.parentPermissions = huge(2_000) as never;
    evidence.observations = { "v2.modelRef": Array.from({ length: 3_000 }, (_, i) => ({ id: `c${i}`, model: { id: "m".repeat(100) } })) };
    evidence.created = Array.from({ length: 5_000 }, (_, i) => ({ sessionID: `s${i}`, parentID: "P" })) as never;
    const summary = summarizeEvidence(evidence);
    const size = Buffer.byteLength(JSON.stringify(summary));
    expect(size).toBeLessThanOrEqual(EVIDENCE_LIMITS.maxBytes);
    expect(summary.truncatedFields).toEqual(expect.arrayContaining(["aggregator.permissions", "parentPermissions", "observations"]));
    for (const marker of [summary.aggregator.permissions, summary.parentPermissions, summary.observations]) {
      expect(marker).toMatchObject({ truncated: true, bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(marker.bytes).toBeGreaterThan(64 * 1024);
    }
    // The small, decisive fields survive.
    expect(summary.parentSessionID).toBe("P");
    expect(summary.sessions).toHaveLength(5);
  });

  it("records no truncation for normal evidence", () => {
    const summary = summarizeEvidence(s2Evidence("v2"));
    expect(summary.truncatedFields).toEqual([]);
    expect(summary.truncated).toBe(false);
  });

  it("stays within its byte bound (well inside the 512 KiB frame / 1 MiB stdout caps) by truncating requests", () => {
    const evidence = s2Evidence("v1");
    for (let index = 0; index < 20_000; index += 1) evidence.ledger.push({ ...evidence.ledger[1], seq: 100 + index, tools: Array.from({ length: 64 }, (_, n) => `tool-${n}-${"x".repeat(100)}`) });
    const summary = summarizeEvidence(evidence);
    expect(summary.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(EVIDENCE_LIMITS.maxBytes);
    expect(EVIDENCE_LIMITS.maxBytes).toBeLessThanOrEqual(256 * 1024);
    expect(summary.requestCount).toBe(evidence.ledger.length);
  });
});

it("refuses to evaluate a scenario without an evaluator", () => {
  expect(() => evaluate({ ...s1Evidence("v1"), scenario: "s99" })).toThrow(/no evaluator/);
});

describe("S2 result marker is STRICT on the parent's durable council_review result (post Gate C p1a03)", () => {
  type E = ReturnType<typeof s2Evidence>;
  const detailOf = (evidence: E) => evaluate(evidence).checks.find((entry: { id: string }) => entry.id === "s2.result-marker");

  it.each([
    ["zero calls", (e: E) => (e.parentToolCalls = []), "0 council_review calls in the parent's durable record (expected exactly 1)"],
    ["two calls", (e: E) => e.parentToolCalls.push({ ...e.parentToolCalls[0], callID: "t2" }), "2 council_review calls in the parent's durable record (expected exactly 1)"],
    ["an error result", (e: E) => (e.parentToolCalls[0] = { ...e.parentToolCalls[0], status: "error", text: "", error: "aggregator failed" } as never), "council_review call t1 status error: aggregator failed"],
    ["a still-running call", (e: E) => (e.parentToolCalls[0] = { ...e.parentToolCalls[0], status: "running" } as never), "council_review call t1 status running"],
    ["the marker absent", (e: E) => (e.parentToolCalls[0].text = "## Aggregated\nnothing"), `aggregator marker ${AGG.marker} absent from the completed council_review result (t1)`],
    ["V1 truncated output without the marker", (e: E) => (e.parentToolCalls[0] = { ...e.parentToolCalls[0], text: "## Aggregated (cut)", truncated: true }), `aggregator marker ${AGG.marker} absent from the completed council_review result (t1); output truncated by the host (state.metadata.truncated / outputPath)`],
    ["message pages exceeded the bound", (e: E) => (e.parentToolPagesExceeded = true), "parent message pages exceeded the read bound; the council_review count is not proven"],
    ["no durable record at all", (e: E) => (e.parentToolCalls = undefined as never), "parent council_review calls were not read"],
  ])("%s -> FAIL with a clear detail", (_label, mutate, detail) => {
    const evidence = s2Evidence("v2");
    mutate(evidence);
    expect(detailOf(evidence)).toEqual({ id: "s2.result-marker", ok: false, detail });
  });

  it("a truncated V1 output that still contains the marker passes", () => {
    const evidence = s2Evidence("v1");
    evidence.parentToolCalls[0] = { ...evidence.parentToolCalls[0], truncated: true };
    expect(detailOf(evidence)?.ok).toBe(true);
  });
});
