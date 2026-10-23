// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/provider-startup.mjs
// Local modifications (see test/PROVENANCE.md): none.
// Provider-specific startup wait (Amendment A3).
//
// The fake provider is ready only once its port file is non-empty. Readiness
// alone is not enough: the owned launcher can exit before readiness (code 0,
// a nonzero code, or a signal), and that must fail at once instead of waiting
// out the startup deadline. Outcomes:
//   ready | exited-before-ready | startup-timeout | work-aborted
//
// Precedence at each decision point, including the recheck after every
// awaited readiness read: an already observed work abort wins, then an already
// observable exit beats readiness. This cannot eliminate races with the OS
// exit notification; it only decides on what has been observed.
//
// Every path disposes of its poll timer and abort listener, and no poll is
// scheduled after the wait settles. A late exit notification is absorbed.
export async function waitForProviderStartup({ isReady, exited, signal = null, timeoutMs, pollMs, timers = { setTimeout, clearTimeout }, now = Date.now }) {
  let exit = null;
  let wake = null;
  const onWake = () => wake?.();
  if (exited && typeof exited.then === "function") {
    exited.then(
      (value) => {
        exit = { code: value?.code ?? null, signal: value?.signal ?? null };
        onWake();
      },
      () => undefined,
    );
  }
  signal?.addEventListener?.("abort", onWake);
  const deadline = now() + timeoutMs;
  const decide = (ready) => {
    if (signal?.aborted) return { outcome: "work-aborted" };
    if (exit) return { outcome: "exited-before-ready", exit };
    if (ready) return { outcome: "ready" };
    return null;
  };
  try {
    for (;;) {
      const before = decide(false);
      if (before) return before;
      const ready = await isReady();
      const after = decide(ready);
      if (after) return after;
      const remaining = deadline - now();
      if (remaining <= 0) return { outcome: "startup-timeout" };
      await new Promise((resolve) => {
        const timer = timers.setTimeout(() => done(), Math.min(pollMs, remaining));
        function done() {
          timers.clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });
    }
  } finally {
    wake = null;
    signal?.removeEventListener?.("abort", onWake);
  }
}
