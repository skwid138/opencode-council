import { describe, expect, it, vi } from "vitest";

import { runCouncilReview } from "./orchestrator";
import type { CouncilConfig } from "./types";

const MODEL_A = { providerID: "provider-a", modelID: "model-a" };
const MODEL_B = { providerID: "provider-b", modelID: "model-b" };

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

function abortIds(session: ReturnType<typeof createSessionMocks>) {
  return (
    session.abort.mock.calls as unknown as Array<[{ path: { id: string } }]>
  ).map(([input]) => input.path.id);
}

function councilConfig(overrides: Partial<CouncilConfig> = {}): CouncilConfig {
  return {
    reviewer: "reviewer",
    aggregator: "aggregator",
    debug: false,
    models: [MODEL_A, MODEL_B],
    aggregator_model: null,
    reviewer_temperature: null,
    reviewer_permission: null,
    aggregator_permission: null,
    timeouts: {
      councillor_ms: 1_000,
      councillor_retry_ms: 1_000,
      aggregator_ms: 1_000,
      hard_cap_ms: 5_000,
    },
    ...overrides,
  };
}

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
        createContext(session) as never,
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
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b-retry" } });
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "reviewer-a") return {};
      return { error: "failed" };
    });
    session.messages.mockResolvedValueOnce({ data: assistantMessages("one response") });

    const result = await runCouncilReview(
      createContext(session) as never,
      councilConfig(),
      vi.fn(),
      undefined,
      "review this",
      "parent-session",
    );

    expect(result).toContain("fewer than 2 successful councillor responses (1/2)");
    expect(result).toContain("provider-a/model-a (1 attempt)");
    expect(session.create).toHaveBeenCalledTimes(3);
    expect(session.prompt).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ agent: "aggregator" }) }),
    );
  });

  it("layers cached workspace permission rules and reviewer overrides", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("response a") });

    await runCouncilReview(
      createContext(session) as never,
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
      createContext(session) as never,
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
        createContext(session) as never,
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
});
