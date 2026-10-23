// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/signals.mjs
// Local modifications (see test/PROVENANCE.md): none.
// Signal routing for the real-host runner. A first SIGINT/SIGTERM aborts the
// run and stops owned process groups immediately; the runner then still
// collects evidence, applies the retention gate, writes the report, and exits
// non-zero. Only a second signal exits at once (after stopping owned groups
// again), so an operator can always get out.

export function installSignalHandlers({ controller, supervisor, proc = process, signals = ["SIGINT", "SIGTERM"] }) {
  let count = 0;
  const failures = [];
  const handler = async (signal) => {
    count += 1;
    controller.abort();
    try {
      await supervisor.stopAll();
    } catch (error) {
      // Never an unhandled rejection: recorded and carried into the report as a failure.
      failures.push(`${signal} shutdown stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (count > 1) proc.exit(130);
  };
  const bound = signals.map((signal) => [signal, () => handler(signal)]);
  for (const [signal, listener] of bound) proc.on(signal, listener);
  return {
    uninstall: () => {
      for (const [signal, listener] of bound) proc.off(signal, listener);
    },
    failures: () => [...failures],
  };
}

/** 130 aborted; 0 only for a complete matrix or a passed pilot verdict; otherwise 1. */
export function exitCodeFor({ aborted, report, pilot }) {
  if (aborted) return 130;
  if (report.status === "complete") return 0;
  if (pilot?.passed) return 0;
  return 1;
}
