import { formatAbortedSummary, formatFailureSummary, synthesizeWithAggregator } from "./aggregator";
import { runCouncillor } from "./councillor";
import { errorMessage, type Logger, modelLabel } from "./logging";
import {
  aggregatorSessionPermission,
  buildReviewerRuleset,
  permissionConfigToRuleset,
} from "./permissions";
import { parentDirectory } from "./session";
import { raceWithTimeout } from "./timeout";
import type {
  CouncilConfig,
  CouncilPluginContext,
  CouncillorAborted,
  CouncillorFailure,
  CouncillorSuccess,
  ReviewState,
} from "./types";

async function runCouncilReviewInner(
  ctx: CouncilPluginContext,
  councilConfig: CouncilConfig,
  log: Logger,
  cachedPermission: unknown,
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

  type CouncillorState = "pending" | "success" | "failure" | "aborted";
  const states: CouncillorState[] = councilConfig.models.map(() => "pending");
  const successes: CouncillorSuccess[] = [];
  const failures: CouncillorFailure[] = [];
  const aborted: CouncillorAborted[] = [];

  let resolveQuorum: () => void = () => {};
  const quorumPromise = new Promise<void>((resolve) => {
    resolveQuorum = resolve;
  });

  const councillorPromises = councilConfig.models.map((model) =>
    runCouncillor(ctx, councilConfig, log, {
      parentSessionID,
      prompt,
      model,
      directory,
      reviewerPermission,
      reviewState,
    }),
  );

  const tracked = councillorPromises.map((promise, index) =>
    promise.then(
      (value) => {
        if (states[index] !== "pending") return;
        states[index] = "success";
        successes.push(value);
        if (successes.length === councilConfig.quorum) resolveQuorum();
      },
      (error) => {
        if (states[index] !== "pending") return;
        states[index] = "failure";
        failures.push({ model: councilConfig.models[index], error: errorMessage(error) });
      },
    ),
  );
  const allFinished = Promise.all(tracked);

  await Promise.race([quorumPromise, allFinished]);

  if (successes.length >= councilConfig.quorum && states.some((state) => state === "pending")) {
    reviewState.quorumReached = true;

    if (councilConfig.timeouts.quorum_grace_ms > 0) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          allFinished,
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, councilConfig.timeouts.quorum_grace_ms);
          }),
        ]);
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
      }
    }

    states.forEach((state, index) => {
      if (state === "pending") {
        states[index] = "aborted";
        aborted.push({ model: councilConfig.models[index] });
      }
    });

    for (const sessionID of reviewState.activeSessions) {
      void ctx.client.session
        .abort({ path: { id: sessionID } })
        .catch(() => {});
    }
  } else {
    await allFinished;
  }

  if (successes.length < 2) {
    return `Error: council_review received fewer than 2 successful councillor responses (${successes.length}/${councilConfig.models.length}). caller should fall back to a single reviewer.

Successful councillors:
${successes.length === 0 ? "none" : successes.map((success) => `- ${modelLabel(success.model)} (${success.attempts} attempt${success.attempts === 1 ? "" : "s"})`).join("\n")}

Failed councillors:
${formatFailureSummary(failures)}${aborted.length > 0 ? `

Aborted councillors:
${formatAbortedSummary(aborted)}` : ""}`;
  }

  return await synthesizeWithAggregator(ctx, councilConfig, log, {
    parentSessionID,
    originalPrompt: prompt,
    successes,
    failures,
    aborted,
    directory,
    reviewState,
    aggregatorPermission: aggregatorSessionPermission(councilConfig),
  });
}

export async function runCouncilReview(
  ctx: CouncilPluginContext,
  councilConfig: CouncilConfig,
  log: Logger,
  cachedPermission: unknown,
  prompt: string,
  parentSessionID: string,
): Promise<string> {
  // Hard-cap timeout: abort all tracked child sessions and set flag to prevent
  // new session creation. Abort calls are fire-and-forget (idempotent, errors swallowed).
  const reviewState: ReviewState = {
    activeSessions: new Set<string>(),
    hardCapTimedOut: false,
    quorumReached: false,
  };
  return await raceWithTimeout(
    runCouncilReviewInner(
      ctx,
      councilConfig,
      log,
      cachedPermission,
      prompt,
      parentSessionID,
      reviewState,
    ),
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
}
