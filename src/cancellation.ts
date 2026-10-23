/**
 * Review-level cancellation (E1). One `Cancellation` per review that has a host
 * abort signal. Every awaited host operation in core is raced against
 * `cancellation.promise` so a cancelled review settles even if a host call never
 * resolves.
 */

/** Budget for stopping children in one cancellation sweep (shared per review). */
export const CANCEL_STOP_BUDGET_MS = 5_000;

export class CouncilCancelledError extends Error {
  constructor() {
    super("council_review cancelled");
    this.name = "CouncilCancelledError";
  }
}

export type Cancellation = {
  readonly cancelled: boolean;
  /** Absolute epoch-ms stop deadline fixed when the sweep starts; undefined before. */
  readonly stopDeadline: number | undefined;
  /** Rejects with CouncilCancelledError on cancel; never resolves. */
  readonly promise: Promise<never>;
  /** Returns false if already cancelled. */
  cancel(stopDeadline: number): boolean;
};

export function createCancellation(): Cancellation {
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<never>((_, reject) => {
    rejectPromise = reject;
  });
  // Races observe the rejection; this marks the source handled when no race is pending.
  promise.catch(() => {});
  let cancelled = false;
  let stopDeadline: number | undefined;

  return {
    get cancelled() {
      return cancelled;
    },
    get stopDeadline() {
      return stopDeadline;
    },
    promise,
    cancel(deadline) {
      if (cancelled) return false;
      cancelled = true;
      stopDeadline = deadline;
      rejectPromise(new CouncilCancelledError());
      return true;
    },
  };
}

/**
 * Race a host operation against review cancellation. Returns `operation` itself
 * when the review is not cancellable, so non-cancellable reviews keep their
 * exact pre-cancellation scheduling.
 */
export function raceCancellation<T>(
  operation: Promise<T>,
  cancellation: Cancellation | undefined,
): Promise<T> {
  return cancellation ? Promise.race([operation, cancellation.promise]) : operation;
}

/**
 * Await a child stop at an awaited call site (see host.ts table), but stop
 * waiting — without throwing — once the review is cancelled; the cancellation
 * sweep owns stopping from then on. Returns `stop` itself when the review is not
 * cancellable.
 */
export function awaitStop(
  stop: Promise<unknown>,
  cancellation: Cancellation | undefined,
): Promise<unknown> {
  return cancellation
    ? Promise.race([stop, cancellation.promise]).catch(() => undefined)
    : stop;
}
