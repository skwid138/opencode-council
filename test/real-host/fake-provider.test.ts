import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { AUXILIARY_SIGNATURES, classifyAuxiliary, createFakeProvider, IDENTITY_PATH, sessionHeaders } from "./fake-provider.mjs";

type Event = [string, ...unknown[]];

/** In-memory response: records writeHead/write/end/destroy in order; `close()` simulates a client disconnect. */
function fakeResponse() {
  const events: Event[] = [];
  let onClose: (() => void) | null = null;
  return {
    events,
    res: {
      writeHead: (status: number, headers: Record<string, string>) => events.push(["head", status, headers["content-type"]]),
      write: (chunk: string) => events.push(["write", chunk]),
      end: (chunk?: string) => events.push(["end", chunk ?? ""]),
      destroy: (error?: Error) => events.push(["destroy", error?.message ?? ""]),
      onClose: (callback: () => void) => {
        onClose = callback;
      },
    },
    close: () => onClose?.(),
    text: () => events.filter(([kind]) => kind === "write" || kind === "end").map(([, chunk]) => chunk).join(""),
  };
}

const TOOLS = [{ type: "function", function: { name: "council_review", description: "d", parameters: {} } }, { type: "function", function: { name: "read", description: "d", parameters: {} } }];

function request(args: Record<string, unknown> = {}) {
  const { session = "ses_1", parent, model = "parent", messages = [{ role: "user", content: "hi" }], stream = true, family = "v2", headers: extra = {} } = args;
  // `tools: undefined` explicitly means "omitted on the wire" (not the default list).
  const tools = Object.hasOwn(args, "tools") ? args.tools : TOOLS;
  const names = sessionHeaders(family as string);
  const headers: Record<string, string> = {};
  if (session) headers[names.session.toUpperCase()] = session as string;
  if (parent) headers[names.parent] = parent as string;
  Object.assign(headers, extra);
  const body: Record<string, unknown> = { model, messages, stream };
  if (tools !== undefined) body.tools = tools;
  return { method: "POST", path: "/v1/chat/completions", headers, body };
}

/** Parent sessions the collector registered (children are known through their parent header). */
const PARENTS = ["ses_1", "A", "B", "H", "H2", "P"];
const provider = (overrides: Record<string, unknown> = {}) => {
  const p = createFakeProvider({
    family: "v2",
    identityToken: "identity-token-123",
    budgetPerSession: 4,
    markers: ["MARK-SYS"],
    nonces: ["NONCE-1"],
    models: {
      parent: [{ type: "tool_call", name: "council_review", args: { prompt: "NONCE-1" } }, { type: "text", text: "parent done" }],
      reviewer: [{ type: "text", text: "review MARKER-R" }],
      held: [{ type: "hold", barrier: "b1", then: { type: "text", text: "late" } }],
      empty: [{ type: "empty" }],
      fail: [{ type: "status", status: 500 }],
      partial: [{ type: "partial-error", text: "PARTIAL-P" }],
      aggregator: [{ type: "text", text: "AGG-MARK" }],
    },
    ...overrides,
  });
  for (const id of PARENTS) p.registerParent(id);
  return p;
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("fake provider dispatch", () => {
  it("normalizes per-host session headers case-insensitively (source-verified pairs)", () => {
    // V1: x-session-id / x-parent-session-id at BOTH pins (1.18.29 has no x-opencode-*; 1.19.3 adds them as aliases).
    expect(sessionHeaders("v1")).toEqual({ session: "x-session-id", parent: "x-parent-session-id", sessionAlias: "x-opencode-session-id", parentAlias: "x-opencode-parent-session-id" });
    // V2: x-opencode-session-id is the actual session; X-Session-Id is affinity (parentID ?? id) and is never read.
    expect(sessionHeaders("v2")).toEqual({ session: "x-opencode-session-id", parent: "x-opencode-parent-session-id", sessionAlias: null, parentAlias: "x-parent-session-id" });
  });

  it("serves the identity endpoint for liveness without spending a budget", async () => {
    const p = provider();
    const r = fakeResponse();
    await p.handle({ method: "GET", path: IDENTITY_PATH, headers: {}, body: null }, r.res);
    expect(r.events[0]).toEqual(["head", 200, "application/json"]);
    expect(JSON.parse(r.text())).toEqual({ token: "identity-token-123" });
  });

  it("progresses per session by assistant turns, so interleaved sessions with identical model IDs are independent", async () => {
    const p = provider();
    const a1 = fakeResponse();
    const b1 = fakeResponse();
    await p.handle(request({ session: "A" }), a1.res);
    await p.handle(request({ session: "B" }), b1.res);
    expect(a1.text()).toContain('"name":"council_review"');
    expect(b1.text()).toContain('"name":"council_review"');
    const a2 = fakeResponse();
    await p.handle(request({ session: "A", messages: [{ role: "user", content: "hi" }, { role: "assistant", tool_calls: [{}] }, { role: "tool", content: "ok" }] }), a2.res);
    expect(a2.text()).toContain("parent done");
    expect(p.ledger().map((entry: { sessionID: string; step: number }) => [entry.sessionID, entry.step])).toEqual([["A", 0], ["B", 0], ["A", 1]]);
  });

  it("re-serves the same step on a retry (identical request)", async () => {
    const p = provider();
    const first = fakeResponse();
    const retry = fakeResponse();
    await p.handle(request({ session: "A" }), first.res);
    await p.handle(request({ session: "A" }), retry.res);
    expect(p.ledger().map((entry: { step: number }) => entry.step)).toEqual([0, 0]);
    expect(retry.text()).toContain('"name":"council_review"');
  });

  it("records bounded parsed fields only: tool names, matched markers and nonces, parent session", async () => {
    const p = provider();
    await p.handle(request({ session: "C", parent: "A", model: "reviewer", messages: [{ role: "system", content: "x MARK-SYS y" }, { role: "user", content: "review NONCE-1 SECRET-BODY" }] }), fakeResponse().res);
    const [entry] = p.ledger();
    expect(entry).toMatchObject({ kind: "model", sessionID: "C", parentSessionID: "A", model: "reviewer", tools: ["council_review", "read"], systemMarkers: ["MARK-SYS"], nonces: ["NONCE-1"], outcome: "text", status: 200 });
    expect(JSON.stringify(p.ledger())).not.toContain("SECRET-BODY");
  });

  const TITLE = [{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, { role: "user", content: "hi NONCE-1" }];
  const V1_COMPACTION = [{ role: "system", content: "You are a context summarization agent. Summarize." }, { role: "user", content: "x" }];
  const V2_COMPACTION_A = [{ role: "user", content: "earlier" }, { role: "user", content: "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work. Details..." }];
  const V2_COMPACTION_B = [{ role: "user", content: "earlier" }, { role: "user", content: "Update the existing checkpoint in the conversation above into one consolidated summary. More..." }];

  it("pins the source-verified auxiliary signatures", () => {
    expect(AUXILIARY_SIGNATURES).toEqual([
      { id: "title", where: "system", prefix: "You are a title generator.", verified: "source" },
      { id: "v1-compaction", where: "system", prefix: "You are a context summarization agent.", verified: "source" },
      { id: "v2-compaction", where: "last-user", prefix: "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.", verified: "source" },
      { id: "v2-compaction", where: "last-user", prefix: "Update the existing checkpoint in the conversation above into one consolidated summary.", verified: "source" },
    ]);
    expect(classifyAuxiliary(TITLE)).toBe("title");
    expect(classifyAuxiliary(V1_COMPACTION)).toBe("v1-compaction");
    expect(classifyAuxiliary(V2_COMPACTION_A)).toBe("v2-compaction");
    expect(classifyAuxiliary(V2_COMPACTION_B)).toBe("v2-compaction");
    expect(classifyAuxiliary([{ role: "user", content: "You are a title generator." }])).toBeNull();
    expect(classifyAuxiliary([{ role: "system", content: "Preamble. You are a title generator." }])).toBeNull();
  });

  it("serves a request from a known session as MAIN regardless of tools (the aggregator with tools omitted or [])", async () => {
    const p = provider();
    for (const tools of [undefined, []]) {
      const r = fakeResponse();
      await p.handle(request({ session: `AGG-${tools === undefined ? "omit" : "empty"}`, parent: "P", model: "aggregator", tools }), r.res);
      expect(r.text()).toContain("AGG-MARK");
      expect(p.ledger().at(-1)).toMatchObject({ kind: "model", parentSessionID: "P", tools: [], outcome: "text", step: 0 });
    }
  });

  it.each([
    ["title (known parent, tools omitted)", { session: "P", tools: undefined, messages: TITLE }, "title"],
    ["V1 compaction from a child without a parent header", { family: "v1", session: "child-x", messages: V1_COMPACTION }, "v1-compaction"],
    ["V2 compaction (first instruction)", { session: "P", messages: V2_COMPACTION_A }, "v2-compaction"],
    ["V2 compaction (checkpoint update)", { session: "kid", parent: "P", messages: V2_COMPACTION_B }, "v2-compaction"],
  ])("records an auxiliary request by signature (%s): sha256 + classification only, never the text", async (_label, req, classification) => {
    const p = provider({ family: (req as { family?: string }).family ?? "v2" });
    const r = fakeResponse();
    await p.handle(request(req as Record<string, unknown>), r.res);
    expect(r.events[0][1]).toBe(200);
    const entry = p.ledger().at(-1);
    expect(entry).toMatchObject({ kind: "auxiliary", auxiliary: classification, classification, status: 200 });
    expect(entry.systemPrefixSha256).toMatch(/^[0-9a-f]{64}$/);
    const raw = JSON.stringify(p.ledger());
    for (const text of ["title generator", "context summarization", "MUST summarize", "existing checkpoint"]) expect(raw).not.toContain(text);
  });

  it.each([
    ["an unknown session (tool-bearing)", { session: "stranger" }],
    ["an unknown session (tool-less)", { session: "stranger", tools: [] }],
    ["no session header", { session: null }],
    ["V2: only the affinity header X-Session-Id", { session: null, headers: { "X-Session-Id": "P" } }],
    ["V2: conflicting parent headers", { session: "kid", parent: "P", headers: { "x-parent-session-id": "OTHER" } }],
    ["V1: x-opencode-session-id only (V1 reads x-session-id at both pins)", { family: "v1", session: null, headers: { "x-opencode-session-id": "P" } }],
    ["V1 1.19.3: conflicting session alias", { family: "v1", session: "P", headers: { "x-opencode-session-id": "OTHER" } }],
  ])("rejects an unidentified request (400 + ledger error, sha256 + classification only): %s", async (_label, req) => {
    const p = provider({ family: (req as { family?: string }).family ?? "v2" });
    const r = fakeResponse();
    await p.handle(request({ ...(req as Record<string, unknown>), messages: [{ role: "system", content: "SYSTEM-SECRET prompt" }, { role: "user", content: "BODY-SECRET" }] }), r.res);
    expect(r.events[0][1]).toBe(400);
    const entry = p.ledger().at(-1);
    expect(entry).toMatchObject({ kind: "unidentified", status: 400, classification: "unknown", systemPrefixSha256: sha256("SYSTEM-SECRET prompt") });
    expect(JSON.stringify(p.ledger())).not.toMatch(/SECRET/);
  });

  it("accepts the V2 x-parent-session-id fallback and equal V1 1.19.3 aliases", async () => {
    const p = provider();
    await p.handle(request({ session: "kid", parent: null, headers: { "x-parent-session-id": "P" } }), fakeResponse().res);
    expect(p.ledger().at(-1)).toMatchObject({ kind: "model", sessionID: "kid", parentSessionID: "P" });
    const v1 = provider({ family: "v1" });
    await v1.handle(request({ family: "v1", session: "kid", parent: "P", headers: { "x-opencode-session-id": "kid", "x-opencode-parent-session-id": "P" } }), fakeResponse().res);
    expect(v1.ledger().at(-1)).toMatchObject({ kind: "model", sessionID: "kid", parentSessionID: "P" });
  });

  it("rejects unknown models and routes", async () => {
    const p = provider();
    const unknown = fakeResponse();
    await p.handle(request({ model: "nope" }), unknown.res);
    expect(unknown.events[0][1]).toBe(400);
    const route = fakeResponse();
    await p.handle({ method: "POST", path: "/other", headers: {}, body: {} }, route.res);
    expect(route.events[0][1]).toBe(404);
  });

  it("enforces a per-session budget", async () => {
    const p = provider({ budgetPerSession: 2 });
    for (let i = 0; i < 3; i += 1) await p.handle(request({ session: "A" }), fakeResponse().res);
    const last = fakeResponse();
    await p.handle(request({ session: "A" }), last.res);
    expect(last.events[0][1]).toBe(429);
    expect(p.ledger().at(-1)).toMatchObject({ kind: "budget-exceeded", sessionID: "A" });
    const other = fakeResponse();
    await p.handle(request({ session: "B" }), other.res);
    expect(other.events[0][1]).toBe(200);
  });

  it("serves empty, HTTP status, and partial-then-error outcomes with exact write ordering", async () => {
    const p = provider();
    const empty = fakeResponse();
    await p.handle(request({ model: "empty" }), empty.res);
    expect(empty.text()).not.toMatch(/"content":"[^"]/);
    expect(empty.text()).toContain("data: [DONE]");
    const fail = fakeResponse();
    await p.handle(request({ model: "fail" }), fail.res);
    expect(fail.events[0]).toEqual(["head", 500, "application/json"]);
    const partial = fakeResponse();
    await p.handle(request({ model: "partial" }), partial.res);
    expect(partial.events.map(([kind]) => kind)).toEqual(["head", "write", "destroy"]);
    expect(partial.events[1][1]).toContain("PARTIAL-P");
    expect(partial.text()).not.toContain("[DONE]");
  });

  it("holds until the barrier is released, then serves the next outcome", async () => {
    const p = provider();
    const r = fakeResponse();
    const pending = p.handle(request({ model: "held", session: "H" }), r.res);
    await Promise.resolve();
    expect(r.events).toEqual([]);
    expect(p.holding()).toEqual([{ sessionID: "H", model: "held", barrier: "b1" }]);
    p.release("b1");
    await pending;
    expect(r.text()).toContain("late");
    expect(p.holding()).toEqual([]);
    expect(p.ledger().at(-1)).toMatchObject({ outcome: "hold", released: true, disconnected: false });
  });

  it("ends a hold when the client disconnects and records the disconnect", async () => {
    const p = provider();
    const r = fakeResponse();
    const pending = p.handle(request({ model: "held", session: "H" }), r.res);
    await Promise.resolve();
    r.close();
    await pending;
    expect(r.events).toEqual([]);
    expect(p.ledger().at(-1)).toMatchObject({ outcome: "hold", released: false, disconnected: true });
    p.release("b1");
  });

  it("exposes a hold-observed hook so drivers can trigger on events instead of sleeping", async () => {
    const seen: string[] = [];
    const p = provider({ onHold: (hold: { sessionID: string }) => seen.push(hold.sessionID) });
    const pending = p.handle(request({ model: "held", session: "H2" }), fakeResponse().res);
    await Promise.resolve();
    expect(seen).toEqual(["H2"]);
    p.release("b1");
    await pending;
  });
});

// ---------------------------------------------------------------------------
// P1b: per-invocation-nonce scripts, barrier'd partial-then-error, aggregator structure,
// tool-result markers, ordering ticks, and an event-driven waitFor.

describe("P1b fake provider extensions", () => {
  const aggText = (markersText: string) => `You are aggregating...\n\n# Original review prompt\n\nx\n\n# Participation summary supplied by council_review\n\nResponded:\n- fake/a\n- fake/b\n\nFailed or timed out:\n- fake/c: fake/c timed out after 20s\n\n# Reviewer responses\n\n## Reviewer 1: fake/a\n\n${markersText}\n\n---\n\n## Reviewer 2: fake/b\n\nMB`;

  it("selects a model's script by the invocation nonce present in the request (first match), else `default`", async () => {
    const p = createFakeProvider({ family: "v2", identityToken: "identity-token-123", nonces: ["NA", "NB"], models: { reviewer: { byNonce: { NA: [{ type: "text", text: "from A" }], NB: [{ type: "text", text: "from B" }] }, default: [{ type: "text", text: "dflt" }] } } });
    p.registerParent("P");
    for (const [content, expected, key] of [["council-review-NB", "from B", "NB"], ["council-review-NA", "from A", "NA"], ["nothing", "dflt", "default"]]) {
      const r = fakeResponse();
      await p.handle(request({ session: "S", parent: "P", model: "reviewer", stream: false, messages: [{ role: "user", content }] }), r.res);
      expect(JSON.parse(r.text()).choices[0].message.content).toBe(expected);
      expect(p.ledger().at(-1)).toMatchObject({ kind: "model", scriptKey: key });
    }
  });

  it("a byNonce script without a match and without `default` is an unknown model (400)", async () => {
    const p = createFakeProvider({ family: "v2", identityToken: "identity-token-123", nonces: ["NA"], models: { reviewer: { byNonce: { NA: [{ type: "text", text: "a" }] } } } });
    p.registerParent("P");
    const r = fakeResponse();
    await p.handle(request({ session: "P", model: "reviewer", messages: [{ role: "user", content: "none" }] }), r.res);
    expect(p.ledger()[0]).toMatchObject({ kind: "unknown-model", status: 400 });
  });

  it("partial-error with a barrier: the partial chunk is written, then the stream fails only after the barrier is released", async () => {
    const p = createFakeProvider({ family: "v2", identityToken: "identity-token-123", models: { partial: [{ type: "partial-error", text: "PARTIAL-P", barrier: "pb" }] } });
    p.registerParent("P");
    const r = fakeResponse();
    const done = p.handle(request({ session: "P", model: "partial" }), r.res);
    await p.waitFor((event: { type: string }) => event.type === "partial-written", { timeoutMs: 1000 });
    expect(r.events.map(([kind]) => kind)).toEqual(["head", "write"]);
    expect(r.text()).toContain("PARTIAL-P");
    p.release("pb");
    await done;
    expect(r.events.map(([kind]) => kind)).toEqual(["head", "write", "destroy"]);
    expect(p.ledger()[0]).toMatchObject({ outcome: "partial-error", released: true, disconnected: false });
  });

  it("partial-error with a barrier ends early (no destroy) when the host disconnects first", async () => {
    const p = createFakeProvider({ family: "v2", identityToken: "identity-token-123", models: { partial: [{ type: "partial-error", text: "PARTIAL-P", barrier: "pb" }] } });
    p.registerParent("P");
    const r = fakeResponse();
    const done = p.handle(request({ session: "P", model: "partial" }), r.res);
    await p.waitFor((event: { type: string }) => event.type === "partial-written", { timeoutMs: 1000 });
    r.close();
    await done;
    expect(r.events.map(([kind]) => kind)).toEqual(["head", "write"]);
    expect(p.ledger()[0]).toMatchObject({ released: false, disconnected: true });
  });

  it("records the aggregator prompt STRUCTURE (labels, classified errors, markers per section) of the last user message, never its text", async () => {
    const p = createFakeProvider({ family: "v2", identityToken: "identity-token-123", nonces: ["MA", "MB"], models: { aggregator: [{ type: "text", text: "AGG" }] } });
    p.registerParent("P");
    await p.handle(request({ session: "AG", parent: "P", model: "aggregator", tools: [], messages: [{ role: "system", content: "sys" }, { role: "user", content: aggText("MA body") }] }), fakeResponse().res);
    const [entry] = p.ledger();
    expect(entry.aggregator).toMatchObject({ responded: ["fake/a", "fake/b"], failed: [{ label: "fake/c", error: { kind: "timeout", text: "fake/c timed out after 20s" } }], sections: [{ label: "fake/a", markers: ["MA"] }, { label: "fake/b", markers: ["MB"] }] });
    expect(JSON.stringify(entry)).not.toContain("MA body");
    // A non-aggregator request has no structure.
    await p.handle(request({ session: "P", model: "aggregator", messages: [{ role: "user", content: "plain" }] }), fakeResponse().res);
    expect(p.ledger()[1].aggregator).toBeNull();
  });

  it("classifies tool-result messages by fixture output markers (call id, markers, length, sha256; never the content)", async () => {
    const p = createFakeProvider({ family: "v1", identityToken: "identity-token-123", outputMarkers: ["OUT-1 42", "DENIED-CONST"], models: { reviewer: [{ type: "text", text: "x" }, { type: "text", text: "y" }] } });
    p.registerParent("P");
    const messages = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "secret stdout OUT-1 42" },
      { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "DENIED-CONST and more" }] },
    ];
    await p.handle(request({ session: "S", parent: "P", model: "reviewer", family: "v1", messages }), fakeResponse().res);
    const [entry] = p.ledger();
    expect(entry.toolResults).toEqual([
      { callId: "c1", markers: ["OUT-1 42"], length: "secret stdout OUT-1 42".length, sha256: sha256("secret stdout OUT-1 42") },
      { callId: "c2", markers: ["DENIED-CONST"], length: "DENIED-CONST and more".length, sha256: sha256("DENIED-CONST and more") },
    ]);
    expect(JSON.stringify(entry)).not.toContain("secret stdout");
  });

  it("orders requests and responses with monotonic ticks (received < completed; a later request has a larger received tick)", async () => {
    const p = provider();
    await p.handle(request({ session: "A", parent: "P", model: "reviewer", stream: false }), fakeResponse().res);
    await p.handle(request({ session: "B", parent: "P", model: "aggregator", stream: true }), fakeResponse().res);
    const [a, b] = p.ledger();
    expect(a.receivedTick).toBeLessThan(a.completedTick);
    expect(b.receivedTick).toBeGreaterThan(a.completedTick);
    expect(b.completedTick).toBeGreaterThan(b.receivedTick);
  });

  it("a held request records released/disconnected ticks; waitFor resolves on hold / disconnect events (event-driven, no polling)", async () => {
    const p = provider();
    const r = fakeResponse();
    const handled = p.handle(request({ session: "H", model: "held" }), r.res);
    const hold = await p.waitFor((event: { type: string; sessionID: string }) => event.type === "hold" && event.sessionID === "H", { timeoutMs: 1000 });
    expect(hold).toMatchObject({ type: "hold", sessionID: "H", model: "held", barrier: "b1" });
    const disconnected = p.waitFor((event: { type: string }) => event.type === "disconnected", { timeoutMs: 1000 });
    r.close();
    await handled;
    expect(await disconnected).toMatchObject({ sessionID: "H", barrier: "b1" });
    expect(p.ledger()[0]).toMatchObject({ released: false, disconnected: true, disconnectedTick: expect.any(Number) });
    // Already-seen events resolve immediately; an unmatched wait times out with a coded error.
    await expect(p.waitFor((event: { type: string }) => event.type === "hold", { timeoutMs: 1000 })).resolves.toMatchObject({ type: "hold" });
    await expect(p.waitFor(() => false, { timeoutMs: 5 })).rejects.toMatchObject({ code: "EPROVIDERWAIT" });
  });

  it("waitFor rejects promptly when the signal aborts", async () => {
    const p = provider();
    const controller = new AbortController();
    const waiting = p.waitFor(() => false, { timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "EABORTED" });
  });

  it("releaseAll releases every barrier (cleanup)", async () => {
    const p = provider();
    const r = fakeResponse();
    const handled = p.handle(request({ session: "H", model: "held" }), r.res);
    await p.waitFor((event: { type: string }) => event.type === "hold", { timeoutMs: 1000 });
    p.releaseAll();
    await handled;
    expect(p.ledger()[0]).toMatchObject({ released: true });
  });

  it("a tool_call step may carry several parallel calls", async () => {
    const p = createFakeProvider({ family: "v2", identityToken: "identity-token-123", models: { m: [{ type: "tool_calls", calls: [{ name: "shell", args: { command: "a" } }, { name: "shell", args: { command: "b" } }] }] } });
    p.registerParent("P");
    const r = fakeResponse();
    await p.handle(request({ session: "P", model: "m", stream: false }), r.res);
    const message = JSON.parse(r.text()).choices[0].message;
    expect(message.tool_calls.map((call: { id: string; function: { arguments: string } }) => [call.id, JSON.parse(call.function.arguments).command])).toEqual([["call_P_0_0", "a"], ["call_P_0_1", "b"]]);
    const streamed = fakeResponse();
    await p.handle(request({ session: "P", model: "m", stream: true }), streamed.res);
    expect(streamed.text()).toContain('"index":1');
    expect(p.ledger()[1].toolCallIds).toEqual(["call_P_0_0", "call_P_0_1"]);
  });
});

describe("Radagast M5: repeating partial-error actor; transparent retries vs continuations", () => {
  const make = () => {
    const p = createFakeProvider({ family: "v2", identityToken: "identity-token-123", models: { partial: [{ type: "partial-error", text: "PARTIAL-P", repeat: true }], once: [{ type: "text", text: "x" }] } });
    p.registerParent("P");
    return p;
  };
  const first = [{ role: "user", content: "go" }];
  // V2 continuation transcript: the partial assistant turn (new id) + a synthetic continuation instruction.
  const continued = [...first, { role: "assistant", content: "PARTIAL-P" }, { role: "user", content: "Continue from where you left off." }];
  const twice = [...continued, { role: "assistant", content: "PARTIAL-P" }, { role: "user", content: "Continue from where you left off." }];

  it("serves the repeating step for every later step (never script-exhausted) and classifies each attempt", async () => {
    const p = make();
    for (const messages of [first, first, continued, continued, twice]) await p.handle(request({ session: "P", model: "partial", messages }), fakeResponse().res);
    const ledger = p.ledger();
    expect(ledger.map((entry: { kind: string; outcome: string }) => [entry.kind, entry.outcome])).toEqual(Array(5).fill(["model", "partial-error"]));
    expect(ledger.map((entry: { attempt: string }) => entry.attempt)).toEqual(["first", "retry", "continuation", "retry", "continuation"]);
  });

  it("without `repeat` the script is still exhausted beyond its steps (unchanged behavior)", async () => {
    const p = make();
    await p.handle(request({ session: "P", model: "once", messages: continued }), fakeResponse().res);
    expect(p.ledger()[0]).toMatchObject({ kind: "script-exhausted" });
  });

  it("attempts are per session (another session's identical transcript is its own first attempt)", async () => {
    const p = make();
    await p.handle(request({ session: "P", model: "partial", messages: first }), fakeResponse().res);
    await p.handle(request({ session: "C1", parent: "P", model: "partial", messages: first }), fakeResponse().res);
    expect(p.ledger().map((entry: { attempt: string }) => entry.attempt)).toEqual(["first", "first"]);
  });
});

describe("S4 budget option B: default host retry behavior is kept; request times are recorded", () => {
  it("error responses carry no retry-suppression headers (no retry-after / x-should-retry)", async () => {
    const heads: Record<string, string>[] = [];
    const p = provider();
    const res = { writeHead: (_status: number, headers: Record<string, string>) => heads.push(headers), write: () => {}, end: () => {}, destroy: () => {}, onClose: () => {} };
    await p.handle(request({ session: "P", model: "fail", stream: false }), res);
    expect(heads).toEqual([{ "content-type": "application/json" }]);
  });

  it("every ledger entry records its receive time (injectable clock)", async () => {
    let clock = 1_000;
    const p = createFakeProvider({ family: "v2", identityToken: "identity-token-123", now: () => (clock += 500), models: { fail: [{ type: "status", status: 500 }] } });
    p.registerParent("P");
    await p.handle(request({ session: "P", model: "fail" }), fakeResponse().res);
    await p.handle(request({ session: "P", model: "fail" }), fakeResponse().res);
    expect(p.ledger().map((entry: { receivedAt: number }) => entry.receivedAt)).toEqual([1_500, 2_000]);
  });
});
