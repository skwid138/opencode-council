/**
 * Council Review Tool Plugin
 *
 * Exposes council_review(prompt), which runs the same review prompt through a
 * configured set of reviewers in parallel, then asks an aggregator to
 * structurally aggregate the results.
 */

import { tool, type Plugin, type PluginOptions } from "@opencode-ai/plugin";
import { formatFailureSummary, synthesizeWithAggregator } from "./aggregator";
import {
  councilOptions,
  hasUserSpecifiedAgent,
  parseCouncilConfig,
  REVIEWER_TEMPERATURE_IGNORED_WARNING,
} from "./config";
import { createLogger, errorMessage, modelLabel } from "./logging";
import {
  aggregatorSessionPermission,
  buildReviewerRuleset,
  permissionConfigToRuleset,
} from "./permissions";
import {
  AGGREGATOR_PERMISSION,
  AGGREGATOR_PROMPT,
  REVIEWER_PERMISSION,
  REVIEWER_PROMPT,
} from "./prompts";
import { createChildSession, parentDirectory, promptAndExtract } from "./session";
import { raceWithTimeout } from "./timeout";
import {
  BUNDLED_AGGREGATOR_AGENT,
  BUNDLED_REVIEWER_AGENT,
  type CouncilPluginOptions,
  type CouncillorFailure,
  type CouncillorSuccess,
  type ModelConfig,
  type PermissionRuleset,
  type ReviewState,
} from "./types";

const CouncilToolPlugin: Plugin = async (ctx, options?: PluginOptions) => {
  const pluginOptions = options as CouncilPluginOptions | undefined;
  const rawCouncilOptions = councilOptions(options);
  const debugEnabled =
    process.env.COUNCIL_DEBUG === "1" ||
    pluginOptions?.debug === true ||
    rawCouncilOptions.debug === true;
  const log = createLogger(ctx, debugEnabled);
  const userSpecifiedReviewer = hasUserSpecifiedAgent(rawCouncilOptions, "reviewer");
  const userSpecifiedAggregator = hasUserSpecifiedAgent(rawCouncilOptions, "aggregator");
  const councilConfig = parseCouncilConfig(options, (message, extra) =>
    log("warn", message, extra),
  );
  if (userSpecifiedReviewer && councilConfig.reviewer_temperature !== null) {
    log("warn", REVIEWER_TEMPERATURE_IGNORED_WARNING);
  }
  // Workspace permission config captured from the config hook at startup.
  // The config hook runs before any tool execution (opencode guarantee), so this
  // is always populated when buildReviewerRuleset is called.
  let cachedPermission: unknown;

  async function runCouncillorAttempt(input: {
    parentSessionID: string;
    prompt: string;
    model: ModelConfig;
    timeoutMs: number;
    attempt: number;
    directory: string;
    reviewerPermission: PermissionRuleset;
    reviewState: ReviewState;
  }): Promise<string> {
    const label = modelLabel(input.model);
    const startedAt = Date.now();
    let sessionID: string | undefined;
    log("debug", "councillor attempt started", {
      model: label,
      attempt: input.attempt,
      timeout_ms: input.timeoutMs,
    });

    try {
      const response = await raceWithTimeout(
        (async () => {
          try {
            sessionID = await createChildSession(
              ctx,
              input.parentSessionID,
              `council: ${label} attempt ${input.attempt}`,
              input.directory,
              [...input.reviewerPermission],
              input.reviewState,
            );

            return await promptAndExtract(ctx, {
              sessionID,
              agent: councilConfig.reviewer,
              model: input.model,
              prompt: input.prompt,
            });
          } finally {
            // Timeout can fire before session.create returns an id; in that race
            // the timeout cleanup has nothing to abort, so this finally aborts
            // the session if the create later resolves.
            if (sessionID) {
              input.reviewState.activeSessions.delete(sessionID);
              await ctx.client.session
                .abort({ path: { id: sessionID } })
                .catch(() => {});
            }
          }
        })(),
        input.timeoutMs,
        `${label} attempt ${input.attempt}`,
        () => {
          log("debug", "councillor attempt timed out", {
            model: label,
            attempt: input.attempt,
            timeout_ms: input.timeoutMs,
          });
          if (sessionID) {
            void ctx.client.session
              .abort({ path: { id: sessionID } })
              .catch(() => {});
          }
        },
      );

      log("debug", "councillor attempt ended", {
        model: label,
        attempt: input.attempt,
        success: true,
        duration_ms: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      log("debug", "councillor attempt ended", {
        model: label,
        attempt: input.attempt,
        success: false,
        duration_ms: Date.now() - startedAt,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  async function runCouncillor(input: {
    parentSessionID: string;
    prompt: string;
    model: ModelConfig;
    directory: string;
    reviewerPermission: PermissionRuleset;
    reviewState: ReviewState;
  }): Promise<CouncillorSuccess> {
    try {
      const response = await runCouncillorAttempt({
        ...input,
        timeoutMs: councilConfig.timeouts.councillor_ms,
        attempt: 1,
      });
      return { model: input.model, response, attempts: 1 };
    } catch (firstError) {
      if (input.reviewState.hardCapTimedOut) throw firstError;

      log("debug", "councillor retry triggered", {
        model: modelLabel(input.model),
        error: errorMessage(firstError),
      });
      try {
        const response = await runCouncillorAttempt({
          ...input,
          timeoutMs: councilConfig.timeouts.councillor_retry_ms,
          attempt: 2,
        });
        return { model: input.model, response, attempts: 2 };
      } catch (retryError) {
        throw new Error(
          `first attempt failed: ${errorMessage(firstError)}; retry failed: ${errorMessage(retryError)}`,
        );
      }
    }
  }

  async function runCouncilReview(
    prompt: string,
    parentSessionID: string,
    reviewState: ReviewState,
  ): Promise<string> {
    // Resolve parent directory once per review — avoids 2N+1 redundant session.get SDK calls.
    const directory = await parentDirectory(ctx, parentSessionID);
    // Permission layering (last-match-wins in opencode's evaluator):
    // 1. Catch-all allows — #28037 workaround (lowest priority)
    // 2. Workspace deny/allow rules — from cachedPermission (ask values stripped)
    // 3. User reviewer_permission overrides (highest priority)
    const reviewerPermission = [
      ...buildReviewerRuleset(cachedPermission, (msg) => log("warn", msg)),
      ...(councilConfig.reviewer_permission
        ? permissionConfigToRuleset(councilConfig.reviewer_permission)
        : []),
    ];
    log("debug", "buildReviewerRuleset permission output", {
      permission_json: JSON.stringify(reviewerPermission),
    });

    const councillorPromises = councilConfig.models.map((model) =>
      runCouncillor({
        parentSessionID,
        prompt,
        model,
        directory,
        reviewerPermission,
        reviewState,
      }),
    );

    const settledResults = await Promise.allSettled(councillorPromises);
    const successes: CouncillorSuccess[] = [];
    const failures: CouncillorFailure[] = [];

    settledResults.forEach((result, index) => {
      const model = councilConfig.models[index];
      if (result.status === "fulfilled") {
        successes.push(result.value);
      } else {
        failures.push({ model, error: errorMessage(result.reason) });
      }
    });

    if (successes.length < 2) {
      return `Error: council_review received fewer than 2 successful councillor responses (${successes.length}/${councilConfig.models.length}). caller should fall back to a single reviewer.

Successful councillors:
${successes.length === 0 ? "none" : successes.map((success) => `- ${modelLabel(success.model)} (${success.attempts} attempt${success.attempts === 1 ? "" : "s"})`).join("\n")}

Failed councillors:
${formatFailureSummary(failures)}`;
    }

    return await synthesizeWithAggregator(ctx, councilConfig, log, {
      parentSessionID,
      originalPrompt: prompt,
      successes,
      failures,
      directory,
      reviewState,
      aggregatorPermission: aggregatorSessionPermission(councilConfig),
    });
  }

  return {
    config: async (config: Record<string, unknown>) => {
      cachedPermission = config.permission;
      config.agent ??= {};
      const agents = config.agent as Record<string, unknown>;

      if (!userSpecifiedReviewer) {
        agents[BUNDLED_REVIEWER_AGENT] = {
          description: "Council plugin adversarial code reviewer",
          mode: "subagent",
          hidden: true,
          temperature: councilConfig.reviewer_temperature ?? 0.3,
          prompt: REVIEWER_PROMPT,
          permission: REVIEWER_PERMISSION,
        };
      }

      if (!userSpecifiedAggregator) {
        agents[BUNDLED_AGGREGATOR_AGENT] = {
          description: "Council plugin structural aggregator",
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
        description: `Fan out a review prompt to the configured council of reviewers in parallel, then ask an aggregator to structurally aggregate the responses.

Use when you need adversarial review from multiple models. The tool returns the aggregator's synthesis when at least two councillors respond. If fewer than two respond, it returns an error string so the caller can fall back to a single reviewer.`,
        args: {
          prompt: tool.schema
            .string()
            .describe("The complete review prompt to send to each councillor"),
        },
        async execute(args, toolContext) {
          const prompt = args.prompt.trim();
          if (!prompt) return "Error: Must provide a non-empty prompt";

          try {
            // Hard-cap timeout: abort all tracked child sessions and set flag to prevent
            // new session creation. Abort calls are fire-and-forget (idempotent, errors swallowed).
            const reviewState: ReviewState = {
              activeSessions: new Set<string>(),
              hardCapTimedOut: false,
            };
            return await raceWithTimeout(
              runCouncilReview(prompt, toolContext.sessionID, reviewState),
              councilConfig.timeouts.hard_cap_ms,
              "council_review",
              () => {
                reviewState.hardCapTimedOut = true;
                log("debug", "hard cap triggered", {
                  timeout_ms: councilConfig.timeouts.hard_cap_ms,
                });
                for (const sessionID of reviewState.activeSessions) {
                  void ctx.client.session
                    .abort({ path: { id: sessionID } })
                    .catch(() => {});
                }
              },
            );
          } catch (error) {
            return `Error: council_review failed: ${errorMessage(error)}`;
          }
        },
      }),
    },
  };
};

export { CouncilToolPlugin };
export { parseCouncilConfig, parseCouncilConfig as validateCouncilConfig } from "./config";
export { raceWithTimeout };

export default { server: CouncilToolPlugin };
