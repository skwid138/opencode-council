// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/provider-startup.test.ts
// Local modifications (see test/PROVENANCE.md): none.
import { describe, expect, it } from "vitest";

import { waitForProviderStartup } from "./provider-startup.mjs";

// Pure, socket-free: readiness, exit, abort, and timers are all injected.
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
};
const never = new Promise<never>(() => {});
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("provider startup wait: an exit before readiness fails", () => {
  it.each([
    ["exit code 0", { code: 0, signal: null }],
    ["a nonzero exit code", { code: 1, signal: null }],
    ["a signal", { code: null, signal: "SIGKILL" }],
  ])("%s before the port file appears is exited-before-ready (no timeout wait)", async (_label, exit) => {
    let reads = 0;
    const started = Date.now();
    const result = await waitForProviderStartup({ isReady: async () => (reads += 1, false), exited: Promise.resolve(exit), timeoutMs: 5_000, pollMs: 5 });
    expect(result).toEqual({ outcome: "exited-before-ready", exit });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("provider startup wait: timeout, readiness, and cancellation", () => {
  it("a pending exit with no port file times out after the startup budget", async () => {
    const started = Date.now();
    expect(await waitForProviderStartup({ isReady: async () => false, exited: never, timeoutMs: 30, pollMs: 5 })).toEqual({ outcome: "startup-timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("readiness with a pending exit is ready", async () => {
    let reads = 0;
    expect(await waitForProviderStartup({ isReady: async () => (reads += 1) >= 3, exited: never, timeoutMs: 5_000, pollMs: 1 })).toEqual({ outcome: "ready" });
    expect(reads).toBe(3);
  });

  it("a work abort during a deferred readiness read wins even if the read then reports ready", async () => {
    const read = deferred<boolean>();
    const work = new AbortController();
    const waiting = waitForProviderStartup({ isReady: () => read.promise, exited: never, signal: work.signal, timeoutMs: 5_000, pollMs: 5 });
    await tick();
    work.abort();
    read.resolve(true);
    expect(await waiting).toEqual({ outcome: "work-aborted" });
  });

  it("an exit observed during a deferred readiness read beats a ready read (post-await recheck)", async () => {
    const read = deferred<boolean>();
    const exit = deferred<{ code: number; signal: null }>();
    const waiting = waitForProviderStartup({ isReady: () => read.promise, exited: exit.promise, timeoutMs: 5_000, pollMs: 5 });
    await tick();
    exit.resolve({ code: 0, signal: null });
    read.resolve(true);
    expect(await waiting).toEqual({ outcome: "exited-before-ready", exit: { code: 0, signal: null } });
  });

  it("simultaneous readiness and a settled exit: the exit wins; an observed abort wins over both", async () => {
    const settled = Promise.resolve({ code: 0, signal: null });
    await settled;
    expect((await waitForProviderStartup({ isReady: async () => true, exited: settled, timeoutMs: 5_000, pollMs: 5 })).outcome).toBe("exited-before-ready");
    const work = new AbortController();
    work.abort();
    expect(await waitForProviderStartup({ isReady: async () => true, exited: settled, signal: work.signal, timeoutMs: 5_000, pollMs: 5 })).toEqual({ outcome: "work-aborted" });
  });

  it("an abort during the poll sleep wakes the wait at once (no full poll interval)", async () => {
    const work = new AbortController();
    const started = Date.now();
    const waiting = waitForProviderStartup({ isReady: async () => false, exited: never, signal: work.signal, timeoutMs: 60_000, pollMs: 30_000 });
    await tick(10);
    work.abort();
    expect(await waiting).toEqual({ outcome: "work-aborted" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("an exit during the poll sleep wakes the wait at once", async () => {
    const exit = deferred<{ code: null; signal: string }>();
    const started = Date.now();
    const waiting = waitForProviderStartup({ isReady: async () => false, exited: exit.promise, timeoutMs: 60_000, pollMs: 30_000 });
    await tick(10);
    exit.resolve({ code: null, signal: "SIGTERM" });
    expect(await waiting).toEqual({ outcome: "exited-before-ready", exit: { code: null, signal: "SIGTERM" } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("provider startup wait: disposal on every path", () => {
  const trackedTimers = () => {
    const live = new Set<ReturnType<typeof setTimeout>>();
    return {
      live,
      timers: {
        setTimeout: (fn: () => void, ms: number) => {
          const handle = setTimeout(() => {
            live.delete(handle);
            fn();
          }, ms);
          live.add(handle);
          return handle;
        },
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
          live.delete(handle);
          clearTimeout(handle);
        },
      },
    };
  };
  const trackedSignal = () => {
    const work = new AbortController();
    let listeners = 0;
    const signal = {
      get aborted() {
        return work.signal.aborted;
      },
      addEventListener: (type: string, fn: () => void) => {
        listeners += 1;
        work.signal.addEventListener(type, fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners -= 1;
        work.signal.removeEventListener(type, fn);
      },
    };
    return { work, signal, listeners: () => listeners };
  };

  it.each([
    ["ready", { ready: true, exit: never, abort: false, timeoutMs: 5_000 }],
    ["exited-before-ready", { ready: false, exit: Promise.resolve({ code: 3, signal: null }), abort: false, timeoutMs: 5_000 }],
    ["startup-timeout", { ready: false, exit: never, abort: false, timeoutMs: 20 }],
    ["work-aborted", { ready: false, exit: never, abort: true, timeoutMs: 5_000 }],
  ] as const)("%s leaves no live timer, no abort listener, and schedules no later read", async (outcome, setup) => {
    const { live, timers } = trackedTimers();
    const tracked = trackedSignal();
    let reads = 0;
    const waiting = waitForProviderStartup({ isReady: async () => (reads += 1, setup.ready), exited: setup.exit, signal: tracked.signal, timeoutMs: setup.timeoutMs, pollMs: 5, timers });
    if (setup.abort) {
      await tick(8);
      tracked.work.abort();
    }
    expect((await waiting).outcome).toBe(outcome);
    expect(live.size).toBe(0);
    expect(tracked.listeners()).toBe(0);
    const readsAtSettle = reads;
    await tick(30);
    expect(reads).toBe(readsAtSettle);
    expect(live.size).toBe(0);
  });

  it("a late exit after a ready decision is absorbed (no rejection, no new timer, no new read)", async () => {
    const { live, timers } = trackedTimers();
    const exit = deferred<{ code: number; signal: null }>();
    let reads = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(await waitForProviderStartup({ isReady: async () => (reads += 1, true), exited: exit.promise, timeoutMs: 5_000, pollMs: 5, timers })).toEqual({ outcome: "ready" });
      exit.resolve({ code: 1, signal: null });
      await tick(20);
      expect(unhandled).toEqual([]);
      expect(reads).toBe(1);
      expect(live.size).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
