import { awaitStop, raceCancellation } from "./cancellation.js";
import type { ChildPermission, CouncilHost } from "./host.js";
import { errorMessage, type Logger, modelLabel } from "./logging.js";
import { type AttemptState, createChildSession, promptAndExtract } from "./session.js";
import { raceWithTimeout } from "./timeout.js";
import type {
  CouncilConfig,
  CouncillorAborted,
  CouncillorFailure,
  CouncillorSuccess,
  ReviewState,
} from "./types.js";

const AGGREGATOR_LABEL_OPTIONS = { includeOptionalMarker: true };

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
  aborted: CouncillorAborted[];
}): string {
  const successfulResponses = input.successes
    .map(
      (success, index) => `## Reviewer ${index + 1}: ${modelLabel(success.model, AGGREGATOR_LABEL_OPTIONS)}

${success.response}`,
    )
    .join("\n\n---\n\n");

  const failures =
    input.failures.length > 0
      ? input.failures
          .map(
            (failure) =>
              `- ${modelLabel(failure.model, AGGREGATOR_LABEL_OPTIONS)}: ${failure.error || "failed"}`,
          )
          .join("\n")
      : "- none";

  const abortedParticipation =
    input.aborted.length > 0
      ? `

Aborted (quorum reached):
${formatAbortedSummary(input.aborted, AGGREGATOR_LABEL_OPTIONS)}`
      : "";

  const abortedSection =
    input.aborted.length > 0
      ? `

## Aborted (quorum reached)

${formatAbortedSummary(input.aborted, AGGREGATOR_LABEL_OPTIONS)}`
      : "";

  return `You are aggregating multiple reviewer responses to one review prompt.

Do structural aggregation only. Do not issue your own verdict.

# Original review prompt

${input.originalPrompt}

# Participation summary supplied by council_review

Responded:
${input.successes.map((success) => `- ${modelLabel(success.model, AGGREGATOR_LABEL_OPTIONS)}`).join("\n")}

Failed or timed out:
${failures}${abortedParticipation}

# Reviewer responses

${successfulResponses}${abortedSection}`;
}

export function formatFailureSummary(
  failures: CouncillorFailure[],
  labelOptions: { includeOptionalMarker?: boolean } = {},
): string {
  if (failures.length === 0) return "none";
  return failures
    .map((failure) => `- ${modelLabel(failure.model, labelOptions)}: ${failure.error}`)
    .join("\n");
}

export function formatAbortedSummary(
  aborted: CouncillorAborted[],
  labelOptions: { includeOptionalMarker?: boolean } = {},
): string {
  if (aborted.length === 0) return "none";
  return aborted.map((entry) => `- ${modelLabel(entry.model, labelOptions)}`).join("\n");
}

export async function synthesizeWithAggregator(
  host: CouncilHost,
  councilConfig: CouncilConfig,
  log: Logger,
  input: {
    parentSessionID: string;
    originalPrompt: string;
    successes: CouncillorSuccess[];
    failures: CouncillorFailure[];
    aborted: CouncillorAborted[];
    directory: string;
    reviewState: ReviewState;
    aggregatorPermission?: ChildPermission;
  },
): Promise<string> {
  const startedAt = Date.now();
  let sessionID: string | undefined;
  const attempt: AttemptState = { expired: false };
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
            host,
            input.parentSessionID,
            "council: aggregator synthesis",
            input.directory,
            input.aggregatorPermission,
            input.reviewState,
            false,
            {
              agent: councilConfig.aggregator,
              ...(councilConfig.aggregator_model ? { model: councilConfig.aggregator_model } : {}),
            },
            attempt,
          );

          return await raceCancellation(
            promptAndExtract(host, {
              sessionID,
              agent: councilConfig.aggregator,
              model: councilConfig.aggregator_model ?? undefined,
              tools: AGGREGATOR_TOOLS,
              prompt: buildAggregatorPrompt(input),
              isCancelled: () => input.reviewState.cancellation?.cancelled === true,
            }),
            input.reviewState.cancellation,
          );
        } finally {
          // Normal completion or failure after create: stop the child. A child
          // whose create resolves after the phase timeout never reaches here
          // with an id: createChildSession sees the expired attempt, stops it
          // (detached), and throws before any prompt.
          if (sessionID) {
            input.reviewState.activeSessions.delete(sessionID);
            // After cancellation the sweep already stopped this child (it was
            // still tracked as active); do not stop it twice.
            if (!input.reviewState.cancellation?.cancelled) {
              // awaited (see host.ts table)
              await awaitStop(host.stopChild(sessionID), input.reviewState.cancellation);
            }
          }
        }
      })(),
      councilConfig.timeouts.aggregator_ms,
      "aggregator synthesis",
      () => {
        attempt.expired = true;
        log("debug", "aggregator synthesis timed out", {
          timeout_ms: councilConfig.timeouts.aggregator_ms,
        });
        if (sessionID) {
          void host.stopChild(sessionID); // detached (see host.ts table)
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
