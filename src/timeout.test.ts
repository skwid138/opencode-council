import { describe, expect, it, vi } from "vitest";

import { formatSeconds, raceWithTimeout } from "./timeout";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("formatSeconds", () => {
  it("rounds milliseconds to whole seconds", () => {
    expect(formatSeconds(250)).toBe("0s");
    expect(formatSeconds(1_500)).toBe("2s");
  });
});

describe("raceWithTimeout", () => {
  it("returns a value when the promise resolves before the timeout", async () => {
    await expect(
      raceWithTimeout(Promise.resolve("ok"), 250, "fast operation"),
    ).resolves.toBe("ok");
  });

  it("rejects with the label and duration when the timeout wins", async () => {
    const pending = deferred<string>();

    await expect(
      raceWithTimeout(pending.promise, 250, "slow operation"),
    ).rejects.toThrow(/slow operation timed out after \d+s/);

    pending.resolve("late");
  });

  it("runs onTimeout when the timeout wins", async () => {
    const pending = deferred<string>();
    const onTimeout = vi.fn();

    await expect(
      raceWithTimeout(pending.promise, 1, "slow operation", onTimeout),
    ).rejects.toThrow("slow operation timed out after 0s");

    expect(onTimeout).toHaveBeenCalledTimes(1);
    pending.resolve("late");
  });
});
