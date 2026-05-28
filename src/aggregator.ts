import { errorMessage, type Logger, modelLabel } from "./logging";
import { createChildSession, promptAndExtract } from "./session";
import { raceWithTimeout } from "./timeout";
import type {
  CouncilConfig,
  CouncilPluginContext,
  CouncillorFailure,
  CouncillorSuccess,
  PermissionRuleset,
  ReviewState,
} from "./types";

export const AGGREGATOR_TOOLS = {
  "chrome-devtools": false,
  context7: false,
  exa: false,
  figma: false,
  read: false,
  write: false,
  edit: false,
  bash: false,
  glob: false,
  grep: false,
  list: false,
  task: false,
  question: false,
  todowrite: false,
  webfetch: false,
  websearch: false,
  skill: false,
  compress: false,
  vision: false,
  council_review: false,
};

export function buildAggregatorPrompt(input: {
  originalPrompt: string;
  successes: CouncillorSuccess[];
  failures: CouncillorFailure[];
}): string {
  const successfulResponses = input.successes
    .map(
      (success, index) => `## Reviewer ${index + 1}: ${modelLabel(success.model)}

Attempts: ${success.attempts}

${success.response}`,
    )
    .join("\n\n---\n\n");

  const failures =
    input.failures.length > 0
      ? input.failures
          .map(
            (failure) =>
              `- ${modelLabel(failure.model)}: ${failure.error || "failed"}`,
          )
          .join("\n")
      : "- none";

  return `You are aggregating multiple reviewer responses to one review prompt.

Do structural aggregation only. Do not issue your own verdict.

# Original review prompt

${input.originalPrompt}

# Participation summary supplied by council_review

Responded:
${input.successes.map((success) => `- ${modelLabel(success.model)} (${success.attempts} attempt${success.attempts === 1 ? "" : "s"})`).join("\n")}

Failed or timed out:
${failures}

# Reviewer responses

${successfulResponses}`;
}

export function formatFailureSummary(failures: CouncillorFailure[]): string {
  if (failures.length === 0) return "none";
  return failures
    .map((failure) => `- ${modelLabel(failure.model)}: ${failure.error}`)
    .join("\n");
}

export async function synthesizeWithAggregator(
  ctx: CouncilPluginContext,
  councilConfig: CouncilConfig,
  log: Logger,
  input: {
    parentSessionID: string;
    originalPrompt: string;
    successes: CouncillorSuccess[];
    failures: CouncillorFailure[];
    directory: string;
    reviewState: ReviewState;
    aggregatorPermission?: PermissionRuleset;
  },
): Promise<string> {
  const startedAt = Date.now();
  let sessionID: string | undefined;
  log("debug", "aggregator synthesis started", {
    model: councilConfig.aggregator_model
      ? modelLabel(councilConfig.aggregator_model)
      : undefined,
    timeout_ms: councilConfig.timeouts.aggregator_ms,
    successes: input.successes.length,
    failures: input.failures.length,
  });

  try {
    const response = await raceWithTimeout(
      (async () => {
        try {
          sessionID = await createChildSession(
            ctx,
            input.parentSessionID,
            "council: aggregator synthesis",
            input.directory,
            input.aggregatorPermission,
            input.reviewState,
          );

          return await promptAndExtract(ctx, {
            sessionID,
            agent: councilConfig.aggregator,
            model: councilConfig.aggregator_model ?? undefined,
            tools: AGGREGATOR_TOOLS,
            prompt: buildAggregatorPrompt(input),
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
      councilConfig.timeouts.aggregator_ms,
      "aggregator synthesis",
      () => {
        log("debug", "aggregator synthesis timed out", {
          timeout_ms: councilConfig.timeouts.aggregator_ms,
        });
        if (sessionID) {
          void ctx.client.session
            .abort({ path: { id: sessionID } })
            .catch(() => {});
        }
      },
    );

    log("debug", "aggregator synthesis ended", {
      success: true,
      duration_ms: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    log("debug", "aggregator synthesis ended", {
      success: false,
      duration_ms: Date.now() - startedAt,
      error: errorMessage(error),
    });
    throw error;
  }
}
