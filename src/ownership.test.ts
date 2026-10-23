import { describe, expect, it, vi } from "vitest";

import type { CouncilHost, StopResult } from "./host";
import {
  createChildRegistry,
  OWNED_CHILD_WARN_THRESHOLD,
  withChildOwnership,
} from "./ownership";
import { createChildSession } from "./session";
import type { ReviewState } from "./types";

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function fakeHost(stopChild: (id: string) => Promise<StopResult>): CouncilHost {
  let next = 0;
  return {
    prepareReview: async () => ({ directory: "/dir", reviewerPermission: [] }),
    createChild: async () => `child-${++next}`,
    runChild: async () => "response",
    stopChild: vi.fn(stopChild),
    log: vi.fn(),
  };
}

function reviewState(overrides: Partial<ReviewState> = {}): ReviewState {
  return { activeSessions: new Set(), hardCapTimedOut: false, quorumReached: false, ...overrides };
}

describe("child ownership registry", () => {
  it("owns a child as soon as create resolves", async () => {
    const registry = createChildRegistry(vi.fn());
    const host = withChildOwnership(fakeHost(() => never()), registry);

    const id = await host.createChild({ parentID: "parent", title: "t", directory: "/dir" });

    expect(registry.has(id)).toBe(true);
    expect(registry.has("parent")).toBe(false);
  });

  it("owns a child before the post-create hard-cap guard stops it", async () => {
    const registry = createChildRegistry(vi.fn());
    const state = reviewState();
    const inner = fakeHost(() => never());
    inner.createChild = async () => {
      state.hardCapTimedOut = true;
      return "late-child";
    };
    const host = withChildOwnership(inner, registry);

    void createChildSession(host, "parent", "t", "/dir", undefined, state).catch(() => {});
    await flush();

    expect(inner.stopChild).toHaveBeenCalledWith("late-child", undefined);
    expect(registry.has("late-child")).toBe(true);
  });

  it("releases a child only when its stop is confirmed", async () => {
    const registry = createChildRegistry(vi.fn());
    const host = withChildOwnership(fakeHost(async () => ({ ok: true })), registry);
    const id = await host.createChild({ parentID: "parent", title: "t", directory: "/dir" });

    await expect(host.stopChild(id)).resolves.toEqual({ ok: true });

    expect(registry.has(id)).toBe(false);
  });

  it("retains a child whose stop reports an error", async () => {
    const registry = createChildRegistry(vi.fn());
    const host = withChildOwnership(
      fakeHost(async () => ({ ok: false, error: "abort failed" })),
      registry,
    );
    const id = await host.createChild({ parentID: "parent", title: "t", directory: "/dir" });

    await expect(host.stopChild(id)).resolves.toEqual({ ok: false, error: "abort failed" });

    expect(registry.has(id)).toBe(true);
  });

  it("retains a child whose stop rejects, and never rejects itself", async () => {
    const registry = createChildRegistry(vi.fn());
    const failure = new Error("host broke the contract");
    const host = withChildOwnership(fakeHost(() => Promise.reject(failure)), registry);
    const id = await host.createChild({ parentID: "parent", title: "t", directory: "/dir" });

    await expect(host.stopChild(id)).resolves.toEqual({ ok: false, error: failure });

    expect(registry.has(id)).toBe(true);
  });

  it("retains a child whose stop never settles", async () => {
    const registry = createChildRegistry(vi.fn());
    const host = withChildOwnership(fakeHost(() => never()), registry);
    const id = await host.createChild({ parentID: "parent", title: "t", directory: "/dir" });

    void host.stopChild(id);
    await flush();

    expect(registry.has(id)).toBe(true);
  });

  it("keeps protecting more than the warn threshold of unconfirmed children and warns once", async () => {
    const warn = vi.fn();
    const registry = createChildRegistry(warn);
    const host = withChildOwnership(fakeHost(() => never()), registry);
    const ids: string[] = [];

    for (let i = 0; i < OWNED_CHILD_WARN_THRESHOLD + 10; i++) {
      const id = await host.createChild({ parentID: "parent", title: "t", directory: "/dir" });
      void host.stopChild(id);
      ids.push(id);
    }
    await flush();

    expect(OWNED_CHILD_WARN_THRESHOLD).toBe(256);
    expect(ids.every((id) => registry.has(id))).toBe(true);
    expect(registry.size).toBe(266);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn at exactly the threshold", async () => {
    const warn = vi.fn();
    const registry = createChildRegistry(warn);
    for (let i = 0; i < OWNED_CHILD_WARN_THRESHOLD; i++) registry.add(`child-${i}`);

    expect(warn).not.toHaveBeenCalled();
    registry.add("one-more");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clear() drops every owned child", () => {
    const registry = createChildRegistry(vi.fn());
    registry.add("a");
    registry.add("b");

    registry.clear();

    expect(registry.has("a")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("passes stop options through to the host", async () => {
    const registry = createChildRegistry(vi.fn());
    const inner = fakeHost(async () => ({ ok: true }));
    const host = withChildOwnership(inner, registry);

    await host.stopChild("child", { deadline: 1234 });

    expect(inner.stopChild).toHaveBeenCalledWith("child", { deadline: 1234 });
  });
});

describe("child ownership registry listing", () => {
  it("lists currently owned children for plugin cleanup", () => {
    const registry = createChildRegistry(vi.fn());
    registry.add("a");
    registry.add("b");
    registry.release("a");

    expect(registry.ids()).toEqual(["b"]);
  });
});
