/**
 * Host seam between the council core (orchestrator, councillor, aggregator,
 * session) and an OpenCode host adapter (V1: `./v1.ts`). Core modules depend
 * only on this interface; adapters own every host SDK call and request body.
 *
 * Child stop semantics. Core awaits `stopChild` exactly where it awaited the
 * V1 `session.abort` before this seam existed, and fire-and-forgets (`void`)
 * it where the abort was detached:
 *
 * | Call site                                                  | Mode     | Why                                                                     |
 * |------------------------------------------------------------|----------|-------------------------------------------------------------------------|
 * | councillor.ts runCouncillorAttempt `finally`               | awaited  | a councillor result is counted only after its child stop settles        |
 * | aggregator.ts synthesizeWithAggregator `finally`           | awaited  | the aggregation is returned only after its child stop settles           |
 * | session.ts createChildSession post-create hard-cap guard   | awaited  | the late child is stopped before the create call rejects                |
 * | councillor.ts phase-timeout callback                       | detached | a timed-out councillor must fail immediately                            |
 * | aggregator.ts phase-timeout callback                       | detached | a timed-out aggregator must fail immediately                            |
 * | session.ts createChildSession late-quorum guard            | detached | a reviewer created after quorum must fail immediately                   |
 * | orchestrator.ts laggard abort sweep                        | detached | aggregation must not wait for laggards to stop                          |
 * | orchestrator.ts hard-cap callback                          | detached | the hard cap must reject immediately                                    |
 * | orchestrator.ts cancellation sweep (host abort signal)     | detached | a cancelled review must settle immediately; shared `deadline`           |
 * | session.ts createChildSession cancelled-after-create guard | detached | a child created after cancellation stops itself; shared `deadline`      |
 * | session.ts late create after cancellation (create pending) | detached | same as above, once the pending create resolves                         |
 * | session.ts createChildSession expired-attempt guard       | detached | create resolved after the phase timeout returned; never prompted        |
 *
 * Detached call sites rely on `stopChild` never rejecting. Once a review is
 * cancelled, the awaited call sites stop waiting (`awaitStop` races the
 * cancellation) and the councillor/aggregator `finally` skips its own stop
 * because the sweep already stopped every tracked child.
 */
import type { Logger } from "./logging.js";
import type { CouncilConfig, ModelConfig } from "./types.js";

export type StopResult = { ok: true } | { ok: false; error: unknown };

export type StopOptions = {
  /**
   * Absolute epoch-ms deadline shared by every stop issued by one cancellation
   * sweep (including late-created children). Hosts with a bounded stop/settle
   * (V2 interrupt + wait) must give up by this time; hosts with fire-and-forget
   * stops (V1 `session.abort`) may ignore it.
   */
  deadline?: number;
};

/**
 * Host-specific child permission payload (V1: `{permission, pattern, action}`
 * rules; V2: `{action, resource, effect}` rules). Core passes it through unchanged.
 */
export type ChildPermission = ReadonlyArray<Readonly<Record<string, string>>>;

export type PrepareReviewInput = {
  parentSessionID: string;
  councilConfig: CouncilConfig;
  /** Workspace permission captured by the host's config hook (V1 only; V2 ignores it). */
  workspacePermission: unknown;
  log: Logger;
};

export type ReviewPreparation = {
  /** Directory children run in (V1). V2 children inherit the parent location via parentID. */
  directory: string;
  reviewerPermission: ChildPermission;
  aggregatorPermission?: ChildPermission;
};

export type CreateChildInput = {
  parentID: string;
  title: string;
  directory: string;
  permission?: ChildPermission;
  /** Agent and configured model of the child. V2 sets them at create; V1 sets them per prompt. */
  agent?: string;
  model?: ModelConfig;
};

export type RunChildInput = {
  sessionID: string;
  agent: string;
  prompt: string;
  model?: ModelConfig;
  tools?: Record<string, boolean>;
  /** True once the owning review is cancelled; hosts stop processing the child's result. */
  isCancelled?: () => boolean;
};

export interface CouncilHost {
  /**
   * Once per review, before any child exists: resolve where children run and
   * compose the reviewer/aggregator child permissions (host permission model).
   */
  prepareReview(input: PrepareReviewInput): Promise<ReviewPreparation>;
  /** Create a child session; resolves its id or rejects with a descriptive error. */
  createChild(input: CreateChildInput): Promise<string>;
  /** Prompt a fresh child once and resolve its final assistant text; rejects on failure or empty output. */
  runChild(input: RunChildInput): Promise<string>;
  /**
   * Stop a child session. Never rejects; failures are reported in the result.
   * `{ ok: true }` means the stop is confirmed (the child no longer runs).
   */
  stopChild(sessionID: string, options?: StopOptions): Promise<StopResult>;
  /** The host's structured logger (debug-gated). */
  log: Logger;
}
