import { describe, expect, it, vi } from "vitest";

import {
  AGGREGATOR_TOOLS,
  buildAggregatorPrompt,
  formatAbortedSummary,
  formatFailureSummary,
  synthesizeWithAggregator,
} from "./aggregator";
import type { CouncilConfig, CouncillorSuccess, ReviewState } from "./types";

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

function success(model: typeof MODEL_A, response: string): CouncillorSuccess {
  return { model, response, attempts: 1 } as CouncillorSuccess;
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
      councillor_ms: 180_000,
      aggregator_ms: 120_000,
      quorum_grace_ms: 0,
      hard_cap_ms: 420_000,
    },
    ...overrides,
  };
}

describe("buildAggregatorPrompt", () => {
  it("formats the original prompt, successes, failures, and reviewer responses", () => {
    const prompt = buildAggregatorPrompt({
      originalPrompt: "review this",
      successes: [
        success(MODEL_A, "response a"),
        success(MODEL_B, "response b"),
      ],
      failures: [{ model: { providerID: "provider-c", modelID: "model-c" }, error: "failed" }],
      aborted: [],
    });

    expect(prompt).toContain("# Original review prompt\n\nreview this");
    expect(prompt).toContain("- provider-a/model-a");
    expect(prompt).toContain("- provider-b/model-b");
    expect(prompt).toContain("- provider-c/model-c: failed");
    expect(prompt).toContain("## Reviewer 1: provider-a/model-a");
    expect(prompt).toContain("response b");
  });

  it("formats no failures as none", () => {
    expect(
      buildAggregatorPrompt({
        originalPrompt: "review this",
        successes: [success(MODEL_A, "response a")],
        failures: [],
        aborted: [],
      }),
    ).toContain("Failed or timed out:\n- none");
  });
});

describe("formatAbortedSummary", () => {
  it("formats aborted councillors or none", () => {
    expect(formatAbortedSummary([])).toBe("none");
    expect(formatAbortedSummary([{ model: MODEL_A }])).toBe("- provider-a/model-a");
  });
});

describe("formatFailureSummary", () => {
  it("formats failures or none", () => {
    expect(formatFailureSummary([])).toBe("none");
    expect(formatFailureSummary([{ model: MODEL_A, error: "failed" }])).toBe(
      "- provider-a/model-a: failed",
    );
  });
});

describe("synthesizeWithAggregator", () => {
  it("creates an aggregator session with locked-down tools and returns the response", async () => {
    const session = createSessionMocks();
    session.create.mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("aggregated response") });
    const reviewState: ReviewState = {
      activeSessions: new Set(),
      hardCapTimedOut: false,
      quorumReached: false,
    };

    await expect(
      synthesizeWithAggregator(createContext(session) as never, councilConfig(), vi.fn(), {
        parentSessionID: "parent",
        originalPrompt: "review this",
        successes: [
          success(MODEL_A, "response a"),
          success(MODEL_B, "response b"),
        ],
        failures: [],
        aborted: [],
        directory: "/dir",
        reviewState,
        aggregatorPermission: [{ permission: "bash", pattern: "*", action: "deny" }],
      }),
    ).resolves.toBe("aggregated response");

    expect(session.create).toHaveBeenCalledWith({
      body: {
        parentID: "parent",
        title: "council: aggregator synthesis",
        permission: [{ permission: "bash", pattern: "*", action: "deny" }],
      },
      query: { directory: "/dir" },
    });
    expect(session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "aggregator-session" },
        body: expect.objectContaining({
          agent: "aggregator",
          tools: AGGREGATOR_TOOLS,
        }),
      }),
    );
    expect(session.abort).toHaveBeenCalledWith({ path: { id: "aggregator-session" } });
    expect(reviewState.activeSessions.has("aggregator-session")).toBe(false);
  });

  it("uses the configured aggregator model", async () => {
    const session = createSessionMocks();
    const aggregatorModel = { providerID: "provider-c", modelID: "model-c" };
    session.create.mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("aggregated response") });

    await synthesizeWithAggregator(
      createContext(session) as never,
      councilConfig({ aggregator_model: aggregatorModel }),
      vi.fn(),
      {
        parentSessionID: "parent",
        originalPrompt: "review this",
        successes: [
          success(MODEL_A, "response a"),
          success(MODEL_B, "response b"),
        ],
        failures: [],
        aborted: [],
        directory: "/dir",
        reviewState: { activeSessions: new Set(), hardCapTimedOut: false, quorumReached: false },
      },
    );

    expect(session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ model: aggregatorModel }),
      }),
    );
  });

  it("aborts the aggregator child session when synthesis times out", async () => {
    const session = createSessionMocks();
    const slowPrompt = deferred<Record<string, unknown>>();
    session.create.mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockReturnValue(slowPrompt.promise);
    session.messages.mockResolvedValue({ data: assistantMessages("late aggregate") });
    const log = vi.fn();

    await expect(
      synthesizeWithAggregator(
        createContext(session) as never,
        councilConfig({ timeouts: { ...councilConfig().timeouts, aggregator_ms: 50 } }),
        log,
        {
          parentSessionID: "parent",
          originalPrompt: "review this",
          successes: [
            success(MODEL_A, "response a"),
            success(MODEL_B, "response b"),
          ],
          failures: [],
          aborted: [],
          directory: "/dir",
          reviewState: { activeSessions: new Set(), hardCapTimedOut: false, quorumReached: false },
        },
      ),
    ).rejects.toThrow("aggregator synthesis timed out");

    expect(log).toHaveBeenCalledWith("debug", "aggregator synthesis timed out", {
      timeout_ms: 50,
    });
    expect(session.abort).toHaveBeenCalledWith({ path: { id: "aggregator-session" } });

    slowPrompt.resolve({});
    await eventually(() => {
      expect(session.abort).toHaveBeenCalledWith({ path: { id: "aggregator-session" } });
    });
  });
});
