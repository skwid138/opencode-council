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
    directory: string;
    reviewerPermission: PermissionRuleset;
    reviewState: ReviewState;
  },
): Promise<string> {
  const label = modelLabel(input.model);
  const startedAt = Date.now();
  let sessionID: string | undefined;
  log("debug", "councillor request started", {
    model: label,
    timeout_ms: input.timeoutMs,
  });

  try {
    const response = await raceWithTimeout(
      (async () => {
        try {
          sessionID = await createChildSession(
            ctx,
            input.parentSessionID,
            `council: ${label}`,
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
      label,
      () => {
        log("debug", "councillor request timed out", {
          model: label,
          timeout_ms: input.timeoutMs,
        });
        if (sessionID) {
          void ctx.client.session
            .abort({ path: { id: sessionID } })
            .catch(() => {});
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
  const response = await runCouncillorAttempt(ctx, councilConfig, log, {
    ...input,
    timeoutMs: councilConfig.timeouts.councillor_ms,
  });
  return { model: input.model, response, attempts: 1 /* #19 selective retry follow-up */ };
}
