import { describe, expect, it } from "vitest";

import { buildAggregatorPrompt } from "../../src/aggregator.js";
import { COUNCIL_TEXT } from "./aggregator-prompt.mjs";
import { classifyCall, drive, errorClassOf, HOST_TEXT } from "./drive.mjs";
import { createFakeProvider, sessionHeaders } from "./fake-provider.mjs";
import { hostAdapter } from "./hosts.mjs";
import { evaluate, fixtureFor } from "./scenarios.mjs";

type Fam = "v1" | "v2";
type Any = Record<string, any>;
const N = "abc123def456";
const REV = "council-plugin-reviewer";
const AGG = "council-plugin-aggregator";
const TIMING = { phaseMs: 1_500, pollMs: 2 };

/** In-memory provider response; `close()` simulates the host dropping the request. */
function fakeResponse() {
  const events: [string, ...unknown[]][] = [];
  let onClose: (() => void) | null = null;
  return {
    res: {
      writeHead: (status: number) => events.push(["head", status]),
      write: (chunk: string) => events.push(["write", chunk]),
      end: (chunk?: string) => events.push(["end", chunk ?? ""]),
      destroy: () => events.push(["destroy"]),
      onClose: (callback: () => void) => (onClose = callback),
    },
    close: () => onClose?.(),
    json: () => JSON.parse(events.filter(([kind]) => kind === "end").map(([, chunk]) => chunk).join("")),
  };
}

/**
 * Scripted host for one cell: real fake provider + normalized events + a client answering the
 * host routes from `state`. Each scenario test plays what the host + plugin would do.
 */
function makeSim(family: Fam, scenario: string, { onPrompt, routes = () => null }: { onPrompt: (sim: Any, id: string, text: string) => Promise<void>; routes?: (sim: Any, req: Any) => unknown }) {
  const host = hostAdapter(family);
  const fx = fixtureFor(scenario, { nonce: N, family, project: "/p", hostVersion: family === "v1" ? "1.19.3" : "2.0.32" });
  const provider = createFakeProvider({ family, identityToken: "identity-token-123", models: fx.models, nonces: fx.providerNonces, markers: fx.providerMarkers, outputMarkers: fx.outputMarkers });
  const seen: Any[] = [];
  const listeners = new Set<(event: Any) => void>();
  const calls: Any[] = [];
  const sessions = new Map<string, Any>();
  let ids = 0;
  let subscriptions = 0;
  const finalWaiters = new Map<string, (() => void)[]>();
  const sim: Any = {
    family,
    fx,
    provider,
    calls,
    sessions,
    get subscriptions() {
      return subscriptions;
    },
    emit(event: Any) {
      seen.push(event);
      for (const listener of [...listeners]) listener(event);
    },
    session(fields: Any) {
      const id = fields.id ?? `${fields.prefix ?? "s"}${++ids}`;
      sessions.set(id, { id, parentID: null, agent: "build", model: { providerID: "fake", modelID: "parent" }, permissions: [], tools: [], completed: null, errorName: null, ...fields });
      if (fields.parentID) sim.emit({ kind: "session-created", sessionID: id, parentID: fields.parentID });
      return id;
    },
    child(parentID: string, modelID: string, agent = REV) {
      return sim.session({ prefix: `${parentID}-${modelID}-`, parentID, agent, model: { providerID: "fake", modelID }, permissions: family === "v2" ? [...(sessions.get(parentID)?.permissions ?? []).filter((rule: Any) => rule.effect === "deny"), { action: "council_review", resource: "*", effect: "deny" }] : [] });
    },
    /** One provider request from `sessionID` (messages per step); returns { done, close, json }. */
    llm(sessionID: string, modelID: string, messages: Any[], tools: string[] = []) {
      const names = sessionHeaders(family);
      const parent = sessions.get(sessionID)?.parentID;
      const headers: Record<string, string> = { [names.session]: sessionID, ...(parent ? { [names.parent]: parent } : {}) };
      const r = fakeResponse();
      const done = provider.handle({ method: "POST", path: "/v1/chat/completions", headers, body: { model: modelID, messages, stream: false, tools: tools.map((name) => ({ type: "function", function: { name, parameters: {} } })) } }, r.res);
      return { done, close: r.close, json: r.json };
    },
    tool(sessionID: string, entry: Any) {
      sessions.get(sessionID).tools.push({ status: "completed", output: null, error: null, errorType: null, interrupted: false, invalidTarget: null, ...entry });
    },
    /** Terminal: V2 execution outcome; V1 idle (+ session.error when `errorName`). */
    finish(sessionID: string, outcome = "succeeded", errorName: string | null = null) {
      const s = sessions.get(sessionID);
      s.completed = 100 + ids;
      s.errorName = errorName;
      if (family === "v2") sim.emit({ kind: "session-final", sessionID, outcome });
      else {
        if (errorName) sim.emit({ kind: "session-error", sessionID, errorName });
        sim.emit({ kind: "session-idle", sessionID });
      }
      for (const resolve of finalWaiters.get(sessionID) ?? []) resolve();
    },
    isFinal: (sessionID: string) => seen.some((event) => event.sessionID === sessionID && (event.kind === "session-final" || event.kind === "session-idle")),
  };

  function messages(id: string) {
    const s = sessions.get(id);
    if (family === "v1") {
      const parts = s.tools.map((tool: Any) => ({ type: "tool", tool: tool.name, callID: tool.callID, state: tool.status === "completed" ? { status: "completed", input: tool.invalidTarget ? { tool: tool.invalidTarget } : {}, output: tool.output ?? "", metadata: {} } : { status: tool.status, input: {}, error: tool.error, metadata: tool.interrupted ? { interrupted: true } : {} } }));
      return { status: 200, json: [{ info: { id: `m-${id}`, role: "assistant", sessionID: id, agent: s.agent, mode: s.agent, providerID: s.model.providerID, modelID: s.model.modelID, time: s.completed ? { created: 1, completed: s.completed } : { created: 1 }, ...(s.errorName ? { error: { name: s.errorName } } : {}) }, parts }] };
    }
    const content = s.tools.map((tool: Any) => ({ type: "tool", id: tool.callID, name: tool.name, state: tool.status === "completed" ? { status: "completed", input: {}, content: [{ type: "text", text: tool.output ?? "" }] } : { status: tool.status, input: {}, error: { type: tool.errorType ?? "unknown", message: tool.error } } }));
    return { status: 200, json: { data: [{ id: `m-${id}`, type: "assistant", time: { created: 1, completed: s.completed }, content }], cursor: {} } };
  }

  async function answer(req: Any): Promise<{ status: number; json?: unknown }> {
    const custom = routes(sim, req);
    if (custom) return custom as { status: number; json?: unknown };
    const v2 = family === "v2";
    if (req.method === "GET" && req.path === (v2 ? "/api/session" : "/session") && !req.query?.parentID) return req.anonymous ? { status: 401 } : { status: 200, json: v2 ? { data: [] } : [] };
    if (req.path === "/api/plugin") return { status: 200, json: { data: [{ source: { type: "package", target: fx.spec }, state: { status: "active" } }] } };
    if (req.path === "/api/agent") return { status: 200, json: { data: [{ name: REV }, { name: AGG }] } };
    if (req.path === "/agent") return { status: 200, json: [{ name: REV }, { name: AGG }] };
    if (req.method === "POST" && req.path === (v2 ? "/api/session" : "/session")) {
      const id = sim.session({ prefix: "P", permissions: req.body?.permissions ?? [] });
      return { status: 200, json: v2 ? { data: { id } } : { id } };
    }
    const prompt = /^\/(?:api\/)?session\/([^/]+)\/prompt(?:_async)?$/.exec(req.path);
    if (prompt) {
      const text = v2 ? req.body.text : req.body.parts[0].text;
      void onPrompt(sim, decodeURIComponent(prompt[1]), text).catch(() => {});
      return { status: v2 ? 200 : 204, json: v2 ? { data: {} } : undefined };
    }
    const wait = /^\/api\/experimental\/session\/([^/]+)\/wait$/.exec(req.path);
    if (wait) {
      const id = decodeURIComponent(wait[1]);
      if (!sim.isFinal(id)) await new Promise<void>((resolve) => finalWaiters.set(id, [...(finalWaiters.get(id) ?? []), resolve]));
      return { status: 204 };
    }
    if (v2 && req.path === "/api/session" && req.query?.parentID) return { status: 200, json: { data: [...sessions.values()].filter((s) => s.parentID === req.query.parentID).map((s) => ({ id: s.id, parentID: s.parentID })) } };
    const children = /^\/session\/([^/]+)\/children$/.exec(req.path);
    if (children) return { status: 200, json: [...sessions.values()].filter((s) => s.parentID === decodeURIComponent(children[1])).map((s) => ({ id: s.id, parentID: s.parentID })) };
    const msgs = /^\/(?:api\/)?session\/([^/]+)\/message$/.exec(req.path);
    if (msgs) return messages(decodeURIComponent(msgs[1]));
    const get = /^\/api\/session\/([^/]+)$/.exec(req.path);
    if (get && req.method === "GET") {
      const s = sessions.get(decodeURIComponent(get[1]));
      return s ? { status: 200, json: { data: { id: s.id, parentID: s.parentID, agent: s.agent, model: { providerID: s.model.providerID, id: s.model.modelID }, permissions: s.permissions } } } : { status: 404 };
    }
    return { status: 404 };
  }

  const request = async (req: Any) => {
    calls.push(req);
    const { status, json = null } = await answer(req);
    return { status, json, text: json === null ? "" : JSON.stringify(json), headers: status === 401 ? { "www-authenticate": 'Basic realm="Secure Area"' } : {} };
  };
  const events = {
    subscribe: async () => void (subscriptions += 1),
    all: () => [...seen],
    watchNonces: (list: string[]) => (sim.watched = list),
    diagnostics: () => ({ typeCounts: {}, otherTypes: 0, toolShapes: [], shapesDropped: 0 }),
    waitFor: (predicate: (event: Any) => boolean, { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const hit = seen.find(predicate);
        if (hit) return resolve(hit);
        const done = () => {
          clearTimeout(timer);
          listeners.delete(listener);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => (done(), reject(Object.assign(new Error("aborted"), { code: "EABORTED" })));
        const timer = setTimeout(() => {
          done();
          reject(Object.assign(new Error(`event wait timed out after ${timeoutMs} ms`), { code: "EEVENTWAIT" }));
        }, timeoutMs);
        function listener(event: Any) {
          if (!predicate(event)) return;
          done();
          resolve(event);
        }
        listeners.add(listener);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }),
  };
  sim.run = ({ wrapClient, wrapEvents, ...extra }: Any = {}) => {
    const req = wrapClient ? wrapClient(request) : request;
    return drive({ scenario, family, host, fx, project: "/p", client: { hasAuth: true, request: req, handshake: req }, events: wrapEvents ? wrapEvents(events) : events, provider, signal: new AbortController().signal, timing: TIMING, ...extra });
  };
  return sim;
}

const user = (text: string) => [{ role: "user", content: text }];
const asked = (text: string, toolCalls: Any[], results: { id: string; content: string }[] = []) => [{ role: "user", content: text }, ...toolCalls.map((call) => ({ role: "assistant", content: null, tool_calls: [call] })), ...results.map((result) => ({ role: "tool", tool_call_id: result.id, content: result.content }))];
const label = (model: string, optional = false) => ({ providerID: "fake", modelID: model, ...(optional ? { optional: true } : {}) });

/** The parent's first step: a council_review tool call (records the provider call id); marks the tool running. */
async function parentCalls(sim: Any, P: string, text: string) {
  const step = sim.llm(P, "parent", user(text), ["council_review", "read"]);
  await step.done;
  const callID = step.json().choices[0].message.tool_calls[0].id;
  sim.tool(P, { callID, name: "council_review", status: "running" });
  return callID;
}
/** The parent's second step after the tool result; completes the call with `result`. */
async function parentDone(sim: Any, P: string, text: string, callID: string, result: string) {
  const tool = sim.sessions.get(P).tools.find((entry: Any) => entry.callID === callID);
  Object.assign(tool, { status: "completed", output: result });
  await sim.llm(P, "parent", asked(text, [{ id: callID, type: "function", function: { name: "council_review", arguments: "{}" } }], [{ id: callID, content: result }]), ["council_review"]).done;
  sim.finish(P);
}
/** A child that answers its scripted text (no tool calls). */
async function plainChild(sim: Any, parentID: string, model: string, prompt: string, agent = REV) {
  const id = sim.child(parentID, model, agent);
  await sim.llm(id, model, user(prompt), ["read"]).done;
  sim.finish(id);
  return id;
}
/** The aggregator child: request carrying the real aggregator prompt (src buildAggregatorPrompt); returns its handle. */
function aggregatorRequest(sim: Any, parentID: string, input: Any) {
  const id = sim.child(parentID, "aggregator", AGG);
  return { id, call: sim.llm(id, "aggregator", [{ role: "system", content: "agg" }, { role: "user", content: buildAggregatorPrompt({ originalPrompt: input.prompt, successes: input.successes, failures: input.failures ?? [], aborted: input.aborted ?? [] }) }]) };
}

describe("classification helpers (constant classes only)", () => {
  it.each([
    ["v2", { status: "error", error: COUNCIL_TEXT.v2AskDenied, errorType: "permission.rejected" }, "hook-denied"],
    ["v2", { status: "error", error: "Permission denied: shell", errorType: "permission.rejected" }, "static-denied"],
    ["v2", { status: "error", error: "No tool named council_review", errorType: "unknown" }, "no-such-tool"],
    ["v2", { status: "error", error: HOST_TEXT.v2Interrupted, errorType: "aborted" }, "interrupted"],
    ["v2", { status: "error", error: HOST_TEXT.v2Declined, errorType: "aborted" }, "rejected"],
    ["v1", { status: "error", error: `${HOST_TEXT.v1DeniedPrefix} Here are some of the relevant rules [...]` }, "static-denied"],
    ["v1", { status: "error", error: HOST_TEXT.v1Rejected }, "rejected"],
    ["v1", { status: "error", error: "Tool execution aborted" }, "aborted"],
    ["v1", { status: "completed", invalidTarget: "council_review" }, "no-such-tool"],
    ["v1", { status: "error", error: "boom" }, "other"],
    ["v1", { status: "completed" }, null],
  ] as const)("%s %j -> %s", (family, entry, expected) => {
    expect(errorClassOf(entry, family)).toBe(expected);
  });

  it("classifyCall records markers / exact-text keys, never the text", () => {
    const classified = classifyCall({ callID: "c", name: "bash", status: "completed", output: "secret ASK-1 42 more", error: null, interrupted: false, invalidTarget: null, messageCompleted: 3 }, { family: "v1", markers: ["ASK-1 42", "OTHER"], exactTexts: { cancelled: "Council review cancelled." } });
    expect(classified).toEqual({ callID: "c", name: "bash", status: "completed", markers: ["ASK-1 42"], errorClass: null, textIs: null, interrupted: false, invalidTarget: null, messageCompleted: 3 });
    expect(classifyCall({ callID: "c", name: "council_review", status: "completed", output: "Council review cancelled." }, { family: "v1", exactTexts: { cancelled: "Council review cancelled." } }).textIs).toBe("cancelled");
    expect(JSON.stringify(classified)).not.toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// S7: cancel. The host stops held children when the PARENT is cancelled.

function s7Host(stopChildrenOnCancel = true, holdChildren = true) {
  return async (sim: Any, P: string, text: string) => {
    const callID = await parentCalls(sim, P, text);
    const token = N;
    const kids = ["reviewer-a", "reviewer-b", "reviewer-c"].map((model) => {
      const id = sim.child(P, model);
      return { id, call: holdChildren ? sim.llm(id, model, user(`council-review-${token}`)) : null };
    });
    await new Promise<void>((resolve) => (sim.onCancel = resolve));
    for (const kid of kids) {
      if (stopChildrenOnCancel) kid.call?.close();
      sim.finish(kid.id, "interrupted", "MessageAbortedError");
    }
    const tool = sim.sessions.get(P).tools.find((entry: Any) => entry.callID === callID);
    if (sim.family === "v1") Object.assign(tool, { status: "completed", output: COUNCIL_TEXT.cancelled });
    else Object.assign(tool, { status: "error", error: HOST_TEXT.v2Interrupted, errorType: "aborted" });
    sim.finish(P, "interrupted");
  };
}
const cancelRoute = (sim: Any, req: Any) => {
  if (/\/abort$|\/interrupt$/.test(req.path)) {
    sim.onCancel?.();
    return sim.family === "v1" ? { status: 200, json: true } : { status: 200, json: { interrupted: true } };
  }
  return null;
};

describe("S7 driver", () => {
  it.each(["v1", "v2"] as const)("%s: holds all 3 reviewers, cancels the PARENT only, and the evidence passes", async (family) => {
    const sim = makeSim(family, "s7", { onPrompt: s7Host(), routes: cancelRoute });
    const evidence = await sim.run();
    expect(evaluate(evidence)).toMatchObject({ verdict: "PASS" });
    const cancels = sim.calls.filter((req: Any) => /\/abort$|\/interrupt$/.test(req.path));
    expect(cancels.map((req: Any) => req.path)).toEqual([family === "v1" ? `/session/${evidence.parentSessionID}/abort` : `/api/session/${evidence.parentSessionID}/interrupt`]);
    expect(evidence.actions).toEqual([{ kind: "cancel", target: evidence.parentSessionID, ok: true, status: 200, order: 1 }]);
  });

  it("an unmet hold precondition never cancels and yields INVALID-FIXTURE (barriers opened)", async () => {
    const sim = makeSim("v2", "s7", { onPrompt: s7Host(true, false), routes: cancelRoute });
    const evidence = await sim.run();
    expect(sim.calls.some((req: Any) => req.path.endsWith("/interrupt"))).toBe(false);
    expect(evidence.preconditions.allHeld).toMatchObject({ met: false });
    expect(evaluate(evidence).verdict).toBe("INVALID-FIXTURE");
  });

  it("children the host never stopped (no disconnect) fail claim (b)", async () => {
    const sim = makeSim("v1", "s7", { onPrompt: s7Host(false), routes: cancelRoute });
    const evidence = await sim.run({ timing: { phaseMs: 200, pollMs: 2 } });
    expect(evaluate(evidence).checks.find((check: Any) => check.id === "s7.children-stopped").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S3: quorum 2 of A, B, C (+ optional O).

function s3Host(aggregatorEarly = false) {
  return async (sim: Any, P: string, text: string) => {
    const x = sim.fx.expected;
    const callID = await parentCalls(sim, P, text);
    const prompt = `council-review-${N}`;
    const kid = (key: string) => {
      const id = sim.child(P, x.models[key]);
      return { id, call: sim.llm(id, x.models[key], user(prompt)) };
    };
    const a = kid("a");
    const b = kid("b");
    const c = kid("c");
    const o = kid("o");
    await a.call.done;
    sim.finish(a.id);
    await o.call.done;
    sim.finish(o.id);
    if (aggregatorEarly) sim.child(P, "aggregator", AGG);
    await b.call.done;
    sim.finish(b.id);
    c.call.close();
    sim.finish(c.id, "interrupted", "MessageAbortedError");
    const agg = aggregatorRequest(sim, P, { prompt, successes: [{ model: label("reviewer-a"), response: x.marker.a }, { model: label("reviewer-o", true), response: x.marker.o }, { model: label("reviewer-b"), response: x.marker.b }], aborted: [{ model: label("reviewer-c") }] });
    await agg.call.done;
    sim.finish(agg.id);
    await parentDone(sim, P, text, callID, `## Aggregated\n${x.aggregator.marker}`);
  };
}

describe("S3 driver", () => {
  it.each(["v1", "v2"] as const)("%s: releases A + O, records the advisory checkpoint, then B; the laggard is aborted -> PASS", async (family) => {
    const sim = makeSim(family, "s3", { onPrompt: s3Host() });
    const evidence = await sim.run();
    expect(evaluate(evidence)).toMatchObject({ verdict: "PASS" });
    expect(evidence.marks).toMatchObject({ checkpoint: { advisory: true, aggregatorRequests: 0 }, mutationClaim: "conditional-on-processing-order" });
    expect(evidence.actions.map((action: Any) => [action.kind, action.target])).toEqual([["release", "A,O"], ["release", "B"]]);
  });
});

// ---------------------------------------------------------------------------
// S4: failures; the partial nonce must be host-visible before the fault.

function s4Host(showPartial = true) {
  return async (sim: Any, P: string, text: string) => {
    const x = sim.fx.expected;
    const callID = await parentCalls(sim, P, text);
    const prompt = `council-review-${N}`;
    const r = (index: number) => {
      const id = sim.child(P, `reviewer-${index}`);
      return { id, call: sim.llm(id, `reviewer-${index}`, user(prompt)) };
    };
    const kids = [1, 2, 3, 4, 5].map(r);
    await sim.provider.waitFor((event: Any) => event.type === "partial-written", { timeoutMs: 1000 });
    if (showPartial) sim.emit({ kind: "nonce-seen", nonce: x.partial, type: "session.text.delta" });
    for (const kid of kids) await kid.call.done;
    sim.finish(kids[0].id, "failed", "APIError");
    sim.finish(kids[1].id);
    sim.finish(kids[2].id, "failed", "UnknownError");
    sim.finish(kids[3].id);
    sim.finish(kids[4].id);
    const agg = aggregatorRequest(sim, P, { prompt, successes: [{ model: label("reviewer-4"), response: x.marker[4] }, { model: label("reviewer-5"), response: x.marker[5] }], failures: [{ model: label("reviewer-1"), error: "prompt failed: APIError" }, { model: label("reviewer-2"), error: "empty response" }, { model: label("reviewer-3"), error: "child session failed: x" }] });
    await agg.call.done;
    sim.finish(agg.id);
    await parentDone(sim, P, text, callID, x.aggregator.marker);
  };
}

describe("S4 driver", () => {
  it.each(["v1", "v2"] as const)("%s: watches P, releases the fault only after P is host-visible -> PASS", async (family) => {
    const sim = makeSim(family, "s4", { onPrompt: s4Host() });
    const evidence = await sim.run();
    expect(sim.watched).toEqual([sim.fx.expected.partial]);
    expect(evaluate(evidence)).toMatchObject({ verdict: "PASS" });
    expect(evidence.marks.partialReleasedAfterSeen).toBe(true);
  });

  it("P never host-visible -> the fault is released anyway, INVALID-FIXTURE", async () => {
    const sim = makeSim("v2", "s4", { onPrompt: s4Host(false) });
    const evidence = await sim.run({ timing: { phaseMs: 300, pollMs: 2 } });
    expect(evidence.preconditions.partialSeen.met).toBe(false);
    expect(evaluate(evidence).verdict).toBe("INVALID-FIXTURE");
  });
});

// ---------------------------------------------------------------------------
// S5 / S6: timeouts.

function s5Host(holdTarget = true) {
  return async (sim: Any, P: string, text: string) => {
    const x = sim.fx.expected;
    const callID = await parentCalls(sim, P, text);
    const prompt = `council-review-${N}`;
    const a = await plainChild(sim, P, "reviewer-a", prompt);
    const b = await plainChild(sim, P, "reviewer-b", prompt);
    const c = sim.child(P, "reviewer-c");
    if (holdTarget) {
      const held = sim.llm(c, "reviewer-c", user(prompt));
      await sim.provider.waitFor((event: Any) => event.type === "hold", { timeoutMs: 1000 });
      held.close();
    }
    sim.finish(c, "interrupted", "MessageAbortedError");
    void a;
    void b;
    const agg = aggregatorRequest(sim, P, { prompt, successes: [{ model: label("reviewer-a"), response: x.marker.a }, { model: label("reviewer-b"), response: x.marker.b }], failures: [{ model: label("reviewer-c"), error: "fake/reviewer-c timed out after 20s" }] });
    await agg.call.done;
    sim.finish(agg.id);
    await parentDone(sim, P, text, callID, x.aggregator.marker);
  };
}

function s6Host() {
  return async (sim: Any, P: string, text: string) => {
    const callID = await parentCalls(sim, P, text);
    const prompt = `council-review-${N}`;
    for (const model of ["reviewer-a", "reviewer-b", "reviewer-c"]) await plainChild(sim, P, model, prompt);
    const agg = aggregatorRequest(sim, P, { prompt, successes: [{ model: label("reviewer-a"), response: "x" }, { model: label("reviewer-b"), response: "y" }] });
    await sim.provider.waitFor((event: Any) => event.type === "hold", { timeoutMs: 1000 });
    agg.call.close();
    sim.finish(agg.id, "interrupted", "MessageAbortedError");
    await parentDone(sim, P, text, callID, sim.fx.expected.exactTexts.aggregatorTimeout);
  };
}

describe("S5 / S6 drivers", () => {
  it.each(["v1", "v2"] as const)("S5 %s: the target is held before its timeout; the host stops it -> PASS", async (family) => {
    const sim = makeSim(family, "s5", { onPrompt: s5Host() });
    expect(evaluate(await sim.run())).toMatchObject({ verdict: "PASS" });
  });

  it("S5: the target never held -> INVALID-FIXTURE", async () => {
    const sim = makeSim("v1", "s5", { onPrompt: s5Host(false) });
    const evidence = await sim.run({ fx: { ...fixtureFor("s5", { nonce: N, family: "v1" }), expected: { ...fixtureFor("s5", { nonce: N, family: "v1" }).expected, timeouts: { councillor_ms: 200, aggregator_ms: 60_000 } } } });
    expect(evaluate(evidence).verdict).toBe("INVALID-FIXTURE");
  });

  it.each(["v1", "v2"] as const)("S6 %s: the aggregator is held, timed out, and stopped -> PASS", async (family) => {
    const sim = makeSim(family, "s6", { onPrompt: s6Host() });
    expect(evaluate(await sim.run())).toMatchObject({ verdict: "PASS" });
  });
});

// ---------------------------------------------------------------------------
// S8: permissions.

function s8Host(family: Fam) {
  return async (sim: Any, P: string, text: string) => {
    const x = sim.fx.expected;
    const shell = x.shellName;
    if (text.includes(x.controlToken)) {
      const step = sim.llm(P, "parent", user(text), [shell]);
      await step.done;
      const callID = step.json().choices[0].message.tool_calls[0].id;
      sim.emit({ kind: "permission-asked", requestID: "perm-1", sessionID: P, permission: family === "v1" ? "bash" : "shell", patterns: [x.commands.ask.command], callID });
      await new Promise<void>((resolve) => (sim.onReply = resolve));
      sim.tool(P, { callID, name: shell, status: "error", error: family === "v1" ? HOST_TEXT.v1Rejected : HOST_TEXT.v2Declined, errorType: "aborted" });
      sim.finish(P);
      return;
    }
    const callID = await parentCalls(sim, P, text);
    const prompt = `council-review-${N}`;
    const c = x.commands;
    // reviewer-a: the would-ask command.
    const a = sim.child(P, "reviewer-a");
    const aStep = sim.llm(a, "reviewer-a", user(prompt), [shell, "read"]);
    await aStep.done;
    const aCall = aStep.json().choices[0].message.tool_calls[0];
    if (family === "v2") sim.tool(a, { callID: aCall.id, name: shell, status: "error", error: COUNCIL_TEXT.v2AskDenied, errorType: "permission.rejected" });
    else sim.tool(a, { callID: aCall.id, name: shell, status: "completed", output: c.ask.output });
    await sim.llm(a, "reviewer-a", asked(prompt, [aCall], [{ id: aCall.id, content: family === "v2" ? COUNCIL_TEXT.v2AskDenied : c.ask.output }]), [shell, "read"]).done;
    sim.finish(a);
    // reviewer-b: resource deny + allowed sibling.
    const b = sim.child(P, "reviewer-b");
    const b0 = sim.llm(b, "reviewer-b", user(prompt), [shell]);
    await b0.done;
    const denyCall = b0.json().choices[0].message.tool_calls[0];
    sim.tool(b, { callID: denyCall.id, name: shell, status: "error", error: family === "v2" ? "Permission denied: shell" : `${HOST_TEXT.v1DeniedPrefix} rules`, errorType: "permission.rejected" });
    const b1 = sim.llm(b, "reviewer-b", asked(prompt, [denyCall], [{ id: denyCall.id, content: "denied" }]), [shell]);
    await b1.done;
    const sibCall = b1.json().choices[0].message.tool_calls[0];
    sim.tool(b, { callID: sibCall.id, name: shell, status: "completed", output: c.sibling.output });
    await sim.llm(b, "reviewer-b", asked(prompt, [denyCall, sibCall], [{ id: denyCall.id, content: "denied" }, { id: sibCall.id, content: c.sibling.output }]), [shell]).done;
    sim.finish(b);
    // reviewer-c: V2 parent-only deny + sibling; V1 plain.
    const rc = sim.child(P, "reviewer-c");
    if (family === "v2") {
      const c0 = sim.llm(rc, "reviewer-c", user(prompt), [shell]);
      await c0.done;
      const parCall = c0.json().choices[0].message.tool_calls[0];
      sim.tool(rc, { callID: parCall.id, name: shell, status: "error", error: "Permission denied: shell", errorType: "permission.rejected" });
      const c1 = sim.llm(rc, "reviewer-c", asked(prompt, [parCall], [{ id: parCall.id, content: "denied" }]), [shell]);
      await c1.done;
      const sib2 = c1.json().choices[0].message.tool_calls[0];
      sim.tool(rc, { callID: sib2.id, name: shell, status: "completed", output: c.sibling2.output });
      await sim.llm(rc, "reviewer-c", asked(prompt, [parCall, sib2], [{ id: parCall.id, content: "denied" }, { id: sib2.id, content: c.sibling2.output }]), [shell]).done;
    } else await sim.llm(rc, "reviewer-c", user(prompt), [shell]).done;
    sim.finish(rc);
    const agg = aggregatorRequest(sim, P, { prompt, successes: [{ model: label("reviewer-a"), response: "a" }, { model: label("reviewer-b"), response: "b" }] });
    await agg.call.done;
    sim.finish(agg.id);
    await parentDone(sim, P, text, callID, x.aggregator.marker);
  };
}
const replyRoute = (sim: Any, req: Any) => {
  if (/\/permission\/[^/]+\/reply$/.test(req.path)) {
    sim.replies = [...(sim.replies ?? []), req];
    sim.onReply?.();
    return sim.family === "v1" ? { status: 200, json: true } : { status: 204 };
  }
  return null;
};

describe("S8 driver", () => {
  it.each(["v1", "v2"] as const)("%s: control asks (rejected by the harness), council children ask/deny/parent-deny -> PASS", async (family) => {
    const sim = makeSim(family, "s8", { onPrompt: s8Host(family), routes: replyRoute });
    const evidence = await sim.run({ readPluginLog: async () => `noise ${sim.fx.expected.stripWarning} noise` });
    const result = evaluate(evidence);
    expect(result.checks.filter((check: Any) => !check.ok)).toEqual([]);
    expect(sim.replies.map((req: Any) => req.body)).toEqual([family === "v1" ? { reply: "reject" } : { decision: "reject" }]);
    if (family === "v2") {
      const create = sim.calls.filter((req: Any) => req.method === "POST" && req.path === "/api/session");
      expect(create[0].body.permissions).toBeUndefined();
      expect(create[1].body.permissions).toEqual(sim.fx.sessionPermissions);
      expect(evidence.parentSession).toEqual({ read: true, permissions: sim.fx.sessionPermissions });
    } else expect(evidence.pluginLog).toEqual({ read: true, stripWarnings: 1, polls: 1 });
  });

  it("V1: an unreadable plugin log counts zero warnings (and fails s8.would-ask)", async () => {
    const sim = makeSim("v1", "s8", { onPrompt: s8Host("v1"), routes: replyRoute });
    const evidence = await sim.run({ readPluginLog: async () => {
      throw new Error("ENOENT secret path");
    } });
    expect(evidence.pluginLog).toMatchObject({ read: false, stripWarnings: 0 });
    expect(evaluate(evidence).checks.find((check: Any) => check.id === "s8.would-ask").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S9 / S10 / S11 / obs-ask.

function recursionHost(family: Fam) {
  return async (sim: Any, P: string, text: string) => {
    const callID = await parentCalls(sim, P, text);
    const prompt = `council-review-${N}`;
    const a = sim.child(P, "reviewer-a");
    const a0 = sim.llm(a, "reviewer-a", user(prompt), ["read"]);
    await a0.done;
    const nested = a0.json().choices[0].message.tool_calls[0];
    if (family === "v2") sim.tool(a, { callID: nested.id, name: "council_review", status: "error", error: "No tool named council_review", errorType: "unknown" });
    else sim.tool(a, { callID: nested.id, name: "invalid", status: "completed", output: "invalid tool", invalidTarget: "council_review" });
    await sim.llm(a, "reviewer-a", asked(prompt, [nested], [{ id: nested.id, content: "no such tool" }]), ["read"]).done;
    sim.finish(a);
    for (const model of ["reviewer-b", "reviewer-c"]) await plainChild(sim, P, model, prompt);
    const agg = aggregatorRequest(sim, P, { prompt, successes: [{ model: label("reviewer-a"), response: "a" }, { model: label("reviewer-b"), response: "b" }] });
    await agg.call.done;
    sim.finish(agg.id);
    await parentDone(sim, P, text, callID, sim.fx.expected.aggregator.marker);
  };
}

describe("S9 driver", () => {
  it.each(["v1", "v2"] as const)("%s: lists each child's descendants (zero) and the refused attempt -> PASS", async (family) => {
    const sim = makeSim(family, "s9", { onPrompt: recursionHost(family) });
    const evidence = await sim.run();
    expect(evaluate(evidence)).toMatchObject({ verdict: "PASS" });
    expect(Object.values(evidence.grandchildren)).toEqual([0, 0, 0, 0]);
  });
});

function s10Host(family: Fam) {
  return async (sim: Any, P: string, text: string) => {
    const callID = await parentCalls(sim, P, text);
    const prompt = `council-review-${N}`;
    const a = sim.child(P, "reviewer-a");
    const a0 = sim.llm(a, "reviewer-a", user(prompt), ["read"]);
    await a0.done;
    const blocked = a0.json().choices[0].message.tool_calls[0];
    sim.tool(a, family === "v2" ? { callID: blocked.id, name: "shell", status: "error", error: "No tool named shell", errorType: "unknown" } : { callID: blocked.id, name: "invalid", status: "completed", output: "x", invalidTarget: "bash" });
    await sim.llm(a, "reviewer-a", asked(prompt, [blocked], [{ id: blocked.id, content: "unavailable" }]), ["read"]).done;
    sim.finish(a);
    for (const model of ["reviewer-b", "reviewer-c"]) await plainChild(sim, P, model, prompt);
    const agg = aggregatorRequest(sim, P, { prompt, successes: [{ model: label("reviewer-a"), response: "a" }, { model: label("reviewer-b"), response: "b" }] });
    await agg.call.done;
    sim.finish(agg.id);
    await parentDone(sim, P, text, callID, sim.fx.expected.aggregator.marker);
  };
}

describe("S10 driver", () => {
  it.each(["v1", "v2"] as const)("%s: shell hidden from reviewer-a and the attempt refused -> PASS", async (family) => {
    expect(evaluate(await makeSim(family, "s10", { onPrompt: s10Host(family) }).run())).toMatchObject({ verdict: "PASS" });
  });
});

function s11Host() {
  return async (sim: Any, P: string, text: string) => {
    const x = sim.fx.expected;
    const callID = await parentCalls(sim, P, text);
    const prompt = `council-review-${N}`;
    const system = { role: "system", content: `You are a code reviewer. ${x.systemMarker}` };
    const a = sim.child(P, "reviewer-a", x.agentName);
    const a0 = sim.llm(a, "reviewer-a", [system, ...user(prompt)], ["read"]);
    await a0.done;
    const denied = a0.json().choices[0].message.tool_calls[0];
    sim.tool(a, { callID: denied.id, name: "read", status: "error", error: "permission denied" });
    const a1 = sim.llm(a, "reviewer-a", [system, ...asked(prompt, [denied], [{ id: denied.id, content: "denied" }])], ["read"]);
    await a1.done;
    const okRead = a1.json().choices[0].message.tool_calls[0];
    sim.tool(a, { callID: okRead.id, name: "read", status: "completed", output: `${x.okContent}\n` });
    await sim.llm(a, "reviewer-a", [system, ...asked(prompt, [denied, okRead], [{ id: denied.id, content: "denied" }, { id: okRead.id, content: x.okContent }])], ["read"]).done;
    sim.finish(a);
    for (const model of ["reviewer-b", "reviewer-c"]) {
      const id = sim.child(P, model, x.agentName);
      await sim.llm(id, model, [system, ...user(prompt)], ["read"]).done;
      sim.finish(id);
    }
    const agg = aggregatorRequest(sim, P, { prompt, successes: [{ model: label("reviewer-a"), response: "a" }, { model: label("reviewer-b"), response: "b" }] });
    await agg.call.done;
    sim.finish(agg.id);
    await parentDone(sim, P, text, callID, x.aggregator.marker);
  };
}

describe("S11 driver", () => {
  it.each(["v1", "v2"] as const)("%s: custom agent children, system marker, denied + sibling reads -> PASS", async (family) => {
    expect(evaluate(await makeSim(family, "s11", { onPrompt: s11Host() }).run())).toMatchObject({ verdict: "PASS" });
  });
});

describe("obs-ask driver (V1, observational)", () => {
  it("records the child ask observation without replying to it", async () => {
    const sim = makeSim("v1", "obs-ask", {
      onPrompt: async (s: Any, P: string, text: string) => {
        const callID = await parentCalls(s, P, text);
        const prompt = `council-review-${N}`;
        const a = s.child(P, "reviewer-a");
        const held = s.llm(a, "reviewer-a", user(prompt), ["webfetch"]);
        await held.done;
        s.emit({ kind: "permission-asked", requestID: "p1", sessionID: a, permission: "webfetch", patterns: [], callID: "c" });
        s.finish(a, "idle", "MessageAbortedError");
        for (const model of ["reviewer-b", "reviewer-c"]) await plainChild(s, P, model, prompt);
        const agg = aggregatorRequest(s, P, { prompt, successes: [{ model: label("reviewer-b"), response: "b" }, { model: label("reviewer-c"), response: "c" }], failures: [{ model: label("reviewer-a"), error: "fake/reviewer-a timed out after 20s" }] });
        await agg.call.done;
        s.finish(agg.id);
        await parentDone(s, P, text, callID, s.fx.expected.aggregator.marker);
      },
      routes: replyRoute,
    });
    const evidence = await sim.run();
    expect(evidence.marks.observation).toEqual({ childAsks: 1, askedPermissions: ["webfetch"], parentFinal: "idle" });
    expect(sim.replies).toBeUndefined();
    expect(evaluate(evidence).verdict).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// S12: two councils + unrelated pending ask.

function s12Host(family: Fam, { replyEarly = false } = {}) {
  return async (sim: Any, P: string, text: string) => {
    const x = sim.fx.expected;
    const shell = family === "v1" ? "bash" : "shell";
    if (text.includes(x.tokens.u)) {
      const step = sim.llm(P, "parent", user(text), [shell]);
      await step.done;
      const call = step.json().choices[0].message.tool_calls[0];
      sim.emit({ kind: "permission-asked", requestID: "perm-u", sessionID: P, permission: shell, patterns: [], callID: call.id });
      if (replyEarly) sim.emit({ kind: "permission-replied", requestID: "perm-u", sessionID: P, reply: "once" });
      await new Promise<void>((resolve) => (sim.onReply = resolve));
      sim.tool(P, { callID: call.id, name: shell, status: "completed", output: x.uOutput });
      await sim.llm(P, "parent", asked(text, [call], [{ id: call.id, content: x.uOutput }]), [shell]).done;
      sim.finish(P);
      return;
    }
    const isA = text.includes(x.tokens.a);
    const token = isA ? x.tokens.a : x.tokens.b;
    const callID = await parentCalls(sim, P, text);
    const prompt = `council-review-${token}`;
    const kids = ["reviewer-a", "reviewer-b", "reviewer-c"].map((model) => {
      const id = sim.child(P, model);
      return { id, model, call: sim.llm(id, model, user(prompt)) };
    });
    if (isA) {
      await new Promise<void>((resolve) => (sim.onCancel = resolve));
      for (const kid of kids) {
        kid.call.close();
        sim.finish(kid.id, "interrupted", "MessageAbortedError");
      }
      const tool = sim.sessions.get(P).tools.find((entry: Any) => entry.callID === callID);
      if (family === "v1") Object.assign(tool, { status: "completed", output: COUNCIL_TEXT.cancelled });
      else Object.assign(tool, { status: "error", error: HOST_TEXT.v2Interrupted, errorType: "aborted" });
      sim.finish(P, "interrupted");
      return;
    }
    for (const kid of kids) {
      await kid.call.done;
      sim.finish(kid.id);
    }
    const agg = aggregatorRequest(sim, P, { prompt, successes: kids.map((kid, index) => ({ model: label(kid.model), response: x.markers.b[index] })) });
    await agg.call.done;
    sim.finish(agg.id);
    await parentDone(sim, P, text, callID, x.aggregate.b);
  };
}

describe("S12 driver", () => {
  it.each(["v1", "v2"] as const)("%s: A cancelled while B held; B completes; U's ask pending until the harness replies -> PASS", async (family) => {
    const sim = makeSim(family, "s12", { onPrompt: s12Host(family), routes: (s, req) => cancelRoute(s, req) ?? replyRoute(s, req) });
    const evidence = await sim.run();
    const result = evaluate(evidence);
    expect(result.checks.filter((check: Any) => !check.ok)).toEqual([]);
    expect(evidence.actions.map((action: Any) => action.kind)).toEqual(["cancel", "release", "reply"]);
    expect(evidence.actions[0].target).toBe(evidence.roles.parentA);
    expect(evidence.actions[2]).toMatchObject({ target: evidence.roles.control, decision: "once" });
    expect(evidence.marks).toMatchObject({ aFinalBeforeBRelease: true, uRepliedBeforeHarness: false, uFinalBeforeReply: false, uRequestsBeforeReply: 1, uReplyAfterBFinal: true });
  });

  it("an ask replied by someone else before the harness fails the pending claim", async () => {
    const sim = makeSim("v2", "s12", { onPrompt: s12Host("v2", { replyEarly: true }), routes: (s, req) => cancelRoute(s, req) ?? replyRoute(s, req) });
    const result = evaluate(await sim.run());
    expect(result.checks.find((check: Any) => check.id === "s12.unrelated-ask-pending").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S13: V2 reload continuity / V1 dispose teardown.

function s13Host(family: Fam) {
  return async (sim: Any, P: string, text: string) => {
    const x = sim.fx.expected;
    const fresh = text.includes(x.freshToken);
    const token = fresh ? x.freshToken : x.token;
    const callID = await parentCalls(sim, P, text);
    const prompt = `council-review-${token}`;
    const kids = ["reviewer-a", "reviewer-b", "reviewer-c"].map((model) => {
      const id = sim.child(P, model);
      return { id, model, call: sim.llm(id, model, user(prompt)) };
    });
    if (!fresh && family === "v1") {
      await new Promise<void>((resolve) => (sim.onDispose = resolve));
      for (const kid of kids) {
        kid.call.close();
        sim.finish(kid.id, "idle", "MessageAbortedError");
      }
      const tool = sim.sessions.get(P).tools.find((entry: Any) => entry.callID === callID);
      Object.assign(tool, { status: "error", error: "Tool execution aborted", interrupted: true });
      sim.finish(P);
      sim.emit({ kind: "instance-disposed" });
      return;
    }
    for (const kid of kids) {
      await kid.call.done;
      sim.finish(kid.id);
    }
    const agg = aggregatorRequest(sim, P, { prompt, successes: kids.map((kid) => ({ model: label(kid.model), response: kid.model })) });
    await agg.call.done;
    sim.finish(agg.id);
    await parentDone(sim, P, text, callID, fresh ? x.aggregate.fresh : x.aggregate.original);
  };
}

describe("S13 driver", () => {
  it("V2: reload (204) with the review in flight, inventory re-activation polled, release, original completes, fresh review -> PASS", async () => {
    let reloaded = false;
    const sim = makeSim("v2", "s13", {
      onPrompt: s13Host("v2"),
      routes: (s, req) => {
        if (req.path === "/api/location/reload") {
          reloaded = true;
          s.emit({ kind: "plugin-updated" });
          return { status: 204 };
        }
        if (req.path === "/api/plugin") return { status: 200, json: { data: [{ source: { type: "package", target: s.fx.spec }, state: reloaded ? { status: "active", generation: 2 } : { status: "active", generation: 1 } }] } };
        return null;
      },
    });
    const evidence = await sim.run();
    expect(evaluate(evidence).checks.filter((check: Any) => !check.ok)).toEqual([]);
    expect(evidence.inventory).toMatchObject({ before: { active: true }, after: { active: true } });
    expect(evidence.marks.pluginUpdatedAfterReload).toBe(1);
  });

  it("V1: dispose with the review in flight -> disposed event, two-form parent terminal, re-subscribe, fresh review -> PASS", async () => {
    const sim = makeSim("v1", "s13", {
      onPrompt: s13Host("v1"),
      routes: (s, req) => {
        if (req.path === "/instance/dispose") {
          setTimeout(() => s.onDispose?.(), 1);
          return { status: 200, json: true };
        }
        return null;
      },
    });
    const evidence = await sim.run();
    expect(evaluate(evidence).checks.filter((check: Any) => !check.ok)).toEqual([]);
    expect(sim.subscriptions).toBe(1);
    expect(evidence.marks).toMatchObject({ disposedEvent: true, teardown: "instance-dispose" });
    expect(evidence.actions.map((action: Any) => action.kind)).toEqual(["dispose"]);
  });
});

describe("drive kit budgets", () => {
  it("a council parent's terminal wait is bounded by councillor + aggregator + phase (not the bare phase budget)", async () => {
    const { createDriveKit } = await import("./drive.mjs");
    const fx = fixtureFor("s4", { nonce: N, family: "v2" });
    const seenTimeouts: number[] = [];
    const kit = createDriveKit({ scenario: "s4", family: "v2", host: hostAdapter("v2"), fx, project: "/p", client: { request: async (req: Any) => (seenTimeouts.push(req.timeout), { status: 204, json: null }) }, events: { all: () => [], waitFor: async (_p: unknown, { timeoutMs }: { timeoutMs: number }) => (seenTimeouts.push(timeoutMs), {}) }, provider: {}, signal: new AbortController().signal, timing: { phaseMs: 60_000, pollMs: 250 } } as never);
    await kit.awaitFinal("P");
    const budget = fx.timeouts.councillor_ms + fx.timeouts.aggregator_ms + 60_000;
    expect(budget).toBe(150_000 + 60_000 + 60_000);
    expect(kit.councilBudgetMs).toBe(budget);
    expect(seenTimeouts).toEqual([budget, budget]);
  });
});

describe("driver robustness (non-ideal hosts)", () => {
  it("S5: a hold that arrives only AFTER the councillor timeout fails the precondition (INVALID-FIXTURE)", async () => {
    const base = fixtureFor("s5", { nonce: N, family: "v2" });
    const sim = makeSim("v2", "s5", {
      onPrompt: async (s: Any, P: string, text: string) => {
        await parentCalls(s, P, text);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const c = s.child(P, "reviewer-c");
        s.llm(c, "reviewer-c", user(`council-review-${N}`));
      },
    });
    const evidence = await sim.run({ fx: { ...base, expected: { ...base.expected, timeouts: { councillor_ms: 100, aggregator_ms: 60_000 } } } });
    expect(evidence.preconditions.targetHeld).toMatchObject({ met: false });
    expect(evidence.preconditions.targetHeld.detail).toMatch(/hold observed after \d+ ms \(councillor timeout 100 ms\)/);
    expect(evaluate(evidence).verdict).toBe("INVALID-FIXTURE");
  });

  it("S12: council A never settling is recorded (B's release is not 'after A') and fails s12.b-completes-after-a", async () => {
    const host = s12Host("v2");
    const sim = makeSim("v2", "s12", {
      onPrompt: async (s: Any, P: string, text: string) => {
        if (text.includes(s.fx.expected.tokens.a)) {
          const callID = await parentCalls(s, P, text);
          void callID;
          for (const model of ["reviewer-a", "reviewer-b", "reviewer-c"]) s.llm(s.child(P, model), model, user(`council-review-${s.fx.expected.tokens.a}`));
          return;
        }
        return host(s, P, text);
      },
      routes: (s, req) => cancelRoute(s, req) ?? replyRoute(s, req),
    });
    const evidence = await sim.run({ timing: { phaseMs: 200, pollMs: 2 } });
    expect(evidence.marks.aFinalBeforeBRelease).toBe(false);
    expect(evaluate(evidence).checks.find((check: Any) => check.id === "s12.b-completes-after-a").ok).toBe(false);
  });

  it("S12: a host answering the permission reply unexpectedly (V2 200 instead of 204) is not an accepted reply", async () => {
    const sim = makeSim("v2", "s12", {
      onPrompt: s12Host("v2"),
      routes: (s, req) => {
        if (/\/permission\/[^/]+\/reply$/.test(req.path)) {
          s.onReply?.();
          return { status: 200, json: { data: {} } };
        }
        return cancelRoute(s, req);
      },
    });
    const evidence = await sim.run();
    expect(evidence.actions.find((action: Any) => action.kind === "reply")).toMatchObject({ ok: false, status: 200 });
    expect(evaluate(evidence).checks.find((check: Any) => check.id === "s12.unrelated-ask-pending").ok).toBe(false);
  });

  it("S13/V2: the inventory is polled until the plugin is active again after the reload", async () => {
    let polls = 0;
    let reloaded = false;
    const sim = makeSim("v2", "s13", {
      onPrompt: s13Host("v2"),
      routes: (s, req) => {
        if (req.path === "/api/location/reload") {
          reloaded = true;
          s.emit({ kind: "plugin-updated" });
          return { status: 204 };
        }
        if (req.path === "/api/plugin") {
          const status = !reloaded ? "active" : ++polls < 3 ? "loading" : "active";
          return { status: 200, json: { data: [{ source: { type: "package", target: s.fx.spec }, state: { status } }] } };
        }
        return null;
      },
    });
    const evidence = await sim.run();
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(evidence.inventory.after.active).toBe(true);
    expect(evaluate(evidence).verdict).toBe("PASS");
  });

  it("S7/V1: an abort recorded only in the persisted assistant error (no session.error event) is still abort evidence", async () => {
    const host = s7Host();
    const sim = makeSim("v1", "s7", { onPrompt: host, routes: cancelRoute });
    const emit = sim.emit;
    sim.emit = (event: Any) => (event.kind === "session-error" ? undefined : emit(event));
    const evidence = await sim.run();
    expect(Object.values(evidence.sessionErrors)).toEqual([]);
    expect(Object.values(evidence.persistedErrors)).toEqual(["MessageAbortedError", "MessageAbortedError", "MessageAbortedError"]);
    expect(evaluate(evidence).verdict).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Post-P1b audit fixes.

describe("audit: S3 checkpoint is recorded as an advisory observation, not a claim", () => {
  it("marks the checkpoint without saying 'supported'", async () => {
    const evidence = await makeSim("v2", "s3", { onPrompt: s3Host() }).run();
    expect(evidence.marks.checkpoint).toEqual({ advisory: true, aggregatorRequests: 0, observation: "aggregator-not-yet-requested-at-checkpoint" });
    expect(evidence.marks.mutationClaim).toBe("conditional-on-processing-order");
    expect(JSON.stringify(evidence.marks)).not.toMatch(/supported/);
  });
});

describe("audit M3: S11 read-deny rule is host-relative (V1 worktree from the host)", () => {
  function s11V1(worktree: { status: number; json?: unknown }) {
    const rewrites: Any[] = [];
    const sim = makeSim("v1", "s11", {
      onPrompt: s11Host(),
      routes: (s, req) => {
        if (req.path === "/project/current") return worktree;
        if (req.path === "/instance/dispose") {
          setTimeout(() => s.emit({ kind: "instance-disposed" }), 1);
          return { status: 200, json: true };
        }
        return null;
      },
    });
    return { sim, rewrites, run: () => sim.run({ rewriteProjectFile: async (file: Any) => void rewrites.push(file) }) };
  }

  it("worktree '/' (non-git project): re-renders the rule relative to it, disposes, re-subscribes, then runs", async () => {
    const { sim, rewrites, run } = s11V1({ status: 200, json: { id: "global", worktree: "/" } });
    const evidence = await run();
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0].path).toBe(`.opencode/agent/${sim.fx.expected.agentName}.md`);
    expect(rewrites[0].content).toContain(`"p/custom-deny-${N}.txt": deny`);
    expect(evidence.actions[0]).toMatchObject({ kind: "dispose", target: null, ok: true });
    expect(sim.subscriptions).toBe(1);
    expect(evidence.marks.worktree).toEqual({ status: 200, known: true, equalsProject: false, rewritten: true, pattern: `p/custom-deny-${N}.txt` });
    expect(evaluate(evidence).verdict).toBe("PASS");
  });

  it("worktree == project: the project-relative rule stands (no rewrite, no dispose)", async () => {
    const { rewrites, run } = s11V1({ status: 200, json: { worktree: "/p" } });
    const evidence = await run();
    expect(rewrites).toEqual([]);
    expect(evidence.actions).toEqual([]);
    expect(evidence.marks.worktree).toMatchObject({ known: true, equalsProject: true, rewritten: false, pattern: `custom-deny-${N}.txt` });
  });

  it("worktree unknown (route unavailable): project-relative rule kept and the observation records it", async () => {
    const { rewrites, run } = s11V1({ status: 404 });
    const evidence = await run();
    expect(rewrites).toEqual([]);
    expect(evidence.marks.worktree).toEqual({ status: 404, known: false, equalsProject: null, rewritten: false, pattern: `custom-deny-${N}.txt` });
  });

  it("V2 never queries a worktree (location.directory = project)", async () => {
    const sim = makeSim("v2", "s11", { onPrompt: s11Host() });
    const evidence = await sim.run();
    expect(sim.calls.some((req: Any) => req.path.includes("/project/"))).toBe(false);
    expect(evidence.marks.worktree).toBeUndefined();
  });
});

describe("audit M6: S8 V1 strip warning is polled (bounded) from opencode.log", () => {
  it("polls until the warning appears", async () => {
    let reads = 0;
    const sim = makeSim("v1", "s8", { onPrompt: s8Host("v1"), routes: replyRoute });
    const evidence = await sim.run({ readPluginLog: async () => (++reads >= 3 ? sim.fx.expected.stripWarning : "not yet") });
    expect(evidence.pluginLog).toEqual({ read: true, stripWarnings: 1, polls: 3 });
  });

  it("gives up at the evidence deadline (bounded) with zero warnings", async () => {
    const sim = makeSim("v1", "s8", { onPrompt: s8Host("v1"), routes: replyRoute });
    const started = Date.now();
    const evidence = await sim.run({ timing: { phaseMs: 150, pollMs: 10 }, readPluginLog: async () => "nothing" });
    expect(evidence.pluginLog.stripWarnings).toBe(0);
    expect(evidence.pluginLog.polls).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("audit M7/M8: S13 V2 waits (bounded) for the post-reload plugin.updated armed before the reload", () => {
  it("a plugin.updated published after the reload response is still counted", async () => {
    const sim = makeSim("v2", "s13", {
      onPrompt: s13Host("v2"),
      routes: (s, req) => {
        if (req.path === "/api/location/reload") {
          setTimeout(() => s.emit({ kind: "plugin-updated" }), 30);
          return { status: 204 };
        }
        return null;
      },
    });
    const evidence = await sim.run();
    expect(evidence.marks.pluginUpdatedAfterReload).toBe(1);
    expect(evidence.inventory).toEqual({ before: { active: true, count: 1, stateKeys: ["status"] }, after: { active: true, count: 1, stateKeys: ["status"] } });
    expect(evaluate(evidence).verdict).toBe("PASS");
  });
});

describe("audit M9/M10: V1 durable reads wait for persisted settlement; dispose settles via durable state", () => {
  it("M9: a V1 child whose time.completed persists only after a few reads is still recorded completed", async () => {
    const sim = makeSim("v1", "s9", { onPrompt: recursionHost("v1") });
    const evidence = await sim.run({
      wrapClient: (request: (req: Any) => Promise<Any>) => {
        const reads = new Map<string, number>();
        return async (req: Any) => {
          const response = await request(req);
          const match = /^\/session\/([^/]+)\/message$/.exec(req.path);
          if (!match || !Array.isArray(response.json)) return response;
          const count = (reads.get(match[1]) ?? 0) + 1;
          reads.set(match[1], count);
          if (count >= 3) return response;
          // Halt published idle before the cleanup writes: not yet completed, tool still running.
          const json = response.json.map((message: Any) => ({ ...message, info: { ...message.info, time: { created: 1 } }, parts: message.parts.map((part: Any) => ({ ...part, state: { ...part.state, status: "running" } })) }));
          return { ...response, json };
        };
      },
    });
    expect(Object.values(evidence.persistedCompleted).every((value) => typeof value === "number")).toBe(true);
    expect(evaluate(evidence).verdict).toBe("PASS");
  });

  it("M10: V1 dispose without retained terminal SSE: re-subscribe + durable settlement -> PASS", async () => {
    const sim = makeSim("v1", "s13", {
      onPrompt: s13Host("v1"),
      routes: (s, req) => {
        if (req.path === "/instance/dispose") {
          setTimeout(() => s.onDispose?.(), 1);
          return { status: 200, json: true };
        }
        return null;
      },
    });
    const emit = sim.emit;
    let disposing = false;
    // The idle events emitted during the teardown are lost (stream closed); only the dispose event is seen.
    sim.emit = (event: Any) => {
      if (event.kind === "instance-disposed") disposing = false;
      if (disposing && event.kind === "session-idle") return;
      emit(event);
    };
    const onPrompt = sim.onDispose;
    void onPrompt;
    const original = sim.run;
    const evidence = await original({
      wrapClient: (request: (req: Any) => Promise<Any>) => async (req: Any) => {
        if (req.path === "/instance/dispose") disposing = true;
        return request(req);
      },
    });
    expect(evidence.finals[evidence.parentSessionID]).toBeUndefined();
    expect(evaluate(evidence).checks.filter((check: Any) => !check.ok)).toEqual([]);
  });
});

describe("audit F2-MA1: every wait is bounded by the remaining cell deadline and honors the cell signal", () => {
  it("awaitFinal / waits never exceed the remaining deadline", async () => {
    const { createDriveKit } = await import("./drive.mjs");
    const fx = fixtureFor("s4", { nonce: N, family: "v1" });
    const seen: number[] = [];
    const kit = createDriveKit({ scenario: "s4", family: "v1", host: hostAdapter("v1"), fx, project: "/p", client: { request: async () => ({ status: 204 }) }, events: { all: () => [], waitFor: async (_p: unknown, { timeoutMs }: { timeoutMs: number }) => (seen.push(timeoutMs), {}) }, provider: {}, signal: new AbortController().signal, timing: { phaseMs: 60_000, pollMs: 250 }, deadlineAt: Date.now() + 5_000 } as never);
    await kit.awaitFinal("P");
    await kit.waitEvent(() => true);
    expect(seen).toHaveLength(2);
    for (const value of seen) expect(value).toBeLessThanOrEqual(5_000);
    expect(kit.bound(60_000)).toBeLessThanOrEqual(5_000);
  });

  it("an aborted cell signal stops a driver mid-wait promptly (no fresh per-wait budget)", async () => {
    const controller = new AbortController();
    const sim = makeSim("v2", "s7", { onPrompt: s7Host(true, true), routes: cancelRoute });
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    // Holds happen, then the driver would wait for the cancel outcome; the abort lands first.
    const outcome = await sim.run({ signal: controller.signal, timing: { phaseMs: 10_000, pollMs: 5 }, wrapClient: (request: (req: Any) => Promise<Any>) => async (req: Any) => (/\/interrupt$/.test(req.path) ? new Promise(() => {}) : request(req)) }).then(() => "resolved", (error: Any) => error?.code ?? error?.name);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome).toBe("EABORTED");
  });
});

describe("audit follow-ups (mutation survivors)", () => {
  it("M9: completed time persisted but a tool part still running -> keep waiting (terminal tool states required)", async () => {
    const sim = makeSim("v1", "s9", { onPrompt: recursionHost("v1") });
    let unsettledReads = 0;
    const evidence = await sim.run({
      wrapClient: (request: (req: Any) => Promise<Any>) => {
        const reads = new Map<string, number>();
        return async (req: Any) => {
          const response = await request(req);
          const match = /^\/session\/([^/]+)\/message$/.exec(req.path);
          if (!match || !Array.isArray(response.json) || !response.json.some((message: Any) => message.parts.length > 0)) return response;
          const count = (reads.get(match[1]) ?? 0) + 1;
          reads.set(match[1], count);
          if (count >= 3) return response;
          unsettledReads += 1;
          return { ...response, json: response.json.map((message: Any) => ({ ...message, parts: message.parts.map((part: Any) => ({ ...part, state: { ...part.state, status: "running" } })) })) };
        };
      },
    });
    expect(unsettledReads).toBeGreaterThan(0);
    expect(evidence.marks.v1Unsettled).toBeUndefined();
    // The durable evidence is the SETTLED read: no tool call is recorded as running.
    const statuses = [...Object.values(evidence.childTools), ...Object.values(evidence.parentTools)].flat().map((call: Any) => call.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status: string) => status === "completed" || status === "error")).toBe(true);
    expect(evaluate(evidence).verdict).toBe("PASS");
  });

  it("F2-MA1: a wait that times out exactly as the cell aborts is an ABORT, never a soft 'not observed'", async () => {
    const { createDriveKit } = await import("./drive.mjs");
    const controller = new AbortController();
    const fx = fixtureFor("s7", { nonce: N, family: "v2" });
    const events = {
      all: () => [],
      waitFor: () => new Promise((_resolve, reject) => setTimeout(() => (controller.abort(), reject(Object.assign(new Error("event wait timed out after 5 ms"), { code: "EEVENTWAIT" }))), 5)),
    };
    const kit = createDriveKit({ scenario: "s7", family: "v2", host: hostAdapter("v2"), fx, project: "/p", client: { request: async () => ({ status: 200 }) }, events, provider: {}, signal: controller.signal, timing: { phaseMs: 1_000, pollMs: 5 } } as never);
    await expect(kit.waitEvent(() => true)).rejects.toMatchObject({ code: "EABORTED" });
  });
});

describe("S4 budget option B: per-failing-reviewer retry statistics (counts and ms only)", () => {
  it("retryStats: requests, retries (identical transcript), continuations, first -> last request duration", async () => {
    const { retryStats } = await import("./drive.mjs");
    const ledger = [
      { sessionID: "R1", kind: "model", attempt: "first", receivedAt: 1_000 },
      { sessionID: "R1", kind: "model", attempt: "retry", receivedAt: 3_000 },
      { sessionID: "X", kind: "model", attempt: "first", receivedAt: 3_500 },
      { sessionID: "R1", kind: "model", attempt: "continuation", receivedAt: 7_500 },
      { sessionID: "R1", kind: "budget-exceeded", attempt: "retry", receivedAt: 9_000 },
    ];
    expect(retryStats(ledger, "R1")).toEqual({ requests: 4, retries: 2, continuations: 1, retryDurationMs: 8_000 });
    expect(retryStats(ledger, "none")).toEqual({ requests: 0, retries: 0, continuations: 0, retryDurationMs: 0 });
    // A wall-clock step between requests never yields a negative / understated duration.
    expect(retryStats([{ sessionID: "Q", receivedAt: 5_000 }, { sessionID: "Q", receivedAt: 1_000 }, { sessionID: "Q", receivedAt: 3_000 }], "Q").retryDurationMs).toBe(4_000);
  });

  it.each(["v1", "v2"] as const)("%s: the S4 evidence carries observations['s4.retries'] for reviewer-1 and reviewer-3 only", async (family) => {
    const evidence = await makeSim(family, "s4", { onPrompt: s4Host() }).run();
    const stats = evidence.observations["s4.retries"];
    expect(Object.keys(stats)).toEqual(["reviewer-1", "reviewer-3"]);
    for (const value of Object.values(stats) as Record<string, number>[]) {
      expect(Object.keys(value)).toEqual(["requests", "retries", "continuations", "retryDurationMs"]);
      expect(value.requests).toBe(1);
      for (const field of Object.values(value)) expect(typeof field).toBe("number");
    }
    expect(evaluate(evidence).verdict).toBe("PASS");
  });
});

describe("P1b re-audit round 2 (Should a): S11 V1 rewrite waits for the disposal before any session", () => {
  function sim11(disposeAfterMs: number | null, disposeStatus = 200) {
    const order: string[] = [];
    const sim = makeSim("v1", "s11", {
      onPrompt: s11Host(),
      routes: (s, req) => {
        if (req.path === "/project/current") return { status: 200, json: { worktree: "/" } };
        if (req.path === "/instance/dispose") {
          if (disposeAfterMs !== null) setTimeout(() => (order.push("disposed-event"), s.emit({ kind: "instance-disposed" })), disposeAfterMs);
          return { status: disposeStatus, json: disposeStatus === 200 ? true : null };
        }
        if (req.method === "POST" && req.path === "/session") order.push("session-create");
        return null;
      },
    });
    return { sim, order };
  }

  it("delayed disposal: no session is created before server.instance.disposed", async () => {
    const { sim, order } = sim11(60);
    const evidence = await sim.run({ rewriteProjectFile: async () => {} });
    expect(order.indexOf("disposed-event")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("disposed-event")).toBeLessThan(order.indexOf("session-create"));
    expect(evidence.preconditions.agentReloaded).toMatchObject({ met: true });
    expect(evaluate(evidence).verdict).toBe("PASS");
  });

  it.each([["the disposal never confirmed", null, 200], ["a failed dispose response", 10, 500]] as const)("%s -> INVALID-FIXTURE, no session created", async (_label, after, status) => {
    const { sim, order } = sim11(after, status);
    const evidence = await sim.run({ rewriteProjectFile: async () => {}, timing: { phaseMs: 150, pollMs: 5 } });
    expect(order).not.toContain("session-create");
    expect(evidence.preconditions.agentReloaded).toMatchObject({ met: false });
    expect(evaluate(evidence).verdict).toBe("INVALID-FIXTURE");
  });
});

describe("P1b re-audit round 2 (Should e): S4 partial-output observation wait is capped at 20 s", () => {
  it("the host-visibility wait for P never exceeds 20 s (and is bounded by the cell deadline)", async () => {
    const { S4_PARTIAL_OBSERVE_MS } = await import("./drive.mjs");
    expect(S4_PARTIAL_OBSERVE_MS).toBe(20_000);
    const sim = makeSim("v2", "s4", { onPrompt: s4Host() });
    const waits: number[] = [];
    const evidence = await sim.run({
      timing: { phaseMs: 60_000, pollMs: 5 },
      wrapEvents: (events: Any) => ({ ...events, waitFor: (predicate: (event: Any) => boolean, options: Any) => (predicate({ kind: "nonce-seen", nonce: sim.fx.expected.partial }) && waits.push(options.timeoutMs), events.waitFor(predicate, options)) }),
    });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThanOrEqual(20_000);
    expect(waits[0]).toBeGreaterThan(19_000);
    expect(evaluate(evidence).verdict).toBe("PASS");
  });
});
