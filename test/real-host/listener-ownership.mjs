// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/listener-ownership.mjs
// Local modifications (see test/PROVENANCE.md): none.
// Fixture-associated listener ownership (Amendment A2).
//
// Every listener the runtime opens for a fixture is registered here the moment
// it exists. Closing follows one contract for preflight and registry listeners:
//   - each listener has ONE close attempt; repeated and concurrent callers share
//     it and see the same outcome;
//   - a listener counts as closed only when its close() resolves (the physical
//     adapter resolves only on the server.close callback);
//   - a rejection is a sticky "failed" outcome; it is observed here, so it can
//     never surface as an unhandled rejection;
//   - a separate close deadline (default 1000 ms, injectable) bounds the wait.
//     It is independent of the run-wide work signal and the pilot work timer.
//     On expiry the outcome is a sticky "timeout": the listener stays
//     unconfirmed (a bounded wait cannot prove the OS closed it), and a late
//     confirmation or rejection never changes the outcome.
// Outcomes stay available after closing so evidence collection and the root
// removal gate can report them. Nothing here signals or kills anything.

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

export const DEFAULT_LISTENER_CLOSE_MS = 1000;

export function createListenerOwnership({ closeMs = DEFAULT_LISTENER_CLOSE_MS, timers = { setTimeout, clearTimeout } } = {}) {
  /** root -> Array<{ group, label, listener, attempt, outcome }> */
  const byRoot = new Map();
  const entriesOf = (root) => byRoot.get(root) ?? [];

  function attempt(entry) {
    entry.attempt ??= new Promise((resolve) => {
      let timer = null;
      const settle = (outcome) => {
        if (entry.outcome) return;
        if (timer !== null) timers.clearTimeout(timer);
        entry.outcome = { group: entry.group, label: entry.label, ...outcome };
        resolve(entry.outcome);
      };
      timer = timers.setTimeout(() => settle({ status: "timeout", error: `close not confirmed within ${closeMs}ms` }), closeMs);
      let closing;
      try {
        closing = Promise.resolve(entry.listener.close());
      } catch (error) {
        closing = Promise.reject(error);
      }
      closing.then(
        () => settle({ status: "closed" }),
        (error) => settle({ status: "failed", error: messageOf(error) }),
      );
    });
    return entry.attempt;
  }

  const plain = (entry) => entry.outcome ?? { group: entry.group, label: entry.label, status: entry.attempt ? "closing" : "open" };

  return {
    register(root, { group, label, listener }) {
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push({ group, label, listener, attempt: null, outcome: null });
    },
    /** Attempts every listener in the group (never rejects); resolves to plain outcomes. */
    closeGroup(root, group) {
      return Promise.all(entriesOf(root).filter((entry) => entry.group === group).map(attempt));
    },
    /** Attempts every listener of the fixture (never rejects); resolves to plain outcomes. */
    closeAll(root) {
      return Promise.all(entriesOf(root).map(attempt));
    },
    /** Plain, serializable status of every listener registered for the fixture. */
    report(root) {
      return entriesOf(root).map(plain);
    },
    /** Labels of listeners not confirmed closed (open, closing, failed, or timed out). */
    unconfirmed(root) {
      return entriesOf(root).filter((entry) => entry.outcome?.status !== "closed").map((entry) => entry.label);
    },
  };
}
