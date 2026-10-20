import { describe, expect, it, vi } from "vitest";

import { writeSync } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpClient } from "./http.mjs";
import { assertNotTty, collectEvidence, createEventDiagnostics, defaultDeps, exactVersionOutput, expectedVersionStdout, PROBE_STDIO, probeEnv, redactHostLog, runCell, tailFile, writeProjectFiles } from "./runner.mjs";

/** Restores each key to its saved value: deletes keys that were absent, re-sets pre-existing values. */
function restoreEnv(saved: Map<string, string | undefined>) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
import { fixtureFor, summarizeEvidence } from "./scenarios.mjs";

type Req = { method: string; path: string; query?: Record<string, unknown>; body?: unknown; anonymous?: boolean };

/** Scripted host client: records every request in order and answers from `answer`. */
function fakeClient(answer: (req: Req) => { status: number; json?: unknown }) {
  const calls: Req[] = [];
  const request = async (req: Req) => {
    calls.push(req);
    const { status, json = null } = answer(req);
    return { status, json, text: json === null ? "" : JSON.stringify(json), headers: status === 401 ? { "www-authenticate": 'Basic realm="Secure Area"' } : {} };
  };
  // The auth handshake goes through `handshake` (raw node:http in production); same fake here.
  return { calls, client: { hasAuth: true, request, handshake: request } };
}

/** Event source the collector subscribes to; `emit` pushes normalized events. */
function fakeEvents() {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const seen: Record<string, unknown>[] = [];
  return {
    seen,
    events: {
      all: () => [...seen],
      waitFor: (predicate: (event: Record<string, unknown>) => boolean, { timeoutMs }: { timeoutMs: number }) =>
        new Promise((resolve, reject) => {
          const hit = seen.find(predicate);
          if (hit) return resolve(hit);
          const timer = setTimeout(() => reject(new Error(`event wait timed out after ${timeoutMs}ms`)), timeoutMs);
          const listener = (event: Record<string, unknown>) => {
            if (predicate(event)) {
              clearTimeout(timer);
              listeners.delete(listener);
              resolve(event);
            }
          };
          listeners.add(listener);
        }),
    },
    emit: (event: Record<string, unknown>) => {
      seen.push(event);
      for (const listener of [...listeners]) listener(event);
    },
  };
}

const TIMING = { phaseMs: 2_000, pollMs: 1 };

describe("collectEvidence (V2, S1)", () => {
  it("sends nothing before the auth challenge, subscribes before prompting, and records inventory, agents, and the parent's requests", async () => {
    const fx = fixtureFor("s1", { nonce: "n1" });
    const ev = fakeEvents();
    const order: string[] = [];
    const { client, calls } = fakeClient((req) => {
      order.push(`${req.method} ${req.path}${req.anonymous ? " (anon)" : ""}`);
      if (req.path === "/api/session" && req.method === "GET") return req.anonymous ? { status: 401 } : { status: 200, json: { data: [] } };
      if (req.path === "/api/plugin") return { status: 200, json: { data: [{ source: { type: "package", target: fx.spec }, state: { status: "active" } }] } };
      if (req.path === "/api/agent") return { status: 200, json: { data: [{ id: "build" }, { id: "council-plugin-reviewer" }, { id: "council-plugin-aggregator" }] } };
      if (req.path === "/api/session" && req.method === "POST") return { status: 200, json: { data: { id: "P" } } };
      if (req.path === "/api/session/P/prompt") {
        setTimeout(() => ev.emit({ kind: "session-final", sessionID: "P", outcome: "succeeded" }), 1);
        return { status: 200, json: { data: {} } };
      }
      if (req.path === "/api/experimental/session/P/wait") return { status: 204 };
      return { status: 404 };
    });
    const ledger = [{ seq: 1, kind: "model", sessionID: "P", model: "parent", tools: ["council_review"], nonces: [] }];
    const evidence = await collectEvidence({
      scenario: "s1",
      family: "v2",
      fixture: fx,
      project: "/scratch/p",
      client,
      events: { ...ev.events, subscribe: async () => void order.push("SUBSCRIBED") },
      provider: { ledger: () => ledger, registerParent: (id: string) => void order.push(`REGISTER ${id}`) },
      signal: new AbortController().signal,
      timing: TIMING,
    });

    expect(order[0]).toBe("GET /api/session (anon)");
    expect(order[1]).toBe("GET /api/session");
    expect(order.indexOf("SUBSCRIBED")).toBeLessThan(order.indexOf("POST /api/session/P/prompt"));
    // The fake provider learns the parent session BEFORE the prompt (known session -> main).
    expect(order.indexOf("REGISTER P")).toBeGreaterThan(order.indexOf("POST /api/session"));
    expect(order.indexOf("REGISTER P")).toBeLessThan(order.indexOf("POST /api/session/P/prompt"));
    expect(calls.find((call) => call.path === "/api/session/P/prompt")?.body).toEqual({ text: "rh council cell n1" });
    expect(evidence).toMatchObject({ scenario: "s1", family: "v2", parentSessionID: "P", agents: ["build", "council-plugin-reviewer", "council-plugin-aggregator"], children: [], finals: { P: "terminal" } });
    expect(evidence.plugin.entries).toHaveLength(1);
    expect(evidence.ledger).toEqual(ledger);
  });

  it("refuses to continue when the listener does not challenge an anonymous request", async () => {
    const { client, calls } = fakeClient(() => ({ status: 200, json: { data: [] } }));
    await expect(
      collectEvidence({ scenario: "s1", family: "v2", fixture: fixtureFor("s1", { nonce: "n" }), project: "/p", client, events: { ...fakeEvents().events, subscribe: async () => {} }, provider: { ledger: () => [] }, signal: new AbortController().signal, timing: TIMING }),
    ).rejects.toThrow(/EAUTHCHALLENGE/);
    expect(calls).toHaveLength(1);
  });
});

describe("collectEvidence (V2, S2)", () => {
  it("joins children from the host, reads each child's agent/model/permissions, and takes the parent council_review result from its durable messages (SSE is diagnostic only)", async () => {
    const fx = fixtureFor("s2", { nonce: "n2" });
    const ev = fakeEvents();
    const kids = ["r0", "r1", "r2", "agg"];
    const meta: Record<string, unknown> = {
      P: { id: "P", agent: "build", model: { providerID: "fake", id: "parent" }, permissions: [{ action: "read", resource: "*", effect: "allow" }, { action: "bash", resource: "rm *", effect: "deny" }] },
      r0: { id: "r0", parentID: "P", agent: "council-plugin-reviewer", model: { providerID: "fake", id: "reviewer-a" }, permissions: [] },
      r1: { id: "r1", parentID: "P", agent: "council-plugin-reviewer", model: { providerID: "fake", id: "reviewer-b" }, permissions: [] },
      r2: { id: "r2", parentID: "P", agent: "council-plugin-reviewer", model: { providerID: "fake", id: "reviewer-c" }, permissions: [] },
      agg: { id: "agg", parentID: "P", agent: "council-plugin-aggregator", model: { providerID: "fake", id: "aggregator" }, permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "council_review", resource: "*", effect: "deny" }] },
    };
    const { client } = fakeClient((req) => {
      if (req.path === "/api/session" && req.method === "GET" && req.query?.parentID === "P") return { status: 200, json: { data: kids.map((id) => meta[id]) } };
      if (req.path === "/api/session" && req.method === "GET") return req.anonymous ? { status: 401 } : { status: 200, json: { data: [] } };
      if (req.path === "/api/plugin") return { status: 200, json: { data: [] } };
      if (req.path === "/api/agent") return { status: 200, json: { data: [] } };
      if (req.path === "/api/session" && req.method === "POST") return { status: 200, json: { data: { id: "P" } } };
      if (req.path === "/api/session/P/prompt") {
        setTimeout(() => {
          for (const id of kids) ev.emit({ kind: "session-created", sessionID: id, parentID: "P", shape: { keys: ["info"], infoKeys: ["id", "parentID"] } });
          for (const id of kids) ev.emit({ kind: "session-final", sessionID: id, outcome: "succeeded" });
          // Verified V2 SSE: the name only on input.started; success has no `tool` (diagnostic only).
          ev.emit({ kind: "tool-input-started", sessionID: "P", callID: "t1", tool: "council_review" });
          ev.emit({ kind: "tool-terminal", sessionID: "P", callID: "t1", tool: null, status: "completed", output: "AGGREGATE-n2", error: null, interrupted: false });
          // Another tool's terminal (correlated by sessionID + call id) and a same-id call in a child are not counted.
          ev.emit({ kind: "tool-input-started", sessionID: "P", callID: "t2", tool: "read" });
          ev.emit({ kind: "tool-terminal", sessionID: "P", callID: "t2", tool: null, status: "completed", output: "x", error: null, interrupted: false });
          ev.emit({ kind: "tool-input-started", sessionID: "r0", callID: "t1", tool: "council_review" });
          ev.emit({ kind: "tool-terminal", sessionID: "r0", callID: "t1", tool: null, status: "completed", output: "x", error: null, interrupted: false });
          ev.emit({ kind: "session-final", sessionID: "P", outcome: "succeeded" });
        }, 1);
        return { status: 200, json: { data: {} } };
      }
      // Durable parent messages (source of truth for the council_review result).
      if (req.path === "/api/session/P/message") {
        return { status: 200, json: { data: [{ id: "m2", type: "assistant", content: [{ type: "text", text: "done" }] }, { id: "m1", type: "assistant", content: [{ type: "tool", id: "t1", name: "council_review", time: { created: 1 }, state: { status: "completed", input: {}, content: [{ type: "text", text: "## Agg\n" }, { type: "text", text: "AGGREGATE-n2" }] } }] }], cursor: {} } };
      }
      if (req.path.startsWith("/api/session/") && req.method === "GET") return { status: 200, json: { data: meta[decodeURIComponent(req.path.split("/").at(-1) as string)] } };
      if (req.path === "/api/experimental/session/P/wait") return { status: 204 };
      return { status: 404 };
    });
    const ledger = [
      { seq: 1, kind: "model", sessionID: "P", model: "parent", tools: ["council_review"], nonces: [] },
      { seq: 2, kind: "auxiliary", sessionID: "P", model: "parent", tools: [], nonces: [], auxiliary: "title" },
      // Raw prompt text IS present in this input ledger entry (as a buggy provider might record it):
      // the persisted evidence (observations + summarizeEvidence) must still not carry it.
      { seq: 3, kind: "unidentified", sessionID: "P", model: "parent", tools: [], nonces: [], classification: "unknown", systemPrefixSha256: "f".repeat(64), systemPrefix: "You are a summarizer RAW-PROMPT-TEXT", messages: [{ role: "user", content: "RAW-PROMPT-TEXT body" }] },
    ];
    const evidence = await collectEvidence({ scenario: "s2", family: "v2", fixture: fx, project: "/p", client, events: { ...ev.events, subscribe: async () => {} }, provider: { ledger: () => ledger }, signal: new AbortController().signal, timing: TIMING });
    expect(evidence.parentPermissions).toEqual([{ action: "read", resource: "*", effect: "allow" }, { action: "bash", resource: "rm *", effect: "deny" }]);
    expect(evidence.parentSessionRead).toBe(true);
    expect(evidence.parentPermissionsPresent).toBe(true);
    expect(evidence.persistedCompleted).toBeUndefined();
    expect(evidence.observations).toEqual({
      "v2.providerConfig": { parentRequestModels: ["parent"] },
      "v2.modelRef": kids.map((id) => ({ id, model: (meta[id] as { model: unknown }).model })),
      "v2.agentsRoute": { status: 200, names: [] },
      "v2.sessionCreatedShape": [{ keys: ["info"], infoKeys: ["id", "parentID"] }],
      "v2.toolOutputSource": { source: "durable-messages", pages: 1, pagesExceeded: false, calls: 1, statuses: ["completed"], textBytes: "## Agg\nAGGREGATE-n2".length, sseCouncilReviewTerminals: 1 },
      "sse.events": null,
    });
    expect(Object.keys(evidence.observations)).toEqual(["v2.providerConfig", "v2.modelRef", "v2.agentsRoute", "v2.sessionCreatedShape", "v2.toolOutputSource", "sse.events"]);
    // The raw input really reached the collector (so the next assertions discriminate)...
    expect(JSON.stringify(evidence.ledger)).toContain("RAW-PROMPT-TEXT");
    // ...but nothing persisted carries it: only classifications / hashes.
    const persisted = summarizeEvidence(evidence);
    expect(JSON.stringify(persisted)).not.toContain("RAW-PROMPT-TEXT");
    expect(JSON.stringify(evidence.observations)).not.toContain("RAW-PROMPT-TEXT");
    expect(persisted.requests[2]).toMatchObject({ seq: 3, kind: "unidentified", classification: "unknown", systemPrefixSha256: "f".repeat(64) });
    expect(evidence.children.map((child: { id: string; model: unknown }) => [child.id, child.model])).toEqual([
      ["r0", { providerID: "fake", modelID: "reviewer-a" }],
      ["r1", { providerID: "fake", modelID: "reviewer-b" }],
      ["r2", { providerID: "fake", modelID: "reviewer-c" }],
      ["agg", { providerID: "fake", modelID: "aggregator" }],
    ]);
    expect(evidence.children[3].permissions).toHaveLength(2);
    expect(evidence.created).toHaveLength(4);
    expect(evidence.parentToolCalls).toEqual([{ callID: "t1", status: "completed", text: "## Agg\nAGGREGATE-n2", error: null, truncated: false }]);
    expect(evidence.parentToolPagesExceeded).toBe(false);
    expect(evidence.finals).toEqual({ P: "terminal", r0: "terminal", r1: "terminal", r2: "terminal", agg: "terminal" });
  });
});

describe("collectEvidence (V2, S2): absent parent permissions are preserved, not dropped", () => {
  async function collectWithParent(parent: { status: number; json?: unknown }) {
    const fx = fixtureFor("s2", { nonce: "n4" });
    const ev = fakeEvents();
    const { client } = fakeClient((req) => {
      if (req.path === "/api/session" && req.method === "GET" && req.query?.parentID === "P") return { status: 200, json: { data: [] } };
      if (req.path === "/api/session" && req.method === "GET") return req.anonymous ? { status: 401 } : { status: 200, json: { data: [] } };
      if (req.path === "/api/plugin" || req.path === "/api/agent") return { status: 200, json: { data: [] } };
      if (req.path === "/api/session" && req.method === "POST") return { status: 200, json: { data: { id: "P" } } };
      if (req.path === "/api/session/P/prompt") {
        setTimeout(() => ev.emit({ kind: "session-final", sessionID: "P", outcome: "succeeded" }), 1);
        return { status: 200, json: { data: {} } };
      }
      if (req.path === "/api/session/P" && req.method === "GET") return parent;
      if (req.path === "/api/session/P/message") return { status: 200, json: { data: [], cursor: {} } };
      if (req.path === "/api/experimental/session/P/wait") return { status: 204 };
      return { status: 404 };
    });
    return collectEvidence({ scenario: "s2", family: "v2", fixture: fx, project: "/p", client, events: { ...ev.events, subscribe: async () => {} }, provider: { ledger: () => [] }, signal: new AbortController().signal, timing: TIMING });
  }

  it("a parent session without a permissions field -> parentPermissionsPresent: false (absence recorded explicitly), parentSessionRead: true", async () => {
    const evidence = await collectWithParent({ status: 200, json: { data: { id: "P", agent: "build" } } });
    expect(evidence.parentPermissionsPresent).toBe(false);
    expect(evidence.parentPermissions).toBeUndefined();
    expect(evidence.parentSessionRead).toBe(true);
  });

  it("an explicit `permissions: null` is kept as null with parentPermissionsPresent: true (distinct from absent)", async () => {
    const evidence = await collectWithParent({ status: 200, json: { data: { id: "P", permissions: null } } });
    expect(evidence.parentPermissionsPresent).toBe(true);
    expect(evidence.parentPermissions).toBeNull();
  });

  it("a non-array permissions value is kept as-is for the evaluator to reject", async () => {
    const evidence = await collectWithParent({ status: 200, json: { data: { id: "P", permissions: { bad: true } } } });
    expect(evidence.parentPermissionsPresent).toBe(true);
    expect(evidence.parentPermissions).toEqual({ bad: true });
  });

  it("an unreadable parent session -> parentSessionRead: false, parentPermissionsPresent: false", async () => {
    const evidence = await collectWithParent({ status: 500 });
    expect(evidence.parentSessionRead).toBe(false);
    expect(evidence.parentPermissionsPresent).toBe(false);
  });
});

describe("collectEvidence (V1)", () => {
  it("waits for the parent idle event (V1 has no wait route), derives child agent/model from messages, and reads the parent's council_review part", async () => {
    const fx = fixtureFor("s2", { nonce: "n3" });
    const ev = fakeEvents();
    const kids = ["r0", "r1", "r2", "agg"];
    const models: Record<string, [string, string]> = { P: ["build", "parent"], r0: ["council-plugin-reviewer", "reviewer-a"], r1: ["council-plugin-reviewer", "reviewer-b"], r2: ["council-plugin-reviewer", "reviewer-c"], agg: ["council-plugin-aggregator", "aggregator"] };
    const completed: Record<string, number | undefined> = { P: 100, r0: 101, r1: 102, r2: undefined, agg: 104 };
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/session" && req.method === "GET") return req.anonymous ? { status: 401 } : { status: 200, json: [] };
      if (req.path === "/agent") return { status: 200, json: [{ name: "council-plugin-reviewer" }, { name: "council-plugin-aggregator" }] };
      if (req.path === "/session" && req.method === "POST") return { status: 200, json: { id: "P" } };
      if (req.path === "/session/P/prompt_async") {
        setTimeout(() => {
          for (const id of kids) ev.emit({ kind: "session-created", sessionID: id, parentID: "P" });
          for (const id of kids) ev.emit({ kind: "session-idle", sessionID: id });
          ev.emit({ kind: "tool-terminal", sessionID: "P", callID: "t1", tool: "council_review", status: "completed", output: "AGGREGATE-n3", error: null, interrupted: false });
          ev.emit({ kind: "session-idle", sessionID: "P" });
        }, 1);
        return { status: 204 };
      }
      if (req.path === "/session/P/children") return { status: 200, json: kids.map((id) => ({ id, parentID: "P" })) };
      const match = /^\/session\/([^/]+)\/message$/.exec(req.path);
      if (match) {
        const [agent, modelID] = models[match[1]];
        const time = completed[match[1]] === undefined ? { created: 1 } : { created: 1, completed: completed[match[1]] };
        // Verified V1 shape: info.agent / info.mode (agent name), top-level providerID / modelID; tool parts.
        const parts = match[1] === "P" ? [{ id: "prt1", sessionID: "P", messageID: "msg1", type: "tool", tool: "council_review", callID: "call1", state: { status: "completed", input: {}, output: "## Agg\nAGGREGATE-n3", title: "council", metadata: {}, time: { start: 1, end: 2 } } }] : [];
        return { status: 200, json: [{ info: { id: "msg0", role: "user", sessionID: match[1] }, parts: [] }, { info: { id: "msg1", role: "assistant", sessionID: match[1], parentID: "msg0", agent, mode: agent, providerID: "fake", modelID, time }, parts }] };
      }
      return { status: 404 };
    });
    const evidence = await collectEvidence({ scenario: "s2", family: "v1", fixture: fx, project: "/p", client, events: { ...ev.events, subscribe: async () => {} }, provider: { ledger: () => [] }, signal: new AbortController().signal, timing: TIMING });
    expect(calls.some((call) => call.path.includes("/wait"))).toBe(false);
    expect(calls.find((call) => call.path === "/session/P/prompt_async")?.query).toEqual({ directory: "/p" });
    expect(evidence.plugin).toBeNull();
    expect(evidence.agents).toEqual(["council-plugin-reviewer", "council-plugin-aggregator"]);
    expect(evidence.children.map((child: { agent: string; model: { modelID: string } }) => [child.agent, child.model.modelID])).toEqual(kids.map((id) => models[id]));
    expect(evidence.finals).toEqual({ P: "terminal", r0: "terminal", r1: "terminal", r2: "terminal", agg: "terminal" });
    // Persisted corroboration: last assistant message time.completed per session (r2 has none).
    expect(evidence.persistedCompleted).toEqual({ P: 100, r0: 101, r1: 102, r2: null, agg: 104 });
    expect(calls.filter((call) => call.path === "/session/P/message")).toHaveLength(1);
    expect(evidence.observations).toEqual({
      "v1.agentsRoute": { status: 200, names: ["council-plugin-reviewer", "council-plugin-aggregator"] },
      "v1.messageAgentModelFields": kids.map((id) => ({ id, agent: models[id][0], mode: models[id][0], providerID: "fake", modelID: models[id][1] })),
      "v1.toolOutput": { source: "durable-parts", calls: 1, statuses: ["completed"], textBytes: "## Agg\nAGGREGATE-n3".length, truncated: [false], sseCouncilReviewTerminals: 1 },
      "sse.events": null,
    });
    // Source of truth: the parent's durable council_review part (state.output); the parent's messages are read once.
    expect(evidence.parentToolCalls).toEqual([{ callID: "call1", status: "completed", text: "## Agg\nAGGREGATE-n3", error: null, truncated: false }]);
  });
});

describe("runCell lifecycle", () => {
  function infra(overrides: Record<string, unknown> = {}) {
    const order: string[] = [];
    const deps = {
      createFixture: vi.fn(async () => (order.push("fixture"), { root: "/scratch/rh-x", project: "/scratch/rh-x/project", run: "/scratch/rh-x/run", logs: "/scratch/rh-x/logs", home: "/scratch/rh-x/home", tmp: "/scratch/rh-x/tmp", xdg: { XDG_CACHE_HOME: "/c", XDG_CONFIG_HOME: "/f", XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s" } })),
      seedPluginCache: vi.fn(async () => order.push("seed")),
      startProvider: vi.fn(async () => (order.push("provider"), { baseURL: "http://127.0.0.1:4200/v1", provider: { ledger: () => [] }, close: async () => order.push("provider-closed") })),
      writeConfig: vi.fn(async () => (order.push("config"), "/scratch/rh-x/run/config.json")),
      launchHost: vi.fn(async () => (order.push("launch"), { port: 4100, password: "rh-" + "x".repeat(43) })),
      connect: vi.fn(async () => (order.push("connect"), { client: {}, events: {}, close: async () => order.push("events-closed") })),
      collect: vi.fn(async () => (order.push("collect"), { scenario: "s1" })),
      evaluate: vi.fn(() => ({ verdict: "PASS", checks: [{ id: "s1.x", ok: true, detail: "" }] })),
      stopAll: vi.fn(async () => (order.push("stop-owned"), [{ aliveAfter: false }])),
      removeFixture: vi.fn(async () => order.push("remove-fixture")),
      ...overrides,
    };
    return { deps, order };
  }
  const cell = { id: "v2-2.0.32:s1:1", host: "v2-2.0.32", scenario: "s1", rep: 1 };
  const manifest = { host: { id: "v2-2.0.32", executablePath: "/opt/x", executableSha256: "a".repeat(64) } };

  it("cleans up in order: stop owned processes, close streams and listeners, then remove the fixture", async () => {
    const { deps, order } = infra();
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps);
    expect(result.verdict).toBe("PASS");
    expect(order).toEqual(["fixture", "seed", "provider", "config", "launch", "connect", "collect", "stop-owned", "events-closed", "provider-closed", "remove-fixture"]);
  });

  it("still cleans up (and FAILs) when collection throws", async () => {
    const { deps, order } = infra({ collect: vi.fn(async () => { throw Object.assign(new Error("boom"), { code: "EX" }); }) });
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps);
    expect(result.verdict).toBe("FAIL");
    expect(result.checks[0]).toEqual({ id: "cell.collect", ok: false, detail: "Error EX" });
    expect(order.slice(-4)).toEqual(["stop-owned", "events-closed", "provider-closed", "remove-fixture"]);
  });

  it("fails and retains the fixture when an owned process survives shutdown", async () => {
    const { deps, order } = infra({ stopAll: vi.fn(async () => (order.push("stop-owned"), [{ aliveAfter: true, pgid: 7 }])) });
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps);
    expect(result.verdict).toBe("FAIL");
    expect(result.checks.map((check: { id: string }) => check.id)).toContain("cell.cleanup");
    expect(order).not.toContain("remove-fixture");
  });

  it("reports the unverified host shapes this cell relied on", async () => {
    const { deps } = infra();
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps);
    expect(result.summary.candidates).toEqual(["v2.providerConfig", "v2.modelRef", "v2.agentsRoute", "v2.sessionCreatedShape"]);
  });

  it("puts the bounded evidence object (with observations) into the result summary; null when collection failed", async () => {
    const { deps } = infra({ collect: vi.fn(async () => ({ scenario: "s1", family: "v2", parentSessionID: "P", children: [], created: [], ledger: [{ seq: 1, kind: "model", sessionID: "P", model: "parent", tools: ["council_review"], nonces: [], systemMarkers: [], status: 200 }], observations: { "v2.agentsRoute": { status: 200, names: ["build"] } } })) });
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps);
    expect(result.summary.evidence).toMatchObject({ scenario: "s1", parentSessionID: "P", requests: [{ seq: 1, sessionID: "P", model: "parent", tools: ["council_review"] }], observations: { "v2.agentsRoute": { status: 200, names: ["build"] } } });
    const failing = infra({ collect: vi.fn(async () => { throw new Error("boom"); }) });
    expect((await runCell({ cell, manifest, signal: new AbortController().signal }, failing.deps)).summary.evidence).toBeNull();
  });
});

describe("version probe cell", () => {
  const base = (order: string[]) => ({
    createFixture: async () => (order.push("fixture"), { root: "/scratch/rh-p", project: "/scratch/rh-p/project", run: "/r", logs: "/l", home: "/h", tmp: "/t", xdg: {} }),
    stopAll: async () => (order.push("stop-owned"), []),
    removeFixture: async () => order.push("remove-fixture"),
  });
  const probe = (stdout: string, extra: Record<string, unknown> = {}) => async () => ({ stdout, stderr: "", truncated: false, ...extra });
  const cellFor = (host: string) => ({ id: `${host}:probe:1`, host, scenario: "probe", rep: 1 });
  const manifestFor = (host: string, version: string) => ({ host: { id: host, version, executablePath: "/opt/x", executableSha256: "a".repeat(64) } });
  const run = (host: string, version: string, deps: Record<string, unknown>) => runCell({ cell: cellFor(host), manifest: manifestFor(host, version), signal: new AbortController().signal }, deps);

  it("V2: passes only on exactly `opencode v<version>\\n` (source-verified, non-TTY), records the expected string, and still cleans up", async () => {
    const order: string[] = [];
    const pass = await run("v2-2.0.32", "2.0.32", { ...base(order), probeVersion: probe("opencode v2.0.32\n") });
    expect(pass).toMatchObject({ verdict: "PASS", checks: [{ id: "probe.version", ok: true, detail: "" }] });
    expect(pass.summary.probe).toEqual({ expected: "opencode v2.0.32\n", stdoutBytes: 17, stderr: "", truncated: false });
    expect(order).toEqual(["fixture", "stop-owned", "remove-fixture"]);
    const bare = await run("v2-2.0.32", "2.0.32", { ...base([]), probeVersion: probe("2.0.32\n") });
    expect(bare.verdict).toBe("FAIL");
    expect(bare.checks[0].detail).toBe('printed "2.0.32\\n", expected exactly "opencode v2.0.32\\n" (v2 --version, non-TTY)');
    const truncated = await run("v2-2.0.32", "2.0.32", { ...base([]), probeVersion: probe("opencode v2.0.32\n", { truncated: true }) });
    expect(truncated.verdict).toBe("FAIL");
    expect(truncated.checks[0].detail).toMatch(/cap/);
    const noisy = await run("v2-2.0.28", "2.0.28", { ...base([]), probeVersion: probe("opencode v2.0.28\n", { stderr: "warning: x\n" }) });
    expect(noisy.verdict).toBe("PASS");
    expect(noisy.summary.probe).toMatchObject({ expected: "opencode v2.0.28\n", stderr: "warning: x\n" });
  });

  it("V1: passes only on exactly `<version>\\n`; V2-style output fails; the expected string is recorded", async () => {
    const pass = await run("v1-1.19.3", "1.19.3", { ...base([]), probeVersion: probe("1.19.3\n") });
    expect(pass.verdict).toBe("PASS");
    expect(pass.summary.probe.expected).toBe("1.19.3\n");
    const v2Style = await run("v1-1.19.3", "1.19.3", { ...base([]), probeVersion: probe("opencode v1.19.3\n") });
    expect(v2Style.verdict).toBe("FAIL");
    expect(v2Style.checks[0].detail).toBe('printed "opencode v1.19.3\\n", expected exactly "1.19.3\\n" (v1 --version, non-TTY)');
    const wrong = await run("v1-1.18.29", "1.18.29", { ...base([]), probeVersion: probe("1.19.3\n") });
    expect(wrong.verdict).toBe("FAIL");
  });

  it("expectedVersionStdout is pinned per family (source-verified at all 4 pins) and refuses an unknown family", () => {
    expect(expectedVersionStdout("v1", "1.18.29")).toBe("1.18.29\n");
    expect(expectedVersionStdout("v1", "1.19.3")).toBe("1.19.3\n");
    expect(expectedVersionStdout("v2", "2.0.28")).toBe("opencode v2.0.28\n");
    expect(expectedVersionStdout("v2", "2.0.32")).toBe("opencode v2.0.32\n");
    expect(() => expectedVersionStdout("v3", "3.0.0")).toThrow(/unknown host family/);
  });

  const ESC = "\u001b";
  it.each([
    // V1
    ["v1", "1.19.3", "exact with one trailing newline", "1.19.3\n", true],
    ["v1", "1.19.3", "exact without newline", "1.19.3", true],
    ["v1", "1.19.3", "V2-style prefix", "opencode v1.19.3\n", false],
    ["v1", "1.19.3", "prefix contamination", "opencode 1.19.3\n", false],
    ["v1", "1.19.3", "a v prefix", "v1.19.3\n", false],
    ["v1", "1.19.3", "a leading space", " 1.19.3\n", false],
    ["v1", "1.19.3", "a trailing space", "1.19.3 \n", false],
    ["v1", "1.19.3", "two trailing newlines", "1.19.3\n\n", false],
    ["v1", "1.19.3", "CRLF", "1.19.3\r\n", false],
    ["v1", "1.19.3", "a second line", "1.19.3\nupdate available\n", false],
    ["v1", "1.19.3", "a banner line first", "banner\n1.19.3\n", false],
    ["v1", "1.19.3", "another version", "1.18.29\n", false],
    ["v1", "1.19.3", "empty", "", false],
    // V2
    ["v2", "2.0.32", "exact with one trailing newline", "opencode v2.0.32\n", true],
    ["v2", "2.0.32", "exact without newline", "opencode v2.0.32", true],
    ["v2", "2.0.32", "bare version (V1 style)", "2.0.32\n", false],
    ["v2", "2.0.32", "no v", "opencode 2.0.32\n", false],
    ["v2", "2.0.32", "ANSI-styled (TTY formatter: bold name, dim v, bold version)", `${ESC}[1mopencode${ESC}[22m ${ESC}[2mv${ESC}[22m${ESC}[1m2.0.32${ESC}[22m\n`, false],
    ["v2", "2.0.32", "a trailing reset sequence", `opencode v2.0.32${ESC}[0m\n`, false],
    ["v2", "2.0.32", "another name", "opencodex v2.0.32\n", false],
    ["v2", "2.0.32", "a leading space", " opencode v2.0.32\n", false],
    ["v2", "2.0.32", "two spaces", "opencode  v2.0.32\n", false],
    ["v2", "2.0.32", "a trailing space", "opencode v2.0.32 \n", false],
    ["v2", "2.0.32", "two trailing newlines", "opencode v2.0.32\n\n", false],
    ["v2", "2.0.32", "CRLF", "opencode v2.0.32\r\n", false],
    ["v2", "2.0.32", "a second line", "opencode v2.0.32\nupdate available\n", false],
    ["v2", "2.0.32", "a banner line first", "banner\nopencode v2.0.32\n", false],
    ["v2", "2.0.32", "another version", "opencode v2.0.28\n", false],
    ["v2", "2.0.32", "empty", "", false],
  ])("exactVersionOutput %s %s: %s", (family, version, _label, stdout, ok) => {
    expect(exactVersionOutput(stdout, version, family)).toBe(ok);
  });
});

describe("version probe process environment (non-TTY; built from scratch)", () => {
  const fixture = { root: "/scratch/rh-p", project: "/scratch/rh-p/project", run: "/scratch/rh-p/run", logs: "/scratch/rh-p/logs", home: "/scratch/rh-p/home", tmp: "/scratch/rh-p/tmp", xdg: { XDG_CACHE_HOME: "/scratch/rh-p/xdg/cache", XDG_CONFIG_HOME: "/scratch/rh-p/xdg/config", XDG_DATA_HOME: "/scratch/rh-p/xdg/data", XDG_STATE_HOME: "/scratch/rh-p/xdg/state" } };

  it("contains only the fixture base keys: no OPENCODE_SSH_ASKPASS_PORT, OPENCODE_PRINT_LOGS, NO_COLOR, or any OPENCODE_* key", () => {
    const env = probeEnv(fixture);
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "SHELL", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
    for (const key of ["OPENCODE_SSH_ASKPASS_PORT", "OPENCODE_PRINT_LOGS", "NO_COLOR", "FORCE_COLOR", "TERM"]) expect(env).not.toHaveProperty(key);
    expect(Object.keys(env).filter((key) => key.startsWith("OPENCODE_"))).toEqual([]);
  });

  it("is built from scratch: the driver's own OPENCODE_SSH_ASKPASS_PORT / OPENCODE_PRINT_LOGS / FORCE_COLOR never leak in", () => {
    const KEYS = ["OPENCODE_SSH_ASKPASS_PORT", "OPENCODE_PRINT_LOGS", "FORCE_COLOR"] as const;
    // Snapshot presence AND value, so pre-existing values are restored exactly (not just absent keys deleted).
    const saved = new Map(KEYS.map((key) => [key, Object.hasOwn(process.env, key) ? process.env[key] : undefined]));
    try {
      Object.assign(process.env, { OPENCODE_SSH_ASKPASS_PORT: "4242", OPENCODE_PRINT_LOGS: "1", FORCE_COLOR: "1" });
      const env = probeEnv(fixture);
      for (const key of KEYS) expect(env).not.toHaveProperty(key);
    } finally {
      restoreEnv(saved);
    }
    for (const [key, value] of saved) expect(process.env[key]).toBe(value);
  });

  it("stdout / stderr are regular files, never a terminal (stdin ignored)", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-probe-stdio-")));
    try {
      const out = await open(join(dir, "version.out"), "wx", 0o600);
      try {
        expect(assertNotTty(out.fd)).toBeUndefined();
        // Every position: stdin ignored, stdout and stderr exactly the descriptors passed in.
        expect(PROBE_STDIO(out.fd, out.fd + 1000)).toEqual(["ignore", out.fd, out.fd + 1000]);
      } finally {
        await out.close();
      }
      expect(() => assertNotTty(-1, { isatty: () => true })).toThrow(/must not be a TTY/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


describe("restoreEnv (test helper used by the env-poisoning test)", () => {
  it("restores pre-existing values and deletes keys that were absent", () => {
    const key = "RH_RESTORE_PROBE_KEY";
    const absent = "RH_RESTORE_ABSENT_KEY";
    process.env[key] = "original";
    delete process.env[absent];
    const saved = new Map([[key, process.env[key]], [absent, undefined]]);
    process.env[key] = "poisoned";
    process.env[absent] = "poisoned";
    restoreEnv(saved);
    expect(process.env[key]).toBe("original");
    expect(Object.hasOwn(process.env, absent)).toBe(false);
    delete process.env[key];
  });
});

describe("real probe path (defaultDeps().probeVersion): the TTY refusal happens BEFORE any spawn", () => {
  async function probeFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-probe-path-")));
    const sub = (name: string) => join(root, name);
    for (const name of ["project", "logs", "home", "tmp", "xdg/cache", "xdg/config", "xdg/data", "xdg/state"]) await mkdir(sub(name), { recursive: true });
    return { root, project: sub("project"), run: sub("run"), logs: sub("logs"), home: sub("home"), tmp: sub("tmp"), xdg: { XDG_CACHE_HOME: sub("xdg/cache"), XDG_CONFIG_HOME: sub("xdg/config"), XDG_DATA_HOME: sub("xdg/data"), XDG_STATE_HOME: sub("xdg/state") } };
  }
  const manifest = { host: { id: "v2-2.0.32", version: "2.0.32", executablePath: "/opt/council-rh/bin/opencode-2.0.32", executableSha256: "a".repeat(64) } };

  it.each([
    ["stdout", 1],
    ["stderr", 2],
  ])("a TTY %s descriptor refuses with EPROBETTY and nothing is spawned", async (_label, ttyCall) => {
    const fixture = await probeFixture();
    try {
      const spawned: unknown[] = [];
      const fds: number[] = [];
      // The probe checks stdout first, then stderr: report a TTY on the selected check only.
      const isatty = (fd: number) => (fds.push(fd), fds.length === ttyCall);
      const deps = defaultDeps({ supervisor: { spawnOwned: async (...args: unknown[]) => (spawned.push(args), { exited: Promise.resolve({ code: 0 }) }) } as never, isatty });
      await expect(deps.probeVersion({ fixture, manifest, signal: new AbortController().signal })).rejects.toMatchObject({ code: "EPROBETTY" });
      expect(spawned).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("non-TTY files: spawns once with argv [--version], the probe env, and stdio [ignore, out, err] (the checked descriptors)", async () => {
    const fixture = await probeFixture();
    try {
      const checked: number[] = [];
      const calls: { command: string; args: string[]; options: { env: Record<string, string>; stdio: unknown[]; cwd: string } }[] = [];
      const supervisor = {
        spawnOwned: async (command: string, args: string[], options: { env: Record<string, string>; stdio: unknown[]; cwd: string }) => (calls.push({ command, args, options }), { exited: Promise.resolve({ code: 0 }) }),
      };
      const deps = defaultDeps({ supervisor: supervisor as never, isatty: (fd: number) => (checked.push(fd), false) });
      const result = await deps.probeVersion({ fixture, manifest, signal: new AbortController().signal });
      expect(result).toEqual({ stdout: "", stderr: "", truncated: false });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe(manifest.host.executablePath);
      expect(calls[0].args).toEqual(["--version"]);
      expect(calls[0].options.cwd).toBe(fixture.project);
      expect(calls[0].options.env).toEqual(probeEnv(fixture));
      expect(calls[0].options.stdio).toEqual(["ignore", checked[0], checked[1]]);
      expect(checked).toHaveLength(2);
      expect(checked[0]).not.toBe(checked[1]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Post Gate C p1a02: stable codes + sanitized details; host-log tail captured before removal.

describe("collectEvidence failures carry stable codes and sanitized details", () => {
  type Answer = (req: Req) => { status: number; json?: unknown } | null;
  /** Healthy V2 S2 host; `override` may replace any answer (return null to fall through). */
  function v2Host(override: Answer, ev: ReturnType<typeof fakeEvents>) {
    return fakeClient((req) => {
      const custom = override(req);
      if (custom) return custom;
      if (req.path === "/api/session" && req.method === "GET" && req.query?.parentID === "P") return { status: 200, json: { data: [{ id: "c1", parentID: "P" }] } };
      if (req.path === "/api/session" && req.method === "GET") return req.anonymous ? { status: 401 } : { status: 200, json: { data: [] } };
      if (req.path === "/api/plugin" || req.path === "/api/agent") return { status: 200, json: { data: [] } };
      if (req.path === "/api/session" && req.method === "POST") return { status: 200, json: { data: { id: "P" } } };
      if (req.path === "/api/session/P/prompt") {
        setTimeout(() => {
          ev.emit({ kind: "session-final", sessionID: "c1", outcome: "succeeded" });
          ev.emit({ kind: "session-final", sessionID: "P", outcome: "succeeded" });
        }, 1);
        return { status: 200, json: { data: {} } };
      }
      if (req.path === "/api/experimental/session/P/wait") return { status: 204 };
      if (req.path === "/api/session/c1") return { status: 200, json: { data: { id: "c1", parentID: "P", agent: "x", model: { providerID: "fake", id: "m" } } } };
      if (req.path === "/api/session/P") return { status: 200, json: { data: { id: "P" } } };
      return { status: 404 };
    });
  }
  const run = (scenario: "s1" | "s2", client: unknown, ev: ReturnType<typeof fakeEvents>) =>
    collectEvidence({ scenario, family: "v2", fixture: fixtureFor(scenario, { nonce: "c" }), project: "/scratch/secret-project", client: client as never, events: { ...ev.events, subscribe: async () => {} }, provider: { ledger: () => [] }, signal: new AbortController().signal, timing: TIMING });

  it.each([
    ["s1", "EPLUGININVENTORY", (req: Req) => (req.path === "/api/plugin" ? { status: 500 } : null), "plugin inventory GET /api/plugin?location[directory]=… -> 500"],
    ["s1", "EAGENTS", (req: Req) => (req.path === "/api/agent" ? { status: 404 } : null), "agents GET /api/agent?location[directory]=… -> 404"],
    ["s1", "ESESSIONCREATE", (req: Req) => (req.path === "/api/session" && req.method === "POST" ? { status: 400 } : null), "session create POST /api/session -> 400"],
    ["s1", "EPROMPT", (req: Req) => (req.path === "/api/session/P/prompt" ? { status: 409 } : null), "prompt POST /api/session/P/prompt -> 409"],
    ["s1", "EWAIT", (req: Req) => (req.path === "/api/experimental/session/P/wait" ? { status: 500 } : null), "wait POST /api/experimental/session/P/wait -> 500"],
    ["s2", "ECHILDREN", (req: Req) => (req.query?.parentID === "P" ? { status: 500 } : null), "children GET /api/session?parentID=… -> 500"],
    ["s2", "ESESSIONGET", (req: Req) => (req.path === "/api/session/c1" ? { status: 404 } : null), "session get GET /api/session/c1 -> 404"],
  ] as const)("%s %s", async (scenario, code, override, detail) => {
    const ev = fakeEvents();
    const error = (await run(scenario, v2Host(override, ev).client, ev).catch((caught: unknown) => caught)) as { code: string; detail: string; message: string };
    expect(error.code).toBe(code);
    expect(error.detail).toBe(detail);
    expect(JSON.stringify(error)).not.toMatch(/secret-project/);
  });

  it("V1 messages read failure -> EMESSAGES", async () => {
    const ev = fakeEvents();
    const { client } = fakeClient((req) => {
      if (req.path === "/session" && req.method === "GET") return req.anonymous ? { status: 401 } : { status: 200, json: [] };
      if (req.path === "/agent") return { status: 200, json: [] };
      if (req.path === "/session" && req.method === "POST") return { status: 200, json: { id: "P" } };
      if (req.path === "/session/P/prompt_async") {
        setTimeout(() => {
          ev.emit({ kind: "session-idle", sessionID: "c1" });
          ev.emit({ kind: "session-idle", sessionID: "P" });
        }, 1);
        return { status: 204 };
      }
      if (req.path === "/session/P/children") return { status: 200, json: [{ id: "c1", parentID: "P" }] };
      if (req.path === "/session/P/message") return { status: 500 };
      return { status: 404 };
    });
    const error = (await collectEvidence({ scenario: "s2", family: "v1", fixture: fixtureFor("s2", { nonce: "m" }), project: "/p", client: client as never, events: { ...ev.events, subscribe: async () => {} }, provider: { ledger: () => [] }, signal: new AbortController().signal, timing: TIMING }).catch((caught: unknown) => caught)) as { code: string; detail: string };
    expect(error).toMatchObject({ code: "EMESSAGES", detail: "messages GET /session/P/message?directory=… -> 500" });
  });
});

describe("runCell: failure details reach the result; host-log tail is captured BEFORE fixture removal and redacted", () => {
  const cell = { id: "v2-2.0.32:s1:1", host: "v2-2.0.32", scenario: "s1", rep: 1 };
  const manifest = { host: { id: "v2-2.0.32", executablePath: "/opt/x", executableSha256: "a".repeat(64) } };
  function infra(collect: () => Promise<unknown>) {
    const order: string[] = [];
    const deps = {
      createFixture: async () => ({ root: "/scratch/rh-x", project: "/scratch/rh-x/project", run: "/scratch/rh-x/run", logs: "/scratch/rh-x/logs", home: "/scratch/rh-x/home", tmp: "/scratch/rh-x/tmp", xdg: {} }),
      seedPluginCache: async () => {},
      startProvider: async () => ({ baseURL: "http://127.0.0.1:4200/v1", provider: { ledger: () => [] }, close: async () => order.push("provider-closed") }),
      writeConfig: async () => "/scratch/rh-x/run/config.json",
      launchHost: async () => ({ port: 4100, password: "rh-" + "x".repeat(43) }),
      connect: async () => ({ client: {}, events: {}, close: async () => order.push("events-closed") }),
      collect,
      evaluate: () => ({ verdict: "PASS", checks: [{ id: "s1.x", ok: true, detail: "" }] }),
      stopAll: async () => (order.push("stop-owned"), [{ aliveAfter: false }]),
      removeFixture: async () => order.push("remove-fixture"),
      logSummary: async () => (order.push("log-summary"), "server listening on http://127.0.0.1:4100"),
    };
    return { deps, order };
  }

  it("a coded harness error -> `cell.collect` detail `Error <CODE>: <detail>`", async () => {
    const error = Object.assign(new Error("EAUTHCHALLENGE: x"), { code: "EAUTHCHALLENGE", detail: "auth challenge GET /api/session -> 401, WWW-Authenticate absent; refusing to trust the port" });
    const { deps } = infra(async () => {
      throw error;
    });
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps);
    expect(result.checks[0]).toEqual({ id: "cell.collect", ok: false, detail: "Error EAUTHCHALLENGE: auth challenge GET /api/session -> 401, WWW-Authenticate absent; refusing to trust the port" });
  });

  it("an uncoded error still records only its class (no message leak)", async () => {
    const { deps } = infra(async () => {
      throw new Error("raw message with rh-secret-password");
    });
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps);
    expect(result.checks[0]).toEqual({ id: "cell.collect", ok: false, detail: "Error" });
  });

  it("the host-log tail is read after the processes stopped and BEFORE the fixture is removed", async () => {
    const { deps, order } = infra(async () => ({ scenario: "s1" }));
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps);
    expect(order).toEqual(["stop-owned", "log-summary", "events-closed", "provider-closed", "remove-fixture"]);
    expect(result.summary.hostLogTail).toBe("server listening on http://127.0.0.1:4100");
  });
});

describe("redactHostLog", () => {
  const password = "rh-" + "Q".repeat(43);
  const basic = Buffer.from(`opencode:${password}`).toString("base64");
  it("removes the password, Basic/Bearer tokens, Authorization values, and fixture paths; bounds to the tail", () => {
    const log = [
      `INFO start /scratch/rh-abc/project`,
      `DEBUG env OPENCODE_SERVER_PASSWORD=${password}`,
      `DEBUG authorization: Basic ${basic}`,
      `DEBUG Authorization=Bearer sk-live-abcdefgh12345678`,
      `DEBUG raw token ${basic} seen`,
      `server listening on http://127.0.0.1:4100`,
    ].join("\n");
    const out = redactHostLog(log, { secrets: [password], fixtureRoot: "/scratch" });
    expect(out).not.toContain(password);
    expect(out).not.toContain(basic);
    expect(out).not.toMatch(/sk-live/);
    expect(out).toContain("authorization: [redacted]");
    expect(out).toContain("Authorization=[redacted]");
    expect(out).toContain("<FIXTURE>/rh-abc/project");
    expect(out).toContain("server listening on http://127.0.0.1:4100");
    const long = redactHostLog(`${"x".repeat(10_000)}\nEND`, { secrets: [], fixtureRoot: "/scratch", maxBytes: 2048 });
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(2048);
    expect(long.endsWith("END")).toBe(true);
  });
});

describe("launchHost readiness on the real path (injected supervisor; nothing is executed)", () => {
  async function hostFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-launch-")));
    const sub = (name: string) => join(root, name);
    for (const name of ["project", "logs", "home", "tmp", "run", "xdg/cache", "xdg/config", "xdg/data", "xdg/state"]) await mkdir(sub(name), { recursive: true });
    return { root, project: sub("project"), run: sub("run"), logs: sub("logs"), home: sub("home"), tmp: sub("tmp"), xdg: { XDG_CACHE_HOME: sub("xdg/cache"), XDG_CONFIG_HOME: sub("xdg/config"), XDG_DATA_HOME: sub("xdg/data"), XDG_STATE_HOME: sub("xdg/state") } };
  }
  /** Fake supervisor: "starts" the host by writing `line(port)` into the log descriptor; never exits. */
  const writingSupervisor = (line: (port: number) => string) => ({
    spawnOwned: async (_command: string, args: string[], options: { stdio: number[] }) => {
      writeSync(options.stdio[1], `${line(Number(args[args.indexOf("--port") + 1]))}\n`);
      return { exited: new Promise(() => {}) };
    },
  });
  const manifest = { host: { id: "v2-2.0.32", executablePath: "/opt/council-rh/bin/opencode-2.0.32", executableSha256: "a".repeat(64) } };
  const timing = { phaseMs: 1_000, pollMs: 10, startupMs: 300 };

  it("V2: ready on the exact `server listening on http://127.0.0.1:<port>` line", async () => {
    const fixture = await hostFixture();
    try {
      const deps = defaultDeps({ timing, supervisor: writingSupervisor((port) => `server listening on http://127.0.0.1:${port}`) as never });
      const launched = await deps.launchHost({ fixture, manifest, family: "v2", configPath: join(fixture.run, "config.json"), signal: new AbortController().signal });
      expect(launched.port).toBeGreaterThan(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("V2: a bare port mention is NOT readiness -> EHOSTSTARTUP with listening-line / port-mention diagnostics; the password never appears", async () => {
    const fixture = await hostFixture();
    try {
      const deps = defaultDeps({ timing, supervisor: writingSupervisor((port) => `connecting to 127.0.0.1:${port}`) as never });
      const error = (await deps.launchHost({ fixture, manifest, family: "v2", configPath: join(fixture.run, "config.json"), signal: new AbortController().signal }).catch((caught: unknown) => caught)) as { code: string; detail: string };
      expect(error.code).toBe("EHOSTSTARTUP");
      expect(error.detail).toBe("host startup outcome startup-timeout within 300 ms; listening line seen: false; port mentioned: true");
      expect(JSON.stringify(error)).not.toMatch(/rh-[A-Za-z0-9_-]{20,}/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// Saruman audit of the post-p1a02 fix.

describe("transport / body-read failures surface in cell.collect as coded details (operation + route)", () => {
  const cell = { id: "v2-2.0.32:s1:1", host: "v2-2.0.32", scenario: "s1", rep: 1 };
  const manifest = { host: { id: "v2-2.0.32", executablePath: "/opt/x", executableSha256: "a".repeat(64) } };
  const SECRET = "secret-message-text";
  /** Real createHttpClient + real collectEvidence: the handshake passes, then the fetch transport misbehaves on /api/plugin. */
  function deps(onPlugin: () => Promise<unknown>) {
    const ev = fakeEvents();
    const handshakeTransport = async ({ headers }: { headers: Record<string, string> }) => (headers.authorization ? { status: 200, headers: {}, text: "[]" } : { status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' }, text: "" });
    const transport = async (url: string) => (url.includes("/api/plugin") ? onPlugin() : new Response("{}", { status: 200 }));
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4100", auth: { username: "opencode", password: "rh-" + "z".repeat(43) }, transport: transport as never, handshakeTransport: handshakeTransport as never });
    return {
      createFixture: async () => ({ root: "/scratch/rh-x", project: "/scratch/rh-x/project", run: "/scratch/rh-x/run", logs: "/scratch/rh-x/logs", home: "/scratch/rh-x/home", tmp: "/scratch/rh-x/tmp", xdg: {} }),
      seedPluginCache: async () => {},
      startProvider: async () => ({ baseURL: "http://127.0.0.1:4200/v1", provider: { ledger: () => [] }, close: async () => {} }),
      writeConfig: async () => "/scratch/rh-x/run/config.json",
      launchHost: async () => ({ port: 4100, password: "x" }),
      connect: async () => ({ client, events: { ...ev.events, subscribe: async () => {} }, close: async () => {} }),
      collect: collectEvidence,
      evaluate: () => ({ verdict: "PASS", checks: [{ id: "x", ok: true, detail: "" }] }),
      stopAll: async () => [],
      removeFixture: async () => {},
      timing: TIMING,
    };
  }

  it.each([
    ["a fetch rejection", () => Promise.reject(Object.assign(new TypeError(SECRET), { cause: { code: "ECONNREFUSED" } })), "Error EHTTPTRANSPORT: plugin inventory GET /api/plugin?location[directory]=… -> transport error TypeError ECONNREFUSED"],
    ["a body-read rejection", () => Promise.resolve({ status: 200, headers: new Headers(), text: () => Promise.reject(Object.assign(new TypeError(SECRET), { cause: { code: "ECONNRESET" } })) }), "Error EHTTPREAD: plugin inventory GET /api/plugin?location[directory]=… -> 200, body read error TypeError ECONNRESET"],
  ])("%s", async (_label, onPlugin, detail) => {
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps(onPlugin as () => Promise<unknown>) as never);
    expect(result.checks[0]).toEqual({ id: "cell.collect", ok: false, detail });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("redactHostLog regression table (audit)", () => {
  // Chosen so base64 has padding AND "+" / "/" (so base64 / base64url / unpadded really differ).
  const password = "rh-" + "???>>>".repeat(7) + "x";
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const b64url = (text: string) => Buffer.from(text).toString("base64url");
  const basicOf = `opencode:${password}`;
  const forms: [string, string][] = [
    ["raw password", password],
    ["base64(password) padded", b64(password)],
    ["base64(password) unpadded", b64(password).replace(/=+$/, "")],
    ["base64url(password)", b64url(password)],
    ["base64url(password) padded", b64url(password) + "=".repeat((4 - (b64url(password).length % 4)) % 4)],
    ["base64(opencode:password) padded", b64(basicOf)],
    ["base64(opencode:password) unpadded", b64(basicOf).replace(/=+$/, "")],
    ["base64url(opencode:password)", b64url(basicOf)],
  ];

  it("the table really has padded / unpadded / url-safe distinct variants", () => {
    expect(b64(password)).toMatch(/=$/);
    expect(b64(password)).toMatch(/[+/]/);
    expect(b64url(password)).not.toBe(b64(password).replace(/=+$/, ""));
  });

  it.each(forms)("%s is redacted", (_label, form) => {
    const out = redactHostLog(`before ${form} after`, { secrets: [password] });
    expect(out).toBe("before [redacted] after");
  });

  it.each([
    ['JSON "authorization"', '{"authorization":"Basic abcdefgh1234"}', '{"authorization":"[redacted]"}'],
    ['JSON "Authorization" with spaces', '{ "Authorization" : "Bearer tok-xyz-123456" }', '{ "Authorization" : "[redacted]" }'],
    ["lowercase basic scheme", "token basic abcdefgh1234== end", "token basic [redacted] end"],
    ["uppercase BEARER scheme", "BEARER abcdefgh1234 end", "BEARER [redacted] end"],
    ["header line", "authorization: Basic abcdefgh1234", "authorization: [redacted]"],
  ])("%s", (_label, input, expected) => {
    expect(redactHostLog(input, { secrets: [] })).toBe(expected);
  });

  it("a credential straddling the 2 KiB cut is redacted BEFORE the cut (no fragment survives)", () => {
    for (const form of [password, b64(basicOf)]) {
      for (const offset of [5, Math.floor(form.length / 2), form.length - 3]) {
        // The cut (last 2048 bytes) starts `offset` chars inside the credential.
        const text = `${"x".repeat(5_000)}${form}${"y".repeat(2048 - (form.length - offset))}`;
        const out = redactHostLog(text, { secrets: [password], maxBytes: 2048 });
        expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2048);
        for (let i = 0; i + 8 <= form.length; i += 1) expect(out).not.toContain(form.slice(i, i + 8));
      }
    }
  });
});

describe("tailFile reads only the last N bytes (fd + stat, read from max(0, size - N))", () => {
  it("returns the last N bytes and never reads more than N", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-tail-")));
    try {
      const path = join(dir, "host.log");
      await writeFile(path, `${"a".repeat(1_000_000)}TAIL-END`);
      const reads: { length: number; position: number }[] = [];
      const out = await tailFile(path, 16, { onRead: (length: number, position: number) => reads.push({ length, position }) });
      expect(out).toBe("aaaaaaaaTAIL-END");
      expect(reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(16);
      expect(reads[0].position).toBe(1_000_008 - 16);
      const small = join(dir, "small.log");
      await writeFile(small, "short");
      expect(await tailFile(small, 64)).toBe("short");
      expect(await tailFile(join(dir, "missing.log"), 64)).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// Post Gate C p1a03: durable parent tool result, SSE diagnostics, escaped-quote redaction.

describe("V2 durable parent messages: pagination, bound, coded failures", () => {
  /** Minimal V2 S2 host whose parent message route serves `pages` (index by cursor). */
  function v2S2(pages: (cursor: string | undefined) => { status: number; json?: unknown }) {
    const ev = fakeEvents();
    const kids = [
      { id: "agg", parentID: "P", agent: "council-plugin-aggregator", model: { providerID: "fake", id: "aggregator" }, permissions: [] },
    ];
    const fake = fakeClient((req) => {
      if (req.path === "/api/session" && req.method === "GET" && req.query?.parentID === "P") return { status: 200, json: { data: kids } };
      if (req.path === "/api/session" && req.method === "GET") return req.anonymous ? { status: 401 } : { status: 200, json: { data: [] } };
      if (req.path === "/api/plugin" || req.path === "/api/agent") return { status: 200, json: { data: [] } };
      if (req.path === "/api/session" && req.method === "POST") return { status: 200, json: { data: { id: "P" } } };
      if (req.path === "/api/session/P/prompt") {
        setTimeout(() => {
          ev.emit({ kind: "session-final", sessionID: "agg", outcome: "succeeded" });
          ev.emit({ kind: "session-final", sessionID: "P", outcome: "succeeded" });
        }, 1);
        return { status: 200, json: { data: {} } };
      }
      if (req.path === "/api/experimental/session/P/wait") return { status: 204 };
      if (req.path === "/api/session/P/message") return pages(req.query?.cursor as string | undefined);
      if (req.path === "/api/session/agg") return { status: 200, json: { data: kids[0] } };
      if (req.path === "/api/session/P") return { status: 200, json: { data: { id: "P" } } };
      return { status: 404 };
    });
    const run = () => collectEvidence({ scenario: "s2", family: "v2", fixture: fixtureFor("s2", { nonce: "pg" }), project: "/scratch/private", client: fake.client as never, events: { ...ev.events, subscribe: async () => {} }, provider: { ledger: () => [] }, signal: new AbortController().signal, timing: TIMING });
    return { run, calls: fake.calls };
  }
  const tool = (id: string, text: string) => ({ id: `m-${id}`, type: "assistant", content: [{ type: "tool", id, name: "council_review", state: { status: "completed", input: {}, content: [{ type: "text", text }] } }] });

  it("follows cursor.next WITHOUT order until the last page; finds the call on a later page", async () => {
    const host = v2S2((cursor) =>
      cursor === undefined ? { status: 200, json: { data: [{ id: "m9", type: "assistant", content: [] }], cursor: { next: "c2" } } } : cursor === "c2" ? { status: 200, json: { data: [tool("t1", "AGGREGATE-pg")], cursor: {} } } : { status: 500 },
    );
    const evidence = await host.run();
    const queries = host.calls.filter((call) => call.path === "/api/session/P/message").map((call) => call.query);
    expect(queries).toEqual([{ type: "assistant", order: "desc", limit: 200 }, { type: "assistant", cursor: "c2", limit: 200 }]);
    expect(evidence.parentToolCalls).toEqual([{ callID: "t1", status: "completed", text: "AGGREGATE-pg", error: null, truncated: false }]);
    expect(evidence.parentToolPagesExceeded).toBe(false);
  });

  it("stops at an empty page, and counts calls across ALL pages (duplicates are visible to the evaluator)", async () => {
    const host = v2S2((cursor) => (cursor === undefined ? { status: 200, json: { data: [tool("t1", "A")], cursor: { next: "c2" } } } : cursor === "c2" ? { status: 200, json: { data: [tool("t2", "B")], cursor: { next: "c3" } } } : { status: 200, json: { data: [], cursor: { next: "c4" } } }));
    const evidence = await host.run();
    expect(evidence.parentToolCalls.map((call: { callID: string }) => call.callID)).toEqual(["t1", "t2"]);
    expect(host.calls.filter((call) => call.path === "/api/session/P/message")).toHaveLength(3);
  });

  it("is bounded (10 pages): an endless cursor chain sets parentToolPagesExceeded", async () => {
    let n = 0;
    const host = v2S2(() => ({ status: 200, json: { data: [{ id: `m${n}`, type: "assistant", content: [] }], cursor: { next: `c${++n}` } } }));
    const evidence = await host.run();
    expect(host.calls.filter((call) => call.path === "/api/session/P/message")).toHaveLength(10);
    expect(evidence.parentToolPagesExceeded).toBe(true);
  });

  it("a repeated cursor stops reading and is treated as unproven (bound semantics)", async () => {
    const host = v2S2(() => ({ status: 200, json: { data: [tool("t1", "A")], cursor: { next: "same" } } }));
    const evidence = await host.run();
    expect(host.calls.filter((call) => call.path === "/api/session/P/message")).toHaveLength(2);
    expect(evidence.parentToolPagesExceeded).toBe(true);
  });

  it.each([
    ["a non-200 page", () => ({ status: 500 })],
    ["a page that is not { data: [] }", () => ({ status: 200, json: { data: {} } })],
  ])("%s -> EMESSAGES with the operation and the route (query keys only)", async (_label, page) => {
    const error = (await v2S2(page).run().catch((caught: unknown) => caught)) as { code: string; detail: string };
    expect(error.code).toBe("EMESSAGES");
    expect(error.detail).toMatch(/^parent messages GET \/api\/session\/P\/message\?type=…&order=…&limit=… -> (500|200)$/);
  });
});

describe("SSE diagnostics accumulator (bounded type counts + key shapes only)", () => {
  it("counts event types (capped distinct types) and records key shapes of tool events without values", () => {
    const diagnostics = createEventDiagnostics({ maxTypes: 3, maxShapes: 4 });
    diagnostics.record({ id: "e1", created: 1, type: "session.tool.input.started", durable: { aggregateID: "a", seq: 1, version: 1 }, data: { sessionID: "SECRET-SESSION", assistantMessageID: "m", id: "t1", name: "council_review" } });
    diagnostics.record({ id: "e2", created: 2, type: "session.tool.success", durable: {}, data: { sessionID: "s", assistantMessageID: "m", id: "t1", content: [{ type: "text", text: "SECRET-TEXT" }], executed: true } });
    diagnostics.record({ type: "message.part.updated", properties: { sessionID: "s", time: 1, part: { id: "p", sessionID: "s", messageID: "m", type: "tool", tool: "council_review", callID: "c", state: { status: "completed", input: {}, output: "SECRET-OUTPUT", title: "t", metadata: {}, time: {} } } } });
    diagnostics.record({ type: "message.part.updated", properties: { part: { type: "text", text: "x" } } });
    diagnostics.record({ type: "session.idle", properties: { sessionID: "s" } });
    diagnostics.record({ type: "session.idle", properties: { sessionID: "s" } });
    diagnostics.record(null);
    const snapshot = diagnostics.snapshot();
    expect(snapshot.typeCounts).toEqual({ "session.tool.input.started": 1, "session.tool.success": 1, "message.part.updated": 2 });
    expect(snapshot.otherTypes).toBe(3);
    expect(snapshot.toolShapes).toEqual([
      { type: "session.tool.input.started", keys: ["created", "data", "durable", "id", "type"], dataKeys: ["assistantMessageID", "id", "name", "sessionID"] },
      { type: "session.tool.success", keys: ["created", "data", "durable", "id", "type"], dataKeys: ["assistantMessageID", "content", "executed", "id", "sessionID"] },
      { type: "message.part.updated", keys: ["properties", "type"], propertiesKeys: ["part", "sessionID", "time"], partKeys: ["callID", "id", "messageID", "sessionID", "state", "tool", "type"], stateKeys: ["input", "metadata", "output", "status", "time", "title"] },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/SECRET/);
  });

  it("bounds the number of distinct shapes and the length of type names", () => {
    const diagnostics = createEventDiagnostics({ maxTypes: 64, maxShapes: 2 });
    for (let i = 0; i < 5; i += 1) diagnostics.record({ type: "session.tool.success", [`k${i}`]: 1, data: {} });
    diagnostics.record({ type: "x".repeat(500) });
    const snapshot = diagnostics.snapshot();
    expect(snapshot.toolShapes).toHaveLength(2);
    expect(snapshot.shapesDropped).toBe(3);
    expect(Object.keys(snapshot.typeCounts).every((key) => key.length <= 64)).toBe(true);
  });

  it("collectEvidence persists events.diagnostics() under observations['sse.events']", async () => {
    const fx = fixtureFor("s1", { nonce: "d" });
    const ev = fakeEvents();
    const { client } = fakeClient((req) => {
      if (req.path === "/session" && req.method === "GET") return req.anonymous ? { status: 401 } : { status: 200, json: [] };
      if (req.path === "/agent") return { status: 200, json: [{ name: "council-plugin-reviewer", mode: "subagent", permission: {}, options: {} }] };
      if (req.path === "/session" && req.method === "POST") return { status: 200, json: { id: "P" } };
      if (req.path === "/session/P/prompt_async") {
        setTimeout(() => ev.emit({ kind: "session-idle", sessionID: "P" }), 1);
        return { status: 204 };
      }
      return { status: 404 };
    });
    const diagnostics = { typeCounts: { "session.idle": 1 }, otherTypes: 0, toolShapes: [], shapesDropped: 0 };
    const evidence = await collectEvidence({ scenario: "s1", family: "v1", fixture: fx, project: "/p", client, events: { ...ev.events, subscribe: async () => {}, diagnostics: () => diagnostics }, provider: { ledger: () => [] }, signal: new AbortController().signal, timing: TIMING });
    expect(evidence.observations["sse.events"]).toEqual(diagnostics);
    expect(summarizeEvidence(evidence).observations["sse.events"]).toEqual(diagnostics);
  });
});

describe("summarizeEvidence keeps the parent tool result as status / sizes only", () => {
  it("never persists the result text", () => {
    const fx = fixtureFor("s2", { nonce: "sm" });
    const summary = summarizeEvidence({ scenario: "s2", family: "v2", parentSessionID: "P", expected: fx.expected, children: [], created: [], ledger: [], parentToolCalls: [{ callID: "t1", status: "completed", text: `BODY-TEXT ${fx.expected.aggregator.marker}`, error: null, truncated: false }], parentToolPagesExceeded: false, observations: {} });
    expect(summary.parentTool).toEqual({ pagesExceeded: false, calls: [{ callID: "t1", status: "completed", textBytes: Buffer.byteLength(`BODY-TEXT ${fx.expected.aggregator.marker}`), markerSeen: true, truncated: false, error: null }] });
    expect(JSON.stringify(summary)).not.toContain("BODY-TEXT");
  });
});

describe("redactHostLog: JSON authorization values with escaped quotes / backslashes", () => {
  it.each([
    ["Digest with escaped quotes", '{"Authorization":"Digest username=\\"opencode\\", response=\\"abc123\\""}', '{"Authorization":"[redacted]"}'],
    ["escaped backslash before an escaped quote", '{"authorization":"x\\\\\\"y\\\\z","next":"keep"}', '{"authorization":"[redacted]","next":"keep"}'],
    ["value ending in an escaped backslash", '{"authorization":"tok\\\\","next":"keep"}', '{"authorization":"[redacted]","next":"keep"}'],
    ["two objects on one line", '[{"authorization":"a\\"b"},{"authorization":"c"}]', '[{"authorization":"[redacted]"},{"authorization":"[redacted]"}]'],
  ])("%s", (_label, input, expected) => {
    expect(redactHostLog(input, { secrets: [] })).toBe(expected);
  });
});

describe("V1 collector reads only the source-verified fields (post Gate C p1a03)", () => {
  /** V1 S2 host: one child whose last assistant info is `childInfo`; agents route answers `agents`. */
  async function collectV1(childInfo: Record<string, unknown>, agents: unknown[] = []) {
    const ev = fakeEvents();
    const { client } = fakeClient((req) => {
      if (req.path === "/session" && req.method === "GET") return req.anonymous ? { status: 401 } : { status: 200, json: [] };
      if (req.path === "/agent") return { status: 200, json: agents };
      if (req.path === "/session" && req.method === "POST") return { status: 200, json: { id: "P" } };
      if (req.path === "/session/P/prompt_async") {
        setTimeout(() => {
          ev.emit({ kind: "session-idle", sessionID: "c1" });
          ev.emit({ kind: "session-idle", sessionID: "P" });
        }, 1);
        return { status: 204 };
      }
      if (req.path === "/session/P/children") return { status: 200, json: [{ id: "c1", parentID: "P" }] };
      if (req.path === "/session/P/message") return { status: 200, json: [{ info: { id: "m1", role: "assistant", sessionID: "P", agent: "build", mode: "build", providerID: "fake", modelID: "parent", time: { created: 1, completed: 2 } }, parts: [] }] };
      if (req.path === "/session/c1/message") return { status: 200, json: [{ info: { id: "m2", role: "assistant", sessionID: "c1", parentID: "m0", time: { created: 1, completed: 2 }, ...childInfo }, parts: [] }] };
      return { status: 404 };
    });
    return collectEvidence({ scenario: "s2", family: "v1", fixture: fixtureFor("s2", { nonce: "v1f" }), project: "/p", client, events: { ...ev.events, subscribe: async () => {} }, provider: { ledger: () => [] }, signal: new AbortController().signal, timing: TIMING });
  }

  it("agents route: a bare array of { name, mode, ... }; entries without `name` are not agents (no `id` fallback)", async () => {
    const evidence = await collectV1({ agent: "x", providerID: "fake", modelID: "m" }, [{ id: "council-plugin-reviewer" }, { name: "council-plugin-aggregator", mode: "subagent", permission: {}, options: {} }, "junk"]);
    expect(evidence.agents).toEqual(["council-plugin-aggregator"]);
  });

  it("child identity = info.agent + top-level info.providerID / info.modelID", async () => {
    const evidence = await collectV1({ agent: "council-plugin-reviewer", mode: "council-plugin-reviewer", providerID: "fake", modelID: "reviewer-a" });
    expect(evidence.children).toEqual([{ id: "c1", parentID: "P", agent: "council-plugin-reviewer", model: { providerID: "fake", modelID: "reviewer-a" } }]);
  });

  it("info.mode is never an agent fallback; a nested info.model is not the verified shape (identity stays null)", async () => {
    const evidence = await collectV1({ mode: "council-plugin-reviewer", model: { providerID: "fake", modelID: "reviewer-a" } });
    expect(evidence.children).toEqual([{ id: "c1", parentID: "P", agent: null, model: { providerID: null, modelID: null } }]);
    expect(evidence.observations["v1.messageAgentModelFields"]).toEqual([{ id: "c1", agent: null, mode: "council-plugin-reviewer", providerID: null, modelID: null }]);
  });

  it("the parent's council_review part is read from the same single parent messages read (zero calls -> [])", async () => {
    const evidence = await collectV1({ agent: "x", providerID: "fake", modelID: "m" });
    expect(evidence.parentToolCalls).toEqual([]);
    expect(evidence.persistedCompleted).toEqual({ P: 2, c1: 2 });
  });
});

describe("SSE diagnostics: bounded worst case and the real event path", () => {
  it("a worst-case snapshot (64 long types, every shape slot full of long keys) stays far below the evidence cap", () => {
    const diagnostics = createEventDiagnostics();
    for (let i = 0; i < 200; i += 1) diagnostics.record({ type: `t${i}-${"y".repeat(500)}` });
    for (let i = 0; i < 200; i += 1) {
      const wide = Object.fromEntries(Array.from({ length: 100 }, (_, k) => [`${i}-${k}-${"k".repeat(500)}`, 1]));
      diagnostics.record({ type: "session.tool.success", ...wide, data: wide });
      diagnostics.record({ type: "message.part.updated", ...wide, properties: { ...wide, part: { ...wide, type: "tool", state: wide } } });
    }
    const snapshot = diagnostics.snapshot();
    expect(Object.keys(snapshot.typeCounts).length).toBeLessThanOrEqual(64);
    expect(snapshot.otherTypes).toBeGreaterThan(0);
    expect(snapshot.shapesDropped).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(96 * 1024);
  });

  it("connect(): every raw SSE event from the host (incl. unknown types) is counted; events.diagnostics() returns the snapshot", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/api/event")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "e1", type: "server.connected", data: {} })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "e2", type: "session.tool.success", durable: {}, data: { sessionID: "P", assistantMessageID: "m", id: "t1", content: [{ type: "text", text: "SECRET" }], executed: true } })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "e3", type: "session.next.unknown", data: {} })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "e4", type: "session.execution.succeeded", data: { sessionID: "P" } })}\n\n`);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    try {
      const deps = defaultDeps({ timing: { phaseMs: 2_000, pollMs: 5, startupMs: 100 }, supervisor: {} as never });
      const connection = await deps.connect({ family: "v2", launched: { port, password: "rh-" + "d".repeat(43) }, project: "/p", signal: controller.signal });
      await connection.events.subscribe();
      await connection.events.waitFor((event: { kind: string }) => event.kind === "session-final", { timeoutMs: 2_000 });
      const snapshot = connection.events.diagnostics();
      expect(snapshot.typeCounts).toEqual({ "server.connected": 1, "session.tool.success": 1, "session.next.unknown": 1, "session.execution.succeeded": 1 });
      expect(snapshot.toolShapes).toEqual([{ type: "session.tool.success", keys: ["data", "durable", "id", "type"], dataKeys: ["assistantMessageID", "content", "executed", "id", "sessionID"] }]);
      expect(JSON.stringify(snapshot)).not.toContain("SECRET");
      await connection.close();
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// P1b runner plumbing.

describe("P1b: collectEvidence dispatches S3-S13 / obs-ask to the drivers after the shared bootstrap", () => {
  it("bootstraps (auth challenge, subscribe, agents) then drives; the agents observation is merged", async () => {
    const order: string[] = [];
    const { client } = fakeClient((req) => {
      order.push(`${req.method} ${req.path}${req.anonymous ? " (anon)" : ""}`);
      if (req.path === "/session" && req.method === "GET") return req.anonymous ? { status: 401 } : { status: 200, json: [] };
      if (req.path === "/agent") return { status: 200, json: [{ name: "council-plugin-reviewer" }] };
      if (req.path === "/session" && req.method === "POST") return { status: 200, json: { id: "P" } };
      if (req.path === "/session/P/prompt_async") return { status: 204 };
      return { status: 404 };
    });
    const ev = fakeEvents();
    // S7 with nothing ever held: the driver records the precondition and stops (no cancel).
    const fx = fixtureFor("s7", { nonce: "n7", family: "v1" });
    const provider = { registerParent: () => {}, ledger: () => [], events: () => [], releaseAll: () => order.push("RELEASE-ALL"), waitFor: () => Promise.reject(Object.assign(new Error("t"), { code: "EPROVIDERWAIT" })) };
    const evidence = await collectEvidence({ scenario: "s7", family: "v1", fixture: fx, project: "/p", client, events: { ...ev.events, subscribe: async () => void order.push("SUBSCRIBED") }, provider, signal: new AbortController().signal, timing: TIMING });
    expect(order.slice(0, 4)).toEqual(["GET /session (anon)", "GET /session", "SUBSCRIBED", "GET /agent"]);
    expect(order).toContain("RELEASE-ALL");
    expect(order.some((line) => line.includes("/abort"))).toBe(false);
    expect(evidence).toMatchObject({ scenario: "s7", family: "v1", parentSessionID: "P", agents: ["council-plugin-reviewer"], preconditions: { allHeld: { met: false } } });
    expect(evidence.observations["v1.agentsRoute"]).toEqual({ status: 200, names: ["council-plugin-reviewer"] });
  });
});

describe("P1b: runCell plumbing", () => {
  function infra(scenario: string, host = "v1-1.19.3") {
    const order: string[] = [];
    const seen: Record<string, unknown> = {};
    const deps = {
      createFixture: async () => ({ root: "/scratch/rh-x", project: "/scratch/rh-x/project", run: "/scratch/rh-x/run", logs: "/scratch/rh-x/logs", home: "/scratch/rh-x/home", tmp: "/scratch/rh-x/tmp", xdg: { XDG_DATA_HOME: "/scratch/rh-x/data" } }),
      seedPluginCache: async () => {},
      startProvider: async ({ fixture }: { fixture: Record<string, unknown> }) => ((seen.providerFixture = fixture), { baseURL: "http://127.0.0.1:4200/v1", provider: { ledger: () => [] }, close: async () => {} }),
      writeConfig: async ({ fx }: { fx: Record<string, unknown> }) => (order.push("config"), (seen.configFx = fx), "/scratch/rh-x/run/config.json"),
      writeProjectFiles: async (_fixture: unknown, fx: { projectFiles: { path: string }[] }) => order.push(`project-files ${fx.projectFiles.map((file) => file.path).join(",")}`),
      launchHost: async () => (order.push("launch"), { port: 4100, password: "rh-" + "x".repeat(43) }),
      connect: async () => ({ client: {}, events: {}, close: async () => {} }),
      collect: async (args: { readPluginLog: () => Promise<string> }) => ((seen.pluginLog = await args.readPluginLog()), { scenario }),
      readPluginLog: async (fixture: { xdg: { XDG_DATA_HOME: string } }) => `log of ${fixture.xdg.XDG_DATA_HOME}`,
      evaluate: () => ({ verdict: "PASS", checks: [{ id: "x", ok: true, detail: "" }] }),
      stopAll: async () => [],
      removeFixture: async () => {},
    };
    return { deps, order, seen, cell: { id: `${host}:${scenario}:1`, host, scenario, rep: 1 }, manifest: { host: { id: host, executablePath: "/opt/x", executableSha256: "a".repeat(64) } } };
  }

  it("S11: the fixture is family/project-aware and its project files are written BEFORE the host launches", async () => {
    const { deps, order, seen, cell, manifest } = infra("s11");
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps as never);
    expect(result.verdict).toBe("PASS");
    const fx = seen.configFx as { projectFiles: { path: string; content: string }[]; council: { reviewer: string }; models: Record<string, { args: { filePath: string } }[]> };
    // The rule resource is host-relative; the read input is the absolute in-project path.
    expect(fx.projectFiles[3].content).toMatch(/"custom-deny-[0-9a-f]{12}\.txt": deny/);
    expect(fx.models["reviewer-a"][0].args.filePath).toMatch(/^\/scratch\/rh-x\/project\/custom-deny-[0-9a-f]{12}\.txt$/);
    expect(order[0]).toBe("config");
    expect(order[1]).toMatch(/^project-files \.opencode\/node_modules,\.opencode\/package\.json,\.opencode\/package-lock\.json,\.opencode\/agent\/rh-reviewer-[0-9a-f]{12}\.md,custom-deny-[0-9a-f]{12}\.txt,custom-ok-[0-9a-f]{12}\.txt$/);
    expect(order[2]).toBe("launch");
    expect(seen.pluginLog).toBe("log of /scratch/rh-x/data");
  });

  /** Real writeProjectFiles into a temp project; launchHost inspects what is ACTUALLY on disk at launch. */
  async function atLaunch(cellHost: string) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-s11m-")));
    const project = join(root, "project");
    await mkdir(project);
    const { deps, order, cell, manifest } = infra("s11", cellHost);
    const { readdir, readFile, lstat } = await import("node:fs/promises");
    const snapshot: Record<string, unknown> = {};
    Object.assign(deps, {
      createFixture: async () => ({ root, project, run: join(root, "run"), logs: join(root, "logs"), home: join(root, "home"), tmp: join(root, "tmp"), xdg: { XDG_DATA_HOME: join(root, "data") } }),
      writeProjectFiles: async (fixture: { project: string }, fx: { projectFiles: { path: string }[] }) => (order.push(`write ${fx.projectFiles.map((file) => file.path).join(",")}`), writeProjectFiles(fixture.project, fx.projectFiles)),
      launchHost: async () => {
        order.push("launch");
        const dot = join(project, ".opencode");
        const nm = await lstat(join(dot, "node_modules")).catch(() => null);
        snapshot.nodeModules = nm ? { dir: nm.isDirectory(), entries: await readdir(join(dot, "node_modules")) } : null;
        snapshot.packageJson = await readFile(join(dot, "package.json"), "utf8").then(JSON.parse, () => null);
        snapshot.packageLock = await readFile(join(dot, "package-lock.json"), "utf8").then(JSON.parse, () => null);
        snapshot.dotEntries = (await readdir(dot)).sort();
        return { port: 4100, password: "rh-" + "x".repeat(43) };
      },
    });
    try {
      const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps as never);
      return { result, order, snapshot };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("S11 diagnostic amendment: V1 S11 has the empty .opencode/node_modules and both marker JSONs naming its HOST version on disk at launch, written first", async () => {
    for (const [host, version] of [["v1-1.18.29", "1.18.29"], ["v1-1.19.3", "1.19.3"]]) {
      const { result, order, snapshot } = await atLaunch(host);
      expect(result.verdict).toBe("PASS");
      expect(order[1]).toMatch(/^write \.opencode\/node_modules,\.opencode\/package\.json,\.opencode\/package-lock\.json,\.opencode\/agent\//);
      expect(order.indexOf("launch")).toBeGreaterThan(order.findIndex((line) => line.startsWith("write ")));
      const deps = { "@opencode-ai/plugin": version };
      expect(snapshot).toEqual({ nodeModules: { dir: true, entries: [] }, packageJson: { dependencies: deps }, packageLock: { name: "opencode", lockfileVersion: 3, requires: true, packages: { "": { dependencies: deps } } }, dotEntries: ["agent", "node_modules", "package-lock.json", "package.json"] });
    }
  });

  it("S11 diagnostic amendment: V2 S11 gets no marker (only its agent dir under .opencode at launch)", async () => {
    const { result, snapshot } = await atLaunch("v2-2.0.32");
    expect(result.verdict).toBe("PASS");
    expect(snapshot).toEqual({ nodeModules: null, packageJson: null, packageLock: null, dotEntries: ["agent"] });
  });

  it("scenarios without project files never write any; summary candidates are scenario-scoped", async () => {
    const { deps, order, cell, manifest } = infra("s8");
    const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps as never);
    expect(order.some((line) => line.startsWith("project-files"))).toBe(false);
    expect(result.summary.candidates).toEqual(["v1.permissionConfig", "v1.pluginLogFlush"]);
  });

  it("writeConfig renders the fixture's permission rules into the host config", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-cfg-")));
    try {
      await mkdir(join(root, "run"));
      const fx = fixtureFor("s8", { nonce: "abc123def456", family: "v1" });
      const path = await defaultDeps({ supervisor: {} as never }).writeConfig({ fixture: { run: join(root, "run") }, family: "v1", fx, providerBaseURL: "http://127.0.0.1:4200/v1" });
      const config = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
      expect(config.permission).toEqual({ bash: { "echo ASK-abc123def456*": "ask", "echo DENY-abc123def456*": "deny" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("P1b: project files and plugin-log reads are confined and bounded", () => {
  it("writeProjectFiles creates nested files exclusively (0600) and refuses escapes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-proj-")));
    try {
      await writeProjectFiles(root, [{ path: ".opencode/agent/x.md", content: "A" }, { path: "f.txt", content: "B" }]);
      const { readFile, stat } = await import("node:fs/promises");
      expect(await readFile(join(root, ".opencode/agent/x.md"), "utf8")).toBe("A");
      expect((await stat(join(root, "f.txt"))).mode & 0o777).toBe(0o600);
      await expect(writeProjectFiles(root, [{ path: "f.txt", content: "again" }])).rejects.toMatchObject({ code: "EEXIST" });
      for (const path of ["../out.txt", "/etc/x", "a/../../b"]) await expect(writeProjectFiles(root, [{ path, content: "x" }])).rejects.toThrow(/escapes the project/);
      // Directory entries (S11 V1 marker): created exclusively and empty; confined like files.
      await writeProjectFiles(root, [{ path: ".opencode/node_modules", type: "dir" }]);
      expect((await stat(join(root, ".opencode/node_modules"))).isDirectory()).toBe(true);
      await expect(writeProjectFiles(root, [{ path: ".opencode/node_modules", type: "dir" }])).rejects.toMatchObject({ code: "EEXIST" });
      await expect(writeProjectFiles(root, [{ path: "../nm", type: "dir" }])).rejects.toThrow(/escapes the project/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

describe("P1b: connect() watches fixture nonces in RAW events and can re-subscribe (loopback SSE stub)", () => {
  it("reports each watched nonce once with only its event type; a second subscribe replaces the stream and keeps prior events", async () => {
    const { createServer } = await import("node:http");
    let streams = 0;
    const server = createServer((req, res) => {
      if (!req.url?.startsWith("/event")) return res.writeHead(404).end();
      streams += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (streams === 1) {
        res.write(`data: ${JSON.stringify({ type: "message.part.delta", properties: { sessionID: "S", delta: "secret PARTIAL-abc123def456 text" } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "message.part.delta", properties: { delta: "PARTIAL-abc123def456 again" } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "S" } })}\n\n`);
      } else res.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "T" } })}\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    try {
      const deps = defaultDeps({ timing: { phaseMs: 2_000, pollMs: 5, startupMs: 100 }, supervisor: {} as never });
      const connection = await deps.connect({ family: "v1", launched: { port, password: "rh-" + "w".repeat(43) }, project: "/p", signal: controller.signal });
      connection.events.watchNonces(["PARTIAL-abc123def456", "short"]);
      await connection.events.subscribe();
      await connection.events.waitFor((event: { kind: string; sessionID?: string }) => event.kind === "session-idle" && event.sessionID === "S", { timeoutMs: 2_000 });
      const nonces = connection.events.all().filter((event: { kind: string }) => event.kind === "nonce-seen");
      expect(nonces).toEqual([{ kind: "nonce-seen", nonce: "PARTIAL-abc123def456", type: "message.part.delta" }]);
      expect(JSON.stringify(connection.events.all())).not.toContain("secret");
      await connection.events.subscribe();
      await connection.events.waitFor((event: { kind: string; sessionID?: string }) => event.kind === "session-idle" && event.sessionID === "T", { timeoutMs: 2_000 });
      expect(streams).toBe(2);
      expect(connection.events.all().some((event: { kind: string; sessionID?: string }) => event.sessionID === "S")).toBe(true);
      await connection.close();
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("post-P1b audit: runCell cleanup / deadline plumbing", () => {
  function infra(overrides: Record<string, unknown> = {}) {
    const order: string[] = [];
    const seen: Record<string, unknown> = {};
    const deps = {
      createFixture: async () => ({ root: "/scratch/rh-x", project: "/scratch/rh-x/project", run: "/scratch/rh-x/run", logs: "/scratch/rh-x/logs", home: "/scratch/rh-x/home", tmp: "/scratch/rh-x/tmp", xdg: { XDG_DATA_HOME: "/scratch/rh-x/data" } }),
      seedPluginCache: async () => {},
      startProvider: async () => ({ baseURL: "http://127.0.0.1:4200/v1", provider: { ledger: () => [] }, close: async () => [{ group: "provider", label: "fake-provider", status: "closed" }] }),
      writeConfig: async () => "/scratch/rh-x/run/config.json",
      writeProjectFiles: async () => {},
      rewriteProjectFile: async (_fixture: unknown, file: { path: string }) => void order.push(`rewrite ${file.path}`),
      launchHost: async () => (order.push("launch"), { port: 4100, password: "rh-" + "x".repeat(43) }),
      connect: async () => ({ client: {}, events: {}, close: async () => {} }),
      collect: async (args: Record<string, unknown>) => (Object.assign(seen, args), await (args.rewriteProjectFile as (file: unknown) => Promise<void>)({ path: "a.md", content: "x" }), { scenario: "s11" }),
      evaluate: () => ({ verdict: "PASS", checks: [{ id: "x", ok: true, detail: "" }] }),
      stopAll: async () => (order.push("stop"), []),
      removeFixture: async () => order.push("remove-fixture"),
      ...overrides,
    };
    return { deps, order, seen };
  }
  const cell = { id: "v1-1.19.3:s11:1", host: "v1-1.19.3", scenario: "s11", rep: 1 };
  const manifest = { host: { id: "v1-1.19.3", executablePath: "/opt/x", executableSha256: "a".repeat(64) } };

  it("F2-MA6: a provider close outcome 'failed' / 'timeout' is a cleanup error: FAIL and the fixture is retained", async () => {
    for (const status of ["failed", "timeout"]) {
      const { deps, order } = infra({ startProvider: async () => ({ baseURL: "http://127.0.0.1:4200/v1", provider: { ledger: () => [] }, close: async () => [{ group: "provider", label: "fake-provider", status, error: "x" }] }) });
      const result = await runCell({ cell, manifest, signal: new AbortController().signal }, deps as never);
      expect(result.verdict).toBe("FAIL");
      expect(result.checks.find((check: { id: string }) => check.id === "cell.cleanup").detail).toBe(`provider close ${status} (fake-provider)`);
      expect(order).not.toContain("remove-fixture");
    }
  });

  it("the work deadline, the signal, and a confined rewrite capability reach collect", async () => {
    const { deps, order, seen } = infra();
    const signal = new AbortController().signal;
    await runCell({ cell, manifest, signal, deadlineAt: 123_456 }, deps as never);
    expect(seen.deadlineAt).toBe(123_456);
    expect(seen.signal).toBe(signal);
    expect(order).toContain("rewrite a.md");
  });

  it("an already-aborted cell signal stops before the host launches (still cleans up)", async () => {
    const { deps, order } = infra();
    const controller = new AbortController();
    controller.abort();
    const result = await runCell({ cell, manifest, signal: controller.signal }, deps as never);
    expect(result.verdict).toBe("FAIL");
    expect(order).not.toContain("launch");
    expect(order).toContain("stop");
  });

  it("M6: readPluginLog reads only $XDG_DATA_HOME/opencode/log/opencode.log (bounded tail)", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-plog-")));
    try {
      await mkdir(join(root, "opencode", "log"), { recursive: true });
      await writeFile(join(root, "opencode", "log", "opencode.log"), "LINE-A\n");
      await writeFile(join(root, "opencode", "log", "2026-10-19T000000.log"), "OTHER-FILE\n");
      const text = await defaultDeps({ supervisor: {} as never }).readPluginLog({ xdg: { XDG_DATA_HOME: root } });
      expect(text).toBe("LINE-A\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("M3: rewriteProjectFile overwrites inside the project only", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-rew-")));
    try {
      const deps = defaultDeps({ supervisor: {} as never });
      await writeProjectFiles(root, [{ path: ".opencode/agent/x.md", content: "OLD" }]);
      await deps.rewriteProjectFile({ project: root }, { path: ".opencode/agent/x.md", content: "NEW" });
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(join(root, ".opencode/agent/x.md"), "utf8")).toBe("NEW");
      await expect(deps.rewriteProjectFile({ project: root }, { path: "../x.md", content: "x" })).rejects.toThrow(/escapes the project/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("connect(): events.waitFor rejects EABORTED as soon as the signal fires", async () => {
    const deps = defaultDeps({ timing: { phaseMs: 5_000, pollMs: 5, startupMs: 100 }, supervisor: {} as never });
    const connection = await deps.connect({ family: "v2", launched: { port: 1, password: "rh-" + "q".repeat(43) }, project: "/p", signal: new AbortController().signal });
    const controller = new AbortController();
    const pending = connection.events.waitFor(() => false, { timeoutMs: 5_000, signal: controller.signal }).catch((error: { code: string }) => error.code);
    controller.abort();
    expect(await pending).toBe("EABORTED");
  });
});

describe("post-P1b audit: connect() aborts in-flight host requests with the cell signal (loopback stub)", () => {
  it("a request to a host that never answers rejects promptly when the cell signal fires", async () => {
    const { createServer } = await import("node:http");
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    try {
      const deps = defaultDeps({ timing: { phaseMs: 30_000, pollMs: 5, startupMs: 100 }, supervisor: {} as never });
      const connection = await deps.connect({ family: "v2", launched: { port, password: "rh-" + "s".repeat(43) }, project: "/p", signal: controller.signal });
      const started = Date.now();
      const pending = connection.client.request({ method: "GET", path: "/api/session", timeout: 30_000, operation: "probe" }).catch((error: { code: string }) => error.code);
      setTimeout(() => controller.abort(), 20);
      expect(await pending).toBe("EHTTPTRANSPORT");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
