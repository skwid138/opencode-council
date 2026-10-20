import { afterEach, describe, expect, it, vi } from "vitest";

import type { CouncilHost, StopOptions, StopResult } from "./host";
import { runCouncilReview } from "./orchestrator";
import type { CouncilConfig } from "./types";
import { createV1Host } from "./v1";

const CANCELLED = "Council review cancelled.";
const MODEL_A = { providerID: "provider-a", modelID: "model-a" };
const MODEL_B = { providerID: "provider-b", modelID: "model-b" };
const MODEL_C = { providerID: "provider-c", modelID: "model-c" };
const AGGREGATOR_TITLE = "council: aggregator synthesis";

type SdkResult = Record<string, unknown>;

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function settle(ms = 20) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionIdForTitle(title: string): string {
  if (title === AGGREGATOR_TITLE) return "aggregator-session";
  return `reviewer-${title.slice(-1)}`;
}

function createSdkSession() {
  return {
    get: vi.fn(
      async (_input: { path: { id: string } }): Promise<SdkResult> => ({
        data: { directory: "/parent-directory" },
      }),
    ),
    create: vi.fn(
      async (input: { body: { title: string } }): Promise<SdkResult> => ({
        data: { id: sessionIdForTitle(input.body.title) },
      }),
    ),
    prompt: vi.fn(async (_input: { path: { id: string } }): Promise<SdkResult> => ({})),
    messages: vi.fn(async (input: { path: { id: string } }) => ({
      data: [
        {
          info: { role: "assistant", time: { created: 1 } },
          parts: [
            {
              type: "text",
              text:
                input.path.id === "aggregator-session"
                  ? "aggregated response"
                  : `response from ${input.path.id}`,
            },
          ],
        },
      ],
    })),
    abort: vi.fn(async (_input: { path: { id: string } }): Promise<SdkResult> => ({})),
  };
}

function hostFor(session: ReturnType<typeof createSdkSession>) {
  return createV1Host({ client: { session }, directory: "/fallback-directory" } as never);
}

function councilConfig(overrides: Partial<CouncilConfig> = {}): CouncilConfig {
  return {
    reviewer: "reviewer",
    aggregator: "aggregator",
    debug: false,
    models: [MODEL_A, MODEL_B],
    quorum: 2,
    aggregator_model: null,
    reviewer_temperature: null,
    reviewer_permission: null,
    aggregator_permission: null,
    timeouts: {
      councillor_ms: 60_000,
      optional_councillor_ms: 60_000,
      aggregator_ms: 60_000,
      quorum_grace_ms: 0,
      hard_cap_ms: 200_000,
    },
    ...overrides,
  };
}

function review(
  host: CouncilHost,
  signal: AbortSignal,
  config: CouncilConfig = councilConfig(),
) {
  return runCouncilReview(host, config, vi.fn(), undefined, "review this", "parent-session", {
    signal,
  });
}

function abortIds(session: ReturnType<typeof createSdkSession>) {
  return session.abort.mock.calls.map(([input]) => input.path.id);
}

function createTitles(session: ReturnType<typeof createSdkSession>) {
  return session.create.mock.calls.map(([input]) => input.body.title);
}

function captureUnhandledRejections() {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", handler);
  return { seen, dispose: () => process.off("unhandledRejection", handler) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("council review cancellation sweep", () => {
  it("returns the cancellation result immediately for an already-aborted signal", async () => {
    const session = createSdkSession();
    const controller = new AbortController();
    controller.abort();

    await expect(review(hostFor(session), controller.signal)).resolves.toBe(CANCELLED);

    expect(session.get).not.toHaveBeenCalled();
    expect(session.create).not.toHaveBeenCalled();
  });

  it("settles when cancelled during the parent directory lookup", async () => {
    const session = createSdkSession();
    session.get.mockImplementation(() => never());
    const controller = new AbortController();

    const result = review(hostFor(session), controller.signal);
    await settle();
    controller.abort();

    await expect(result).resolves.toBe(CANCELLED);
    expect(session.create).not.toHaveBeenCalled();
  });

  it("emits no permission-preparation logs while the V1 parent lookup is pending", async () => {
    const session = createSdkSession();
    session.get.mockImplementation(() => never());
    const controller = new AbortController();
    const log = vi.fn();

    const result = runCouncilReview(
      hostFor(session),
      councilConfig(),
      log,
      { bash: { "sudo *": "ask" } },
      "review this",
      "parent-session",
      { signal: controller.signal },
    );
    await settle();
    expect(session.get).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    controller.abort();

    await expect(result).resolves.toBe(CANCELLED);
    expect(log.mock.calls.filter(([, message]) => String(message).includes("Stripping ask")))
      .toEqual([]);
    expect(log.mock.calls.filter(([, message]) => message === "buildReviewerRuleset permission output"))
      .toEqual([]);
  });

  it("does not read V1 messages for a child whose prompt resolves after cancellation", async () => {
    const session = createSdkSession();
    const promptA = deferred<SdkResult>();
    const promptB = deferred<SdkResult>();
    session.prompt.mockImplementation((input) =>
      input.path.id === "reviewer-a" ? promptA.promise : promptB.promise,
    );
    const controller = new AbortController();

    const result = review(hostFor(session), controller.signal);
    await settle();
    expect(session.prompt).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(result).resolves.toBe(CANCELLED);

    promptA.resolve({});
    promptB.resolve({});
    await settle();

    expect(session.messages).not.toHaveBeenCalled();
  });

  it("settles when cancelled during child create and stops children created late", async () => {
    const session = createSdkSession();
    const createA = deferred<SdkResult>();
    const createB = deferred<SdkResult>();
    session.create.mockImplementation((input) =>
      input.body.title.endsWith("model-a") ? createA.promise : createB.promise,
    );
    const controller = new AbortController();
    const unhandled = captureUnhandledRejections();

    try {
      const result = review(hostFor(session), controller.signal);
      await settle();
      expect(session.create).toHaveBeenCalledTimes(2);
      controller.abort();

      await expect(result).resolves.toBe(CANCELLED);

      createA.resolve({ data: { id: "reviewer-a" } });
      createB.reject(new Error("late create failure"));
      await settle();

      expect(abortIds(session)).toEqual(["reviewer-a"]);
      expect(session.prompt).not.toHaveBeenCalled();
      expect(createTitles(session)).not.toContain(AGGREGATOR_TITLE);
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.dispose();
    }
  });

  it("stops running councillors and never starts the aggregator when cancelled during the councillor run", async () => {
    const session = createSdkSession();
    session.prompt.mockImplementation(() => never());
    const controller = new AbortController();

    const result = review(hostFor(session), controller.signal);
    await settle();
    expect(session.prompt).toHaveBeenCalledTimes(2);
    controller.abort();

    await expect(result).resolves.toBe(CANCELLED);
    expect(abortIds(session)).toEqual(["reviewer-a", "reviewer-b"]);
    expect(createTitles(session)).not.toContain(AGGREGATOR_TITLE);
  });

  it("does not wait on a never-settling child stop during the sweep", async () => {
    const session = createSdkSession();
    session.prompt.mockImplementation(() => never());
    session.abort.mockImplementation(() => never());
    const controller = new AbortController();

    const result = review(hostFor(session), controller.signal);
    await settle();
    controller.abort();

    await expect(result).resolves.toBe(CANCELLED);
    expect(abortIds(session)).toEqual(["reviewer-a", "reviewer-b"]);
  });

  it("clears the quorum grace, hard-cap, and phase timers when cancelled during the grace window", async () => {
    vi.useFakeTimers();
    const session = createSdkSession();
    session.prompt.mockImplementation((input) =>
      input.path.id === "reviewer-c" ? never() : Promise.resolve({}),
    );
    const controller = new AbortController();

    const result = review(
      hostFor(session),
      controller.signal,
      councilConfig({
        models: [MODEL_A, MODEL_B, MODEL_C],
        quorum: 2,
        timeouts: { ...councilConfig().timeouts, quorum_grace_ms: 10_000 },
      }),
    );
    await flushMicrotasks();
    await flushMicrotasks();
    expect(abortIds(session)).toEqual(["reviewer-a", "reviewer-b"]);
    controller.abort();
    await flushMicrotasks();

    await expect(result).resolves.toBe(CANCELLED);
    expect(abortIds(session)).toEqual(["reviewer-a", "reviewer-b", "reviewer-c"]);
    expect(createTitles(session)).not.toContain(AGGREGATOR_TITLE);
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the aggregator child when cancelled during aggregation", async () => {
    const session = createSdkSession();
    session.prompt.mockImplementation((input) =>
      input.path.id === "aggregator-session" ? never() : Promise.resolve({}),
    );
    const controller = new AbortController();

    const result = review(hostFor(session), controller.signal);
    await settle();
    expect(createTitles(session)).toContain(AGGREGATOR_TITLE);
    controller.abort();

    await expect(result).resolves.toBe(CANCELLED);
    expect(abortIds(session)).toEqual(["reviewer-a", "reviewer-b", "aggregator-session"]);
  });

  it("ignores late councillor completion and late rejection after cancel without unhandled rejections", async () => {
    const session = createSdkSession();
    const promptA = deferred<SdkResult>();
    const promptB = deferred<SdkResult>();
    session.prompt.mockImplementation((input) =>
      input.path.id === "reviewer-a" ? promptA.promise : promptB.promise,
    );
    const controller = new AbortController();
    const unhandled = captureUnhandledRejections();

    try {
      const result = review(hostFor(session), controller.signal);
      await settle();
      controller.abort();
      await expect(result).resolves.toBe(CANCELLED);

      promptA.resolve({});
      promptB.reject(new Error("late prompt failure"));
      await settle();

      expect(createTitles(session)).not.toContain(AGGREGATOR_TITLE);
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.dispose();
    }
  });

  it("gives every stop in one sweep, including late-created children, the same deadline", async () => {
    const stops: Array<{ id: string; options?: StopOptions }> = [];
    const lateCreate = deferred<string>();
    let creates = 0;
    const host: CouncilHost = {
      prepareReview: async () => ({ directory: "/dir", reviewerPermission: [] }),
      createChild: async () => {
        creates++;
        return creates === 1 ? "reviewer-a" : await lateCreate.promise;
      },
      runChild: () => never(),
      stopChild: async (id, options): Promise<StopResult> => {
        stops.push({ id, options });
        return { ok: true };
      },
      log: vi.fn(),
    };
    const controller = new AbortController();
    const before = Date.now();

    const result = review(host, controller.signal);
    await settle();
    controller.abort();
    await expect(result).resolves.toBe(CANCELLED);
    lateCreate.resolve("reviewer-b");
    await settle();

    expect(stops.map((stop) => stop.id)).toEqual(["reviewer-a", "reviewer-b"]);
    const deadline = stops[0].options?.deadline;
    expect(deadline).toBeGreaterThanOrEqual(before + 5_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(stops[1].options?.deadline).toBe(deadline);
  });
});
