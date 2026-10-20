// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/listener-ownership.test.ts
// Local modifications (see test/PROVENANCE.md): none.
import { describe, expect, it } from "vitest";

import { DEFAULT_LISTENER_CLOSE_MS, createListenerOwnership } from "./listener-ownership.mjs";

// Fake listeners only: close() returns a promise the test settles. No socket is opened.
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const fakeListener = (behavior: () => Promise<void> | void = () => undefined) => {
  const listener = { closes: 0, close: () => (listener.closes += 1, behavior()) };
  return listener;
};
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("listener ownership: one shared, confirmed close attempt per listener", () => {
  it("repeated and concurrent closes share one attempt and see the same confirmed outcome", async () => {
    const gate = deferred();
    const listener = fakeListener(() => gate.promise);
    const owned = createListenerOwnership();
    owned.register("/root", { group: "preflight", label: "preflight ipv4", listener });
    const first = owned.closeGroup("/root", "preflight");
    const second = owned.closeAll("/root");
    await tick();
    expect(listener.closes).toBe(1);
    expect(owned.report("/root")).toEqual([{ group: "preflight", label: "preflight ipv4", status: "closing" }]);
    gate.resolve();
    expect(await first).toEqual([{ group: "preflight", label: "preflight ipv4", status: "closed" }]);
    expect(await second).toEqual(await first);
    expect(await owned.closeAll("/root")).toEqual(await first);
    expect(listener.closes).toBe(1);
    expect(owned.unconfirmed("/root")).toEqual([]);
  });
});

describe("listener ownership: bounded close deadline (independent of the work signal)", () => {
  it("defaults to a 1000 ms listener close deadline", () => {
    expect(DEFAULT_LISTENER_CLOSE_MS).toBe(1000);
  });

  it("an unconfirmed close times out, stays unconfirmed, and a late confirmation never promotes it to closed", async () => {
    const gate = deferred();
    const owned = createListenerOwnership({ closeMs: 20 });
    owned.register("/root", { group: "registry", label: "registry", listener: fakeListener(() => gate.promise) });
    const started = Date.now();
    expect(await owned.closeAll("/root")).toEqual([{ group: "registry", label: "registry", status: "timeout", error: "close not confirmed within 20ms" }]);
    expect(Date.now() - started).toBeLessThan(1000);
    gate.resolve();
    await tick();
    expect(owned.report("/root")).toEqual([{ group: "registry", label: "registry", status: "timeout", error: "close not confirmed within 20ms" }]);
    expect(await owned.closeAll("/root")).toEqual(owned.report("/root"));
    expect(owned.unconfirmed("/root")).toEqual(["registry"]);
  });

  it("a rejection after the deadline is observed (no unhandled rejection) and the outcome stays timeout", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const gate = deferred();
      const owned = createListenerOwnership({ closeMs: 20 });
      owned.register("/root", { group: "preflight", label: "preflight unix", listener: fakeListener(() => gate.promise) });
      expect((await owned.closeAll("/root"))[0].status).toBe("timeout");
      gate.reject(new Error("late close failure"));
      await tick(20);
      expect(unhandled).toEqual([]);
      expect(owned.report("/root")[0].status).toBe("timeout");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("listener ownership: failures are sticky and never stop the other closes", () => {
  it("attempts every listener even when one rejects or throws synchronously; failures stay failed", async () => {
    const owned = createListenerOwnership({ closeMs: 50 });
    const a = fakeListener();
    const b = fakeListener(() => Promise.reject(new Error("ERR_SERVER_NOT_RUNNING")));
    const c = fakeListener(() => {
      throw new Error("sync close failure");
    });
    const d = fakeListener();
    owned.register("/root", { group: "preflight", label: "preflight ipv4", listener: a });
    owned.register("/root", { group: "preflight", label: "preflight ipv6", listener: b });
    owned.register("/root", { group: "preflight", label: "preflight unix", listener: c });
    owned.register("/root", { group: "registry", label: "registry", listener: d });
    expect(await owned.closeGroup("/root", "preflight")).toEqual([
      { group: "preflight", label: "preflight ipv4", status: "closed" },
      { group: "preflight", label: "preflight ipv6", status: "failed", error: "ERR_SERVER_NOT_RUNNING" },
      { group: "preflight", label: "preflight unix", status: "failed", error: "sync close failure" },
    ]);
    expect(d.closes).toBe(0); // other groups are untouched by a group close
    await owned.closeAll("/root");
    expect([a, b, c, d].map((listener) => listener.closes)).toEqual([1, 1, 1, 1]);
    expect(owned.unconfirmed("/root")).toEqual(["preflight ipv6", "preflight unix"]);
    expect(JSON.parse(JSON.stringify(owned.report("/root")))).toEqual(owned.report("/root"));
  });

  it("an unknown fixture has no listeners to report or close", async () => {
    const owned = createListenerOwnership();
    expect(owned.report("/nowhere")).toEqual([]);
    expect(await owned.closeAll("/nowhere")).toEqual([]);
    expect(owned.unconfirmed("/nowhere")).toEqual([]);
  });
});
