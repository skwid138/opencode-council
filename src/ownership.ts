/**
 * Child ownership registry (one per plugin instance, shared by every review of
 * that instance; never module-global).
 *
 * - A child is owned from the moment its create resolves (before any core
 *   hard-cap / quorum / cancellation guard runs and before its first prompt).
 * - A child is released only on a CONFIRMED stop (`stopChild` -> `{ ok: true }`).
 *   Failed, rejected, or never-settling stops keep the child owned until plugin
 *   cleanup (`clear()`). There is no eviction.
 * - Membership backs the `council_review` recursion guard (and, on V2, the
 *   ask -> deny evaluate hook).
 */
import type { CouncilHost, StopResult } from "./host.js";

export const OWNED_CHILD_WARN_THRESHOLD = 256;

export type ChildRegistry = {
  add(sessionID: string): void;
  has(sessionID: string): boolean;
  release(sessionID: string): void;
  /** Snapshot of currently owned (not yet confirmed-stopped) children. */
  ids(): string[];
  clear(): void;
  readonly size: number;
};

export function createChildRegistry(
  warn: (message: string, extra?: Record<string, unknown>) => void,
): ChildRegistry {
  const owned = new Set<string>();
  let warned = false;

  return {
    add(sessionID) {
      owned.add(sessionID);
      if (!warned && owned.size > OWNED_CHILD_WARN_THRESHOLD) {
        warned = true;
        warn(
          `council child ownership registry retains more than ${OWNED_CHILD_WARN_THRESHOLD} unconfirmed child sessions; they remain protected until plugin cleanup`,
          { count: owned.size },
        );
      }
    },
    has(sessionID) {
      return owned.has(sessionID);
    },
    release(sessionID) {
      owned.delete(sessionID);
    },
    ids() {
      return [...owned];
    },
    clear() {
      owned.clear();
    },
    get size() {
      return owned.size;
    },
  };
}

/** Decorate a host so every child it creates is owned until its stop is confirmed. */
export function withChildOwnership(host: CouncilHost, registry: ChildRegistry): CouncilHost {
  return {
    log: host.log,
    prepareReview: (input) => host.prepareReview(input),
    createChild: (input) =>
      host.createChild(input).then((sessionID) => {
        registry.add(sessionID);
        return sessionID;
      }),
    runChild: (input) => host.runChild(input),
    stopChild(sessionID, options) {
      let stop: Promise<StopResult>;
      try {
        stop = host.stopChild(sessionID, options);
      } catch (error) {
        return Promise.resolve({ ok: false, error });
      }
      return stop.then(
        (result) => {
          if (result.ok) registry.release(sessionID);
          return result;
        },
        (error: unknown): StopResult => ({ ok: false, error }),
      );
    },
  };
}
