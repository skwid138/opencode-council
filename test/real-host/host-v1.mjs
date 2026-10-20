// Provenance: ADAPTED (rewritten) from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/host-v1.mjs.
// Retained: route/config/event-normalizer adapter shape. Replaced: contracts.mjs
// gating, normalizer permission/bash focus, and plugin remove/restore, with the
// council routes and events (research §5, source-verified at 1.18.29 / 1.19.3).
// Shapes NOT yet source-verified are listed in `candidates`; the spike confirms them. The V1
// shapes this adapter reads are now all source-verified (agents route bare array; assistant
// info.agent / info.mode / info.modelID / info.providerID; tool parts; children; session.created
// / session.idle; research §12).
import { bounded, boundedList, checkConfigInput, checkRules, mentionsPort, FAKE_API_KEY, FAKE_PROVIDER_ID, isRecord, renderAgentFile, scopedCandidates, seg, serveArgv, str, toolTerminal } from "./host-common.mjs";

/**
 * Every tool part of durable V1 messages (source-verified part shape, research §12). Raw
 * output / error text stays IN MEMORY for classification by drive.mjs and is never persisted.
 * `invalidTarget`: a call the host repaired to the `invalid` tool records the original name
 * at state.input.tool (UNVERIFIED: v1.invalidToolRepair).
 */
function toolEntriesFromMessages(messages) {
  const entries = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message) || !isRecord(message.info) || message.info.role !== "assistant" || !Array.isArray(message.parts)) continue;
    const completed = isRecord(message.info.time) && typeof message.info.time.completed === "number" ? message.info.time.completed : null;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== "tool") continue;
      const state = isRecord(part.state) ? part.state : {};
      const metadata = isRecord(state.metadata) ? state.metadata : {};
      const input = isRecord(state.input) ? state.input : {};
      entries.push({
        messageID: str(message.info.id),
        messageCompleted: completed,
        callID: str(part.callID),
        name: str(part.tool),
        status: str(state.status),
        output: typeof state.output === "string" ? state.output : null,
        error: str(state.error),
        errorType: null,
        interrupted: metadata.interrupted === true,
        truncated: metadata.truncated === true || typeof metadata.outputPath === "string",
        invalidTarget: part.tool === "invalid" ? str(input.tool) : null,
      });
    }
  }
  return entries;
}

/** Abstract rules -> V1 workspace `permission` map: shell -> bash; a lone `*` rule -> the flat effect. */
function renderPermission(rules) {
  const map = {};
  for (const rule of checkRules(rules)) {
    const tool = rule.action === "shell" ? "bash" : rule.action;
    const current = map[tool];
    if (rule.resource === "*" && current === undefined) map[tool] = rule.effect;
    else map[tool] = { ...(typeof current === "string" ? { "*": current } : current ?? {}), [rule.resource]: rule.effect };
  }
  return map;
}

/** Fixture tool calls. bash { command } SOURCE-VERIFIED (Radagast M1); read / webfetch inputs UNVERIFIED (v1.readToolInput, v1.webfetchToolInput). */
function toolCall(kind, target) {
  if (kind === "shell") return { name: "bash", args: { command: target } };
  if (kind === "read") return { name: "read", args: { filePath: target } };
  if (kind === "webfetch") return { name: "webfetch", args: { url: target, format: "text" } };
  throw new Error(`no V1 fixture tool ${kind}`);
}

/**
 * SOURCE-VERIFIED (Radagast, post-P1b audit; 1.18.29 16747470 and 1.19.3 e3c4eb24). Never also
 * listed as UNVERIFIED candidates (hosts.test.ts).
 */
export const V1_VERIFIED_SHAPES = Object.freeze({
  "v1.textDelta": "text deltas are message.part.delta {sessionID,messageID,partID,field,delta} (the raw nonce scan reads the delta)",
  "v1.permissionAskedShape": "permission.asked properties {id,sessionID,permission,patterns,metadata,always,tool?:{messageID,callID}} (patterns/metadata/always required)",
  "v1.invalidToolRepair": "an unavailable tool call is repaired to a COMPLETED `invalid` call whose state.input.tool is the original name",
  "v1.bashToolInput": "bash input { command } (no description)",
  "v1.readRuleRelativeToWorktree": "read permission rule resources are matched relative to instance.worktree ('/'-normalized); the tool input path stays absolute",
  "v1.pluginLog": "plugin app.log lines land in $XDG_DATA_HOME/opencode/log/opencode.log (flush interval UNVERIFIED: v1.pluginLogFlush)",
  "v1.projectCurrentRoute": "GET /project/current (?directory=) exists at both pins and returns the bare project (incl. worktree) -- Saruman-verified (re-audit round 2)",
  "v1.disposeSettlement": "after server.instance.disposed the terminal SSE may not be retained; old sessions settle durably (completed / aborted messages)",
  "v1.haltIdleBeforeCleanup": "halt publishes idle before the cleanup writes: wait for persisted time.completed / terminal tool states before durable assertions",
});

/** Child abort evidence (UNVERIFIED v1.abortEvidence): session.error / persisted assistant error name MessageAbortedError. */
const ABORT = ["v1.abortEvidence"];
const V1_SCENARIO_CANDIDATES = Object.freeze({
  s1: [],
  s2: [],
  s3: ABORT,
  // Retry budget / backoff and the Bun destroy-transport error text stay UNVERIFIED.
  s4: ["v1.providerRetryPolicy", "v1.streamDestroyError"],
  s5: ABORT,
  s6: ABORT,
  s7: ABORT,
  // Effect file-logger flush interval stays UNVERIFIED (the driver polls opencode.log, bounded).
  s8: ["v1.permissionConfig", "v1.pluginLogFlush"],
  s9: [],
  s10: [],
  s11: ["v1.agentFileLocation", "v1.agentFrontmatterPermission", "v1.readToolInput"],
  s12: ["v1.permissionConfig", ...ABORT],
  s13: ABORT,
  "obs-ask": ["v1.permissionConfig", "v1.webfetchToolInput"],
});

/**
 * Tool calls named `name` in durable V1 messages (source-verified): `[{ info, parts }]`, tool part
 * { type:"tool", tool, callID, state:{ status, output:string | error:string, metadata? } }.
 * Plugin output may be truncated: state.metadata.truncated / state.metadata.outputPath.
 */
function toolCallsFromMessages(messages, name) {
  const calls = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message) || !isRecord(message.info) || message.info.role !== "assistant" || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== "tool" || part.tool !== name) continue;
      const state = isRecord(part.state) ? part.state : {};
      const metadata = isRecord(state.metadata) ? state.metadata : {};
      calls.push({ callID: str(part.callID), status: str(state.status), text: typeof state.output === "string" ? state.output : "", error: str(state.error), truncated: metadata.truncated === true || typeof metadata.outputPath === "string" });
    }
  }
  return calls;
}

function normalizeEvent(raw) {
  if (!isRecord(raw) || typeof raw.type !== "string") return { kind: "other", type: null };
  const p = isRecord(raw.properties) ? raw.properties : {};
  switch (raw.type) {
    case "server.connected":
      return { kind: "connected" };
    case "session.created": {
      const info = isRecord(p.info) ? p.info : {};
      return { kind: "session-created", sessionID: str(info.id), parentID: str(info.parentID) };
    }
    case "session.idle":
      return { kind: "session-idle", sessionID: str(p.sessionID) };
    // Source-verified: properties { sessionID, status: { type: "idle" | ... } }; idle is the same settle signal.
    case "session.status":
      return isRecord(p.status) && p.status.type === "idle" ? { kind: "session-idle", sessionID: str(p.sessionID) } : { kind: "other", type: raw.type };
    case "session.error":
      // The error NAME only (a type name); never its data / message.
      return { kind: "session-error", sessionID: str(p.sessionID), errorName: isRecord(p.error) ? bounded(p.error.name, 64) : null };
    // SOURCE-VERIFIED (v1.permissionAskedShape): properties { id, sessionID, permission,
    // patterns[], metadata, always, tool?: { messageID, callID } }.
    case "permission.asked":
      return { kind: "permission-asked", requestID: str(p.id), sessionID: str(p.sessionID), permission: bounded(p.permission, 64), patterns: boundedList(p.patterns), callID: isRecord(p.tool) ? str(p.tool.callID) : null };
    case "permission.replied":
      return { kind: "permission-replied", requestID: str(p.requestID), sessionID: str(p.sessionID), reply: bounded(p.reply, 32) };
    case "server.instance.disposed":
      return { kind: "instance-disposed" };
    case "message.part.updated": {
      // Source-verified: the part at properties.part, siblings properties.sessionID / properties.time.
      const part = isRecord(p.part) ? p.part : {};
      if (part.type !== "tool" || !isRecord(part.state)) return { kind: "other", type: raw.type };
      const base = { sessionID: str(part.sessionID) ?? str(p.sessionID), callID: str(part.callID), tool: str(part.tool) };
      if (part.state.status === "completed") return toolTerminal({ ...base, status: "completed", output: str(part.state.output) });
      if (part.state.status === "error") {
        return toolTerminal({ ...base, status: "error", error: str(part.state.error), interrupted: isRecord(part.state.metadata) && part.state.metadata.interrupted === true });
      }
      return { kind: "tool-running", ...base, status: str(part.state.status) };
    }
    default:
      return { kind: "other", type: raw.type };
  }
}

export const v1Host = Object.freeze({
  family: "v1",
  launchArgv: serveArgv,
  // Readiness: V1's listening line is NOT source-verified -> `127.0.0.1:<port>` (digit boundary).
  isListening: (text, port) => mentionsPort(text, port),
  // The auxiliary (title / compaction) signatures are SOURCE-VERIFIED (research §12; see
  // fake-provider.mjs AUXILIARY_SIGNATURES), so they are not candidates.
  // v1.agentsRoute and v1.messageAgentModelFields are source-verified (1.18.29 16747470 /
  // 1.19.3 e3c4eb24; research §12): no V1 candidates remain.
  candidates: Object.freeze([]),
  candidatesFor: scopedCandidates([], V1_SCENARIO_CANDIDATES),
  verifiedShapes: V1_VERIFIED_SHAPES,
  hostEnvExtra: ({ configPath, password }) => ({
    OPENCODE_CONFIG: configPath,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  }),
  routes: Object.freeze({
    identity: (directory) => ({ method: "GET", path: "/session", query: { directory } }),
    createSession: (directory) => ({ method: "POST", path: "/session", query: { directory }, body: {} }),
    prompt: ({ sessionID, text, directory }) => ({ method: "POST", path: `/session/${seg(sessionID)}/prompt_async`, query: { directory }, body: { parts: [{ type: "text", text }] } }),
    children: ({ sessionID, directory }) => ({ method: "GET", path: `/session/${seg(sessionID)}/children`, query: { directory } }),
    messages: ({ sessionID, directory }) => ({ method: "GET", path: `/session/${seg(sessionID)}/message`, query: { directory } }),
    status: (directory) => ({ method: "GET", path: "/session/status", query: { directory } }),
    events: (directory) => ({ path: "/event", query: { directory } }),
    cancel: ({ sessionID, directory }) => ({ method: "POST", path: `/session/${seg(sessionID)}/abort`, query: { directory } }),
    dispose: (directory) => ({ method: "POST", path: "/instance/dispose", query: { directory } }),
    /** Source-verified (research §5): -> `true`. Decisions: once | always | reject. */
    /** SOURCE-VERIFIED (v1.projectCurrentRoute): -> the bare project { id, worktree, vcs?, ... } (S11 host-relative read rules). */
    projectCurrent: (directory) => ({ method: "GET", path: "/project/current", query: { directory } }),
    reply: ({ requestID, decision, directory }) => ({ method: "POST", path: `/permission/${seg(requestID)}/reply`, query: { directory }, body: { reply: decision } }),
    /** Source-verified: bare array of { name, mode, hidden?, description?, native?, permission, options, model? }. */
    agents: (directory) => ({ method: "GET", path: "/agent", query: { directory } }),
  }),
  toolCallsFromMessages,
  toolEntriesFromMessages,
  toolCall,
  agentFile: renderAgentFile,
  /** Agent names from the bare-array agents route: `name` only (source-verified; no `id` fallback). */
  agentNamesFrom: (response) => (response.status === 200 && Array.isArray(response.json) ? response.json.filter((agent) => isRecord(agent) && typeof agent.name === "string").map((agent) => agent.name) : null),
  sessionIDFrom: (response) => (response.status === 200 && isRecord(response.json) ? str(response.json.id) : null),
  childrenFrom: (response) => (response.status === 200 && Array.isArray(response.json) ? response.json : null),
  normalizeEvent,
  buildConfig({ providerBaseURL, models, parentModel, spec, council, permissionRules = null }) {
    checkConfigInput({ providerBaseURL, spec, models, parentModel });
    return {
      // Workspace permission (UNVERIFIED v1.permissionConfig; normalizer-observed shape).
      ...(permissionRules ? { permission: renderPermission(permissionRules) } : {}),
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      share: "disabled",
      model: `${FAKE_PROVIDER_ID}/${parentModel}`,
      provider: {
        [FAKE_PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "real-host fake provider",
          options: { baseURL: providerBaseURL, apiKey: FAKE_API_KEY },
          models: Object.fromEntries(models.map((id) => [id, { name: id, tool_call: true }])),
        },
      },
      plugin: [[spec, { council }]],
      // Suppression (source-verified, research §12): no title generation, no auto-compaction.
      // (`small_model` is not a disable switch; `share` is unrelated.) Any auxiliary request FAILs S1/S2.
      agent: { title: { disable: true } },
      compaction: { auto: false },
    };
  },
});
