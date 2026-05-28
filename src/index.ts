/**
 * Council Review Tool Plugin
 *
 * Exposes council_review(prompt), which runs the same review prompt through a
 * configured set of reviewers in parallel, then asks an aggregator to
 * structurally aggregate the results.
 */

import { tool, type Plugin, type PluginOptions } from "@opencode-ai/plugin";
import {
  composeCouncilConfig,
  councilOptions,
  hasUserSpecifiedAgent,
  resolveDebug,
  REVIEWER_TEMPERATURE_IGNORED_WARNING,
} from "./config";
import { createLogger, errorMessage } from "./logging";
import { runCouncilReview } from "./orchestrator";
import {
  AGGREGATOR_PERMISSION,
  AGGREGATOR_PROMPT,
  REVIEWER_PERMISSION,
  REVIEWER_PROMPT,
} from "./prompts";
import {
  BUNDLED_AGGREGATOR_AGENT,
  BUNDLED_REVIEWER_AGENT,
} from "./types";

const CouncilToolPlugin: Plugin = async (ctx, options?: PluginOptions) => {
  const rawCouncilOptions = councilOptions(options);
  const debugEnabled = resolveDebug(options);
  const log = createLogger(ctx, debugEnabled);
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
            return await runCouncilReview(
              ctx,
              councilConfig,
              log,
              cachedPermission,
              prompt,
              toolContext.sessionID,
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
export {
  composeCouncilConfig,
  parseCouncilConfig,
  parseCouncilConfig as validateCouncilConfig,
  resolveDebug,
} from "./config";
export { raceWithTimeout } from "./timeout";

export default { server: CouncilToolPlugin };
