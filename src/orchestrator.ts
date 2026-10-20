import { formatAbortedSummary, formatFailureSummary, synthesizeWithAggregator } from "./aggregator.js";
import { runCouncillor } from "./councillor.js";
import {
  CANCEL_STOP_BUDGET_MS,
  createCancellation,
  raceCancellation,
} from "./cancellation.js";
import type { CouncilHost } from "./host.js";
import type { ChildRegistry } from "./ownership.js";
import { errorMessage, type Logger, modelLabel } from "./logging.js";
import { raceWithTimeout } from "./timeout.js";
import type {
  CouncilConfig,
  CouncillorAborted,
  CouncillorFailure,
  CouncillorSuccess,
  ReviewState,
} from "./types.js";

export const COUNCIL_REVIEW_CANCELLED = "Council review cancelled.";

async function runCouncilReviewInner(
  host: CouncilHost,
  councilConfig: CouncilConfig,
  log: Logger,
  cachedPermission: unknown,
  prompt: string,
  parentSessionID: string,
  reviewState: ReviewState,
): Promise<string> {
  // Every awaited host operation is raced against review cancellation (identity
  // when the review has no abort signal).
  const race = <T>(operation: Promise<T>) =>
    raceCancellation(operation, reviewState.cancellation);

  // Resolve the child directory and compose child permissions once per review
  // (host permission model; V1 also avoids 2N+1 redundant session.get calls).
  const { directory, reviewerPermission, aggregatorPermission } = await race(
    host.prepareReview({
      parentSessionID,
      councilConfig,
      workspacePermission: cachedPermission,
      log,
    }),
  );

  type CouncillorState = "pending" | "success" | "failure" | "aborted";
  const states: CouncillorState[] = councilConfig.models.map(() => "pending");
  const successes: CouncillorSuccess[] = [];
  const failures: CouncillorFailure[] = [];
  const aborted: CouncillorAborted[] = [];
  const requiredCount = councilConfig.models.filter((model) => !model.optional).length;
  let requiredSuccessCount = 0;

  let resolveQuorum: () => void = () => {};
  const quorumPromise = new Promise<void>((resolve) => {
    resolveQuorum = resolve;
  });

  const councillorPromises = councilConfig.models.map((model) =>
    runCouncillor(host, councilConfig, log, {
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
        if (!value.model.optional) {
          requiredSuccessCount++;
          if (requiredSuccessCount === councilConfig.quorum) resolveQuorum();
        }
      },
      (error) => {
        if (states[index] !== "pending") return;
        states[index] = "failure";
        failures.push({ model: councilConfig.models[index], error: errorMessage(error) });
      },
    ),
  );
  const allFinished = Promise.all(tracked);

  await race(Promise.race([quorumPromise, allFinished]));

  if (requiredSuccessCount >= councilConfig.quorum && states.some((state) => state === "pending")) {
    reviewState.quorumReached = true;

    if (councilConfig.timeouts.quorum_grace_ms > 0) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await race(
          Promise.race([
            allFinished,
            new Promise<void>((resolve) => {
              graceTimer = setTimeout(resolve, councilConfig.timeouts.quorum_grace_ms);
            }),
          ]),
        );
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
      void host.stopChild(sessionID); // detached laggard abort sweep (see host.ts table)
    }
  } else {
    await race(allFinished);
  }

  if (successes.length < 2) {
    const fallbackLabelOptions = { includeOptionalMarker: true };
    return `Error: council_review received fewer than 2 successful councillor responses (${successes.length}/${councilConfig.models.length}; required: ${requiredSuccessCount}/${requiredCount}). caller should fall back to a single reviewer.

Successful councillors:
${successes.length === 0 ? "none" : successes.map((success) => `- ${modelLabel(success.model, fallbackLabelOptions)}`).join("\n")}

Failed councillors:
${formatFailureSummary(failures, fallbackLabelOptions)}${aborted.length > 0 ? `

Aborted councillors:
${formatAbortedSummary(aborted, fallbackLabelOptions)}` : ""}`;
  }

  return await race(
    synthesizeWithAggregator(host, councilConfig, log, {
      parentSessionID,
      originalPrompt: prompt,
      successes,
      failures,
      aborted,
      directory,
      reviewState,
      aggregatorPermission,
    }),
  );
}

export async function runCouncilReview(
  host: CouncilHost,
  councilConfig: CouncilConfig,
  log: Logger,
  cachedPermission: unknown,
  prompt: string,
  parentSessionID: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const { signal } = options;
  if (signal?.aborted) return COUNCIL_REVIEW_CANCELLED;

  // Hard-cap timeout: abort all tracked child sessions and set flag to prevent
  // new session creation. Abort calls are fire-and-forget (idempotent, errors swallowed).
  const reviewState: ReviewState = {
    activeSessions: new Set<string>(),
    hardCapTimedOut: false,
    quorumReached: false,
  };

  // Cancellation sweep (E1): on host abort, mark the review cancelled, stop every
  // tracked child (detached, one shared per-review stop deadline), and let the
  // raced awaits settle the review. Late-created children stop themselves
  // (session.ts). The aggregator never starts after cancellation.
  const cancellation = signal ? createCancellation() : undefined;
  if (cancellation) reviewState.cancellation = cancellation;
  const onAbort = () => {
    if (!cancellation?.cancel(Date.now() + CANCEL_STOP_BUDGET_MS)) return;
    log("debug", "council review cancelled", {
      active_sessions: reviewState.activeSessions.size,
    });
    for (const sessionID of reviewState.activeSessions) {
      // detached cancellation sweep (see host.ts table)
      void host.stopChild(sessionID, { deadline: cancellation.stopDeadline });
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await raceWithTimeout(
      runCouncilReviewInner(
        host,
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
          void host.stopChild(sessionID); // detached hard-cap stop (see host.ts table)
        }
      },
    );
    return cancellation?.cancelled ? COUNCIL_REVIEW_CANCELLED : result;
  } catch (error) {
    if (cancellation?.cancelled) return COUNCIL_REVIEW_CANCELLED;
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export const COUNCIL_CHILD_REFUSAL =
  "Error: council_review cannot run inside a council child session.";

/**
 * Host-agnostic `council_review` tool body shared by every host adapter.
 * Refuses immediately (no children) when the caller is a council child owned
 * by this plugin instance (recursion guard, E2).
 */
export async function executeCouncilReview(
  deps: {
    host: CouncilHost;
    ownedChildren: ChildRegistry;
    councilConfig: CouncilConfig;
    log: Logger;
    cachedPermission: unknown;
  },
  request: { prompt: string; sessionID: string; signal?: AbortSignal },
): Promise<string> {
  if (deps.ownedChildren.has(request.sessionID)) return COUNCIL_CHILD_REFUSAL;

  const prompt = request.prompt.trim();
  if (!prompt) return "Error: Must provide a non-empty prompt";

  try {
    return await runCouncilReview(
      deps.host,
      deps.councilConfig,
      deps.log,
      deps.cachedPermission,
      prompt,
      request.sessionID,
      { signal: request.signal },
    );
  } catch (error) {
    return `Error: council_review failed: ${errorMessage(error)}`;
  }
}
