/**
 * OpenCode V2 host adapter: `setup(ctx)` for the V2 Promise plugin host.
 *
 * Host API types come from the structural contract in `./v2-contract.ts`; this
 * module never imports `@opencode/plugin` (or `effect`) at runtime or in its
 * emitted declarations.
 *
 * - Bundled agents are upserted inside `ctx.agent.transform` (the callback
 *   replays on every host reload).
 * - `council_review` is registered via `ctx.tool.transform` with a JSON-Schema
 *   input and `options.codemode: false` (D7), and runs the host-agnostic core.
 * - Child sessions: create({parentID, title, agent, model?, permissions}) ->
 *   prompt -> wait -> context; stop = interrupt({resume:false}) + wait, bounded.
 * - Child permissions follow D8 option C (`./v2-permissions.ts`); a
 *   `permission.hook("evaluate")` turns still-ask decisions for council-owned
 *   children into deny.
 * - Logging: console.error with a `[council-plugin]` prefix, plus the debug-only
 *   file log (`./debug-file.ts`) (D6).
 */
import { homedir } from "node:os";

import {
  composeCouncilConfig,
  councilOptions,
  hasUserSpecifiedAgent,
  REVIEWER_TEMPERATURE_IGNORED_WARNING,
} from "./config.js";
import { createDebugFile, type DebugFile, toDebugRecord } from "./debug-file.js";
import type { CouncilHost, StopResult } from "./host.js";
import { errorMessage, type Logger } from "./logging.js";
import { executeCouncilReview } from "./orchestrator.js";
import { createChildRegistry, withChildOwnership } from "./ownership.js";
import {
  AGGREGATOR_PERMISSION,
  AGGREGATOR_PROMPT,
  BUNDLED_AGGREGATOR_DESCRIPTION,
  BUNDLED_REVIEWER_DESCRIPTION,
  COUNCIL_REVIEW_DESCRIPTION,
  COUNCIL_REVIEW_PROMPT_ARG_DESCRIPTION,
  REVIEWER_PERMISSION,
  REVIEWER_PROMPT,
} from "./prompts.js";
import {
  BUNDLED_AGGREGATOR_AGENT,
  BUNDLED_REVIEWER_AGENT,
  isPlainObject,
  type ModelConfig,
} from "./types.js";
import type {
  V2AgentDraft,
  V2ContextAssistantMessage,
  V2ContextIdleMessage,
  V2ContextTextPart,
  V2Cleanup,
  V2ModelRef,
  V2PermissionRule,
  V2Registration,
  V2SetupContext,
} from "./v2-contract.js";
import {
  composeV2ChildPermissions,
  parentDenyRules,
  translatePermissionOverride,
} from "./v2-permissions.js";

/** Per-child stop budget (interrupt admission + wait) when no sweep deadline is given. */
export const V2_STOP_BUDGET_MS = 5_000;

export const COUNCIL_SHUTTING_DOWN =
  "Error: council_review is unavailable: the council plugin is shutting down.";

export const V2_ASK_DENIED_MESSAGE =
  "Council review sessions cannot request interactive approval; this action is unavailable in council sessions.";

class StopDeadlineError extends Error {
  constructor(step: string) {
    super(`child stop ${step} did not settle before the deadline`);
    this.name = "StopDeadlineError";
  }
}

function beforeDeadline<T>(operation: Promise<T>, deadline: number, step: string): Promise<T> {
  // A late settlement after the deadline must not surface as an unhandled rejection.
  operation.catch(() => {});
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new StopDeadlineError(step));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StopDeadlineError(step)), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isIdleMessage(value: unknown): value is V2ContextIdleMessage {
  return isPlainObject(value) && value.type === "idle";
}

function isAssistantMessage(value: unknown): value is V2ContextAssistantMessage {
  return isPlainObject(value) && value.type === "assistant";
}

function isTextPart(value: unknown): value is V2ContextTextPart {
  return isPlainObject(value) && value.type === "text" && typeof value.text === "string";
}

/**
 * Detect a council child's final text from its V2 session context.
 *
 * Fresh-child / one-prompt invariant: every council child is a freshly created
 * session prompted exactly once, so its context holds exactly one run. The LAST
 * `idle` entry (array order) is that run's terminal marker and the LAST
 * `assistant` entry (array order, no timestamp sort) is its final answer. There
 * is deliberately no backtracking to earlier assistant messages.
 */
export function extractV2ChildText(messages: unknown): string {
  if (!Array.isArray(messages)) throw new Error("invalid session context");

  // The guards only check the discriminant; every field read below is still
  // re-checked at runtime because host data is untrusted.
  let idle: V2ContextIdleMessage | undefined;
  let assistant: V2ContextAssistantMessage | undefined;
  for (const message of messages) {
    if (isIdleMessage(message)) idle = message;
    else if (isAssistantMessage(message)) assistant = message;
  }

  if (!idle) throw new Error("child session did not settle (no idle marker)");
  const outcome: unknown = idle.outcome;
  if (outcome !== "succeeded") {
    const label = typeof outcome === "string" ? outcome : "ended without outcome";
    const detail = idle.error === undefined ? "" : `: ${errorMessage(idle.error)}`;
    throw new Error(`child session ${label}${detail}`);
  }
  if (!assistant) throw new Error("empty response");
  if (assistant.error !== undefined && assistant.error !== null) {
    throw new Error(`assistant error: ${errorMessage(assistant.error)}`);
  }

  const content: unknown = assistant.content;
  const text = (Array.isArray(content) ? content : [])
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("empty response");
  return text;
}

function toModelRef(model: ModelConfig): V2ModelRef {
  return { providerID: model.providerID, id: model.modelID };
}

function runtimeModelRef(value: unknown): V2ModelRef | undefined {
  return isPlainObject(value) &&
    typeof value.providerID === "string" &&
    value.providerID.length > 0 &&
    typeof value.id === "string" &&
    value.id.length > 0
    ? { providerID: value.providerID, id: value.id }
    : undefined;
}

export type V2CouncilHost = CouncilHost & {
  /** Children with live stop state (created and not yet confirmed stopped). */
  readonly trackedChildren: number;
  /** Forget all stop state and memoized stops (plugin cleanup). */
  resetStops(): void;
};

type V2ChildState = {
  stopRequested: boolean;
  /** Pending `session.prompt` admission, while one is outstanding. */
  admission?: Promise<unknown>;
};

const noop = () => {};

export function createV2Host(
  ctx: V2SetupContext,
  deps: { log: Logger; home: string },
): V2CouncilHost {
  const { log, home } = deps;
  const children = new Map<string, V2ChildState>();
  const stops = new Map<string, Promise<StopResult>>();

  /** D3: configured model -> the selected agent's runtime model -> omit (host default). */
  async function agentModel(agentID: string): Promise<V2ModelRef | undefined> {
    try {
      const agent = await ctx.agent.get({ agentID });
      return runtimeModelRef(agent?.data?.model);
    } catch (error) {
      log("debug", "agent model lookup failed", { error: errorMessage(error) });
      return undefined;
    }
  }

  return {
    log,

    get trackedChildren() {
      return children.size;
    },

    resetStops() {
      children.clear();
      stops.clear();
    },

    async prepareReview(input) {
      let parent: Awaited<ReturnType<V2SetupContext["session"]["get"]>>;
      try {
        parent = await ctx.session.get({ sessionID: input.parentSessionID });
      } catch (error) {
        // Fail closed: without the parent's deny rules a child could be broader than its parent.
        throw new Error(`failed to read parent session permissions: ${errorMessage(error)}`);
      }
      // Throws (review fails closed, no children) on malformed parent permissions.
      const parentRules = parentDenyRules(parent?.permissions);
      input.log("debug", "council child permissions prepared", { count: parentRules.length });
      return {
        // V2 children inherit the parent location through parentID.
        directory: "",
        ...composeV2ChildPermissions({
          parentRules,
          councilConfig: input.councilConfig,
          home,
        }),
      };
    },

    async createChild(input) {
      const model = input.model
        ? toModelRef(input.model)
        : input.agent
          ? await agentModel(input.agent)
          : undefined;
      let created: Awaited<ReturnType<V2SetupContext["session"]["create"]>>;
      try {
        created = await ctx.session.create({
          parentID: input.parentID,
          title: input.title,
          ...(input.agent ? { agent: input.agent } : {}),
          ...(model ? { model } : {}),
          permissions: (input.permission ?? []) as ReadonlyArray<V2PermissionRule>,
        });
      } catch (error) {
        throw new Error(`failed to create child session: ${errorMessage(error)}`);
      }
      const sessionID = created?.id;
      if (typeof sessionID !== "string" || sessionID.length === 0) {
        throw new Error("failed to create child session: missing session id");
      }
      if (!children.has(sessionID)) children.set(sessionID, { stopRequested: false });
      return sessionID;
    },

    async runChild(input) {
      const sessionID = input.sessionID;
      const state = children.get(sessionID);
      if (!state || state.stopRequested) throw new Error("child stop requested before prompt");

      // Upstream `Session.prompt` resolves only after preparation (incl. prompt
      // hooks) and admission, and admission wakes execution. A stop must wait for
      // this admission before interrupting, or a late admission would start an
      // execution on a child already reported stopped (see stopChild).
      const admission = ctx.session.prompt({ sessionID, text: input.prompt });
      state.admission = admission;
      try {
        await admission;
      } catch (error) {
        throw new Error(`prompt failed: ${errorMessage(error)}`);
      } finally {
        state.admission = undefined;
      }
      if (state.stopRequested) throw new Error("child stop requested");

      try {
        await ctx.session.wait({ sessionID });
      } catch (error) {
        throw new Error(`wait failed: ${errorMessage(error)}`);
      }
      if (state.stopRequested) throw new Error("child stop requested");
      let messages: unknown;
      try {
        messages = await ctx.session.context({ sessionID });
      } catch (error) {
        throw new Error(`failed to get context: ${errorMessage(error)}`);
      }
      return extractV2ChildText(messages);
    },

    // Stop = mark stop-requested -> let any pending prompt admission settle ->
    // interrupt({resume:false}) -> wait, all before ONE absolute deadline.
    // Confirmed (`ok: true`) only if every step completes in time; then the
    // child's stop state and memo are forgotten. Unconfirmed stops stay memoized
    // so duplicates share one attempt (no retry) until plugin cleanup.
    stopChild(sessionID, options) {
      const existing = stops.get(sessionID);
      if (existing) return existing;
      let state = children.get(sessionID);
      if (!state) {
        state = { stopRequested: true };
        children.set(sessionID, state);
      }
      state.stopRequested = true;
      const admission = state.admission;
      const deadline = options?.deadline ?? Date.now() + V2_STOP_BUDGET_MS;
      const stop = (async (): Promise<StopResult> => {
        try {
          if (admission) {
            await beforeDeadline(admission.then(noop, noop), deadline, "prompt admission");
          }
          await beforeDeadline(
            ctx.session.interrupt({ sessionID, resume: false }),
            deadline,
            "interrupt",
          );
          await beforeDeadline(ctx.session.wait({ sessionID }), deadline, "wait");
          stops.delete(sessionID);
          children.delete(sessionID);
          return { ok: true };
        } catch (error) {
          log("debug", "council child stop unconfirmed", { sessionID, error: errorMessage(error) });
          return { ok: false, error };
        }
      })();
      stops.set(sessionID, stop);
      return stop;
    },
  };
}

/**
 * V2 logger: console.error with the `[council-plugin]` prefix, the (fixed)
 * message, and only the allowlisted debug-record metadata (model, sessionID,
 * role, durationMs, count, error {kind, class}) — never error message text or
 * arbitrary extras. The debug file receives the same allowlisted record.
 */
export function createV2Logger(debugEnabled: boolean, debugFile?: DebugFile): Logger {
  return (level, message, extra) => {
    if (level === "debug" && !debugEnabled) return;
    try {
      const { ts: _ts, level: _level, event: _event, ...metadata } = toDebugRecord(
        level,
        message,
        extra,
      );
      const suffix = Object.keys(metadata).length > 0 ? ` ${JSON.stringify(metadata)}` : "";
      console.error(`[council-plugin] ${level}: ${message}${suffix}`);
    } catch {
      // never throw from logging
    }
    debugFile?.write(level, message, extra);
  };
}

function upsertAgent(
  draft: V2AgentDraft,
  spec: { description: string; system: string; permissions: V2PermissionRule[]; temperature: number },
) {
  draft.description = spec.description;
  draft.mode = "subagent";
  draft.hidden = true;
  draft.system = spec.system;
  draft.permissions = spec.permissions.map((rule) => ({ ...rule }));
  draft.request ??= { settings: {}, headers: {}, body: {} };
  draft.request.body ??= {};
  draft.request.body.temperature = spec.temperature;
}

/** Bound for EACH cleanup step after the child-stop sweep (every registration dispose, the debug-log close). */
export const V2_CLEANUP_STEP_BUDGET_MS = 1_000;

/** Resolves "settled" when `operation` settles (either way), or "timed-out" after `ms`. Never rejects. */
function settleWithin(operation: Promise<unknown>, ms: number): Promise<"settled" | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function disposeQuietly(registration: V2Registration | undefined, log: Logger, what: string) {
  if (!registration) return;
  let disposing: Promise<void>;
  try {
    disposing = registration.dispose().catch((error: unknown) => {
      log("warn", `council ${what} registration dispose failed`, { error: errorMessage(error) });
    });
  } catch (error) {
    log("warn", `council ${what} registration dispose failed`, { error: errorMessage(error) });
    return;
  }
  if ((await settleWithin(disposing, V2_CLEANUP_STEP_BUDGET_MS)) === "timed-out") {
    log("warn", `council ${what} registration dispose timed out`);
  }
}

async function closeDebugFile(debugFile: DebugFile | undefined, log: Logger) {
  if (!debugFile) return;
  let closing: Promise<void>;
  try {
    closing = debugFile.close();
  } catch {
    return;
  }
  if ((await settleWithin(closing, V2_CLEANUP_STEP_BUDGET_MS)) === "timed-out") {
    log("warn", "council debug log close timed out");
  }
}

export type V2SetupDeps = {
  /** Debug-log file factory (test seam); defaults to the real `createDebugFile`. */
  createDebugFile?: () => DebugFile;
};

export function createV2Setup(deps: V2SetupDeps = {}): (ctx: V2SetupContext) => Promise<V2Cleanup> {
  const makeDebugFile = deps.createDebugFile ?? (() => createDebugFile());
  return (ctx) => setupInstance(ctx, makeDebugFile);
}

/** V2 plugin entry (`default.setup`). */
export const setup: (ctx: V2SetupContext) => Promise<V2Cleanup> = createV2Setup();

async function setupInstance(
  ctx: V2SetupContext,
  makeDebugFile: () => DebugFile,
): Promise<V2Cleanup> {
  const rawCouncilOptions = councilOptions(ctx.options);
  const userSpecifiedReviewer = hasUserSpecifiedAgent(rawCouncilOptions, "reviewer");
  const userSpecifiedAggregator = hasUserSpecifiedAgent(rawCouncilOptions, "aggregator");

  // Warnings raised while parsing are buffered until the logger exists.
  const parseWarnings: Array<[string, Record<string, unknown> | undefined]> = [];
  const councilConfig = composeCouncilConfig(
    ctx.options,
    (message, extra) => parseWarnings.push([message, extra]),
    // Never put raw user config values into V2 message text (console/debug file).
    { overrideAsk: "keep", describeValue: "type" },
  );
  const debugFile = councilConfig.debug ? makeDebugFile() : undefined;
  const log = createV2Logger(councilConfig.debug, debugFile);
  for (const [message, extra] of parseWarnings) log("warn", message, extra);
  if (userSpecifiedReviewer && councilConfig.reviewer_temperature !== null) {
    log("warn", REVIEWER_TEMPERATURE_IGNORED_WARNING);
  }

  const home = homedir();
  const ownedChildren = createChildRegistry((message, extra) => log("warn", message, extra));
  const v2Host = createV2Host(ctx, { log, home });
  const councilHost = withChildOwnership(v2Host, ownedChildren);
  // Aborted by cleanup: cancels every in-flight review of this instance.
  const instanceClosed = new AbortController();

  const registrations: { agent?: V2Registration; tool?: V2Registration; hook?: V2Registration } = {};
  try {
    if (!userSpecifiedReviewer || !userSpecifiedAggregator) {
      const reviewerPermissions = translatePermissionOverride(REVIEWER_PERMISSION, home);
      const aggregatorPermissions = translatePermissionOverride(AGGREGATOR_PERMISSION, home);
      registrations.agent = await ctx.agent.transform((editor) => {
        if (!userSpecifiedReviewer) {
          editor.update(BUNDLED_REVIEWER_AGENT, (draft) =>
            upsertAgent(draft, {
              description: BUNDLED_REVIEWER_DESCRIPTION,
              system: REVIEWER_PROMPT,
              permissions: reviewerPermissions,
              temperature: councilConfig.reviewer_temperature ?? 0.3,
            }),
          );
        }
        if (!userSpecifiedAggregator) {
          editor.update(BUNDLED_AGGREGATOR_AGENT, (draft) =>
            upsertAgent(draft, {
              description: BUNDLED_AGGREGATOR_DESCRIPTION,
              system: AGGREGATOR_PROMPT,
              permissions: aggregatorPermissions,
              temperature: 0,
            }),
          );
        }
      });
    }

    registrations.tool = await ctx.tool.transform((editor) => {
      editor.add({
        name: "council_review",
        description: COUNCIL_REVIEW_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: COUNCIL_REVIEW_PROMPT_ARG_DESCRIPTION },
          },
          required: ["prompt"],
        },
        options: { codemode: false },
        async execute(input, context) {
          if (instanceClosed.signal.aborted) return { content: COUNCIL_SHUTTING_DOWN };
          const prompt = isPlainObject(input) && typeof input.prompt === "string" ? input.prompt : "";
          const signal = context.signal
            ? AbortSignal.any([context.signal, instanceClosed.signal])
            : instanceClosed.signal;
          const content = await executeCouncilReview(
            { host: councilHost, ownedChildren, councilConfig, log, cachedPermission: undefined },
            { prompt, sessionID: context.sessionID, signal },
          );
          return { content };
        },
      });
    });

    registrations.hook = await ctx.permission.hook("evaluate", (event) => {
      try {
        if (event.effect === "ask" && ownedChildren.has(event.sessionID)) {
          event.effect = "deny";
          event.message = V2_ASK_DENIED_MESSAGE;
        }
      } catch {
        // never throw into the host permission pipeline
      }
    });
  } catch (error) {
    await disposeQuietly(registrations.hook, log, "permission hook");
    await disposeQuietly(registrations.tool, log, "tool");
    await disposeQuietly(registrations.agent, log, "agent");
    await closeDebugFile(debugFile, log);
    throw error;
  }

  // Cleanup: close the instance (cancels every in-flight review: each review's
  // sweep stops its children; late creates stop themselves) -> stop any
  // remaining owned children (bounded 5 s total) -> dispose hook -> tool ->
  // agent (each bounded 1 s) -> clear ownership and stop state -> close the
  // debug file (bounded 1 s). Expired steps log a fixed warning and continue.
  // Worst case: 5 s + 3 x 1 s + 1 s = 9 s; cleanup always returns.
  // The bounds stop cleanup from WAITING; they do not cancel the underlying
  // operations. A never-settling child stop, registration dispose, or debug-log
  // fs op keeps running after cleanup returns: it may complete later, and a
  // stuck fs op may keep the debug-log descriptor open (documented residual,
  // unverified on a real host).
  // Documented residual: a child whose stop never settles loses ask -> deny and
  // the recursion guard after cleanup.
  return async () => {
    if (instanceClosed.signal.aborted) return;
    const deadline = Date.now() + V2_STOP_BUDGET_MS;
    instanceClosed.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(ownedChildren.ids().map((id) => councilHost.stopChild(id, { deadline }))),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, V2_STOP_BUDGET_MS);
      }),
    ]);
    clearTimeout(timer);
    await disposeQuietly(registrations.hook, log, "permission hook");
    await disposeQuietly(registrations.tool, log, "tool");
    await disposeQuietly(registrations.agent, log, "agent");
    ownedChildren.clear();
    v2Host.resetStops();
    await closeDebugFile(debugFile, log);
  };
}
