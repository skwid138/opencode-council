// Council-only. P1b scenario drivers (S3-S13 + the observational V1 non-bash-ask cell). Each
// driver runs against a live host through the shared bootstrap in runner.mjs and returns the
// evidence that scenarios-p1b.mjs evaluates. Rules (approved plan §4 "Global evidence rules"):
//   - triggers only after EVENT-DRIVEN preconditions (provider hold / partial events, host SSE
//     events); no sleeps; every wait is bounded by the phase budget;
//   - a target-phase precondition not met in time is recorded (INVALID-FIXTURE), barriers are
//     released, and the driver stops triggering;
//   - the harness never interrupts / aborts children: control actions target only harness-
//     created parent sessions (or the instance for V1 dispose / V2 reload);
//   - everything persisted is a classification (labels, markers, constant classes, ticks),
//     never raw tool output, error text, or prompt text.
import { posix } from "node:path";

import { COUNCIL_TEXT } from "./aggregator-prompt.mjs";
import { isRecord } from "./host-common.mjs";
import { httpFailure, lastAssistant, ok2xx, v1Messages, v2ChildIdentity, v2Messages } from "./host-ops.mjs";
import { HarnessError } from "./http.mjs";

/** Scenarios this module drives (S1/S2 stay in runner.mjs collectEvidence). */
export const P1B_DRIVEN = Object.freeze(new Set(["s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13", "obs-ask"]));

/**
 * Mirrored host error texts (normalizer contracts, source-verified at V1 16747470 / V2 2.0.28
 * 026b106b; UNVERIFIED at the other pins -> candidatesFor lists the shapes each scenario uses).
 */
export const HOST_TEXT = Object.freeze({
  v1DeniedPrefix: "The user has specified a rule which prevents you from using this specific tool call.",
  v1Rejected: "The user rejected permission to use this specific tool call.",
  v1Aborted: "Tool execution aborted",
  v2Interrupted: "Tool execution interrupted",
  v2Declined: "The user declined this tool call",
  /** UNVERIFIED (v2.noSuchToolRefusal): the plan's "No tool named…" dispatch refusal. */
  v2NoSuchToolPrefix: "No tool named",
});

/** Constant class of a tool call's failure (never its text). */
export function errorClassOf(entry, family) {
  if (entry.invalidTarget) return "no-such-tool";
  if (entry.status !== "error") return null;
  const error = typeof entry.error === "string" ? entry.error : "";
  if (error.includes(COUNCIL_TEXT.v2AskDenied)) return "hook-denied";
  if (family === "v2") {
    if (entry.errorType === "permission.rejected") return "static-denied";
    if (error.startsWith(HOST_TEXT.v2NoSuchToolPrefix)) return "no-such-tool";
    if (error === HOST_TEXT.v2Interrupted) return "interrupted";
    if (error === HOST_TEXT.v2Declined) return "rejected";
  } else {
    if (error.startsWith(HOST_TEXT.v1DeniedPrefix)) return "static-denied";
    if (error === HOST_TEXT.v1Rejected) return "rejected";
    if (error === HOST_TEXT.v1Aborted) return "aborted";
  }
  return "other";
}

/** A durable tool entry -> { callID, name, status, markers, errorClass, textIs, interrupted, invalidTarget, messageCompleted }. */
export function classifyCall(entry, { family, markers = [], exactTexts = {} }) {
  const texts = [entry.output, entry.error].filter((value) => typeof value === "string");
  const primary = entry.status === "completed" ? entry.output : entry.error;
  const textIs = Object.entries(exactTexts).find(([, value]) => typeof primary === "string" && primary === value)?.[0] ?? null;
  return {
    callID: entry.callID,
    name: entry.name,
    status: entry.status,
    markers: markers.filter((marker) => texts.some((text) => text.includes(marker))),
    errorClass: errorClassOf(entry, family),
    textIs,
    interrupted: entry.interrupted === true,
    invalidTarget: entry.invalidTarget ?? null,
    messageCompleted: entry.messageCompleted ?? null,
  };
}

/**
 * Retry statistics of one session's provider requests (S4 budget option B): counts and ms only.
 * `retries` = identical-transcript attempts, `continuations` = grown-transcript attempts,
 * `retryDurationMs` = first -> last request receive time.
 */
export function retryStats(ledger, sessionID) {
  const entries = ledger.filter((entry) => entry.sessionID === sessionID);
  const times = entries.map((entry) => entry.receivedAt).filter((value) => typeof value === "number");
  return {
    requests: entries.length,
    retries: entries.filter((entry) => entry.attempt === "retry").length,
    continuations: entries.filter((entry) => entry.attempt === "continuation").length,
    retryDurationMs: times.length > 0 ? Math.max(...times) - Math.min(...times) : 0,
  };
}

/**
 * S4 partial-output observation cap (re-audit round 2): the wait for P to become host-visible
 * is at most 20 s (and never past the cell deadline), so the worst-case V2 default retry
 * backoff (~100.8 s) plus this wait fits the 150 s councillor budget. Not seen -> INVALID-FIXTURE.
 */
export const S4_PARTIAL_OBSERVE_MS = 20_000;

/** Bounded copies of the normalized permission events. */
const permissionEvent = (event) => ({ requestID: event.requestID ?? null, sessionID: event.sessionID ?? null, permission: event.permission ?? null, patterns: (event.patterns ?? []).slice(0, 4), callID: event.callID ?? null, reply: event.reply ?? null });

/**
 * The per-cell driving context: host requests, waits, and bookkeeping shared by every driver.
 * `ctx` = { scenario, family, host, fx, project, client, events, provider, signal, timing, readPluginLog }.
 */
export function createDriveKit(ctx) {
  const { family, host, fx, project, events, provider, signal, timing } = ctx;
  // Frame-2 MA1: the cell signal reaches every host request and every wait; every wait is
  // bounded by the REMAINING cell work deadline (never a fresh per-wait budget past it).
  const deadlineAt = typeof ctx.deadlineAt === "number" ? ctx.deadlineAt : Infinity;
  const bound = (ms) => Math.max(0, Math.min(ms, deadlineAt - Date.now()));
  const aborted = () => Object.assign(new Error("cell aborted"), { code: "EABORTED", detail: "cell work aborted (deadline / operator)" });
  const checkpoint = () => {
    if (signal?.aborted) throw aborted();
  };
  /** Host request carrying the cell signal; rejects EABORTED as soon as the signal fires. */
  const client = {
    request(req) {
      checkpoint();
      const pending = ctx.client.request({ ...req, ...(signal ? { signal } : {}) });
      if (!signal) return pending;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(aborted());
        signal.addEventListener("abort", onAbort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
  };
  const sleep = (ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(aborted())), { once: true });
  });
  // A council parent settles only after its councillors (<= councillor_ms) and its aggregator
  // (<= aggregator_ms): its terminal wait is event-driven, so a generous bound costs nothing
  // (the driver's 180 s work deadline still caps the cell).
  const councilBudgetMs = (fx.timeouts?.councillor_ms ?? 0) + (fx.timeouts?.aggregator_ms ?? 0) + timing.phaseMs;
  const actions = [];
  const preconditions = {};
  const marks = {};
  const roles = {};
  let order = 0;
  const isFinal = (sessionID) => (event) => (family === "v2" ? event.kind === "session-final" : event.kind === "session-idle") && event.sessionID === sessionID;
  const markers = [...new Set([...(fx.outputMarkers ?? []), ...(fx.expected.resultMarkers ?? [])])];
  const classify = (entry) => classifyCall(entry, { family, markers, exactTexts: fx.expected.exactTexts ?? {} });
  const record = (action) => {
    order += 1;
    actions.push({ ...action, order });
    return actions.at(-1);
  };

  const kit = {
    actions,
    preconditions,
    marks,
    roles,
    /** Index into events.all() (ordering proofs). */
    mark: () => events.all().length,
    async createSession(role, { permissions = null } = {}) {
      const route = family === "v2" && permissions ? host.routes.createSession(project, { permissions }) : host.routes.createSession(project);
      const response = await client.request({ ...route, operation: "session create" });
      const sessionID = host.sessionIDFrom(response);
      if (!sessionID) throw httpFailure("ESESSIONCREATE", "session create", route, response);
      // Before its prompt: the fake provider serves this session and its children as MAIN.
      provider.registerParent?.(sessionID);
      roles[role] = sessionID;
      return sessionID;
    },
    async prompt(sessionID, token) {
      const route = host.routes.prompt({ sessionID, text: `rh council cell ${token}`, directory: project });
      const response = await client.request({ ...route, operation: "prompt" });
      if (!ok2xx(response)) throw httpFailure("EPROMPT", "prompt", route, response);
    },
    /** Council parent terminal. V2: the session wait route, then the terminal event; V1: the idle event. */
    async awaitFinal(sessionID, timeoutMs = councilBudgetMs) {
      if (family === "v2") {
        const route = host.routes.wait({ sessionID });
        const response = await client.request({ ...route, timeout: bound(timeoutMs), operation: "wait" });
        if (!ok2xx(response)) throw httpFailure("EWAIT", "wait", route, response);
      }
      checkpoint();
      return events.waitFor(isFinal(sessionID), { timeoutMs: bound(timeoutMs), signal });
    },
    councilBudgetMs,
    bound,
    checkpoint,
    sleep,
    client,
    isFinal,
    /** Event-driven: resolves true once `count` distinct sessions hold matching barriers (false on budget expiry). */
    async waitHolds(match, count, timeoutMs = timing.phaseMs) {
      const distinct = () => new Set(provider.events().filter((event) => event.type === "hold" && match(event)).map((event) => event.sessionID)).size;
      checkpoint();
      try {
        await provider.waitFor(() => distinct() >= count, { timeoutMs: bound(timeoutMs), signal });
        return true;
      } catch (error) {
        if (error?.code === "EPROVIDERWAIT") return false;
        throw error;
      }
    },
    async waitProvider(predicate, timeoutMs = timing.phaseMs) {
      checkpoint();
      try {
        return await provider.waitFor(predicate, { timeoutMs: bound(timeoutMs), signal });
      } catch (error) {
        if (error?.code === "EPROVIDERWAIT") return null;
        throw error;
      }
    },
    async waitEvent(predicate, timeoutMs = timing.phaseMs) {
      checkpoint();
      try {
        return await events.waitFor(predicate, { timeoutMs: bound(timeoutMs), signal });
      } catch (error) {
        if (signal?.aborted) throw aborted();
        if (error?.code === "EEVENTWAIT" || /timed out/.test(String(error?.message))) return null;
        throw error;
      }
    },
    /**
     * Radagast M9 (V1): halt publishes idle BEFORE the cleanup writes, so a durable read right
     * after idle / error can be early. Re-read (bounded by the phase budget and the cell
     * deadline) until the last assistant message has time.completed and every tool part is
     * terminal. Returns the last read; unsettled sessions are recorded in marks.v1Unsettled.
     */
    async v1SettledMessages(sessionID) {
      const until = Date.now() + bound(timing.phaseMs);
      for (;;) {
        const messages = await v1Messages(client, host, project, sessionID);
        const { completed } = lastAssistant(messages);
        const open = host.toolEntriesFromMessages(messages).some((entry) => entry.status !== "completed" && entry.status !== "error");
        if (completed !== null && !open) return messages;
        if (Date.now() >= until) {
          (marks.v1Unsettled ??= []).push(sessionID);
          return messages;
        }
        await sleep(timing.pollMs);
      }
    },
    precondition(name, met, detail) {
      preconditions[name] = { met: Boolean(met), detail: met ? "" : detail };
      return Boolean(met);
    },
    release(target, barriers) {
      for (const barrier of barriers) provider.release(barrier);
      record({ kind: "release", target, ok: true, barriers: barriers.length });
    },
    /** Parent-only cancel (V1 abort / V2 interrupt?resume=false); never a child. */
    async cancel(sessionID) {
      const route = host.routes.cancel({ sessionID, directory: project });
      const response = await client.request({ ...route, operation: "cancel" });
      const ok = ok2xx(response) && (family === "v1" ? response.json === true : !isRecord(response.json) || response.json.interrupted !== false);
      return record({ kind: "cancel", target: sessionID, ok, status: response.status });
    },
    async reply(sessionID, requestID, decision) {
      const route = host.routes.reply({ sessionID, requestID, decision, directory: project });
      const response = await client.request({ ...route, operation: "permission reply" });
      const ok = family === "v1" ? response.status === 200 && response.json === true : response.status === 204;
      return record({ kind: "reply", target: sessionID, ok, status: response.status, decision });
    },
    async instanceAction(kind) {
      const route = kind === "reload" ? host.routes.reload() : host.routes.dispose(project);
      const response = await client.request({ ...route, operation: kind });
      return record({ kind, target: null, ok: ok2xx(response), status: response.status });
    },
    /** Every listed child of `parentID` (strict shape; ECHILDREN otherwise). */
    async listChildren(parentID) {
      const route = host.routes.children({ sessionID: parentID, directory: project });
      const response = await client.request({ ...route, operation: "children" });
      const listed = host.childrenFrom(response);
      if (!listed) throw httpFailure("ECHILDREN", "children", route, response);
      return listed;
    },
    /** Durable council_review calls of a parent, classified. */
    async parentCalls(sessionID) {
      if (family === "v2") {
        const read = await v2Messages(client, host, sessionID, "parent messages");
        if (read.exceeded) throw new HarnessError("EMESSAGES", `parent messages for ${sessionID} exceeded the page bound`);
        return host.toolEntriesFromMessages(read.messages).filter((entry) => entry.name === "council_review").map(classify);
      }
      return host.toolEntriesFromMessages(await kit.v1SettledMessages(sessionID)).filter((entry) => entry.name === "council_review").map(classify);
    },
    /**
     * Children of each parent with identity (V2 session get; V1 last assistant info), every
     * child's classified tool calls, and (V1) persisted completion + error name.
     */
    async collectChildren(parentIDs) {
      const children = [];
      const childTools = {};
      const persistedCompleted = {};
      const persistedErrors = {};
      for (const parentID of parentIDs) {
        for (const listed of await kit.listChildren(parentID)) {
          if (family === "v2") {
            const { rawModel, ...identity } = await v2ChildIdentity(client, host, listed);
            children.push(identity);
            const read = await v2Messages(client, host, listed.id, "child messages");
            childTools[listed.id] = host.toolEntriesFromMessages(read.messages).map(classify);
          } else {
            const messages = await kit.v1SettledMessages(listed.id);
            const { info, completed } = lastAssistant(messages);
            children.push({ id: listed.id, parentID: listed.parentID ?? null, agent: typeof info.agent === "string" ? info.agent : null, model: { providerID: typeof info.providerID === "string" ? info.providerID : null, modelID: typeof info.modelID === "string" ? info.modelID : null } });
            childTools[listed.id] = host.toolEntriesFromMessages(messages).map(classify);
            persistedCompleted[listed.id] = completed;
            persistedErrors[listed.id] = isRecord(info.error) && typeof info.error.name === "string" ? info.error.name.slice(0, 64) : null;
          }
        }
      }
      return { children, childTools, ...(family === "v1" ? { persistedCompleted, persistedErrors } : {}) };
    },
    /** V1: persisted completion of a harness session's last assistant message. */
    async persisted(sessionID) {
      const { info, completed } = lastAssistant(await kit.v1SettledMessages(sessionID));
      return { completed, errorName: isRecord(info.error) && typeof info.error.name === "string" ? info.error.name.slice(0, 64) : null };
    },
    /** The standard evidence snapshot (events + ledger + bookkeeping), merged with scenario fields. */
    snapshot(fields) {
      const all = events.all();
      const finals = {};
      const sessionErrors = {};
      for (const event of all) {
        if (family === "v2" && event.kind === "session-final" && event.sessionID) finals[event.sessionID] = event.outcome;
        if (family === "v1" && event.kind === "session-idle" && event.sessionID) finals[event.sessionID] = "idle";
        if (event.kind === "session-error" && event.sessionID) (sessionErrors[event.sessionID] ??= []).push(event.errorName ?? null);
      }
      const hostNonces = {};
      for (const event of all) if (event.kind === "nonce-seen" && !hostNonces[event.nonce]) hostNonces[event.nonce] = { seen: true, type: event.type ?? null };
      const parentSessionID = roles.parent ?? roles.parentA ?? null;
      return {
        scenario: ctx.scenario,
        family,
        expected: fx.expected,
        parentSessionID,
        roles: { ...roles },
        created: all.filter((event) => event.kind === "session-created" && !Object.values(roles).includes(event.sessionID)).map((event) => ({ sessionID: event.sessionID, parentID: event.parentID })),
        ledger: provider.ledger(),
        finals,
        ...(family === "v1" ? { sessionErrors } : {}),
        permissionEvents: { asked: all.filter((event) => event.kind === "permission-asked").map(permissionEvent), replied: all.filter((event) => event.kind === "permission-replied").map(permissionEvent) },
        actions: [...actions],
        hostNonces,
        preconditions: { ...preconditions },
        marks: { ...marks },
        children: [],
        parentTools: {},
        childTools: {},
        ...fields,
        observations: { ...(fields?.observations ?? {}), "sse.events": typeof events.diagnostics === "function" ? events.diagnostics() : null },
      };
    },
  };
  return kit;
}

const MODEL = (name) => (event) => event.model === name;

/** Single-council collection after the parent settled: children + classified calls + parent result. */
async function collectCouncil(kit, parentIDs, extra = {}) {
  const collected = await kit.collectChildren(parentIDs);
  const parentTools = {};
  for (const id of parentIDs) parentTools[id] = await kit.parentCalls(id);
  return kit.snapshot({ ...collected, parentTools, ...extra });
}

/** Precondition failed: open every barrier (nothing stays held), stop triggering, return what is known. */
function abandon(ctx, kit) {
  ctx.provider.releaseAll?.();
  return kit.snapshot({});
}

// ---------------------------------------------------------------------------
// Drivers.

/** S3: hold A, B, C, O -> release A, O -> advisory checkpoint (no aggregator yet) -> release B -> quorum. */
async function driveS3(ctx) {
  const kit = createDriveKit(ctx);
  const x = ctx.fx.expected;
  const P = await kit.createSession("parent");
  await kit.prompt(P, x.token);
  const barriers = Object.values(x.barrier);
  if (!kit.precondition("allHeld", await kit.waitHolds((event) => barriers.includes(event.barrier), 4), "A, B, C and O were not all held by the provider within the phase budget")) return abandon(ctx, kit);
  const holdOf = (key) => ctx.provider.events().find((event) => event.type === "hold" && event.barrier === x.barrier[key]);
  kit.release("A,O", [x.barrier.a, x.barrier.o]);
  // Advisory checkpoint: A and O responded and their child executions settled.
  for (const key of ["a", "o"]) {
    await kit.waitProvider((event) => event.type === "responded" && event.sessionID === holdOf(key)?.sessionID);
    await kit.waitEvent(kit.isFinal(holdOf(key)?.sessionID));
  }
  const aggregatorAtCheckpoint = ctx.provider.ledger().filter((entry) => entry.model === x.aggregator.modelID).length;
  // ADVISORY observation only (plan: "advisory checkpoint: no aggregator"); it is not a claim.
  kit.marks.checkpoint = { advisory: true, aggregatorRequests: aggregatorAtCheckpoint, observation: aggregatorAtCheckpoint === 0 ? "aggregator-not-yet-requested-at-checkpoint" : "aggregator-already-requested-at-checkpoint" };
  // The mutation claim ("aggregation waited for B") stays conditional on host processing order.
  kit.marks.mutationClaim = "conditional-on-processing-order";
  kit.release("B", [x.barrier.b]);
  await kit.awaitFinal(P);
  // The laggard (C) is stopped by the plugin's sweep: wait for the host to drop its held request.
  await kit.waitProvider((event) => event.type === "disconnected" && event.barrier === x.barrier.c);
  return collectCouncil(kit, [P]);
}

/** S4: 500 / empty / partial (P shown by the host BEFORE the fault) / two successes. */
async function driveS4(ctx) {
  const kit = createDriveKit(ctx);
  const x = ctx.fx.expected;
  ctx.events.watchNonces?.([x.partial]);
  const P = await kit.createSession("parent");
  await kit.prompt(P, x.token);
  const partial = await kit.waitProvider((event) => event.type === "partial-written" && event.model === "reviewer-3");
  const seen = partial ? await kit.waitEvent((event) => event.kind === "nonce-seen" && event.nonce === x.partial, Math.min(S4_PARTIAL_OBSERVE_MS, ctx.timing.phaseMs)) : null;
  kit.marks.partialReleasedAfterSeen = seen !== null;
  // Release the fault either way (the precondition records whether P was host-visible first).
  kit.release("reviewer-3", [x.partialBarrier]);
  if (!kit.precondition("partialSeen", seen !== null, partial ? `partial nonce ${x.partial} not observed in host events before the stream fault` : "the partial chunk was never written")) return abandon(ctx, kit);
  await kit.awaitFinal(P);
  const evidence = await collectCouncil(kit, [P]);
  // Per failing reviewer (r1: 500, r3: partial-then-error): retries / continuations / duration.
  const stats = {};
  for (const model of ["reviewer-1", "reviewer-3"]) {
    const children = evidence.children.filter((child) => child.parentID === P && child.model?.modelID === model);
    stats[model] = children.length === 1 ? retryStats(evidence.ledger, children[0].id) : { requests: 0, retries: 0, continuations: 0, retryDurationMs: 0 };
  }
  evidence.observations["s4.retries"] = stats;
  return evidence;
}

/** S5: reviewer-c held after its request -> councillor timeout -> the plugin stops it. */
async function driveS5(ctx) {
  const kit = createDriveKit(ctx);
  const x = ctx.fx.expected;
  const P = await kit.createSession("parent");
  const started = Date.now();
  await kit.prompt(P, x.token);
  // Wait within the (generous) phase budget; the PRECONDITION is that the hold came before the councillor timeout.
  const held = await kit.waitHolds(MODEL(x.target), 1);
  const elapsed = Date.now() - started;
  if (!kit.precondition("targetHeld", held && elapsed < x.timeouts.councillor_ms, held ? `hold observed after ${elapsed} ms (councillor timeout ${x.timeouts.councillor_ms} ms)` : "the target councillor was never held before its timeout")) return abandon(ctx, kit);
  await kit.waitProvider((event) => event.type === "disconnected" && event.barrier === x.barrier);
  await kit.awaitFinal(P);
  return collectCouncil(kit, [P]);
}

/** S6: aggregator held after its request -> aggregator timeout -> the plugin stops it. */
async function driveS6(ctx) {
  const kit = createDriveKit(ctx);
  const x = ctx.fx.expected;
  const P = await kit.createSession("parent");
  await kit.prompt(P, x.token);
  const hold = await kit.waitProvider((event) => event.type === "hold" && event.model === x.target);
  const lastReviewer = ctx.provider.events().filter((event) => event.type === "responded" && event.model !== "parent" && event.model !== x.target).at(-1);
  const gap = hold && lastReviewer ? hold.at - lastReviewer.at : null;
  if (!kit.precondition("targetHeld", hold !== null && gap !== null && gap < x.timeouts.aggregator_ms, hold ? `aggregator hold ${gap} ms after the last reviewer response (aggregator timeout ${x.timeouts.aggregator_ms} ms)` : "the aggregator was never held")) return abandon(ctx, kit);
  await kit.waitProvider((event) => event.type === "disconnected" && event.barrier === x.barrier);
  await kit.awaitFinal(P);
  return collectCouncil(kit, [P]);
}

/** S7: all reviewers held -> the harness cancels the PARENT only. */
async function driveS7(ctx) {
  const kit = createDriveKit(ctx);
  const x = ctx.fx.expected;
  const P = await kit.createSession("parent");
  await kit.prompt(P, x.token);
  if (!kit.precondition("allHeld", await kit.waitHolds((event) => x.barriers.includes(event.barrier), 3), "the 3 reviewers were not all held")) return abandon(ctx, kit);
  await kit.cancel(P);
  await kit.waitEvent(kit.isFinal(P));
  for (const barrier of x.barriers) await kit.waitProvider((event) => event.type === "disconnected" && event.barrier === barrier);
  return collectCouncil(kit, [P]);
}

/** S8: unrelated control would-ask, then a council whose children hit ask / deny / parent-only deny. */
async function driveS8(ctx) {
  const kit = createDriveKit(ctx);
  const x = ctx.fx.expected;
  const U = await kit.createSession("control");
  await kit.prompt(U, x.controlToken);
  const asked = await kit.waitEvent((event) => event.kind === "permission-asked" && event.sessionID === U);
  if (asked) {
    await kit.reply(U, asked.requestID, "reject");
    await kit.waitEvent(kit.isFinal(U));
  }
  const P = await kit.createSession("parent", { permissions: ctx.fx.sessionPermissions });
  let parentSession;
  if (ctx.family === "v2") {
    const response = await kit.client.request({ ...ctx.host.routes.session({ sessionID: P }), operation: "parent session get" });
    const data = ctx.host.sessionFrom(response);
    parentSession = { read: data !== null, permissions: data && Array.isArray(data.permissions) ? data.permissions : null };
  }
  await kit.prompt(P, x.token);
  await kit.awaitFinal(P);
  const pluginLog = ctx.family === "v1" ? await readStripWarnings(ctx, kit, x.stripWarning) : undefined;
  return collectCouncil(kit, [P], { ...(parentSession ? { parentSession } : {}), ...(pluginLog ? { pluginLog } : {}) });
}

/**
 * V1 plugin log ($XDG_DATA_HOME/opencode/log/opencode.log, Radagast M6): bounded poll (phase
 * budget and cell deadline) until the exact strip warning appears; the file logger's flush
 * interval is UNVERIFIED (v1.pluginLogFlush). Records only the count and the number of polls.
 */
async function readStripWarnings(ctx, kit, warning) {
  if (typeof ctx.readPluginLog !== "function") return { read: false, stripWarnings: 0, polls: 0 };
  const until = Date.now() + kit.bound(ctx.timing.phaseMs);
  let polls = 0;
  let read = false;
  for (;;) {
    polls += 1;
    try {
      const text = String(await ctx.readPluginLog());
      read = true;
      const stripWarnings = text.split(warning).length - 1;
      if (stripWarnings >= 1) return { read, stripWarnings, polls };
    } catch {
      // unreadable this time; keep polling within the bound
    }
    if (Date.now() >= until) return { read, stripWarnings: 0, polls };
    await kit.sleep(ctx.timing.pollMs);
  }
}

/** S9: a reviewer child calls council_review: host refusal + zero descendants. */
async function driveS9(ctx) {
  const kit = createDriveKit(ctx);
  const P = await kit.createSession("parent");
  await kit.prompt(P, ctx.fx.expected.token);
  await kit.awaitFinal(P);
  const collected = await kit.collectChildren([P]);
  const grandchildren = {};
  for (const child of collected.children) grandchildren[child.id] = (await kit.listChildren(child.id)).length;
  return kit.snapshot({ ...collected, parentTools: { [P]: await kit.parentCalls(P) }, grandchildren });
}

/** S10 / S11 / obs-ask: one council, observe after the parent settles. */
async function driveSingle(ctx, kit = createDriveKit(ctx)) {
  const P = await kit.createSession("parent");
  await kit.prompt(P, ctx.fx.expected.token);
  await kit.awaitFinal(P);
  return collectCouncil(kit, [P]);
}

/**
 * S11 (Radagast M3): V1 matches read rules relative to instance.worktree. Ask the host
 * (UNVERIFIED route v1.projectCurrentRoute); if the worktree is known and is not the project,
 * re-render the agent file against it, dispose the instance (agents are re-read on the next
 * request) and re-subscribe -- all before any session exists. Unknown -> the project-relative
 * rule stands and the observation says so. V2 matches relative to location.directory (= project).
 */
async function driveS11(ctx) {
  const kit = createDriveKit(ctx);
  if (ctx.family === "v1") {
    const x = ctx.fx.expected;
    const response = await kit.client.request({ ...ctx.host.routes.projectCurrent(ctx.project), operation: "project current" });
    const worktree = response.status === 200 && isRecord(response.json) && typeof response.json.worktree === "string" ? response.json.worktree : null;
    const observation = { status: response.status, known: worktree !== null, equalsProject: worktree === null ? null : posix.resolve(worktree) === posix.resolve(ctx.project), rewritten: false, pattern: x.denyPattern };
    if (worktree !== null && !observation.equalsProject) {
      observation.pattern = posix.relative(worktree, x.denyPath).split("\\").join("/");
      await ctx.rewriteProjectFile(ctx.fx.renderAgent(observation.pattern));
      // Re-audit round 2 (Should a): as S13 -- the dispose must succeed AND the host must report
      // server.instance.disposed (bounded by the phase budget and the cell deadline) before the
      // stream is re-opened or any session exists; otherwise the agent reload is unproven
      // (INVALID-FIXTURE) and nothing is triggered.
      const disposeMark = kit.mark();
      const disposed = kit.waitEvent((event) => event.kind === "instance-disposed" && ctx.events.all().indexOf(event) >= disposeMark);
      const action = await kit.instanceAction("dispose");
      const event = action.ok ? await disposed : null;
      observation.rewritten = true;
      kit.marks.worktree = observation;
      if (!kit.precondition("agentReloaded", action.ok && event !== null, action.ok ? "server.instance.disposed not observed after the agent re-render" : `instance dispose -> ${action.status}`)) return abandon(ctx, kit);
      await ctx.events.subscribe();
    }
    kit.marks.worktree = observation;
  }
  return driveSingle(ctx, kit);
}

async function driveObsAsk(ctx) {
  const evidence = await driveSingle(ctx);
  const councilIDs = new Set(evidence.children.map((child) => child.id));
  const childAsks = evidence.permissionEvents.asked.filter((event) => councilIDs.has(event.sessionID));
  evidence.marks.observation = { childAsks: childAsks.length, askedPermissions: [...new Set(childAsks.map((event) => event.permission))], parentFinal: evidence.finals[evidence.parentSessionID] ?? null };
  return evidence;
}

/** S12: councils A, B + unrelated U (real ask); cancel A while B is held; B completes; U waits for the harness reply. */
async function driveS12(ctx) {
  const kit = createDriveKit(ctx);
  const x = ctx.fx.expected;
  const A = await kit.createSession("parentA");
  const B = await kit.createSession("parentB");
  const U = await kit.createSession("control");
  kit.roles.parent = A;
  await kit.prompt(A, x.tokens.a);
  await kit.prompt(B, x.tokens.b);
  await kit.prompt(U, x.tokens.u);
  const held = await kit.waitHolds((event) => x.barriers.a.includes(event.barrier) || x.barriers.b.includes(event.barrier), 6);
  const asked = await kit.waitEvent((event) => event.kind === "permission-asked" && event.sessionID === U);
  if (!kit.precondition("ready", held && asked !== null, `holds ${held}; unrelated ask ${asked !== null}`)) return abandon(ctx, kit);
  await kit.cancel(A);
  await kit.waitEvent(kit.isFinal(A));
  for (const barrier of x.barriers.a) await kit.waitProvider((event) => event.type === "disconnected" && event.barrier === barrier);
  const aFinalAt = ctx.events.all().findIndex(kit.isFinal(A));
  kit.marks.aFinalBeforeBRelease = aFinalAt !== -1 && aFinalAt < kit.mark();
  kit.release("B", x.barriers.b);
  await kit.awaitFinal(B);
  const all = () => ctx.events.all();
  kit.marks.uRepliedBeforeHarness = all().some((event) => event.kind === "permission-replied" && event.sessionID === U);
  kit.marks.uFinalBeforeReply = all().some(kit.isFinal(U));
  kit.marks.uRequestsBeforeReply = ctx.provider.ledger().filter((entry) => entry.sessionID === U).length;
  kit.marks.uReplyAfterBFinal = all().some(kit.isFinal(B));
  await kit.reply(U, asked.requestID, "once");
  await kit.waitEvent(kit.isFinal(U));
  // U continues: its next provider request carries the command output.
  await kit.waitProvider((event) => event.type === "responded" && event.sessionID === U && ctx.provider.ledger().filter((entry) => entry.sessionID === U).length >= 2);
  const collected = await kit.collectChildren([A, B]);
  return kit.snapshot({ ...collected, parentTools: { [A]: await kit.parentCalls(A), [B]: await kit.parentCalls(B) } });
}

/** Inventory entry of our plugin: { active, count, stateKeys } (key names only; activation evidence, not generation evidence). */
function inventoryEntry(response, spec) {
  const list = response.status === 200 && isRecord(response.json) && Array.isArray(response.json.data) ? response.json.data : null;
  const ours = list ? list.filter((entry) => entry?.source?.target === spec) : [];
  if (ours.length !== 1) return { active: false, count: ours.length, stateKeys: [] };
  const state = isRecord(ours[0].state) ? ours[0].state : {};
  return { active: state.status === "active", count: 1, stateKeys: Object.keys(state).sort().slice(0, 16) };
}

/** S13 V2: reload with the review in flight -> activation -> release -> the original call completes; fresh review after. */
async function driveS13v2(ctx, kit) {
  const x = ctx.fx.expected;
  const inventory = async () => inventoryEntry(await kit.client.request({ ...ctx.host.routes.plugins(ctx.project), operation: "plugin inventory" }), ctx.fx.spec);
  const P = await kit.createSession("parent");
  await kit.prompt(P, x.token);
  if (!kit.precondition("allHeld", await kit.waitHolds((event) => x.barriers.includes(event.barrier), 3), "the 3 reviewers were not all held")) return abandon(ctx, kit);
  const before = await inventory();
  // Radagast M7/M8: arm the plugin.updated wait BEFORE issuing the reload; await it (bounded) after.
  const updatedBefore = ctx.events.all().filter((event) => event.kind === "plugin-updated").length;
  const updated = kit.waitEvent(() => ctx.events.all().filter((event) => event.kind === "plugin-updated").length > updatedBefore);
  await kit.instanceAction("reload");
  // 204 is not activation: poll the inventory until our plugin is active again (bounded).
  let after = await inventory();
  const deadline = Date.now() + kit.bound(ctx.timing.phaseMs);
  while (!after.active && Date.now() < deadline && !ctx.signal?.aborted) {
    await kit.sleep(ctx.timing.pollMs);
    after = await inventory();
  }
  await updated;
  kit.marks.pluginUpdatedAfterReload = ctx.events.all().filter((event) => event.kind === "plugin-updated").length - updatedBefore;
  kit.release("original", x.barriers);
  await kit.awaitFinal(P);
  const F = await kit.createSession("fresh");
  await kit.prompt(F, x.freshToken);
  await kit.awaitFinal(F);
  const collected = await kit.collectChildren([P, F]);
  return kit.snapshot({ ...collected, parentTools: { [P]: await kit.parentCalls(P), [F]: await kit.parentCalls(F) }, inventory: { before, after } });
}

/** S13 V1: dispose the instance with the review in flight (teardown) -> two-form parent terminal; fresh review after re-subscribing. */
async function driveS13v1(ctx, kit) {
  const x = ctx.fx.expected;
  const P = await kit.createSession("parent");
  await kit.prompt(P, x.token);
  if (!kit.precondition("allHeld", await kit.waitHolds((event) => x.barriers.includes(event.barrier), 3), "the 3 reviewers were not all held")) return abandon(ctx, kit);
  const disposeMark = kit.mark();
  await kit.instanceAction("dispose");
  const disposed = await kit.waitEvent((event, index) => event.kind === "instance-disposed");
  kit.marks.disposedEvent = disposed !== null && ctx.events.all().findIndex((event) => event.kind === "instance-disposed") >= disposeMark;
  kit.marks.teardown = kit.marks.disposedEvent ? "instance-dispose" : null;
  for (const barrier of x.barriers) await kit.waitProvider((event) => event.type === "disconnected" && event.barrier === barrier);
  // Radagast M10: the terminal SSE may not survive the dispose. Re-connect (the instance
  // re-bootstraps on the next request) and settle the old sessions via DURABLE reads (M9 wait).
  await ctx.events.subscribe();
  const parentCalls = await kit.parentCalls(P);
  const F = await kit.createSession("fresh");
  await kit.prompt(F, x.freshToken);
  await kit.awaitFinal(F);
  const collected = await kit.collectChildren([P, F]);
  return kit.snapshot({ ...collected, parentTools: { [P]: parentCalls, [F]: await kit.parentCalls(F) } });
}

const DRIVERS = {
  s3: driveS3,
  s4: driveS4,
  s5: driveS5,
  s6: driveS6,
  s7: driveS7,
  s8: driveS8,
  s9: driveS9,
  s10: driveSingle,
  s11: driveS11,
  s12: driveS12,
  s13: (ctx) => (ctx.family === "v2" ? driveS13v2(ctx, createDriveKit(ctx)) : driveS13v1(ctx, createDriveKit(ctx))),
  "obs-ask": driveObsAsk,
};

export async function drive(ctx) {
  const driver = DRIVERS[ctx.scenario];
  if (!driver) throw new Error(`no driver for scenario ${ctx.scenario}`);
  return driver(ctx);
}
