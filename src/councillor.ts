import { awaitStop, raceCancellation } from "./cancellation.js";
import type { ChildPermission, CouncilHost } from "./host.js";
import { errorMessage, type Logger, modelLabel } from "./logging.js";
import { type AttemptState, createChildSession, promptAndExtract } from "./session.js";
import { raceWithTimeout } from "./timeout.js";
import type {
  CouncilConfig,
  CouncillorSuccess,
  ModelConfig,
  ReviewState,
} from "./types.js";

export async function runCouncillorAttempt(
  host: CouncilHost,
  councilConfig: CouncilConfig,
  log: Logger,
  input: {
    parentSessionID: string;
    prompt: string;
    model: ModelConfig;
    timeoutMs: number;
    directory: string;
    reviewerPermission: ChildPermission;
    reviewState: ReviewState;
  },
): Promise<string> {
  const label = modelLabel(input.model);
  const startedAt = Date.now();
  let sessionID: string | undefined;
  const attempt: AttemptState = { expired: false };
  log("debug", "councillor request started", {
    model: label,
    timeout_ms: input.timeoutMs,
  });

  try {
    const response = await raceWithTimeout(
      (async () => {
        try {
          sessionID = await createChildSession(
            host,
            input.parentSessionID,
            `council: ${label}`,
            input.directory,
            [...input.reviewerPermission],
            input.reviewState,
            true,
            { agent: councilConfig.reviewer, model: input.model },
            attempt,
          );

          return await raceCancellation(
            promptAndExtract(host, {
              sessionID,
              agent: councilConfig.reviewer,
              model: input.model,
              prompt: input.prompt,
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
      input.timeoutMs,
      label,
      () => {
        attempt.expired = true;
        log("debug", "councillor request timed out", {
          model: label,
          timeout_ms: input.timeoutMs,
        });
        if (sessionID) {
          void host.stopChild(sessionID); // detached (see host.ts table)
        }
      },
    );

    log("debug", "councillor request completed", {
      model: label,
      success: true,
      duration_ms: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    log("debug", "councillor request completed", {
      model: label,
      success: false,
      duration_ms: Date.now() - startedAt,
      error: errorMessage(error),
    });
    throw error;
  }
}

export async function runCouncillor(
  host: CouncilHost,
  councilConfig: CouncilConfig,
  log: Logger,
  input: {
    parentSessionID: string;
    prompt: string;
    model: ModelConfig;
    directory: string;
    reviewerPermission: ChildPermission;
    reviewState: ReviewState;
  },
): Promise<CouncillorSuccess> {
  const timeoutMs = input.model.optional
    ? councilConfig.timeouts.optional_councillor_ms
    : councilConfig.timeouts.councillor_ms;
  const response = await runCouncillorAttempt(host, councilConfig, log, {
    ...input,
    timeoutMs,
  });
  return { model: input.model, response, attempts: 1 /* #19 selective retry follow-up */ };
}
