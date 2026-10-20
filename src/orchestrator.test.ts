import { afterEach, describe, expect, it, vi } from "vitest";

import { runCouncilReview } from "./orchestrator";
import type { CouncilConfig } from "./types";
import { createV1Host } from "./v1";

const MODEL_A = { providerID: "provider-a", modelID: "model-a" };
const MODEL_B = { providerID: "provider-b", modelID: "model-b" };
const MODEL_C = { providerID: "provider-c", modelID: "model-c" };

function createSessionMocks() {
  return {
    get: vi.fn(async () => ({ data: { directory: "/parent-directory" } })),
    create: vi.fn(),
    prompt: vi.fn(),
    messages: vi.fn(),
    abort: vi.fn(async () => ({})),
  };
}

function createContext(session = createSessionMocks()) {
  return {
    client: { session },
    directory: "/fallback-directory",
  };
}

function assistantMessages(text: string) {
  return [
    {
      info: { role: "assistant", time: { created: 1 } },
      parts: [{ type: "text", text }],
    },
  ];
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function abortIds(session: ReturnType<typeof createSessionMocks>) {
  return (
    session.abort.mock.calls as unknown as Array<[{ path: { id: string } }]>
  ).map(([input]) => input.path.id);
}

function aggregatorPrompt(session: ReturnType<typeof createSessionMocks>): string {
  const call = session.prompt.mock.calls.find(
    ([input]) => (input as { body?: { agent?: string } }).body?.agent === "aggregator",
  );
  const parts = (call?.[0] as { body?: { parts?: Array<{ text?: string }> } } | undefined)?.body
    ?.parts;
  return parts?.[0]?.text ?? "";
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
      councillor_ms: 1_000,
      optional_councillor_ms: 60_000,
      aggregator_ms: 1_000,
      quorum_grace_ms: 0,
      hard_cap_ms: 5_000,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runCouncilReview", () => {
  it("fans out to councillors, aggregates two successes, and cleans up sessions", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockResolvedValue({});
    session.messages
      .mockResolvedValueOnce({ data: assistantMessages("response a") })
      .mockResolvedValueOnce({ data: assistantMessages("response b") })
      .mockResolvedValueOnce({ data: assistantMessages("aggregated response") });

    await expect(
      runCouncilReview(
        createV1Host(createContext(session) as never),
        councilConfig(),
        vi.fn(),
        undefined,
        "review this",
        "parent-session",
      ),
    ).resolves.toBe("aggregated response");

    expect(session.get).toHaveBeenCalledTimes(1);
    expect(session.create.mock.calls.map(([input]) => input.query)).toEqual([
      { directory: "/parent-directory" },
      { directory: "/parent-directory" },
      { directory: "/parent-directory" },
    ]);
    expect(abortIds(session)).toEqual([
      "reviewer-a",
      "reviewer-b",
      "aggregator-session",
    ]);
  });

  it("returns fallback guidance and skips aggregation with fewer than two successes", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return {};
      return { error: "failed" };
    });
    session.messages.mockResolvedValueOnce({ data: assistantMessages("one response") });

    const result = await runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig(),
      vi.fn(),
      undefined,
      "review this",
      "parent-session",
    );

    expect(result).toContain("fewer than 2 successful councillor responses (1/2; required: 1/2)");
    expect(result).toContain("provider-a/model-a");
    expect(session.create).toHaveBeenCalledTimes(2);
    expect(session.prompt).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ agent: "aggregator" }) }),
    );
  });

  it("includes required-only counts in fallback guidance for mixed councils", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return {};
      return { error: "failed" };
    });
    session.messages.mockResolvedValueOnce({ data: assistantMessages("one response") });

    const result = await runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({ models: [MODEL_A, MODEL_B, { ...MODEL_C, optional: true }], quorum: 2 }),
      vi.fn(),
      undefined,
      "review this",
      "parent-session",
    );

    expect(result).toContain(
      "fewer than 2 successful councillor responses (1/3; required: 1/2)",
    );
  });

  it("marks optional councillors but not required councillors in fallback guidance", async () => {
    const session = createSessionMocks();
    const optionalD = { providerID: "provider-d", modelID: "model-d", optional: true };
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-d" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-c") return {};
      if (input.path.id === "reviewer-d") return { error: "optional failed" };
      return { error: "required failed" };
    });
    session.messages.mockResolvedValueOnce({ data: assistantMessages("optional response") });

    const result = await runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({
        models: [MODEL_A, MODEL_B, { ...MODEL_C, optional: true }, optionalD],
        quorum: 2,
      }),
      vi.fn(),
      undefined,
      "review this",
      "parent-session",
    );

    expect(result).toContain("Successful councillors:\n- provider-c/model-c (optional)");
    expect(result).toContain("- provider-d/model-d (optional): prompt failed: optional failed");
    expect(result).toContain("- provider-a/model-a: prompt failed: required failed");
    expect(result).toContain("- provider-b/model-b: prompt failed: required failed");
    expect(result).not.toContain("provider-a/model-a (optional)");
    expect(result).not.toContain("provider-b/model-b (optional)");
  });

  it("layers cached workspace permission rules and reviewer overrides", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ error: "create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("response a") });

    await runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({ reviewer_permission: { bash: "deny" } }),
      vi.fn(),
      { bash: { "git *": "allow", "sudo *": "deny" } },
      "review this",
      "parent-session",
    );

    expect((session.create.mock.calls[0][0] as { body: Record<string, unknown> }).body.permission)
      .toEqual([
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "external_directory", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "git *", action: "allow" },
        { permission: "bash", pattern: "sudo *", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "council_review", pattern: "*", action: "deny" },
      ]);
  });

  it("passes explicit aggregator permissions to aggregation only", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockResolvedValue({});
    session.messages
      .mockResolvedValueOnce({ data: assistantMessages("response a") })
      .mockResolvedValueOnce({ data: assistantMessages("response b") })
      .mockResolvedValueOnce({ data: assistantMessages("aggregated response") });

    await runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({ aggregator_permission: { bash: "deny" } }),
      vi.fn(),
      undefined,
      "review this",
      "parent-session",
    );

    expect((session.create.mock.calls[2][0] as { body: Record<string, unknown> }).body.permission)
      .toEqual([{ permission: "bash", pattern: "*", action: "deny" }]);
  });

  it("aborts active child sessions when the hard cap triggers", async () => {
    const session = createSessionMocks();
    const slowPrompt = deferred<Record<string, unknown>>();
    const log = vi.fn();
    session.create
      .mockResolvedValueOnce({ data: { id: "hard-cap-a" } })
      .mockResolvedValueOnce({ data: { id: "hard-cap-b" } });
    session.prompt.mockReturnValue(slowPrompt.promise);
    session.messages.mockResolvedValue({ data: assistantMessages("late response") });

    await expect(
      runCouncilReview(
        createV1Host(createContext(session) as never),
        councilConfig({ timeouts: { ...councilConfig().timeouts, hard_cap_ms: 50 } }),
        log,
        undefined,
        "review this",
        "parent-session",
      ),
    ).rejects.toThrow("council_review timed out");

    expect(log).toHaveBeenCalledWith("debug", "hard cap triggered", {
      timeout_ms: 50,
    });
    expect(abortIds(session)).toEqual(expect.arrayContaining(["hard-cap-a", "hard-cap-b"]));

    slowPrompt.resolve({});
  });

  it("keeps the aggregator prompt free of aborted sections when full quorum succeeds", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockResolvedValue({});
    session.messages
      .mockResolvedValueOnce({ data: assistantMessages("response a") })
      .mockResolvedValueOnce({ data: assistantMessages("response b") })
      .mockResolvedValueOnce({ data: assistantMessages("aggregated response") });

    await expect(
      runCouncilReview(
        createV1Host(createContext(session) as never),
        councilConfig(),
        vi.fn(),
        undefined,
        "review this",
        "parent-session",
      ),
    ).resolves.toBe("aggregated response");

    expect(aggregatorPrompt(session)).not.toContain("Aborted");
    expect(abortIds(session)).toEqual(["reviewer-a", "reviewer-b", "aggregator-session"]);
  });

  it("aborts pending laggards without retry once quorum succeeds with no grace", async () => {
    const session = createSessionMocks();
    const laggardPrompt = deferred<Record<string, unknown>>();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-c") return await laggardPrompt.promise;
      return {};
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return { data: assistantMessages("response a") };
      if (input.path.id === "reviewer-b") return { data: assistantMessages("response b") };
      if (input.path.id === "reviewer-c") return { data: assistantMessages("late response") };
      return { data: assistantMessages("aggregated response") };
    });

    await expect(
      runCouncilReview(
        createV1Host(createContext(session) as never),
        councilConfig({
          models: [MODEL_A, MODEL_B, MODEL_C],
          quorum: 2,
        }),
        vi.fn(),
        undefined,
        "review this",
        "parent-session",
      ),
    ).resolves.toBe("aggregated response");

    expect(aggregatorPrompt(session)).toContain("## Aborted (quorum reached)");
    expect(aggregatorPrompt(session)).toContain("- provider-c/model-c");
    expect(abortIds(session)).toContain("reviewer-c");

    laggardPrompt.resolve({});
  });

  it("times out optional councillors using optional_councillor_ms", async () => {
    vi.useFakeTimers();
    const session = createSessionMocks();
    const optionalPrompt = deferred<Record<string, unknown>>();
    const log = vi.fn();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-b") return { error: "required failed" };
      if (input.path.id === "reviewer-c") return await optionalPrompt.promise;
      return {};
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return { data: assistantMessages("response a") };
      return { data: assistantMessages("late optional") };
    });

    const result = runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({
        models: [MODEL_A, MODEL_B, { ...MODEL_C, optional: true }],
        quorum: 2,
        timeouts: {
          ...councilConfig().timeouts,
          councillor_ms: 10_000,
          optional_councillor_ms: 50,
          hard_cap_ms: 20_000,
        },
      }),
      log,
      undefined,
      "review this",
      "parent-session",
    );

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);

    await expect(result).resolves.toContain("fewer than 2 successful councillor responses");
    expect(log).toHaveBeenCalledWith("debug", "councillor request timed out", {
      model: "provider-c/model-c",
      timeout_ms: 50,
    });
    optionalPrompt.resolve({});
  });

  it("does not let optional successes satisfy required quorum", async () => {
    const session = createSessionMocks();
    const requiredPrompt = deferred<Record<string, unknown>>();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-b") return await requiredPrompt.promise;
      return {};
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return { data: assistantMessages("required response a") };
      if (input.path.id === "reviewer-b") return { data: assistantMessages("required response b") };
      if (input.path.id === "reviewer-c") return { data: assistantMessages("optional response") };
      return { data: assistantMessages("aggregated response") };
    });

    const result = runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({
        models: [MODEL_A, MODEL_B, { ...MODEL_C, optional: true }],
        quorum: 2,
      }),
      vi.fn(),
      undefined,
      "review this",
      "parent-session",
    );

    await flushMicrotasks();
    expect(session.create).toHaveBeenCalledTimes(3);

    requiredPrompt.resolve({});

    await expect(result).resolves.toBe("aggregated response");
    expect(aggregatorPrompt(session)).toContain("provider-b/model-b");
    expect(aggregatorPrompt(session)).not.toContain("## Aborted (quorum reached)");
  });

  it("runs aggregation with all-required successes unchanged", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockResolvedValue({});
    session.messages
      .mockResolvedValueOnce({ data: assistantMessages("response a") })
      .mockResolvedValueOnce({ data: assistantMessages("response b") })
      .mockResolvedValueOnce({ data: assistantMessages("aggregated response") });

    await expect(
      runCouncilReview(
        createV1Host(createContext(session) as never),
        councilConfig(),
        vi.fn(),
        undefined,
        "review this",
        "parent-session",
      ),
    ).resolves.toBe("aggregated response");

    expect(aggregatorPrompt(session)).toContain("provider-a/model-a");
    expect(aggregatorPrompt(session)).toContain("provider-b/model-b");
  });

  it("aggregates when required quorum is unmet but one required and one optional succeed", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-b") return { error: "required failed" };
      return {};
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return { data: assistantMessages("required response") };
      if (input.path.id === "reviewer-c") return { data: assistantMessages("optional response") };
      return { data: assistantMessages("aggregated response") };
    });

    await expect(
      runCouncilReview(
        createV1Host(createContext(session) as never),
        councilConfig({ models: [MODEL_A, MODEL_B, { ...MODEL_C, optional: true }], quorum: 2 }),
        vi.fn(),
        undefined,
        "review this",
        "parent-session",
      ),
    ).resolves.toBe("aggregated response");

    expect(aggregatorPrompt(session)).toContain("provider-c/model-c");
  });

  it("aggregates when all required fail but at least two optional councillors succeed", async () => {
    const session = createSessionMocks();
    const optionalD = { providerID: "provider-d", modelID: "model-d", optional: true };
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-d" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a" || input.path.id === "reviewer-b") {
        return { error: "required failed" };
      }
      return {};
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-c") return { data: assistantMessages("optional response c") };
      if (input.path.id === "reviewer-d") return { data: assistantMessages("optional response d") };
      return { data: assistantMessages("aggregated response") };
    });

    await expect(
      runCouncilReview(
        createV1Host(createContext(session) as never),
        councilConfig({
          models: [MODEL_A, MODEL_B, { ...MODEL_C, optional: true }, optionalD],
          quorum: 2,
        }),
        vi.fn(),
        undefined,
        "review this",
        "parent-session",
      ),
    ).resolves.toBe("aggregated response");

    expect(aggregatorPrompt(session)).toContain("provider-c/model-c");
    expect(aggregatorPrompt(session)).toContain("provider-d/model-d");
  });

  it("lets a laggard success join during the quorum grace window", async () => {
    vi.useFakeTimers();
    const session = createSessionMocks();
    const promptA = deferred<Record<string, unknown>>();
    const promptB = deferred<Record<string, unknown>>();
    const promptC = deferred<Record<string, unknown>>();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return await promptA.promise;
      if (input.path.id === "reviewer-b") return await promptB.promise;
      if (input.path.id === "reviewer-c") return await promptC.promise;
      return {};
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return { data: assistantMessages("response a") };
      if (input.path.id === "reviewer-b") return { data: assistantMessages("response b") };
      if (input.path.id === "reviewer-c") return { data: assistantMessages("response c") };
      return { data: assistantMessages("aggregated response") };
    });

    const result = runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({
        models: [MODEL_A, MODEL_B, MODEL_C],
        quorum: 2,
        timeouts: { ...councilConfig().timeouts, quorum_grace_ms: 50 },
      }),
      vi.fn(),
      undefined,
      "review this",
      "parent-session",
    );

    promptA.resolve({});
    promptB.resolve({});
    await flushMicrotasks();
    promptC.resolve({});

    await expect(result).resolves.toBe("aggregated response");
    expect(aggregatorPrompt(session)).toContain("provider-c/model-c");
    expect(aggregatorPrompt(session)).not.toContain("Aborted");
  });

  it("records an optional success during the quorum grace window", async () => {
    vi.useFakeTimers();
    const session = createSessionMocks();
    const promptA = deferred<Record<string, unknown>>();
    const promptB = deferred<Record<string, unknown>>();
    const optionalPrompt = deferred<Record<string, unknown>>();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return await promptA.promise;
      if (input.path.id === "reviewer-b") return await promptB.promise;
      if (input.path.id === "reviewer-c") return await optionalPrompt.promise;
      return {};
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-c") return { data: assistantMessages("optional response") };
      if (input.path.id === "aggregator-session") return { data: assistantMessages("aggregated response") };
      return { data: assistantMessages(`required response for ${input.path.id}`) };
    });

    const result = runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({
        models: [MODEL_A, MODEL_B, { ...MODEL_C, optional: true }],
        quorum: 2,
        timeouts: { ...councilConfig().timeouts, quorum_grace_ms: 50 },
      }),
      vi.fn(),
      undefined,
      "review this",
      "parent-session",
    );

    promptA.resolve({});
    promptB.resolve({});
    await flushMicrotasks();
    optionalPrompt.resolve({});

    await expect(result).resolves.toBe("aggregated response");
    expect(aggregatorPrompt(session)).toContain("provider-c/model-c");
    expect(aggregatorPrompt(session)).not.toContain("Aborted");
  });

  it("records an optional failure during the quorum grace window", async () => {
    vi.useFakeTimers();
    const session = createSessionMocks();
    const promptA = deferred<Record<string, unknown>>();
    const promptB = deferred<Record<string, unknown>>();
    const optionalPrompt = deferred<Record<string, unknown>>();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return await promptA.promise;
      if (input.path.id === "reviewer-b") return await promptB.promise;
      if (input.path.id === "reviewer-c") return await optionalPrompt.promise;
      return {};
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "aggregator-session") return { data: assistantMessages("aggregated response") };
      return { data: assistantMessages(`required response for ${input.path.id}`) };
    });

    const result = runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({
        models: [MODEL_A, MODEL_B, { ...MODEL_C, optional: true }],
        quorum: 2,
        timeouts: { ...councilConfig().timeouts, quorum_grace_ms: 50 },
      }),
      vi.fn(),
      undefined,
      "review this",
      "parent-session",
    );

    promptA.resolve({});
    promptB.resolve({});
    await flushMicrotasks();
    optionalPrompt.resolve({ error: "optional failed" });

    await expect(result).resolves.toBe("aggregated response");
    expect(aggregatorPrompt(session)).toContain("provider-c/model-c (optional): prompt failed: optional failed");
    expect(aggregatorPrompt(session)).not.toContain("Aborted");
  });

  it("keeps late optional success out after laggard sweep marks it aborted", async () => {
    const session = createSessionMocks();
    const optionalPrompt = deferred<Record<string, unknown>>();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-c") return await optionalPrompt.promise;
      return {};
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-c") return { data: assistantMessages("late optional") };
      if (input.path.id === "aggregator-session") return { data: assistantMessages("aggregated response") };
      return { data: assistantMessages(`required response for ${input.path.id}`) };
    });

    await expect(
      runCouncilReview(
        createV1Host(createContext(session) as never),
        councilConfig({ models: [MODEL_A, MODEL_B, { ...MODEL_C, optional: true }], quorum: 2 }),
        vi.fn(),
        undefined,
        "review this",
        "parent-session",
      ),
    ).resolves.toBe("aggregated response");

    optionalPrompt.resolve({});
    await flushMicrotasks();

    expect(aggregatorPrompt(session)).toContain("## Aborted (quorum reached)");
    expect(aggregatorPrompt(session)).toContain("- provider-c/model-c");
    expect(aggregatorPrompt(session)).not.toContain("late optional");
  });

  it("clears the quorum grace timer when all councillors finish during grace", async () => {
    vi.useFakeTimers();
    const session = createSessionMocks();
    const promptA = deferred<Record<string, unknown>>();
    const promptB = deferred<Record<string, unknown>>();
    const promptC = deferred<Record<string, unknown>>();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return await promptA.promise;
      if (input.path.id === "reviewer-b") return await promptB.promise;
      if (input.path.id === "reviewer-c") return await promptC.promise;
      return {};
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "aggregator-session") {
        return { data: assistantMessages("aggregated response") };
      }
      return { data: assistantMessages(`response for ${input.path.id}`) };
    });

    const result = runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({
        models: [MODEL_A, MODEL_B, MODEL_C],
        quorum: 2,
        timeouts: { ...councilConfig().timeouts, quorum_grace_ms: 10_000 },
      }),
      vi.fn(),
      undefined,
      "review this",
      "parent-session",
    );

    promptA.resolve({});
    promptB.resolve({});
    await flushMicrotasks();
    promptC.resolve({});

    await expect(result).resolves.toBe("aggregated response");
    expect(aggregatorPrompt(session)).not.toContain("Aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the hard cap win while waiting in the quorum grace window", async () => {
    vi.useFakeTimers();
    const session = createSessionMocks();
    const log = vi.fn();
    const promptA = deferred<Record<string, unknown>>();
    const promptB = deferred<Record<string, unknown>>();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-c" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") {
        return await promptA.promise;
      }
      if (input.path.id === "reviewer-b") {
        return await promptB.promise;
      }
      return await new Promise(() => {});
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return { data: assistantMessages("response a") };
      return { data: assistantMessages("response b") };
    });

    const result = runCouncilReview(
      createV1Host(createContext(session) as never),
      councilConfig({
        models: [MODEL_A, MODEL_B, MODEL_C],
        quorum: 2,
        timeouts: {
          ...councilConfig().timeouts,
          councillor_ms: 20_000,
          quorum_grace_ms: 10_000,
          hard_cap_ms: 5_000,
        },
      }),
      log,
      undefined,
      "review this",
      "parent-session",
    );
    const observedResult = result.catch((error) => error as Error);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    promptA.resolve({});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    promptB.resolve({});
    await flushMicrotasks();
    expect(session.create).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    const observed = await observedResult;
    expect(observed).toBeInstanceOf(Error);
    if (!(observed instanceof Error)) throw new Error("expected Error result");
    expect(observed.message).toContain("council_review timed out");
    expect(abortIds(session)).toEqual(
      expect.arrayContaining(["reviewer-a", "reviewer-b", "reviewer-c"]),
    );
    expect(session.create.mock.calls).toHaveLength(3);
    expect(log).toHaveBeenCalledWith("debug", "hard cap triggered", {
      timeout_ms: 5_000,
    });
  });
});
