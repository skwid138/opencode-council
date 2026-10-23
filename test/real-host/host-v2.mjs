// Provenance: ADAPTED (rewritten) from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/host-v2.mjs (2.0.28-based).
// Retained: route/config/event-normalizer adapter shape, inventory route. Replaced:
// contracts.mjs gating, reviewed provider template, plugin remove/restore. Fixed:
// wait is POST /api/experimental/session/:id/wait (the normalizer used
// /api/session/:id/wait); interrupt is ?resume=false and returns {interrupted}.
// Shapes NOT yet source-verified are listed in `candidates`; the spike confirms them.
import { bounded, boundedList, checkConfigInput, checkRules, hasListeningLine, FAKE_API_KEY, FAKE_PROVIDER_ID, isRecord, renderAgentFile, scopedCandidates, seg, serveArgv, str, toolTerminal } from "./host-common.mjs";

/** Concatenated `text` of `{type:"text"}` entries (file entries ignored). */
const contentText = (content) => (Array.isArray(content) ? content.filter((entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string").map((entry) => entry.text).join("") : "");

/**
 * Tool calls named `name` in durable V2 assistant messages (source-verified): content entry
 * { type:"tool", id, name, state:{ status, content?[], error?{message} } }; no `state.output`.
 */
function toolCallsFromMessages(messages, name) {
  const calls = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue;
    for (const entry of message.content) {
      if (!isRecord(entry) || entry.type !== "tool" || entry.name !== name) continue;
      const state = isRecord(entry.state) ? entry.state : {};
      calls.push({ callID: str(entry.id), status: str(state.status), text: contentText(state.content), error: isRecord(state.error) ? str(state.error.message) : str(state.error), truncated: false });
    }
  }
  return calls;
}

/**
 * Every tool content entry of durable V2 assistant messages (source-verified, research §12).
 * Raw text / error message stay IN MEMORY for classification by drive.mjs; never persisted.
 */
function toolEntriesFromMessages(messages) {
  const entries = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue;
    const completed = isRecord(message.time) && typeof message.time.completed === "number" ? message.time.completed : null;
    for (const entry of message.content) {
      if (!isRecord(entry) || entry.type !== "tool") continue;
      const state = isRecord(entry.state) ? entry.state : {};
      const error = isRecord(state.error) ? state.error : null;
      entries.push({
        messageID: str(message.id),
        messageCompleted: completed,
        callID: str(entry.id),
        name: str(entry.name),
        status: str(state.status),
        output: state.status === "completed" ? contentText(state.content) : null,
        error: error ? str(error.message) : str(state.error),
        errorType: error ? str(error.type) : null,
        interrupted: false,
        truncated: false,
        invalidTarget: null,
      });
    }
  }
  return entries;
}

/** Fixture tool calls: shell { command } (normalizer contract @2.0.28; UNVERIFIED here); read { path } SOURCE-VERIFIED (Radagast M2). */
function toolCall(kind, target) {
  if (kind === "shell") return { name: "shell", args: { command: target } };
  if (kind === "read") return { name: "read", args: { path: target } };
  throw new Error(`no V2 fixture tool ${kind}`);
}

/**
 * SOURCE-VERIFIED (Radagast, post-P1b audit; 2.0.28 026b106b and 2.0.32 843a6c51). Never also
 * listed as UNVERIFIED candidates (hosts.test.ts).
 */
export const V2_VERIFIED_SHAPES = Object.freeze({
  "v2.textDelta": "text deltas are session.text.delta (the raw nonce scan reads the delta)",
  "v2.permissionAskedShape": "permission.asked uses data {id,sessionID,action,resources,...}",
  "v2.staticDenyError": 'a static deny fails the tool with { type: "permission.rejected", message: "Permission denied: <action>" }',
  "v2.noSuchToolRefusal": 'an unavailable tool call fails with No tool named "x" is currently available...',
  "v2.readToolInput": "read input { path }",
  "v2.readRuleRelativeToLocation": "read permission rule resources are matched relative to location.directory ('/'-normalized); the tool input path stays absolute",
  "v2.reloadPluginUpdated": "POST /api/location/reload re-activates plugins and publishes plugin.updated (generation evidence)",
  "v2.continuationTranscript": "a stream fault is continued with a new assistant id + a synthetic continuation instruction (fake provider M5)",
});

const BASE_CANDIDATES = Object.freeze(["v2.providerConfig", "v2.modelRef", "v2.agentsRoute", "v2.sessionCreatedShape"]);
const PERMISSION = ["v2.permissionConfig", "v2.shellToolInput"];
const V2_SCENARIO_CANDIDATES = Object.freeze({
  s1: [],
  s2: [],
  s3: [],
  // Retry budget and the Bun destroy-transport error text stay UNVERIFIED.
  s4: ["v2.providerRetryPolicy", "v2.streamDestroyError"],
  s5: [],
  s6: [],
  s7: [],
  s8: [...PERMISSION, "v2.sessionCreatePermissions"],
  s9: [],
  s10: ["v2.shellToolInput"],
  s11: ["v2.agentFileLocation", "v2.agentFrontmatterPermission"],
  s12: PERMISSION,
  s13: [],
  "obs-ask": [],
});

function normalizeEvent(raw) {
  if (!isRecord(raw) || typeof raw.type !== "string") return { kind: "other", type: null };
  const d = isRecord(raw.data) ? raw.data : {};
  switch (raw.type) {
    case "server.connected":
      return { kind: "connected" };
    case "session.created": {
      // CANDIDATE (v2.sessionCreatedShape): sessionID, id, or info.id.
      const info = isRecord(d.info) ? d.info : {};
      const keys = (record) => Object.keys(record).sort().slice(0, 32).map((key) => key.slice(0, 64));
      return { kind: "session-created", sessionID: str(d.sessionID) ?? str(d.id) ?? str(info.id), parentID: str(d.parentID) ?? str(info.parentID), shape: { keys: keys(d), infoKeys: keys(info) } };
    }
    case "session.inbox.enqueued":
      return { kind: "admitted", sessionID: str(d.sessionID) };
    case "session.execution.started":
      return { kind: "execution-started", sessionID: str(d.sessionID) };
    case "session.execution.succeeded":
    case "session.execution.failed":
      return { kind: "session-final", sessionID: str(d.sessionID), outcome: raw.type.slice("session.execution.".length) };
    case "session.execution.interrupted":
      return { kind: "session-final", sessionID: str(d.sessionID), outcome: "interrupted", reason: bounded(d.reason, 32) };
    // SOURCE-VERIFIED (v2.permissionAskedShape): data { id, sessionID, action, resources[], source?: { type: "tool", id }, ... }.
    case "permission.asked": {
      const source = isRecord(d.source) ? d.source : null;
      return { kind: "permission-asked", requestID: str(d.id), sessionID: str(d.sessionID), permission: bounded(d.action, 64), patterns: boundedList(d.resources), callID: source?.type === "tool" ? str(source.id) : null };
    }
    case "permission.replied":
      return { kind: "permission-replied", requestID: str(d.requestID), sessionID: str(d.sessionID), reply: bounded(d.reply, 32) };
    case "plugin.updated":
      return { kind: "plugin-updated" };
    // SOURCE-VERIFIED (2.0.28 026b106b / 2.0.32 843a6c51): the tool NAME is only on
    // input.started; success / failed carry { sessionID, assistantMessageID, id (call id),
    // content[] / error{} } with no `tool` and no `output`. SSE is diagnostic only (volatile);
    // the durable message read is the source of truth for the parent's council_review result.
    case "session.tool.input.started":
      return { kind: "tool-input-started", sessionID: str(d.sessionID), callID: str(d.id), tool: str(d.name) };
    case "session.tool.success":
      return toolTerminal({ sessionID: str(d.sessionID), callID: str(d.id), tool: null, status: "completed", output: contentText(d.content) });
    case "session.tool.failed":
      return toolTerminal({ sessionID: str(d.sessionID), callID: str(d.id), tool: null, status: "error", error: isRecord(d.error) ? str(d.error.message) : str(d.error) });
    default:
      return { kind: "other", type: raw.type };
  }
}

export const v2Host = Object.freeze({
  family: "v2",
  launchArgv: serveArgv,
  // Readiness: the exact source-verified line `server listening on http://127.0.0.1:<port>`.
  isListening: (text, port) => hasListeningLine(text, port),
  // The auxiliary (title / compaction) signatures are SOURCE-VERIFIED (research §12): not candidates.
  // v2.toolOutputSource is source-verified (durable messages; research §12): not a candidate.
  candidates: BASE_CANDIDATES,
  candidatesFor: scopedCandidates(BASE_CANDIDATES, V2_SCENARIO_CANDIDATES),
  verifiedShapes: V2_VERIFIED_SHAPES,
  hostEnvExtra: ({ configPath, password }) => ({ OPENCODE_CONFIG: configPath, OPENCODE_SERVER_PASSWORD: password }),
  routes: Object.freeze({
    identity: () => ({ method: "GET", path: "/api/session" }),
    /** `permissions` (S8 parent-only deny): UNVERIFIED body field (v2.sessionCreatePermissions). */
    createSession: (directory, { permissions } = {}) => ({ method: "POST", path: "/api/session", body: { location: { directory }, ...(permissions ? { permissions } : {}) } }),
    /** Source-verified (research §5): -> 204. Decisions: once | always | reject. */
    reply: ({ sessionID, requestID, decision }) => ({ method: "POST", path: `/api/session/${seg(sessionID)}/permission/${seg(requestID)}/reply`, body: { decision } }),
    prompt: ({ sessionID, text }) => ({ method: "POST", path: `/api/session/${seg(sessionID)}/prompt`, body: { text } }),
    wait: ({ sessionID }) => ({ method: "POST", path: `/api/experimental/session/${seg(sessionID)}/wait` }),
    cancel: ({ sessionID }) => ({ method: "POST", path: `/api/session/${seg(sessionID)}/interrupt`, query: { resume: "false" } }),
    children: ({ sessionID }) => ({ method: "GET", path: "/api/session", query: { parentID: sessionID } }),
    session: ({ sessionID }) => ({ method: "GET", path: `/api/session/${seg(sessionID)}` }),
    log: ({ sessionID }) => ({ method: "GET", path: `/api/experimental/session/${seg(sessionID)}/log` }),
    /** Durable assistant messages (source-verified): first page desc; follow `cursor.next` WITHOUT `order` (cursor cannot combine with order). */
    messages: ({ sessionID, cursor }) => ({ method: "GET", path: `/api/session/${seg(sessionID)}/message`, query: cursor ? { type: "assistant", cursor, limit: 200 } : { type: "assistant", order: "desc", limit: 200 } }),
    plugins: (directory) => ({ method: "GET", path: "/api/plugin", query: { location: { directory } } }),
    reload: () => ({ method: "POST", path: "/api/location/reload" }),
    events: () => ({ path: "/api/event" }),
    /** CANDIDATE (v2.agentsRoute). */
    agents: (directory) => ({ method: "GET", path: "/api/agent", query: { location: { directory } } }),
  }),
  sessionIDFrom: (response) => (response.status === 200 && isRecord(response.json) && isRecord(response.json.data) ? str(response.json.data.id) : null),
  childrenFrom: (response) => (response.status === 200 && isRecord(response.json) && Array.isArray(response.json.data) ? response.json.data : null),
  /** `{ data: Message[], cursor: { next? } }` -> { messages, next } (null when not that shape). */
  messagePageFrom: (response) => (response.status === 200 && isRecord(response.json) && Array.isArray(response.json.data) ? { messages: response.json.data, next: isRecord(response.json.cursor) ? str(response.json.cursor.next) : null } : null),
  toolCallsFromMessages,
  toolEntriesFromMessages,
  toolCall,
  /** UNVERIFIED (v2.agentFileLocation / v2.agentFrontmatterPermission): same layout as V1. */
  agentFile: renderAgentFile,
  /** CANDIDATE (v2.agentsRoute): `{ data: [...] }` with `name` (or `id`). */
  agentNamesFrom: (response) => (response.status === 200 && isRecord(response.json) && Array.isArray(response.json.data) ? response.json.data.map((agent) => (isRecord(agent) ? agent.name ?? agent.id ?? null : null)).filter((name) => typeof name === "string") : null),
  sessionFrom: (response) => (response.status === 200 && isRecord(response.json) && isRecord(response.json.data) ? response.json.data : null),
  normalizeEvent,
  buildConfig({ providerBaseURL, models, parentModel, spec, council, permissionRules = null }) {
    checkConfigInput({ providerBaseURL, spec, models, parentModel });
    return {
      // Config-level rules (UNVERIFIED v2.permissionConfig; normalizer-observed `permissions` at 2.0.28).
      ...(permissionRules ? { permissions: checkRules(permissionRules) } : {}),
      // CANDIDATE (v2.modelRef, v2.providerConfig): research §5 shapes.
      model: `${FAKE_PROVIDER_ID}/${parentModel}`,
      share: "disabled",
      update: "disable",
      providers: {
        [FAKE_PROVIDER_ID]: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: providerBaseURL, apiKey: FAKE_API_KEY },
          models: Object.fromEntries(models.map((id) => [id, { capabilities: { tools: true } }])),
        },
      },
      plugins: [{ package: spec, options: { council } }],
      // Suppression (source-verified, research §12): no title agent, no auto-compaction, no
      // warming. (`small_model` is not a disable switch.) Any auxiliary request FAILs S1/S2.
      agents: { title: { disabled: true } },
      compaction: { auto: false },
      warming: false,
    };
  },
});
