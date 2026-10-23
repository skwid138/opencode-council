/**
 * OpenCode V1 host adapter.
 *
 * - `createV1Host(ctx)` implements the core `CouncilHost` seam with the exact V1
 *   SDK calls and request bodies (`session.get/create/prompt/messages/abort`,
 *   `app.log`).
 * - `CouncilToolPlugin` is the V1 `server` plugin function: the config hook
 *   (bundled agent injection + workspace permission caching) and the
 *   `council_review` tool registration.
 *
 * `@opencode-ai/plugin` is only imported dynamically inside the server function,
 * so loading the package entry graph never imports it at runtime.
 */
import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import {
  composeCouncilConfig,
  councilOptions,
  hasUserSpecifiedAgent,
  resolveDebug,
  REVIEWER_TEMPERATURE_IGNORED_WARNING,
} from "./config.js";
import type { CouncilHost, StopResult } from "./host.js";
import { createLogger, errorMessage } from "./logging.js";
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
import { composeV1ChildPermissions } from "./permissions.js";
import { extractLatestAssistantText } from "./session.js";
import { BUNDLED_AGGREGATOR_AGENT, BUNDLED_REVIEWER_AGENT } from "./types.js";

export type CouncilPluginContext = Pick<PluginInput, "client" | "directory">;

/** True only when `data.info` is an assistant message with a non-null `error`. */
function hasAssistantError(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const info = (data as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return false;
  const { role, error } = info as { role?: unknown; error?: unknown };
  return role === "assistant" && error !== null && error !== undefined;
}

function stopResultFromAbort(result: unknown): StopResult {
  try {
    const error = (result as { error?: unknown } | null | undefined)?.error;
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function createV1Host(
  ctx: CouncilPluginContext,
  options: { debug?: boolean } = {},
): CouncilHost {
  return {
    log: createLogger(ctx, options.debug ?? false),

    prepareReview(input) {
      // Baseline order: the parent lookup settles first, then permissions are
      // composed (emitting their warnings/debug logs). One `.then` with both
      // handlers keeps child creation scheduled exactly as before the seam.
      const compose = (directory: string) => ({
        directory,
        ...composeV1ChildPermissions(input.workspacePermission, input.councilConfig, input.log),
      });
      return ctx.client.session.get({ path: { id: input.parentSessionID } }).then(
        (parentSession) => compose(parentSession?.data?.directory ?? ctx.directory),
        () => compose(ctx.directory),
      );
    },

    async createChild(input) {
      const body: Record<string, unknown> = {
        parentID: input.parentID,
        title: input.title,
      };
      if (input.permission) body.permission = input.permission;

      const createResult = await ctx.client.session.create({
        body,
        query: { directory: input.directory },
      } as Parameters<typeof ctx.client.session.create>[0]) as {
        data?: { id?: string };
        error?: unknown;
      };

      if (createResult.error) {
        throw new Error(`failed to create child session: ${errorMessage(createResult.error)}`);
      }

      const sessionID = createResult.data?.id;
      if (!sessionID) {
        throw new Error("failed to create child session: missing session id");
      }
      return sessionID;
    },

    async runChild(input) {
      const body: Record<string, unknown> = {
        agent: input.agent,
        parts: [{ type: "text", text: input.prompt }],
      };

      if (input.model) {
        body.model = { providerID: input.model.providerID, modelID: input.model.modelID };
      }
      if (input.tools) body.tools = input.tools;

      const promptResult = await ctx.client.session.prompt({
        path: { id: input.sessionID },
        body,
      } as Parameters<typeof ctx.client.session.prompt>[0]) as { data?: unknown; error?: unknown };

      if (promptResult.error) {
        throw new Error(`prompt failed: ${errorMessage(promptResult.error)}`);
      }
      // E3: a successful prompt response whose assistant message carries a host
      // error is a failure (absent data stays accepted). Fixed text only.
      if (hasAssistantError(promptResult.data)) {
        throw new Error("assistant error: failed");
      }
      // Cancelled while the prompt was pending: do not read the child's messages.
      if (input.isCancelled?.()) {
        throw new Error("council_review cancelled");
      }

      const messagesResult = await ctx.client.session.messages({
        path: { id: input.sessionID },
      }) as { data?: unknown; error?: unknown };

      if (messagesResult.error) {
        throw new Error(`failed to get messages: ${errorMessage(messagesResult.error)}`);
      }

      const responseText = extractLatestAssistantText(messagesResult.data);
      if (!responseText) {
        throw new Error("empty response");
      }

      return responseText;
    },

    // V1 ignores StopOptions.deadline: session.abort is a single request whose
    // result is the stop confirmation (no separate settle phase to bound).
    stopChild(sessionID) {
      try {
        return ctx.client.session
          .abort({ path: { id: sessionID } })
          .then(stopResultFromAbort, (error: unknown): StopResult => ({ ok: false, error }));
      } catch (error) {
        return Promise.resolve({ ok: false, error });
      }
    },
  };
}

const CouncilToolPlugin: Plugin = async (ctx, options?: PluginOptions) => {
  const rawCouncilOptions = councilOptions(options);
  const debugEnabled = resolveDebug(options);
  const host = createV1Host(ctx, { debug: debugEnabled });
  const log = host.log;
  // Per-instance child ownership (recursion guard). V1 has no plugin cleanup
  // hook, so owned children live for the plugin's lifetime unless confirmed stopped.
  const ownedChildren = createChildRegistry((message, extra) => log("warn", message, extra));
  const councilHost = withChildOwnership(host, ownedChildren);
  const userSpecifiedReviewer = hasUserSpecifiedAgent(rawCouncilOptions, "reviewer");
  const userSpecifiedAggregator = hasUserSpecifiedAgent(rawCouncilOptions, "aggregator");
  const councilConfig = composeCouncilConfig(options, (message, extra) =>
    log("warn", message, extra),
  );
  if (userSpecifiedReviewer && councilConfig.reviewer_temperature !== null) {
    log("warn", REVIEWER_TEMPERATURE_IGNORED_WARNING);
  }
  // Workspace permission config captured from the config hook at startup.
  // The config hook runs before any tool execution (opencode guarantee), so this
  // is always populated when buildReviewerRuleset is called.
  let cachedPermission: unknown;

  const { tool } = await import("@opencode-ai/plugin");

  return {
    config: async (config: Record<string, unknown>) => {
      cachedPermission = config.permission;
      config.agent ??= {};
      const agents = config.agent as Record<string, unknown>;

      if (!userSpecifiedReviewer) {
        agents[BUNDLED_REVIEWER_AGENT] = {
          description: BUNDLED_REVIEWER_DESCRIPTION,
          mode: "subagent",
          hidden: true,
          temperature: councilConfig.reviewer_temperature ?? 0.3,
          prompt: REVIEWER_PROMPT,
          permission: REVIEWER_PERMISSION,
        };
      }

      if (!userSpecifiedAggregator) {
        agents[BUNDLED_AGGREGATOR_AGENT] = {
          description: BUNDLED_AGGREGATOR_DESCRIPTION,
          mode: "subagent",
          hidden: true,
          temperature: 0,
          prompt: AGGREGATOR_PROMPT,
          permission: AGGREGATOR_PERMISSION,
        };
      }
    },
    tool: {
      council_review: tool({
        description: COUNCIL_REVIEW_DESCRIPTION,
        args: {
          prompt: tool.schema.string().describe(COUNCIL_REVIEW_PROMPT_ARG_DESCRIPTION),
        },
        async execute(args, toolContext) {
          return await executeCouncilReview(
            { host: councilHost, ownedChildren, councilConfig, log, cachedPermission },
            {
              prompt: args.prompt,
              sessionID: toolContext.sessionID,
              signal: toolContext.abort,
            },
          );
        },
      }),
    },
  };
};

export { CouncilToolPlugin };
