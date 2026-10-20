// Provenance: ADAPTED (rewritten) from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, paths test/real-host/runner.mjs and
//   test/real-host/runtime.mjs (responsibility inventory in test/PROVENANCE.md).
// Retained: fail-closed steps; cleanup always in the order stop owned processes ->
// close streams/listeners -> remove the fixture only if no owned process survived;
// auth challenge before any other host request; evidence before verdicts.
// Replaced/deleted: matrix/pilot orchestration (now the controller, one cell per
// container), Darwin sandbox preflight, canary, normalizer audit/debug logs,
// plugin remove/restore lifecycle.
//
// One cell, inside the container: fixture in /scratch -> seed the preseeded plugin
// cache -> in-process fake provider -> host config -> launch the host (owned process
// group) -> collect evidence -> evaluate -> cleanup.
import { randomBytes } from "node:crypto";
import { cp, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isatty } from "node:tty";

import { buildHostEnv, createFixture as createFixtureDir, generateServerPassword, hostEnvProblems, SYSTEM_PATH_DIRS } from "./env.mjs";
import { createFakeProvider, serve } from "./fake-provider.mjs";
import { hostAdapter } from "./hosts.mjs";
import { createHttpClient, HarnessError, openEventStream, readEventStream, verifyAuthChallenge } from "./http.mjs";
import { mentionsPort } from "./host-common.mjs";
import { httpFailure, lastAssistant, MAX_MESSAGE_PAGES, ok2xx, short, v1ChildIdentity, v1Messages, v2ChildIdentity, v2Messages } from "./host-ops.mjs";
import { drive, P1B_DRIVEN } from "./drive.mjs";
import { createListenerOwnership } from "./listener-ownership.mjs";
import { waitForProviderStartup } from "./provider-startup.mjs";
import { evaluate, fixtureFor, summarizeEvidence } from "./scenarios.mjs";
import { createSupervisor } from "./supervisor.mjs";
import { hostById } from "./cells.mjs";

export const DEFAULT_TIMING = Object.freeze({ phaseMs: 60_000, pollMs: 250, startupMs: 30_000 });
const IMAGE_ROOT = "/opt/council-rh";
const SCRATCH = "/scratch";
const MAX_EVENTS = 10_000;
const LOG_TAIL_BYTES = 2048;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Host-log tail for the result frame: redacts the fixture password (raw and as the Basic token
 * `opencode:<password>`), Authorization header values, Basic / Bearer tokens, sk- / gh*_ style
 * tokens, and replaces the fixture root with <FIXTURE>; then keeps the last `maxBytes` bytes.
 */
export function redactHostLog(text, { secrets = [], fixtureRoot = null, maxBytes = LOG_TAIL_BYTES } = {}) {
  let out = String(text ?? "");
  // Every encoding of each secret: raw; base64 / base64url (padded and unpadded) of the secret
  // and of the Basic credential `opencode:<secret>`. Longest first so a padded form is not split.
  const forms = new Set();
  for (const secret of secrets.filter((value) => typeof value === "string" && value.length >= 8)) {
    forms.add(secret);
    for (const plain of [secret, `opencode:${secret}`]) {
      const b64 = Buffer.from(plain).toString("base64");
      const url = Buffer.from(plain).toString("base64url");
      for (const form of [b64, b64.replace(/=+$/, ""), url, url + "=".repeat((4 - (url.length % 4)) % 4)]) forms.add(form);
    }
  }
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join("[redacted]");
  // Authorization values: quoted JSON (any key case / spacing; the value is a full JSON string,
  // so escaped quotes `\"` and backslashes `\\` inside it never end the match early) and
  // header / key=value forms.
  out = out.replace(/("authorization"\s*:\s*")(?:[^"\\]|\\.)*(")/gi, "$1[redacted]$2");
  out = out.replace(/(authorization\s*[:=]\s*)(?:(?:basic|bearer)\s+)?[^\s,;"']+/gi, "$1[redacted]");
  out = out.replace(/\b(basic|bearer)\s+[A-Za-z0-9+/=._~-]{8,}/gi, "$1 [redacted]");
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,})/g, "[redacted]");
  if (typeof fixtureRoot === "string" && fixtureRoot.length > 1) out = out.replace(new RegExp(escapeRe(fixtureRoot), "g"), "<FIXTURE>");
  // Bound AFTER redaction: a credential straddling the cut is already gone.
  const bytes = Buffer.from(out);
  if (bytes.length <= maxBytes) return out;
  let cut = bytes.subarray(bytes.length - maxBytes).toString("utf8");
  while (Buffer.byteLength(cut) > maxBytes) cut = cut.slice(1);
  return cut;
}
/** Version probe capture cap (stdout and stderr each). */
const PROBE_CAP_BYTES = 4096;

/**
 * Expected `--version` stdout per host family, SOURCE-VERIFIED (Radagast) at all four pins for
 * the release binaries with stdout NOT a TTY (research §12):
 *   V1 (1.18.29, 1.19.3): yargs 18 `.version()` -> console.log(version)  -> "<v>\n"
 *   V2 (2.0.28, 2.0.32):  Effect 4.0.1 CliOutput `bold(name) dim("v") bold(version)`, plain
 *                         when stdout is not a TTY (or NO_COLOR is set)    -> "opencode v<v>\n"
 */
export function expectedVersionStdout(family, version) {
  if (family === "v1") return `${version}\n`;
  if (family === "v2") return `opencode v${version}\n`;
  throw new Error(`unknown host family ${family}`);
}

/** Exactly the family's expected line, with or without its single trailing "\n" (no styling, prefix, whitespace, CR, or extra lines). */
export function exactVersionOutput(stdout, version, family) {
  const expected = expectedVersionStdout(family, version);
  return stdout === expected || stdout === expected.slice(0, -1);
}

/**
 * Probe environment: built from scratch (same base keys as the host launch, no extras). In
 * particular it never carries OPENCODE_SSH_ASKPASS_PORT (V2: bypasses version parsing),
 * OPENCODE_PRINT_LOGS (V2: stderr logs), or any color / terminal variable. NO_COLOR is
 * deliberately NOT set: stdout is a regular file (never a TTY), which already selects plain
 * output, and keeping the env identical to the launch env avoids masking a regression -- any
 * ANSI styling fails the exact check (fail-closed).
 */
export function probeEnv(fixture) {
  return buildHostEnv(fixture, { pathDirs: SYSTEM_PATH_DIRS, extra: {} });
}

/** stdin ignored; stdout / stderr are regular files (never a terminal). */
export const PROBE_STDIO = (outFd, errFd) => ["ignore", outFd, errFd];

/** Refuses a terminal descriptor for probe output (the V2 formatter styles a TTY). */
export function assertNotTty(fd, { isatty: check = isatty } = {}) {
  if (check(fd)) throw Object.assign(new Error(`probe output fd ${fd} must not be a TTY`), { code: "EPROBETTY" });
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const errorClass = (error) => {
  const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? ` ${error.code}` : "";
  return `${name}${code}`;
};
/** errorClass, plus `: <detail>` for coded harness errors (their detail is bounded and sanitized). */
const describeError = (error) => (typeof error?.code === "string" && typeof error?.detail === "string" ? `${errorClass(error)}: ${error.detail}` : errorClass(error));

/** Bounds for the SSE diagnostics (worst case well below the 192 KiB evidence cap). */
export { MAX_MESSAGE_PAGES };

export const EVENT_DIAGNOSTIC_LIMITS = Object.freeze({ maxTypes: 64, maxShapes: 8, maxKeys: 32, maxName: 64 });

/**
 * Bounded observation of the raw SSE stream: event type -> count (at most `maxTypes` distinct
 * types; everything else, incl. non-JSON / untyped events, is counted in `otherTypes`) and the
 * KEY SHAPE (sorted key names only, never values) of `session.tool*` events and of tool-part
 * `message.part.updated` events (at most `maxShapes` distinct shapes; the rest -> `shapesDropped`).
 */
export function createEventDiagnostics({ maxTypes = EVENT_DIAGNOSTIC_LIMITS.maxTypes, maxShapes = EVENT_DIAGNOSTIC_LIMITS.maxShapes } = {}) {
  const { maxKeys, maxName } = EVENT_DIAGNOSTIC_LIMITS;
  const typeCounts = new Map();
  const shapes = new Map();
  let otherTypes = 0;
  let shapesDropped = 0;
  const keysOf = (value) => (isRecord(value) ? Object.keys(value).sort().slice(0, maxKeys).map((key) => key.slice(0, maxName)) : null);
  function shapeOf(raw, type) {
    if (type.startsWith("session.tool")) return { type, keys: keysOf(raw), dataKeys: keysOf(raw.data) };
    const properties = isRecord(raw.properties) ? raw.properties : null;
    const part = properties && isRecord(properties.part) ? properties.part : null;
    if (type === "message.part.updated" && part?.type === "tool") return { type, keys: keysOf(raw), propertiesKeys: keysOf(properties), partKeys: keysOf(part), stateKeys: keysOf(part.state) };
    return null;
  }
  return {
    record(raw) {
      const type = isRecord(raw) && typeof raw.type === "string" ? raw.type.slice(0, maxName) : null;
      if (type !== null && (typeCounts.has(type) || typeCounts.size < maxTypes)) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
      else otherTypes += 1;
      const shape = type === null ? null : shapeOf(raw, type);
      if (!shape) return;
      const id = JSON.stringify(shape);
      if (shapes.has(id)) return;
      if (shapes.size >= maxShapes) shapesDropped += 1;
      else shapes.set(id, shape);
    },
    snapshot: () => ({ typeCounts: Object.fromEntries(typeCounts), otherTypes, toolShapes: [...shapes.values()], shapesDropped }),
  };
}

/** SSE tool terminals for council_review in `sessionID` (diagnostic only): V2 names come from input.started, correlated by sessionID + call id. */
function sseCouncilReviewTerminals(all, sessionID) {
  const names = new Map();
  for (const event of all) if (event.kind === "tool-input-started") names.set(`${event.sessionID}\u0000${event.callID}`, event.tool);
  return all.filter((event) => event.kind === "tool-terminal" && event.sessionID === sessionID && (event.tool ?? names.get(`${event.sessionID}\u0000${event.callID}`)) === "council_review").length;
}

/** Status / size summary of the parent's durable council_review calls (never the text). */
const toolOutputObservation = (calls) => ({ calls: calls.length, statuses: calls.slice(0, 8).map((call) => short(call.status)), textBytes: calls.reduce((sum, call) => sum + Buffer.byteLength(String(call.text ?? "")), 0) });

/**
 * Drives one S1/S2 cell against a running host and returns evidence for
 * scenarios.evaluate(). `events` must provide subscribe(), waitFor(), all().
 */
export async function collectEvidence({ scenario, family, fixture, project, client, events, provider, signal, timing = DEFAULT_TIMING, readPluginLog = null, deadlineAt = Infinity, rewriteProjectFile = null }) {
  const host = hostAdapter(family);
  const phase = { timeoutMs: timing.phaseMs, signal };
  // Nothing is sent to the listener before it proves it is the instance we started.
  await verifyAuthChallenge(client, host.routes.identity(project));
  await events.subscribe();

  let plugin = null;
  if (family === "v2") {
    const deadline = Date.now() + timing.phaseMs;
    for (;;) {
      const route = host.routes.plugins(project);
      const response = await client.request({ ...route, operation: "plugin inventory" });
      if (response.status !== 200 || !isRecord(response.json) || !Array.isArray(response.json.data)) throw httpFailure("EPLUGININVENTORY", "plugin inventory", route, response);
      const entries = response.json.data;
      plugin = { entries };
      const ours = entries.filter((entry) => entry?.source?.target === fixture.spec);
      if (ours.length === 1 && ours[0].state?.status === "active") break;
      if (Date.now() >= deadline || signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
    }
  }
  const agentsRoute = host.routes.agents(project);
  const agentsResponse = await client.request({ ...agentsRoute, operation: "agents" });
  const agents = host.agentNamesFrom(agentsResponse);
  if (agents === null) throw httpFailure("EAGENTS", "agents", agentsRoute, agentsResponse);

  // P1b scenarios (S3-S13, obs-ask): event-driven drivers (drive.mjs) after the same bootstrap.
  if (P1B_DRIVEN.has(scenario)) {
    const evidence = await drive({ scenario, family, host, fx: fixture, project, client, events, provider, signal, timing, readPluginLog, deadlineAt, rewriteProjectFile });
    return { ...evidence, plugin, agents, observations: { [`${family}.agentsRoute`]: { status: agentsResponse.status, names: agents }, ...evidence.observations } };
  }

  const createRoute = host.routes.createSession(project);
  const created = await client.request({ ...createRoute, operation: "session create" });
  const parentSessionID = host.sessionIDFrom(created);
  if (!parentSessionID) throw httpFailure("ESESSIONCREATE", "session create", createRoute, created);
  // Before the prompt: the fake provider serves requests of known sessions (this parent and
  // children naming it in their parent header) as MAIN; anything else is auxiliary or rejected.
  provider.registerParent?.(parentSessionID);
  const isFinal = (sessionID) => (event) => (family === "v2" ? event.kind === "session-final" : event.kind === "session-idle") && event.sessionID === sessionID;
  const promptRoute = host.routes.prompt({ sessionID: parentSessionID, text: `rh council cell ${fixture.nonce}`, directory: project });
  const prompted = await client.request({ ...promptRoute, operation: "prompt" });
  if (!ok2xx(prompted)) throw httpFailure("EPROMPT", "prompt", promptRoute, prompted);
  if (family === "v2") {
    const waitRoute = host.routes.wait({ sessionID: parentSessionID });
    const waited = await client.request({ ...waitRoute, timeout: timing.phaseMs, operation: "wait" });
    if (!ok2xx(waited)) throw httpFailure("EWAIT", "wait", waitRoute, waited);
  }
  await events.waitFor(isFinal(parentSessionID), phase);

  let children = [];
  let parentPermissions;
  let parentPermissionsPresent;
  let parentSessionRead;
  let persistedCompleted;
  // The parent's council_review calls from its DURABLE record (S2 source of truth; SSE is volatile).
  let parentToolCalls;
  let parentToolPagesExceeded;
  let toolOutput = null;
  const v1Raw = [];
  if (scenario === "s2") {
    const childrenRoute = host.routes.children({ sessionID: parentSessionID, directory: project });
    const childrenResponse = await client.request({ ...childrenRoute, operation: "children" });
    const listed = host.childrenFrom(childrenResponse);
    if (!listed) throw httpFailure("ECHILDREN", "children", childrenRoute, childrenResponse);
    for (const child of listed) await events.waitFor(isFinal(child.id), phase);
    children = [];
    if (family === "v2") {
      for (const child of listed) children.push(await v2ChildIdentity(client, host, child));
      // The parent's permissions read back: its deny rules are the expected prefix of the
      // aggregator's. A non-array value (null included) is kept as-is so the evaluator can
      // reject it (mirrors src/v2-permissions.ts parentDenyRules).
      const parent = host.sessionFrom(await client.request({ ...host.routes.session({ sessionID: parentSessionID }), operation: "parent session get" }));
      parentSessionRead = parent !== null;
      // Absence is recorded EXPLICITLY (parentPermissionsPresent: false); an explicit
      // `permissions: null` is kept as null (malformed for parentDenyRules), never conflated.
      parentPermissionsPresent = parent !== null && Object.hasOwn(parent, "permissions") && parent.permissions !== undefined;
      parentPermissions = parentPermissionsPresent ? parent.permissions : undefined;
      const read = await v2Messages(client, host, parentSessionID, "parent messages");
      parentToolCalls = host.toolCallsFromMessages(read.messages, "council_review");
      parentToolPagesExceeded = read.exceeded;
      toolOutput = { source: "durable-messages", pages: read.pages, pagesExceeded: read.exceeded, ...toolOutputObservation(parentToolCalls) };
    } else {
      // One read of the parent's messages: settlement corroboration (last assistant
      // time.completed) and its council_review tool part(s) (state.output).
      const parentMessages = await v1Messages(client, host, project, parentSessionID);
      persistedCompleted = { [parentSessionID]: lastAssistant(parentMessages).completed };
      parentToolCalls = host.toolCallsFromMessages(parentMessages, "council_review");
      parentToolPagesExceeded = false;
      toolOutput = { source: "durable-parts", ...toolOutputObservation(parentToolCalls), truncated: parentToolCalls.slice(0, 8).map((call) => call.truncated === true) };
      for (const child of listed) {
        const { identity, completed, raw } = await v1ChildIdentity(client, host, project, child);
        children.push(identity);
        persistedCompleted[child.id] = completed;
        v1Raw.push(raw);
      }
    }
  }

  const all = events.all();
  const ledger = provider.ledger();
  const finals = {};
  for (const id of [parentSessionID, ...children.map((child) => child.id)]) if (all.some(isFinal(id))) finals[id] = "terminal";
  if (toolOutput) toolOutput.sseCouncilReviewTerminals = sseCouncilReviewTerminals(all, parentSessionID);
  const createdEvents = all.filter((event) => event.kind === "session-created" && event.sessionID !== parentSessionID);

  // What each host shape actually looked like at runtime: the UNVERIFIED ones (host adapters'
  // `candidates`) plus runtime records of source-verified ones (agents, identity fields, the
  // parent tool result source) and the bounded SSE diagnostics (`sse.events`, null if absent).
  const sseEvents = typeof events.diagnostics === "function" ? events.diagnostics() : null;
  const agentsObservation = { status: agentsResponse.status, names: agents };
  const observations =
    family === "v2"
      ? {
          "v2.providerConfig": { parentRequestModels: [...new Set(ledger.filter((entry) => entry.sessionID === parentSessionID && entry.kind === "model").map((entry) => entry.model))] },
          "v2.modelRef": children.map((child) => ({ id: child.id, model: child.rawModel ?? null })),
          "v2.agentsRoute": agentsObservation,
          "v2.sessionCreatedShape": [...new Map(createdEvents.filter((event) => event.shape).map((event) => [JSON.stringify(event.shape), event.shape])).values()].slice(0, 8),
          "v2.toolOutputSource": toolOutput,
          "sse.events": sseEvents,
        }
      : {
          "v1.agentsRoute": agentsObservation,
          "v1.messageAgentModelFields": v1Raw,
          "v1.toolOutput": toolOutput,
          "sse.events": sseEvents,
        };

  return {
    scenario,
    family,
    parentSessionID,
    expected: fixture.expected,
    plugin,
    agents,
    children: children.map(({ rawModel, ...child }) => child),
    created: createdEvents.map((event) => ({ sessionID: event.sessionID, parentID: event.parentID })),
    ledger,
    ...(parentToolCalls !== undefined ? { parentToolCalls, parentToolPagesExceeded } : {}),
    finals,
    ...(family === "v2" && scenario === "s2" ? { parentSessionRead, parentPermissionsPresent, ...(parentPermissionsPresent ? { parentPermissions } : {}) } : {}),
    ...(persistedCompleted !== undefined ? { persistedCompleted } : {}),
    observations,
  };
}

// ---------------------------------------------------------------------------
// Real in-container infrastructure (not exercised by unit tests).

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Last `bytes` bytes of a file: fd + fstat, one positioned read from max(0, size - bytes). "" if missing. */
export async function tailFile(path, bytes, { onRead = null } = {}) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const position = Math.max(0, size - bytes);
    const length = size - position;
    const buffer = Buffer.alloc(length);
    onRead?.(length, position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle.close();
  }
}
const tail = (path, bytes) => tailFile(path, bytes);

/**
 * Writes fixture project entries in order: files `{ path, content }` (exclusive create, 0600) and
 * directories `{ path, type: "dir" }` (S11 V1 config marker: created exclusively, so empty, 0700).
 * Refuses any path outside `project`.
 */
export async function writeProjectFiles(project, files, { overwrite = false } = {}) {
  for (const file of files) {
    const target = join(project, file.path);
    const rel = relative(project, target);
    if (isAbsolute(file.path) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`project file escapes the project: ${file.path}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (file.type === "dir") await mkdir(target, { mode: 0o700 });
    else await writeFile(target, file.content, { flag: overwrite ? "w" : "wx", mode: 0o600 });
  }
}

/** `supervisor` / `isatty` are injectable for tests only (TTY refusal before any spawn). */
export function defaultDeps({ timing = DEFAULT_TIMING, supervisor = createSupervisor(), isatty: ttyCheck = isatty } = {}) {
  const listeners = createListenerOwnership();
  const state = { logPath: null, password: null };
  return {
    timing,
    createFixture: (cell) => createFixtureDir(SCRATCH, { label: cell.id.replace(/[^a-z0-9]+/gi, "-") }),
    async seedPluginCache(fixture) {
      await cp(`${IMAGE_ROOT}/plugin-cache/cache`, fixture.xdg.XDG_CACHE_HOME, { recursive: true, errorOnExist: true, force: false });
      await cp(`${IMAGE_ROOT}/plugin-cache/config`, fixture.xdg.XDG_CONFIG_HOME, { recursive: true, errorOnExist: true, force: false }).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    },
    async startProvider({ family, fixture: fx, root }) {
      const provider = createFakeProvider({ family, identityToken: randomBytes(16).toString("hex"), models: fx.models, nonces: fx.providerNonces, markers: fx.providerMarkers, outputMarkers: fx.outputMarkers ?? [] });
      const server = await serve(provider, { port: 0 });
      // Held requests never block close: open every barrier and drop open connections first.
      const close = () => {
        provider.releaseAll();
        server.closeAllConnections?.();
        return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      };
      listeners.register(root, { group: "provider", label: "fake-provider", listener: { close } });
      return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, provider, close: () => listeners.closeAll(root) };
    },
    async writeConfig({ fixture, family, fx, providerBaseURL }) {
      const config = hostAdapter(family).buildConfig({ providerBaseURL, models: Object.keys(fx.models), parentModel: fx.parentModel, spec: fx.spec, council: fx.council, permissionRules: fx.permissionRules ?? null });
      const path = join(fixture.run, "config.json");
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return path;
    },
    writeProjectFiles: (fixture, fx) => writeProjectFiles(fixture.project, fx.projectFiles ?? []),
    rewriteProjectFile: (fixture, file) => writeProjectFiles(fixture.project, [file], { overwrite: true }),
    // Radagast M6: the V1 plugin log is $XDG_DATA_HOME/opencode/log/opencode.log (bounded tail).
    readPluginLog: (fixture) => tailFile(join(fixture.xdg.XDG_DATA_HOME, "opencode", "log", "opencode.log"), 256 * 1024),
    async launchHost({ fixture, manifest, family, configPath, signal }) {
      const host = hostAdapter(family);
      const port = await freePort();
      const password = generateServerPassword();
      state.password = password;
      const env = buildHostEnv(fixture, { pathDirs: SYSTEM_PATH_DIRS, extra: host.hostEnvExtra({ configPath, password }) });
      const problems = hostEnvProblems(env, fixture, { realHome: null });
      if (problems.length > 0) throw new Error(`host environment rejected: ${problems.join("; ")}`);
      state.logPath = join(fixture.logs, "host.log");
      const log = await open(state.logPath, "wx", 0o600);
      try {
        const [command, ...args] = host.launchArgv(manifest.host.executablePath, port);
        const owned = await supervisor.spawnOwned(command, args, { cwd: fixture.project, env, stdio: ["ignore", log.fd, log.fd] });
        const startup = await waitForProviderStartup({
          // Family-specific listening line (V2 source-verified exact line; V1 `127.0.0.1:<port>`).
          isReady: async () => host.isListening(await tail(state.logPath, 64 * 1024), port),
          exited: owned.exited,
          signal,
          timeoutMs: timing.startupMs,
          pollMs: timing.pollMs,
        });
        if (startup.outcome !== "ready") {
          const text = await tail(state.logPath, 64 * 1024);
          throw new HarnessError("EHOSTSTARTUP", `host startup outcome ${startup.outcome} within ${timing.startupMs} ms; listening line seen: ${host.isListening(text, port)}; port mentioned: ${mentionsPort(text, port)}`);
        }
        return { port, password };
      } finally {
        await log.close();
      }
    },
    async connect({ family, launched, project, signal }) {
      const host = hostAdapter(family);
      // Frame-2 MA1: the cell signal aborts every host request.
      const client = createHttpClient({ baseURL: `http://127.0.0.1:${launched.port}`, auth: { username: "opencode", password: launched.password }, signal });
      const seen = [];
      const waiters = new Set();
      const diagnostics = createEventDiagnostics();
      // Fixture nonces to detect in RAW host events (S4: the partial text must be host-visible
      // before the fault). Only { nonce, event type } is recorded, once per nonce; never text.
      const watched = new Set();
      const reported = new Set();
      let stream = null;
      const push = (normalized) => {
        if (seen.length >= MAX_EVENTS) return;
        seen.push(normalized);
        for (const waiter of [...waiters]) waiter(normalized);
      };
      const events = {
        /** Opens the event stream; called again (V1 after dispose) it replaces the previous stream and keeps every event seen. */
        async subscribe() {
          stream?.abort();
          stream = await openEventStream(client, host.routes.events(project), { timeoutMs: timing.phaseMs, signal });
          readEventStream(stream.response.body, async (event) => {
            let raw = null;
            try {
              raw = JSON.parse(event.data);
            } catch {
              raw = null;
            }
            // Every raw event is counted (bounded); only the normalized list is capped.
            diagnostics.record(raw);
            push(host.normalizeEvent(raw));
            for (const nonce of watched) {
              if (reported.has(nonce) || !String(event.data).includes(nonce)) continue;
              reported.add(nonce);
              push({ kind: "nonce-seen", nonce, type: isRecord(raw) && typeof raw.type === "string" ? raw.type.slice(0, 64) : null });
            }
          }).catch(() => {});
        },
        watchNonces(list) {
          for (const nonce of list) if (typeof nonce === "string" && nonce.length >= 8) watched.add(nonce);
        },
        all: () => [...seen],
        diagnostics: () => diagnostics.snapshot(),
        /** Event-driven; rejects EEVENTWAIT at `timeoutMs`, EABORTED as soon as `signal` (or the cell signal) aborts. */
        waitFor: (predicate, { timeoutMs, signal: waitSignal = signal } = {}) =>
          new Promise((resolve, reject) => {
            const hit = seen.find(predicate);
            if (hit) return resolve(hit);
            const done = () => {
              clearTimeout(timer);
              waiters.delete(listener);
              waitSignal?.removeEventListener("abort", onAbort);
            };
            const onAbort = () => {
              done();
              reject(new HarnessError("EABORTED", "event wait aborted (cell deadline / operator)"));
            };
            const timer = setTimeout(() => {
              done();
              reject(new HarnessError("EEVENTWAIT", `event wait timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            function listener(event) {
              if (!predicate(event)) return;
              done();
              resolve(event);
            }
            waiters.add(listener);
            if (waitSignal?.aborted) onAbort();
            else waitSignal?.addEventListener("abort", onAbort, { once: true });
          }),
      };
      return { client, events, close: async () => stream?.abort() };
    },
    collect: collectEvidence,
    evaluate,
    async probeVersion({ fixture, manifest, signal }) {
      const env = probeEnv(fixture);
      const outPath = join(fixture.logs, "version.out");
      const errPath = join(fixture.logs, "version.err");
      const out = await open(outPath, "wx", 0o600);
      const err = await open(errPath, "wx", 0o600);
      try {
        // Before any spawn: a terminal descriptor would get the V2 formatter's ANSI styling.
        assertNotTty(out.fd, { isatty: ttyCheck });
        assertNotTty(err.fd, { isatty: ttyCheck });
        const owned = await supervisor.spawnOwned(manifest.host.executablePath, ["--version"], { cwd: fixture.project, env, stdio: PROBE_STDIO(out.fd, err.fd) });
        const exited = await Promise.race([owned.exited, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("version probe timed out"), { code: "EPROBETIMEOUT" })), timing.startupMs))]);
        if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "EABORTED" });
        if (exited.code !== 0) throw Object.assign(new Error(`version probe exited ${exited.code ?? exited.signal}`), { code: "EPROBEEXIT" });
      } finally {
        await out.close();
        await err.close();
      }
      // Full stdout (capped, never trimmed): the check is exact.
      const stdout = await readFile(outPath);
      const stderr = await readFile(errPath);
      return { stdout: stdout.subarray(0, PROBE_CAP_BYTES).toString("utf8"), stderr: stderr.subarray(0, PROBE_CAP_BYTES).toString("utf8"), truncated: stdout.length > PROBE_CAP_BYTES };
    },
    stopAll: () => supervisor.stopAll(),
    removeFixture: (fixture) => supervisor.removeRootIfSafe(fixture.root),
    async logSummary() {
      if (!state.logPath) return null;
      // Read a larger tail, redact, THEN bound: a secret cut at the read boundary can never survive half-redacted.
      return redactHostLog(await tail(state.logPath, 64 * 1024), { secrets: [state.password], fixtureRoot: SCRATCH });
    },
  };
}

/**
 * Version probe: under the same containment, run `<executable> --version` with the
 * fixture-only environment and require exactly the host version. (The driver
 * already verified the executable sha256 before calling this.)
 */
async function runProbe({ cell, manifest, signal }, deps) {
  const checks = [];
  let fixture = null;
  let probe = null;
  try {
    fixture = await deps.createFixture(cell);
    const host = hostById(cell.host);
    const version = manifest.host.version ?? host.version;
    const expected = expectedVersionStdout(host.family, version);
    const { stdout, stderr, truncated } = await deps.probeVersion({ fixture, manifest, signal });
    // stderr is recorded (bounded) but does not gate: the plan checks exact version stdout + hash.
    probe = { expected, stdoutBytes: Buffer.byteLength(String(stdout)), stderr: String(stderr ?? "").slice(0, 512), truncated: truncated === true };
    const ok = !truncated && exactVersionOutput(String(stdout), version, host.family);
    checks.push({ id: "probe.version", ok, detail: ok ? "" : truncated ? `stdout exceeded the ${PROBE_CAP_BYTES}-byte cap` : `printed ${JSON.stringify(String(stdout).slice(0, 64))}, expected exactly ${JSON.stringify(expected)} (${host.family} --version, non-TTY)` });
  } catch (error) {
    checks.push({ id: "probe.run", ok: false, detail: errorClass(error) });
  }
  const cleanup = [];
  const stops = await deps.stopAll().catch((error) => (cleanup.push(`stop failed (${errorClass(error)})`), []));
  if (stops.some((stop) => stop?.aliveAfter)) cleanup.push("owned process alive after stop");
  if (fixture && cleanup.length === 0) await deps.removeFixture(fixture).catch((error) => cleanup.push(`fixture retained (${errorClass(error)})`));
  if (cleanup.length > 0) checks.push({ id: "cell.cleanup", ok: false, detail: cleanup.join("; ") });
  return { verdict: checks.every((entry) => entry.ok) ? "PASS" : "FAIL", checks, summary: { probe } };
}

/** Runs one cell end to end. Never throws: every failure becomes a FAIL check. */
export async function runCell({ cell, manifest, signal, deadlineAt = Infinity }, deps = defaultDeps()) {
  if (cell.scenario === "probe") return runProbe({ cell, manifest, signal }, deps);
  const timing = deps.timing ?? DEFAULT_TIMING;
  const family = hostById(cell.host).family;
  const checks = [];
  let stage = "fixture";
  let fixture = null;
  let provider = null;
  let connection = null;
  let result = null;
  let evidence = null;
  // Frame-2 MA1: no new stage starts once the cell signal fired (the cleanup below still runs).
  const checkpoint = () => {
    if (signal?.aborted) throw new HarnessError("EABORTED", `cell aborted before stage ${stage}`);
  };
  try {
    checkpoint();
    fixture = await deps.createFixture(cell);
    stage = "seed";
    await deps.seedPluginCache(fixture, manifest);
    const fx = fixtureFor(cell.scenario, { nonce: randomBytes(6).toString("hex"), family, project: fixture.project, hostVersion: hostById(cell.host).version });
    stage = "provider";
    checkpoint();
    provider = await deps.startProvider({ family, fixture: fx, root: fixture.root });
    stage = "config";
    checkpoint();
    const configPath = await deps.writeConfig({ fixture, family, fx, providerBaseURL: provider.baseURL });
    // Project files (S11 agent definition + read targets; V1 S11 also the .opencode config-install
    // skip-marker) exist before the host starts.
    if ((fx.projectFiles ?? []).length > 0) await deps.writeProjectFiles(fixture, fx);
    stage = "launch";
    checkpoint();
    const launched = await deps.launchHost({ fixture, manifest, family, configPath, signal });
    stage = "connect";
    checkpoint();
    connection = await deps.connect({ family, launched, project: fixture.project, signal });
    stage = "collect";
    checkpoint();
    evidence = await deps.collect({ scenario: cell.scenario, family, fixture: fx, project: fixture.project, client: connection.client, events: connection.events, provider: provider.provider, signal, timing, deadlineAt, readPluginLog: deps.readPluginLog ? () => deps.readPluginLog(fixture) : null, rewriteProjectFile: deps.rewriteProjectFile ? (file) => deps.rewriteProjectFile(fixture, file) : null });
    result = deps.evaluate(evidence);
  } catch (error) {
    result = { verdict: "FAIL", checks: [{ id: `cell.${stage}`, ok: false, detail: describeError(error) }] };
  }
  checks.push(...result.checks);

  // Cleanup: stop owned processes first (never delayed for logs), then streams and
  // listeners, then remove the fixture only if nothing owned survived.
  const cleanup = [];
  let stops = [];
  try {
    stops = await deps.stopAll();
  } catch (error) {
    cleanup.push(`stop failed (${errorClass(error)})`);
  }
  const survivors = stops.filter((stop) => stop?.aliveAfter);
  if (survivors.length > 0) cleanup.push(`owned process group(s) alive after stop: ${survivors.map((stop) => stop.pgid).join(",")}`);
  // Host-log tail: after the processes stopped (complete log), BEFORE the fixture is removed.
  const hostLogTail = deps.logSummary ? await deps.logSummary().catch(() => null) : undefined;
  for (const [label, close] of [["event stream", connection?.close], ["provider", provider?.close]]) {
    if (!close) continue;
    try {
      // Frame-2 MA6: listener-ownership closeAll RESOLVES with outcomes; a failed / timed-out
      // (or still closing) listener is a cleanup error -- FAIL, fixture retained.
      const outcomes = await close();
      for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
        if (outcome?.status !== "closed") cleanup.push(`${label} close ${outcome?.status ?? "unknown"} (${outcome?.label ?? "listener"})`);
      }
    } catch (error) {
      cleanup.push(`${label} close failed (${errorClass(error)})`);
    }
  }
  if (fixture && cleanup.length === 0) {
    try {
      await deps.removeFixture(fixture);
    } catch (error) {
      cleanup.push(`fixture retained (${errorClass(error)})`);
    }
  }
  if (cleanup.length > 0) checks.push({ id: "cell.cleanup", ok: false, detail: cleanup.join("; ") });

  const verdict = result.verdict === "PASS" && checks.every((entry) => entry.ok) ? "PASS" : result.verdict === "INVALID-FIXTURE" ? "INVALID-FIXTURE" : "FAIL";
  const summary = { candidates: hostAdapter(family).candidatesFor(cell.scenario), ledgerRequests: provider ? provider.provider.ledger().length : 0, evidence: evidence ? summarizeEvidence(evidence) : null };
  if (hostLogTail !== undefined) summary.hostLogTail = hostLogTail;
  return { verdict, checks, summary };
}
