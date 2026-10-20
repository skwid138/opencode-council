// Provenance: ADAPTED (rewritten) from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/fake-provider.mjs.
// Retained: OpenAI-compatible /chat/completions shape (JSON + SSE), identity
// endpoint for liveness, unknown route/model rejection, call budget, bounded ledger.
// Replaced: single model/nonce/tool script with per-(session, model) scripts and
// outcomes (text, tool_call, empty, HTTP status, partial-then-error, hold), host
// session-header attribution, and in-process barrier control. See test/PROVENANCE.md.
//
// Runs IN-PROCESS inside the driver: barriers are released by function calls
// (no HTTP control surface). serve() binds 127.0.0.1 and is used only inside the
// container; unit tests drive handle() with injected request/response objects.
//
// Step selection is stateless per request: step = number of assistant turns
// already present in the request messages. A retry re-sends identical messages,
// so it re-serves the same step.
//
// P1b: a model's script is either a steps array or { byNonce: { <nonce>: steps }, default? }
// selected by the first fixture invocation nonce found in the request text (several
// concurrent councils share reviewer models). Outcomes: text, tool_call, tool_calls
// (parallel), empty, status, partial-error (optionally held on a barrier AFTER the partial
// chunk, so the harness can prove the host saw it before the fault), hold. Every request
// gets monotonic received / completed ticks; holds, releases, disconnects, partial writes,
// and responses are provider events (waitFor is event-driven). The aggregator prompt's
// STRUCTURE (aggregator-prompt.mjs) and tool-result marker classes are recorded, never text.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { parseAggregatorPrompt } from "./aggregator-prompt.mjs";

export const IDENTITY_PATH = "/__rh/identity";
/**
 * Auxiliary (non-council) request signatures, SOURCE-VERIFIED by Radagast at all four pins
 * (research §12). With the fixtures' suppression config (title disabled, auto-compaction off,
 * V2 warming off) none of them should ever fire in S1/S2: any match is recorded as an
 * `auxiliary` ledger entry (served, so the host does not hang) and FAILs the cell.
 *   title          system prefix (parent-only on both hosts; fires before the main request)
 *   v1-compaction  system prefix
 *   v2-compaction  no dedicated system prompt; the appended LAST user message starts with one of two prefixes
 */
export const AUXILIARY_SIGNATURES = Object.freeze([
  Object.freeze({ id: "title", where: "system", prefix: "You are a title generator.", verified: "source" }),
  Object.freeze({ id: "v1-compaction", where: "system", prefix: "You are a context summarization agent.", verified: "source" }),
  Object.freeze({ id: "v2-compaction", where: "last-user", prefix: "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.", verified: "source" }),
  Object.freeze({ id: "v2-compaction", where: "last-user", prefix: "Update the existing checkpoint in the conversation above into one consolidated summary.", verified: "source" }),
]);
/** Only a sha256 of this many leading system-prompt characters is ever recorded (never the text). */
const SYSTEM_PREFIX_CHARS = 256;
const COMPLETIONS_PATH = "/v1/chat/completions";
const AUX_TEXT = "real-host fixture";
const MAX_TOOL_NAMES = 64;
const MAX_NAME_CHARS = 128;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 4096;
const MAX_TOOL_RESULTS = 16;

/**
 * Source-verified header pairs. V1: `x-session-id` / `x-parent-session-id` at BOTH pins (1.18.29
 * has no x-opencode-*; 1.19.3 adds x-opencode-session-id / x-opencode-parent-session-id as
 * aliases, which must agree when present). V2: `x-opencode-session-id` is the actual session;
 * parent = `x-opencode-parent-session-id` or `x-parent-session-id` (must agree when both are
 * present). V2 `X-Session-Id` is affinity (parentID ?? id) and is NEVER read.
 */
const HEADERS = Object.freeze({
  v1: Object.freeze({ session: "x-session-id", parent: "x-parent-session-id", sessionAlias: "x-opencode-session-id", parentAlias: "x-opencode-parent-session-id" }),
  v2: Object.freeze({ session: "x-opencode-session-id", parent: "x-opencode-parent-session-id", sessionAlias: null, parentAlias: "x-parent-session-id" }),
});

/** Host session-attribution headers (lowercase; lookups are case-insensitive). */
export function sessionHeaders(family) {
  const names = HEADERS[family];
  if (!names) throw new Error(`unknown host family ${family}`);
  return names;
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const lower = (headers) => Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]));

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  return "";
}

/** "title" | "v1-compaction" | "v2-compaction" | null for a request's messages. */
export function classifyAuxiliary(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systems = list.filter((message) => message?.role === "system").map(textOf);
  const lastUser = textOf(list.filter((message) => message?.role === "user").at(-1));
  for (const signature of AUXILIARY_SIGNATURES) {
    if (signature.where === "system" ? systems.some((text) => text.startsWith(signature.prefix)) : lastUser.startsWith(signature.prefix)) return signature.id;
  }
  return null;
}

const digest = (text) => createHash("sha256").update(text).digest("hex");
const bounded = (value) => (typeof value === "string" && value !== "" ? value.slice(0, MAX_NAME_CHARS) : null);

/** { value, conflict }: the primary header, cross-checked against its alias when both are present. */
function pick(headers, primary, alias) {
  const a = bounded(headers[primary]);
  const b = alias ? bounded(headers[alias]) : null;
  if (a && b && a !== b) return { value: null, conflict: true };
  return { value: primary === HEADERS.v2.parent ? a ?? b : a, conflict: false };
}

export function createFakeProvider({ family, identityToken, models, budgetPerSession = 24, markers = [], nonces = [], outputMarkers = [], onHold = null, now = Date.now }) {
  if (typeof identityToken !== "string" || identityToken.length < 8) throw new Error("fake provider requires a per-instance identity token");
  const names = sessionHeaders(family);
  const ledger = [];
  const perSession = new Map();
  const barriers = new Map();
  const holds = new Set();
  const parents = new Set();
  /** sessionID -> Set of transcript digests already served (retry vs continuation). */
  const transcripts = new Map();
  const events = [];
  const waiters = new Set();
  let seq = 0;
  let tick = 0;
  const nextTick = () => (tick += 1);

  function emit(event) {
    const stamped = { ...event, tick: nextTick(), at: Date.now() };
    if (events.length < MAX_EVENTS) events.push(stamped);
    for (const waiter of [...waiters]) waiter(stamped);
  }

  /** models[id] is a steps array, or { byNonce: { nonce: steps }, default? } keyed by the first nonce found in `text`. */
  const scriptFor = (model, text) => {
    const value = typeof model === "string" && Object.hasOwn(models, model) ? models[model] : undefined;
    if (Array.isArray(value)) return { steps: value, key: null };
    if (!isRecord(value) || !isRecord(value.byNonce)) return null;
    for (const [nonce, steps] of Object.entries(value.byNonce)) if (text.includes(nonce) && Array.isArray(steps)) return { steps, key: nonce };
    return Array.isArray(value.default) ? { steps: value.default, key: "default" } : null;
  };
  /** Known = a registered parent session, or a child whose parent header names one. */
  const known = (entry) => entry.sessionID !== null && (parents.has(entry.sessionID) || (entry.parentSessionID !== null && parents.has(entry.parentSessionID)));

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const chunk = (id, model, delta, finish) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  /** Tool calls of an outcome: `tool_call` keeps the historical id `call_<session>_<step>`; `tool_calls` suffixes `_<i>`. */
  const toolCallsOf = (outcome, callId) =>
    outcome.type === "tool_call"
      ? [{ id: callId, type: "function", function: { name: outcome.name, arguments: JSON.stringify(outcome.args ?? {}) } }]
      : outcome.type === "tool_calls" && Array.isArray(outcome.calls)
        ? outcome.calls.map((call, index) => ({ id: `${callId}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }))
        : [];

  function serveCompletion(res, { stream, model, id, outcome, callId }) {
    const toolCalls = toolCallsOf(outcome, callId);
    const content = outcome.type === "text" ? outcome.text : outcome.type === "empty" ? "" : null;
    const finish = toolCalls.length > 0 ? "tool_calls" : "stop";
    if (!stream) {
      const message = toolCalls.length > 0 ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content };
      json(res, 200, { id, object: "chat.completion", created: 0, model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (toolCalls.length > 0) res.write(chunk(id, model, { role: "assistant", tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }, null));
    else if (content) res.write(chunk(id, model, { role: "assistant", content }, null));
    else res.write(chunk(id, model, { role: "assistant" }, null));
    res.write(chunk(id, model, {}, finish));
    res.end("data: [DONE]\n\n");
  }

  function waitForRelease(barrier, res) {
    if (!barriers.has(barrier)) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      barriers.set(barrier, { promise, release, released: false });
    }
    const entry = barriers.get(barrier);
    if (entry.released) return Promise.resolve("released");
    return new Promise((resolve) => {
      res.onClose?.(() => resolve("disconnected"));
      entry.promise.then(() => resolve("released"));
    });
  }

  async function handle(req, res) {
    const headers = lower(req.headers);
    if (req.method === "GET" && req.path === IDENTITY_PATH) {
      json(res, 200, { token: identityToken });
      return;
    }
    seq += 1;
    const entry = { seq, kind: "model", sessionID: null, parentSessionID: null, model: null, step: null, outcome: null, stream: false, tools: [], systemMarkers: [], nonces: [], status: null, released: null, disconnected: false, scriptKey: null, attempt: null, aggregator: null, toolResults: [], toolCallIds: [], receivedTick: nextTick(), receivedAt: now(), completedTick: null, disconnectedTick: null };
    ledger.push(entry);
    if (req.method !== "POST" || req.path !== COMPLETIONS_PATH) {
      Object.assign(entry, { kind: "rejected-route", status: 404 });
      json(res, 404, { error: { message: "unknown route" } });
      return;
    }
    const body = isRecord(req.body) ? req.body : {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    entry.model = typeof body.model === "string" ? body.model.slice(0, MAX_NAME_CHARS) : null;
    entry.stream = body.stream === true;
    const session = pick(headers, names.session, names.sessionAlias);
    const parent = pick(headers, names.parent, names.parentAlias);
    entry.sessionID = session.value;
    entry.parentSessionID = parent.value;
    entry.tools = (Array.isArray(body.tools) ? body.tools : [])
      .map((tool) => tool?.function?.name)
      .filter((name) => typeof name === "string")
      .slice(0, MAX_TOOL_NAMES)
      .map((name) => name.slice(0, MAX_NAME_CHARS));
    const systemText = messages.filter((message) => message?.role === "system").map(textOf).join("\n");
    const allText = messages.map(textOf).join("\n");
    entry.systemMarkers = markers.filter((marker) => systemText.includes(marker));
    entry.nonces = nonces.filter((nonce) => allText.includes(nonce));
    // Structure only (labels, constant error prefixes, markers per section); never prompt text.
    entry.aggregator = parseAggregatorPrompt(textOf(messages.filter((message) => message?.role === "user").at(-1)), { markers: nonces });
    entry.toolResults = messages
      .filter((message) => message?.role === "tool")
      .slice(0, MAX_TOOL_RESULTS)
      .map((message) => {
        const text = textOf(message);
        return { callId: bounded(message.tool_call_id), markers: outputMarkers.filter((marker) => text.includes(marker)), length: text.length, sha256: digest(text) };
      });

    const script = scriptFor(entry.model, allText);
    entry.scriptKey = script?.key ?? null;
    // Classification (only a sha256 of the system prefix is ever recorded, never its text):
    //   1. a source-verified auxiliary signature -> "auxiliary" (served; S1/S2 FAIL on it,
    //      since suppression should have prevented it) -- checked first so an auxiliary
    //      request from a known session is still detected;
    //   2. a known council/parent session -> MAIN regardless of tools (the aggregator is main
    //      with `tools` omitted or []);
    //   3. anything else (unknown / missing / conflicting session headers) -> 400 "unidentified".
    const auxiliary = classifyAuxiliary(messages);
    entry.classification = auxiliary ?? "unknown";
    entry.systemPrefixSha256 = digest(systemText.slice(0, SYSTEM_PREFIX_CHARS));
    if (auxiliary) {
      Object.assign(entry, { kind: "auxiliary", auxiliary, status: 200, outcome: "text" });
      serveCompletion(res, { stream: entry.stream, model: entry.model, id: `aux_${seq}`, outcome: { type: "text", text: AUX_TEXT } });
      return;
    }
    if (session.conflict || parent.conflict || !known(entry)) {
      Object.assign(entry, { kind: "unidentified", status: 400, headerConflict: session.conflict || parent.conflict });
      json(res, 400, { error: { message: "real-host fake provider: unidentified request" } });
      return;
    }
    const steps = script?.steps;
    if (!Array.isArray(steps)) {
      Object.assign(entry, { kind: "unknown-model", status: 400 });
      json(res, 400, { error: { message: "unknown model" } });
      return;
    }
    const count = (perSession.get(entry.sessionID) ?? 0) + 1;
    perSession.set(entry.sessionID, count);
    if (count > budgetPerSession) {
      Object.assign(entry, { kind: "budget-exceeded", status: 429 });
      json(res, 429, { error: { message: "real-host fake provider session budget exceeded" } });
      return;
    }
    entry.step = messages.filter((message) => message?.role === "assistant").length;
    // Radagast M5: an identical transcript is a transparent RETRY (V1 retries); a grown one is a
    // CONTINUATION (V2 re-requests with the partial turn + a synthetic continuation instruction).
    const seenTranscripts = transcripts.get(entry.sessionID) ?? new Set();
    const transcript = digest(JSON.stringify(messages));
    entry.attempt = seenTranscripts.size === 0 ? "first" : seenTranscripts.has(transcript) ? "retry" : "continuation";
    seenTranscripts.add(transcript);
    transcripts.set(entry.sessionID, seenTranscripts);
    // A last step with `repeat: true` serves every later step (the actor never runs out of script).
    let outcome = steps[entry.step] ?? (steps.at(-1)?.repeat === true ? steps.at(-1) : undefined);
    if (!outcome) {
      Object.assign(entry, { kind: "script-exhausted", status: 500 });
      json(res, 500, { error: { message: "fake provider script exhausted" } });
      return;
    }
    entry.outcome = outcome.type;
    const where = { seq: entry.seq, sessionID: entry.sessionID, model: entry.model };
    /** Waits on `barrier`; records released / disconnected (+ tick and event). */
    const holdOn = async (barrier) => {
      const hold = { sessionID: entry.sessionID, model: entry.model, barrier };
      holds.add(hold);
      onHold?.(hold);
      emit({ type: "hold", ...where, barrier });
      const how = await waitForRelease(barrier, res);
      holds.delete(hold);
      entry.released = how === "released";
      entry.disconnected = how === "disconnected";
      if (entry.disconnected) {
        entry.disconnectedTick = nextTick();
        emit({ type: "disconnected", ...where, barrier });
      } else emit({ type: "released", ...where, barrier });
      return how;
    };
    if (outcome.type === "hold") {
      if ((await holdOn(outcome.barrier)) === "disconnected") return;
      outcome = outcome.then;
    }
    const id = `chatcmpl_${entry.sessionID}_${entry.step}`;
    const callId = `call_${entry.sessionID}_${entry.step}`;
    if (outcome.type === "status") {
      entry.status = outcome.status;
      json(res, outcome.status, { error: { message: `fake provider status ${outcome.status}` } });
      entry.completedTick = nextTick();
      emit({ type: "responded", ...where, status: outcome.status });
      return;
    }
    entry.status = 200;
    if (outcome.type === "partial-error") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk(id, entry.model, { role: "assistant", content: outcome.text }, null));
      emit({ type: "partial-written", ...where });
      // Held AFTER the partial chunk: the harness releases once the host has shown it.
      if (outcome.barrier !== undefined && (await holdOn(outcome.barrier)) === "disconnected") return;
      res.destroy(new Error("fake provider partial stream failure"));
      entry.completedTick = nextTick();
      emit({ type: "stream-failed", ...where });
      return;
    }
    entry.toolCallIds = toolCallsOf(outcome, callId).map((call) => call.id);
    serveCompletion(res, { stream: entry.stream, model: entry.model, id, outcome, callId });
    entry.completedTick = nextTick();
    emit({ type: "responded", ...where, status: 200 });
  }

  return {
    handle,
    /** The collector registers the parent session right after creating it (before prompting). */
    registerParent(sessionID) {
      if (typeof sessionID === "string" && sessionID !== "") parents.add(sessionID.slice(0, MAX_NAME_CHARS));
    },
    /** Releases every current and future hold on `barrier`. */
    release(barrier) {
      if (!barriers.has(barrier)) barriers.set(barrier, { promise: Promise.resolve(), release: () => {}, released: true });
      const entry = barriers.get(barrier);
      entry.released = true;
      entry.release();
    },
    /** Releases every barrier (cleanup only). */
    releaseAll() {
      for (const [barrier] of barriers) this.release(barrier);
      for (const hold of holds) this.release(hold.barrier);
    },
    holding: () => [...holds].map((hold) => ({ ...hold })),
    events: () => events.map((event) => ({ ...event })),
    /** Event-driven: resolves with the first (already seen or future) provider event matching `predicate`. */
    waitFor(predicate, { timeoutMs, signal } = {}) {
      const hit = events.find(predicate);
      if (hit) return Promise.resolve({ ...hit });
      return new Promise((resolve, reject) => {
        const done = (fn, value) => {
          clearTimeout(timer);
          waiters.delete(listener);
          signal?.removeEventListener("abort", onAbort);
          fn(value);
        };
        const onAbort = () => done(reject, Object.assign(new Error("provider wait aborted"), { code: "EABORTED", detail: "provider wait aborted" }));
        const timer = setTimeout(() => done(reject, Object.assign(new Error(`provider wait timed out after ${timeoutMs} ms`), { code: "EPROVIDERWAIT", detail: `provider event wait timed out after ${timeoutMs} ms` })), timeoutMs);
        function listener(event) {
          if (predicate(event)) done(resolve, { ...event });
        }
        waiters.add(listener);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    ledger: () => ledger.map((entry) => ({ ...entry, tools: [...entry.tools], systemMarkers: [...entry.systemMarkers], nonces: [...entry.nonces], toolResults: entry.toolResults.map((result) => ({ ...result, markers: [...result.markers] })), toolCallIds: [...entry.toolCallIds] })),
  };
}

/** Binds 127.0.0.1 (ephemeral port by default). In-container only; never used by unit tests. */
export function serve(provider, { port = 0 } = {}) {
  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (part) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) req.destroy();
      else chunks.push(part);
    });
    req.on("end", () => {
      let body = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      } catch {
        body = null;
      }
      const adapter = {
        writeHead: (status, headers) => res.writeHead(status, headers),
        write: (data) => res.write(data),
        end: (data) => res.end(data),
        destroy: (error) => res.destroy(error),
        onClose: (callback) => res.once("close", () => {
          if (!res.writableEnded) callback();
        }),
      };
      provider.handle({ method: req.method, path: new URL(req.url, "http://127.0.0.1").pathname, headers: req.headers, body }, adapter).catch(() => res.destroy());
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
