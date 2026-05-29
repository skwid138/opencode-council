import { describe, expect, it, vi } from "vitest";

import { runCouncillor, runCouncillorAttempt } from "./councillor";
import type { CouncilConfig, ReviewState } from "./types";

const MODEL_A = { providerID: "provider-a", modelID: "model-a" };
const MODEL_B = { providerID: "provider-b", modelID: "model-b" };

function createSessionMocks() {
  return {
    get: vi.fn(),
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

async function eventually(assertion: () => void, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
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
      councillor_ms: 120_000,
      aggregator_ms: 120_000,
      quorum_grace_ms: 0,
      hard_cap_ms: 360_000,
    },
    ...overrides,
  };
}

describe("runCouncillorAttempt", () => {
  it("creates, prompts, extracts, and aborts a councillor session", async () => {
    const session = createSessionMocks();
    session.create.mockResolvedValueOnce({ data: { id: "request-session" } });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("response") });
    const reviewState: ReviewState = {
      activeSessions: new Set(),
      hardCapTimedOut: false,
      quorumReached: false,
    };

    await expect(
      runCouncillorAttempt(createContext(session) as never, councilConfig(), vi.fn(), {
        parentSessionID: "parent",
        prompt: "review this",
        model: MODEL_A,
        timeoutMs: 1_000,
        directory: "/dir",
        reviewerPermission: [{ permission: "bash", pattern: "*", action: "allow" }],
        reviewState,
      }),
    ).resolves.toBe("response");

    expect(session.create).toHaveBeenCalledWith({
      body: {
        parentID: "parent",
        title: "council: provider-a/model-a",
        permission: [{ permission: "bash", pattern: "*", action: "allow" }],
      },
      query: { directory: "/dir" },
    });
    expect(session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "request-session" },
        body: expect.objectContaining({ agent: "reviewer", model: MODEL_A }),
      }),
    );
    expect(session.abort).toHaveBeenCalledWith({ path: { id: "request-session" } });
    expect(reviewState.activeSessions.has("request-session")).toBe(false);
  });

  it("aborts a timed-out session immediately and logs the timeout", async () => {
    const session = createSessionMocks();
    const slowPrompt = deferred<Record<string, unknown>>();
    const log = vi.fn();
    session.create.mockResolvedValueOnce({ data: { id: "slow-session" } });
    session.prompt.mockReturnValue(slowPrompt.promise);
    session.messages.mockResolvedValue({ data: assistantMessages("late response") });

    await expect(
      runCouncillorAttempt(createContext(session) as never, councilConfig(), log, {
        parentSessionID: "parent",
        prompt: "review this",
        model: MODEL_A,
        timeoutMs: 50,
        directory: "/dir",
        reviewerPermission: [],
        reviewState: { activeSessions: new Set(), hardCapTimedOut: false, quorumReached: false },
      }),
    ).rejects.toThrow("provider-a/model-a timed out");

    expect(log).toHaveBeenCalledWith("debug", "councillor request timed out", {
      model: "provider-a/model-a",
      timeout_ms: 50,
    });
    expect(session.abort).toHaveBeenCalledWith({ path: { id: "slow-session" } });

    slowPrompt.resolve({});
  });

  it("aborts a councillor session when create resolves after the request timeout", async () => {
    const session = createSessionMocks();
    const slowCreate = deferred<{ data: { id: string } }>();
    session.create.mockReturnValueOnce(slowCreate.promise);
    session.prompt.mockResolvedValue({});
    session.messages.mockResolvedValue({ data: assistantMessages("late response") });

    const resultPromise = runCouncillorAttempt(
      createContext(session) as never,
      councilConfig(),
      vi.fn(),
      {
        parentSessionID: "parent",
        prompt: "review this",
        model: MODEL_A,
        timeoutMs: 50,
        directory: "/dir",
        reviewerPermission: [],
        reviewState: { activeSessions: new Set(), hardCapTimedOut: false, quorumReached: false },
      },
    );

    await expect(resultPromise).rejects.toThrow("provider-a/model-a timed out");
    expect(session.abort).not.toHaveBeenCalledWith({ path: { id: "late-session" } });

    slowCreate.resolve({ data: { id: "late-session" } });
    await eventually(() => {
      expect(session.abort).toHaveBeenCalledWith({ path: { id: "late-session" } });
    });
  });
});

describe("runCouncillor", () => {
  it("returns success after one request", async () => {
    const session = createSessionMocks();
    session.create.mockResolvedValueOnce({ data: { id: "first-session" } });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("response") });

    await expect(
      runCouncillor(createContext(session) as never, councilConfig(), vi.fn(), {
        parentSessionID: "parent",
        prompt: "review this",
        model: MODEL_A,
        directory: "/dir",
        reviewerPermission: [],
        reviewState: { activeSessions: new Set(), hardCapTimedOut: false, quorumReached: false },
      }),
    ).resolves.toEqual({ model: MODEL_A, response: "response", attempts: 1 });
  });

  it("propagates the single-attempt failure", async () => {
    const session = createSessionMocks();
    session.create.mockResolvedValueOnce({ data: { id: "failed-session" } });
    session.prompt.mockResolvedValueOnce({ error: "single failed" });

    await expect(
      runCouncillor(createContext(session) as never, councilConfig(), vi.fn(), {
        parentSessionID: "parent",
        prompt: "review this",
        model: MODEL_A,
        directory: "/dir",
        reviewerPermission: [],
        reviewState: { activeSessions: new Set(), hardCapTimedOut: false, quorumReached: false },
      }),
    ).rejects.toThrow("prompt failed: single failed");
    expect(session.create).toHaveBeenCalledTimes(1);
  });

  it("propagates the hard-cap short-circuit from createChildSession", async () => {
    const session = createSessionMocks();
    session.create.mockResolvedValueOnce({ data: { id: "first-session" } });
    session.prompt.mockResolvedValueOnce({ error: "first failed" });
    const reviewState: ReviewState = {
      activeSessions: new Set(),
      hardCapTimedOut: true,
      quorumReached: false,
    };

    await expect(
      runCouncillor(createContext(session) as never, councilConfig(), vi.fn(), {
        parentSessionID: "parent",
        prompt: "review this",
        model: MODEL_A,
        directory: "/dir",
        reviewerPermission: [],
        reviewState,
      }),
    ).rejects.toThrow("council_review hard cap already triggered");
    expect(session.create).not.toHaveBeenCalled();
  });
});
