import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@opencode-ai/plugin", () => {
  const stringSchema = {
    describe: () => stringSchema,
  };
  const toolFn = (definition: unknown) => definition;
  Object.assign(toolFn, {
    schema: {
      string: () => stringSchema,
    },
  });
  return { tool: toolFn };
});

import {
  CouncilToolPlugin,
  validateCouncilConfig,
  raceWithTimeout,
} from "./index";

const MODEL_A = { providerID: "provider-a", modelID: "model-a" };
const MODEL_B = { providerID: "provider-b", modelID: "model-b" };

type SessionMocks = ReturnType<typeof createSessionMocks>;

function createSessionMocks() {
  return {
    get: vi.fn(async () => ({ data: { directory: "/parent-directory" } })),
    create: vi.fn(),
    prompt: vi.fn(),
    messages: vi.fn(),
    abort: vi.fn(async () => ({})),
  };
}

function createContext(session: SessionMocks, directory = "/fallback-directory") {
  return {
    client: { session },
    directory,
  };
}

function validCouncil(overrides: Record<string, unknown> = {}) {
  return {
    reviewer: "test-reviewer",
    aggregator: "test-aggregator",
    models: [MODEL_A, MODEL_B],
    ...overrides,
  };
}

async function createExecute(
  session: SessionMocks,
  council: Record<string, unknown>,
  directory?: string,
) {
  const hooks = (await CouncilToolPlugin(createContext(session, directory) as never, {
    council,
  } as never)) as unknown as {
    tool: {
      council_review: {
        execute: (
          args: { prompt: string },
          toolContext: { sessionID: string },
        ) => Promise<string>;
      };
    };
  };
  return hooks.tool.council_review.execute as (
    args: { prompt: string },
    toolContext: { sessionID: string },
  ) => Promise<string>;
}

function assistantMessages(text: string, created = 1) {
  return [
    {
      info: { role: "assistant", time: { created } },
      parts: [{ type: "text", text }],
    },
  ];
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function abortIds(session: SessionMocks) {
  return (
    session.abort.mock.calls as unknown as Array<[{ path: { id: string } }]>
  ).map(([input]) => input.path.id);
}

function createIds(session: SessionMocks, ids: string[]) {
  const queue = [...ids];
  session.create.mockImplementation(async () => ({ data: { id: queue.shift() } }));
}

describe("plugin module shape", () => {
  it("default export has server property that is a function", async () => {
    const mod = await import("./index");

    expect(mod.default).toHaveProperty("server");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server function returns hooks with tool.council_review", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server(
      createContext(createSessionMocks()) as never,
      { council: validCouncil() } as never,
    );

    expect(hooks).toHaveProperty("tool");
    expect(hooks.tool).toHaveProperty("council_review");
  });
});

describe("package.json exports", () => {
  it("exposes ./server export pointing to dist/index.js", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
    );

    expect(pkg.exports["./server"]).toEqual({ import: "./dist/index.js" });
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
});

describe("validateCouncilConfig", () => {
  it("throws when reviewer is missing", () => {
    expect(() =>
      validateCouncilConfig({ council: { aggregator: "agg", models: [MODEL_A, MODEL_B] } }),
    ).toThrow("council.reviewer is required");
  });

  it("throws when reviewer is an empty string", () => {
    expect(() =>
      validateCouncilConfig({
        council: { reviewer: " ", aggregator: "agg", models: [MODEL_A, MODEL_B] },
      }),
    ).toThrow("council.reviewer is required");
  });

  it("throws when aggregator is missing", () => {
    expect(() =>
      validateCouncilConfig({ council: { reviewer: "reviewer", models: [MODEL_A, MODEL_B] } }),
    ).toThrow("council.aggregator is required");
  });

  it("throws when aggregator is an empty string", () => {
    expect(() =>
      validateCouncilConfig({
        council: { reviewer: "reviewer", aggregator: " ", models: [MODEL_A, MODEL_B] },
      }),
    ).toThrow("council.aggregator is required");
  });

  it("throws when models are missing", () => {
    expect(() =>
      validateCouncilConfig({ council: { reviewer: "reviewer", aggregator: "agg" } }),
    ).toThrow("council.models is required");
  });

  it("throws when models contain fewer than 2 valid entries", () => {
    expect(() =>
      validateCouncilConfig({
        council: {
          reviewer: "reviewer",
          aggregator: "agg",
          models: [MODEL_A, { providerID: "", modelID: "invalid" }],
        },
      }),
    ).toThrow("council.models must include at least 2 valid model entries");
  });

  it("clamps invalid timeout values", () => {
    const config = validateCouncilConfig({
      council: {
        reviewer: "reviewer-agent",
        aggregator: "aggregator-agent",
        models: [MODEL_A, MODEL_B],
        timeouts: {
          councillor_ms: -50,
          councillor_retry_ms: 0,
          aggregator_ms: 999_999_999,
          hard_cap_ms: 500.4,
        },
      },
    });

    expect(config.timeouts.councillor_ms).toBe(1);
    expect(config.timeouts.councillor_retry_ms).toBe(1);
    expect(config.timeouts.aggregator_ms).toBe(360_000);
    expect(config.timeouts.hard_cap_ms).toBe(500);
  });

  it("uses timeout defaults for missing timeout values", () => {
    const config = validateCouncilConfig({
      council: {
        reviewer: "reviewer-agent",
        aggregator: "aggregator-agent",
        models: [MODEL_A, MODEL_B],
        timeouts: { aggregator_ms: 500 },
      },
    });

    expect(config.reviewer).toBe("reviewer-agent");
    expect(config.aggregator).toBe("aggregator-agent");
    expect(config.models).toEqual([MODEL_A, MODEL_B]);
    expect(config.aggregator_model).toBeNull();
    expect(config.timeouts.councillor_ms).toBe(180_000);
    expect(config.timeouts.councillor_retry_ms).toBe(90_000);
    expect(config.timeouts.aggregator_ms).toBe(500);
    expect(config.timeouts.hard_cap_ms).toBe(360_000);
  });
});

describe("councillor retry logic", () => {
  it("retries a failed councillor attempt and records the retry success", async () => {
    const session = createSessionMocks();
    createIds(session, ["a-first", "b-first", "a-retry", "b-retry"]);
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "a-first") return { error: "first failed" };
      if (input.path.id === "a-retry") return {};
      return { error: "other model failed" };
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "a-retry") return { data: assistantMessages("retry ok") };
      return { data: assistantMessages("unexpected") };
    });
    const execute = await createExecute(session, validCouncil());

    const result = await execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(result).toContain("fewer than 2 successful councillor responses (1/2)");
    expect(result).toContain("provider-a/model-a (2 attempts)");
    expect(abortIds(session)).toEqual(
      expect.arrayContaining(["a-first", "a-retry", "b-first", "b-retry"]),
    );
  });

  it("reports both attempt failures when retry also fails", async () => {
    const session = createSessionMocks();
    createIds(session, ["a-first", "b-first", "a-retry", "b-retry"]);
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id.endsWith("first")) return { error: "first failed" };
      return { error: "retry failed" };
    });
    const execute = await createExecute(session, validCouncil());

    const result = await execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(result).toContain("fewer than 2 successful councillor responses (0/2)");
    expect(result).toContain("first attempt failed: prompt failed: \"first failed\"");
    expect(result).toContain("retry failed: prompt failed: \"retry failed\"");
    expect(abortIds(session)).toEqual(
      expect.arrayContaining(["a-first", "a-retry", "b-first", "b-retry"]),
    );
  });
});

describe("aggregator threshold", () => {
  it("returns an error string and skips aggregator when fewer than two councillors succeed", async () => {
    const session = createSessionMocks();
    createIds(session, ["councillor-a", "councillor-b", "councillor-b-retry"]);
    session.prompt.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "councillor-a") return {};
      return { error: "failed" };
    });
    session.messages.mockResolvedValueOnce({ data: assistantMessages("one response") });
    const execute = await createExecute(session, validCouncil());

    const result = await execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(result).toContain("Error: council_review received fewer than 2");
    expect(result).toContain("caller should fall back to a single reviewer");
    expect(session.prompt).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ agent: "test-aggregator" }) }),
    );
  });

  it("creates an aggregator synthesis session when at least two councillors succeed", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "councillor-a" } })
      .mockResolvedValueOnce({ data: { id: "councillor-b" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockResolvedValue({});
    session.messages
      .mockResolvedValueOnce({ data: assistantMessages("response a") })
      .mockResolvedValueOnce({ data: assistantMessages("response b") })
      .mockResolvedValueOnce({ data: assistantMessages("aggregated response") });
    const execute = await createExecute(session, validCouncil());

    const result = await execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(result).toBe("aggregated response");
    expect(session.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ title: "council: aggregator synthesis" }),
      }),
    );
    expect(session.prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: { id: "aggregator-session" },
        body: expect.objectContaining({ agent: "test-aggregator" }),
      }),
    );
    expect(abortIds(session)).toEqual([
      "councillor-a",
      "councillor-b",
      "aggregator-session",
    ]);
  });
});

describe("child session permissions", () => {
  it("passes bash allow and deny rules from the workspace opencode config", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "council-tool-"));
    fs.writeFileSync(
      path.join(directory, "opencode.json"),
      JSON.stringify({
        permission: {
          bash: {
            "*": "ask",
            "git status*": "allow",
            "npm install*": "ask",
            "rm *": "deny",
          },
        },
      }),
    );
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "permission-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("success") });
    const execute = await createExecute(session, validCouncil(), directory);

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          permission: [
            { permission: "bash", pattern: "git status*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
            { permission: "bash", pattern: "*", action: "deny" },
          ],
        }),
      }),
    );
  });
});

describe("session.abort cleanup", () => {
  it("aborts created councillor sessions after a successful response", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "successful-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("success") });
    const execute = await createExecute(session, validCouncil());

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(session.abort).toHaveBeenCalledWith({
      path: { id: "successful-session" },
    });
  });

  it("aborts created councillor sessions after prompt extraction fails", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "failed-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ data: { id: "failed-retry-session" } })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt
      .mockResolvedValueOnce({ error: "prompt failed" })
      .mockResolvedValueOnce({ error: "retry prompt failed" });
    const execute = await createExecute(session, validCouncil());

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(abortIds(session)).toEqual(
      expect.arrayContaining(["failed-session", "failed-retry-session"]),
    );
  });

  it("aborts a timed-out session after the underlying prompt eventually settles", async () => {
    const session = createSessionMocks();
    const slowPrompt = deferred<Record<string, unknown>>();
    session.create
      .mockResolvedValueOnce({ data: { id: "slow-session" } })
      .mockResolvedValueOnce({ error: "other model create failed" })
      .mockResolvedValueOnce({ error: "other model retry create failed" })
      .mockResolvedValueOnce({ data: { id: "retry-session" } });
    session.prompt.mockImplementation((input: { path: { id: string } }) => {
      if (input.path.id === "slow-session") return slowPrompt.promise;
      return Promise.resolve({});
    });
    session.messages.mockResolvedValue({ data: assistantMessages("eventual response") });
    const execute = await createExecute(session, validCouncil({
      timeouts: {
        councillor_ms: 250,
        councillor_retry_ms: 1_000,
        hard_cap_ms: 2_000,
      },
    }));

    const result = await execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(result).toContain("provider-a/model-a (2 attempts)");
    expect(abortIds(session)).toContain("retry-session");
    expect(abortIds(session)).not.toContain("slow-session");

    slowPrompt.resolve({});

    await eventually(() => {
      expect(abortIds(session)).toContain("slow-session");
    });
  });

  it("does not call abort when child session creation never returns an id", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "other create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" })
      .mockResolvedValueOnce({ error: "other retry create failed" });
    const execute = await createExecute(session, validCouncil());

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(session.abort).not.toHaveBeenCalled();
  });

  it("silences abort failures without changing the council result", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "abort-fails-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("success") });
    session.abort.mockRejectedValue(new Error("abort failed"));
    const execute = await createExecute(session, validCouncil());

    const result = await execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(result).toContain("fewer than 2 successful councillor responses (1/2)");
    expect(session.abort).toHaveBeenCalledWith({
      path: { id: "abort-fails-session" },
    });
  });
});
