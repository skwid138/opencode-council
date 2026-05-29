import { errorMessage, type Logger, modelLabel } from "./logging";
import { createChildSession, promptAndExtract } from "./session";
import { raceWithTimeout } from "./timeout";
import type {
  CouncilConfig,
  CouncilPluginContext,
  CouncillorSuccess,
  ModelConfig,
  PermissionRuleset,
  ReviewState,
} from "./types";

export async function runCouncillorAttempt(
  ctx: CouncilPluginContext,
  councilConfig: CouncilConfig,
  log: Logger,
  input: {
    parentSessionID: string;
    prompt: string;
    model: ModelConfig;
    timeoutMs: number;
    attempt: number;
    directory: string;
    reviewerPermission: PermissionRuleset;
    reviewState: ReviewState;
  },
): Promise<string> {
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
            true,
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

export async function runCouncillor(
  ctx: CouncilPluginContext,
  councilConfig: CouncilConfig,
  log: Logger,
  input: {
    parentSessionID: string;
    prompt: string;
    model: ModelConfig;
    directory: string;
    reviewerPermission: PermissionRuleset;
    reviewState: ReviewState;
  },
): Promise<CouncillorSuccess> {
  try {
    const response = await runCouncillorAttempt(ctx, councilConfig, log, {
      ...input,
      timeoutMs: councilConfig.timeouts.councillor_ms,
      attempt: 1,
    });
    return { model: input.model, response, attempts: 1 };
  } catch (firstError) {
    if (input.reviewState.hardCapTimedOut || input.reviewState.quorumReached) {
      throw firstError;
    }

    log("debug", "councillor retry triggered", {
      model: modelLabel(input.model),
      error: errorMessage(firstError),
    });
    try {
      const response = await runCouncillorAttempt(ctx, councilConfig, log, {
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
