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
  parseCouncilConfig,
  validateCouncilConfig,
  raceWithTimeout,
} from "./index";
import {
  AGGREGATOR_PERMISSION,
  AGGREGATOR_PROMPT,
  REVIEWER_PERMISSION,
  REVIEWER_PROMPT,
} from "./prompts";

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

function createContext(
  session: SessionMocks,
  directory = "/fallback-directory",
  appLog = vi.fn(async () => ({})),
) {
  return {
    client: { session, app: { log: appLog } },
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
  appLog?: ReturnType<typeof vi.fn>,
  resolvedConfig: Record<string, unknown> = {},
) {
  const hooks = (await CouncilToolPlugin(createContext(session, directory, appLog) as never, {
    council,
  } as never)) as unknown as {
    config: (config: Record<string, unknown>) => Promise<void>;
    tool: {
      council_review: {
        execute: (
          args: { prompt: string },
          toolContext: { sessionID: string },
        ) => Promise<string>;
      };
    };
  };
  await hooks.config(resolvedConfig);
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

function createPermissions(session: SessionMocks) {
  return (session.create.mock.calls as unknown as Array<[
    { body: Record<string, unknown> },
  ]>).map(([input]) => input.body.permission);
}

function expectNoAskRules(ruleset: unknown) {
  expect(ruleset).toEqual(
    expect.not.arrayContaining([expect.objectContaining({ action: "ask" })]),
  );
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

describe("structured logging", () => {
  it("logs undersized explicit hard cap warnings through the opencode app logger", async () => {
    const appLog = vi.fn(async () => ({}));

    await CouncilToolPlugin(
      createContext(createSessionMocks(), "/fallback-directory", appLog) as never,
      {
        council: validCouncil({ timeouts: { hard_cap_ms: 2_000 } }),
      } as never,
    );

    expect(appLog).toHaveBeenCalledWith({
      body: {
        service: "council-plugin",
        level: "warn",
        message: expect.stringContaining("Configured hard_cap_ms is below computed phase timeout budget"),
        extra: expect.objectContaining({
          configured_hard_cap_ms: 2_000,
          computed_hard_cap_ms: 420_000,
        }),
      },
    });
  });

  it("logs workspace ask stripping warnings through the opencode app logger", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const appLog = vi.fn(async () => ({}));
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "permission-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("success") });
    const hooks = (await CouncilToolPlugin(
      createContext(session, "/fallback-directory", appLog) as never,
      { council: validCouncil() } as never,
    )) as unknown as {
      config: (config: Record<string, unknown>) => Promise<void>;
      tool: { council_review: { execute: (args: { prompt: string }, toolContext: { sessionID: string }) => Promise<string> } };
    };
    await hooks.config({ permission: { bash: { "*": "ask" } } });

    await hooks.tool.council_review.execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(appLog).toHaveBeenCalledWith({
      body: {
        service: "council-plugin",
        level: "warn",
        message: expect.stringContaining("Stripping ask permission from workspace bash.*"),
      },
    });
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("emits debug logs when the config debug flag is enabled", async () => {
    const appLog = vi.fn(async () => ({}));
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
    const hooks = (await CouncilToolPlugin(
      createContext(session, "/fallback-directory", appLog) as never,
      { council: validCouncil({ debug: true }) } as never,
    )) as unknown as {
      tool: { council_review: { execute: (args: { prompt: string }, toolContext: { sessionID: string }) => Promise<string> } };
    };

    await hooks.tool.council_review.execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(appLog).toHaveBeenCalledWith({
      body: expect.objectContaining({
        service: "council-plugin",
        level: "debug",
        message: "councillor attempt started",
      }),
    });
    expect(appLog).toHaveBeenCalledWith({
      body: expect.objectContaining({
        service: "council-plugin",
        level: "debug",
        message: "aggregator synthesis started",
      }),
    });
  });

  it("emits debug logs when COUNCIL_DEBUG is 1", async () => {
    const previousDebug = process.env.COUNCIL_DEBUG;
    process.env.COUNCIL_DEBUG = "1";
    const appLog = vi.fn(async () => ({}));
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
    const hooks = (await CouncilToolPlugin(
      createContext(session, "/fallback-directory", appLog) as never,
      { council: validCouncil() } as never,
    )) as unknown as {
      tool: { council_review: { execute: (args: { prompt: string }, toolContext: { sessionID: string }) => Promise<string> } };
    };

    try {
      await hooks.tool.council_review.execute(
        { prompt: "review this" },
        { sessionID: "parent-session" },
      );

      expect(appLog).toHaveBeenCalledWith({
        body: expect.objectContaining({
          service: "council-plugin",
          level: "debug",
          message: "councillor attempt started",
        }),
      });
    } finally {
      if (previousDebug === undefined) {
        delete process.env.COUNCIL_DEBUG;
      } else {
        process.env.COUNCIL_DEBUG = previousDebug;
      }
    }
  });

  it("does not emit debug logs by default", async () => {
    const previousDebug = process.env.COUNCIL_DEBUG;
    delete process.env.COUNCIL_DEBUG;
    const appLog = vi.fn(async () => ({}));
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
    const hooks = (await CouncilToolPlugin(
      createContext(session, "/fallback-directory", appLog) as never,
      { council: validCouncil() } as never,
    )) as unknown as {
      tool: { council_review: { execute: (args: { prompt: string }, toolContext: { sessionID: string }) => Promise<string> } };
    };

    try {
      await hooks.tool.council_review.execute(
        { prompt: "review this" },
        { sessionID: "parent-session" },
      );

      expect(appLog).not.toHaveBeenCalledWith({
        body: expect.objectContaining({ level: "debug" }),
      });
    } finally {
      if (previousDebug !== undefined) process.env.COUNCIL_DEBUG = previousDebug;
    }
  });

  it("logs and aborts active child sessions when the outer hard cap timeout triggers", async () => {
    const appLog = vi.fn(async () => ({}));
    const session = createSessionMocks();
    const slowPrompt = deferred<Record<string, unknown>>();
    createIds(session, ["hard-cap-a", "hard-cap-b"]);
    session.prompt.mockReturnValue(slowPrompt.promise);
    session.messages.mockResolvedValue({ data: assistantMessages("late response") });
    const execute = await createExecute(
      session,
      validCouncil({
        debug: true,
        timeouts: {
          councillor_ms: 1_000,
          councillor_retry_ms: 1_000,
          aggregator_ms: 1_000,
          hard_cap_ms: 50,
        },
      }),
      "/fallback-directory",
      appLog,
    );

    const result = await execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(result).toContain("council_review timed out");
    expect(appLog).toHaveBeenCalledWith({
      body: expect.objectContaining({
        service: "council-plugin",
        level: "debug",
        message: "hard cap triggered",
      }),
    });
    expect(abortIds(session)).toEqual(
      expect.arrayContaining(["hard-cap-a", "hard-cap-b"]),
    );
    slowPrompt.resolve({});
  });

  it("logs councillor timeout events and retry triggers when debug is enabled", async () => {
    const appLog = vi.fn(async () => ({}));
    const session = createSessionMocks();
    const slowPrompt = deferred<Record<string, unknown>>();
    createIds(session, ["a-first", "b-first", "a-retry", "aggregator-session"]);
    session.prompt.mockImplementation((input: { path: { id: string } }) => {
      if (input.path.id === "a-first") return slowPrompt.promise;
      return Promise.resolve({});
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "b-first") return { data: assistantMessages("response b") };
      if (input.path.id === "a-retry") return { data: assistantMessages("retry response") };
      return { data: assistantMessages("aggregated response") };
    });
    const execute = await createExecute(
      session,
      validCouncil({
        debug: true,
        timeouts: {
          councillor_ms: 1,
          councillor_retry_ms: 1_000,
          aggregator_ms: 1_000,
          hard_cap_ms: 5_000,
        },
      }),
      "/fallback-directory",
      appLog,
    );

    const result = await execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(result).toBe("aggregated response");
    expect(appLog).toHaveBeenCalledWith({
      body: expect.objectContaining({
        level: "debug",
        message: "councillor attempt timed out",
      }),
    });
    expect(appLog).toHaveBeenCalledWith({
      body: expect.objectContaining({
        level: "debug",
        message: "councillor retry triggered",
      }),
    });
    slowPrompt.resolve({});
  });

  it("logs aggregator timeout events when debug is enabled", async () => {
    const appLog = vi.fn(async () => ({}));
    const session = createSessionMocks();
    const slowAggregator = deferred<Record<string, unknown>>();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockImplementation((input: { path: { id: string } }) => {
      if (input.path.id === "aggregator-session") return slowAggregator.promise;
      return Promise.resolve({});
    });
    session.messages
      .mockResolvedValueOnce({ data: assistantMessages("response a") })
      .mockResolvedValueOnce({ data: assistantMessages("response b") });
    const execute = await createExecute(
      session,
      validCouncil({
        debug: true,
        timeouts: {
          councillor_ms: 1_000,
          councillor_retry_ms: 1_000,
          aggregator_ms: 1,
          hard_cap_ms: 5_000,
        },
      }),
      "/fallback-directory",
      appLog,
    );

    const result = await execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(result).toContain("aggregator synthesis timed out");
    expect(appLog).toHaveBeenCalledWith({
      body: expect.objectContaining({
        level: "debug",
        message: "aggregator synthesis timed out",
      }),
    });
    slowAggregator.resolve({});
  });
});

describe("config hook bundled agents", () => {
  it("bundled reviewer denies write access", () => {
    expect(REVIEWER_PERMISSION).toHaveProperty("write", "deny");
  });

  it("bundled reviewer prompt encourages read-only investigation with available tools", () => {
    expect(REVIEWER_PROMPT).toEqual(expect.stringContaining("read"));
    expect(REVIEWER_PROMPT).toEqual(expect.stringContaining("glob"));
    expect(REVIEWER_PROMPT).toEqual(expect.stringContaining("grep"));
    expect(REVIEWER_PROMPT).toEqual(expect.stringContaining("bash"));
    expect(REVIEWER_PROMPT.toLowerCase()).toEqual(
      expect.stringContaining("read-only"),
    );
    expect(REVIEWER_PROMPT).not.toEqual(expect.stringContaining("Do not execute"));
    expect(REVIEWER_PROMPT).not.toEqual(
      expect.stringContaining("Review only the material supplied"),
    );
  });

  it("injects bundled agents when reviewer and aggregator are not user-specified", async () => {
    const hooks = (await CouncilToolPlugin(
      createContext(createSessionMocks()) as never,
      { council: { models: [MODEL_A, MODEL_B] } } as never,
    )) as unknown as { config: (config: Record<string, unknown>) => Promise<void> };
    const config: Record<string, unknown> = {};

    await hooks.config(config);

    expect(config.agent).toEqual({
      "council-plugin-reviewer": {
        description: "Council plugin adversarial code reviewer",
        mode: "subagent",
        hidden: true,
        temperature: 0.3,
        prompt: REVIEWER_PROMPT,
        permission: REVIEWER_PERMISSION,
      },
      "council-plugin-aggregator": {
        description: "Council plugin structural aggregator",
        mode: "subagent",
        hidden: true,
        temperature: 0,
        prompt: AGGREGATOR_PROMPT,
        permission: AGGREGATOR_PERMISSION,
      },
    });
  });

  it("uses reviewer_temperature to override the bundled reviewer agent temperature", async () => {
    const hooks = (await CouncilToolPlugin(
      createContext(createSessionMocks()) as never,
      { council: { models: [MODEL_A, MODEL_B], reviewer_temperature: 1.5 } } as never,
    )) as unknown as { config: (config: Record<string, unknown>) => Promise<void> };
    const config: Record<string, unknown> = {};

    await hooks.config(config);

    expect(config.agent).toEqual(
      expect.objectContaining({
        "council-plugin-reviewer": expect.objectContaining({
          temperature: 1.5,
        }),
      }),
    );
  });

  it("does not inject bundled agents when reviewer and aggregator are user-specified", async () => {
    const hooks = (await CouncilToolPlugin(
      createContext(createSessionMocks()) as never,
      { council: validCouncil() } as never,
    )) as unknown as { config: (config: Record<string, unknown>) => Promise<void> };
    const config: Record<string, unknown> = { agent: { existing: { mode: "subagent" } } };

    await hooks.config(config);

    expect(config.agent).toEqual({ existing: { mode: "subagent" } });
  });

  it("ignores reviewer_temperature when the reviewer agent is user-specified", async () => {
    const hooks = (await CouncilToolPlugin(
      createContext(createSessionMocks()) as never,
      {
        council: {
          models: [MODEL_A, MODEL_B],
          reviewer: "my-reviewer",
          reviewer_temperature: 1.5,
        },
      } as never,
    )) as unknown as { config: (config: Record<string, unknown>) => Promise<void> };
    const config: Record<string, unknown> = {
      agent: { "my-reviewer": { mode: "subagent" }, existing: { mode: "subagent" } },
    };

    await hooks.config(config);

    expect(config.agent).toEqual(
      expect.objectContaining({
        "my-reviewer": { mode: "subagent" },
      }),
    );
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

describe("parseCouncilConfig", () => {
  it("defaults reviewer and aggregator to bundled agent names", () => {
    const config = parseCouncilConfig({ council: { models: [MODEL_A, MODEL_B] } });

    expect(config.reviewer).toBe("council-plugin-reviewer");
    expect(config.aggregator).toBe("council-plugin-aggregator");
  });

  it("reads the debug option from config", () => {
    const config = validateCouncilConfig({
      council: validCouncil({ debug: true }),
    });

    expect(config.debug).toBe(true);
  });

  it("keeps the validateCouncilConfig export as a backward-compatible alias", () => {
    const config = validateCouncilConfig({ council: { models: [MODEL_A, MODEL_B] } });

    expect(config.reviewer).toBe("council-plugin-reviewer");
    expect(config.aggregator).toBe("council-plugin-aggregator");
  });

  it("validates reviewer_temperature as a finite number in the supported range", () => {
    expect(
      validateCouncilConfig({ council: { models: [MODEL_A, MODEL_B] } })
        .reviewer_temperature,
    ).toBeNull();

    for (const reviewerTemperature of [0, 0.3, 1.5, 2]) {
      expect(
        validateCouncilConfig({
          council: validCouncil({ reviewer_temperature: reviewerTemperature }),
        }).reviewer_temperature,
      ).toBe(reviewerTemperature);
    }

    for (const reviewerTemperature of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      3,
      "0.5",
      true,
      {},
    ]) {
      expect(() =>
        validateCouncilConfig({
          council: validCouncil({ reviewer_temperature: reviewerTemperature }),
        }),
      ).toThrow("council.reviewer_temperature must be a finite number between 0 and 2");
    }
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

  it("computes the default hard cap from the default phase timeouts", () => {
    const config = validateCouncilConfig({ council: { models: [MODEL_A, MODEL_B] } });

    expect(config.timeouts.aggregator_ms).toBe(120_000);
    expect(config.timeouts.hard_cap_ms).toBe(420_000);
  });

  it("computes the hard cap after reading configured phase timeouts", () => {
    const config = validateCouncilConfig({
      council: validCouncil({
        timeouts: {
          councillor_ms: 2_000,
          councillor_retry_ms: 3_000,
          aggregator_ms: 4_000,
        },
      }),
    });

    expect(config.timeouts.hard_cap_ms).toBe(39_000);
  });

  it("honors an explicit hard cap override even when it is below the computed default", () => {
    const config = validateCouncilConfig({
      council: validCouncil({
        timeouts: { hard_cap_ms: 2_000 },
      }),
    });

    expect(config.timeouts.hard_cap_ms).toBe(2_000);
  });

  it("does not upper-clamp configured phase timeouts", () => {
    const config = validateCouncilConfig({
      council: validCouncil({
        timeouts: { aggregator_ms: 999_999_999 },
      }),
    });

    expect(config.timeouts.aggregator_ms).toBe(999_999_999);
    expect(config.timeouts.hard_cap_ms).toBe(1_000_299_999);
  });

  it("warns when an explicit hard cap is below the computed hard cap", () => {
    const warn = vi.fn();

    const config = validateCouncilConfig(
      {
        council: validCouncil({
          timeouts: { hard_cap_ms: 2_000 },
        }),
      },
      warn,
    );

    expect(config.timeouts.hard_cap_ms).toBe(2_000);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Configured hard_cap_ms is below computed phase timeout budget"),
      expect.objectContaining({ configured_hard_cap_ms: 2_000, computed_hard_cap_ms: 420_000 }),
    );
  });

  it("floors invalid timeout values without upper-clamping large values", () => {
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
    expect(config.timeouts.aggregator_ms).toBe(999_999_999);
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
    expect(config.timeouts.hard_cap_ms).toBe(300_500);
  });

  it("keeps flat allow and deny permission overrides", () => {
    const config = validateCouncilConfig({
      council: validCouncil({ reviewer_permission: { bash: "deny" } }),
    });

    expect(config.reviewer_permission).toEqual({ bash: "deny" });
  });

  it("keeps nested permission override pattern maps", () => {
    const config = validateCouncilConfig({
      council: validCouncil({
        reviewer_permission: {
          bash: { "git *": "allow", "sudo *": "deny" },
        },
      }),
    });

    expect(config.reviewer_permission).toEqual({
      bash: { "git *": "allow", "sudo *": "deny" },
    });
  });

  it("keeps mixed flat and nested permission overrides", () => {
    const config = validateCouncilConfig({
      council: validCouncil({
        reviewer_permission: {
          read: "allow",
          external_directory: { "/tmp/*": "allow" },
        },
      }),
    });

    expect(config.reviewer_permission).toEqual({
      read: "allow",
      external_directory: { "/tmp/*": "allow" },
    });
  });

  it("strips flat ask permission overrides with a warning", () => {
    const warn = vi.fn();

    const config = validateCouncilConfig(
      {
        council: validCouncil({ reviewer_permission: { bash: "ask" } }),
      },
      warn,
    );

    expect(config.reviewer_permission).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Stripping ask permission override"),
    );
  });

  it("routes ask permission stripping warnings through the supplied warning logger", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warn = vi.fn();

    const config = validateCouncilConfig(
      {
        council: validCouncil({ reviewer_permission: { bash: "ask" } }),
      },
      warn,
    );

    expect(config.reviewer_permission).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Stripping ask permission override for bash"),
    );
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("strips nested ask permission override entries with a warning", () => {
    const warn = vi.fn();

    const config = validateCouncilConfig(
      {
        council: validCouncil({
          reviewer_permission: {
            external_directory: { "/path/*": "ask", "/other/*": "allow" },
          },
        }),
      },
      warn,
    );

    expect(config.reviewer_permission).toEqual({
      external_directory: { "/other/*": "allow" },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Stripping ask permission override"),
    );
  });

  it("removes nested permission keys when all entries are ask", () => {
    const warn = vi.fn();

    const config = validateCouncilConfig(
      {
        council: validCouncil({
          reviewer_permission: {
            external_directory: { "/path/*": "ask" },
          },
        }),
      },
      warn,
    );

    expect(config.reviewer_permission).toEqual({});
  });

  it("skips invalid permission override values", () => {
    const config = validateCouncilConfig({
      council: validCouncil({
        reviewer_permission: {
          read: null,
          bash: ["allow"],
          external_directory: { "/tmp/*": "allow", "/bad/*": 1 },
          question: 42,
        },
      }),
    });

    expect(config.reviewer_permission).toEqual({
      external_directory: { "/tmp/*": "allow" },
    });
  });

  it("keeps an empty object permission override as an empty result", () => {
    const config = validateCouncilConfig({
      council: validCouncil({ reviewer_permission: {} }),
    });

    expect(config.reviewer_permission).toEqual({});
  });

  it("returns null for non-object permission overrides", () => {
    const stringConfig = validateCouncilConfig({
      council: validCouncil({ reviewer_permission: "deny" }),
    });
    const arrayConfig = validateCouncilConfig({
      council: validCouncil({ aggregator_permission: ["deny"] }),
    });

    expect(stringConfig.reviewer_permission).toBeNull();
    expect(arrayConfig.aggregator_permission).toBeNull();
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
        body: expect.objectContaining({
          agent: "test-aggregator",
          tools: expect.objectContaining({ bash: false, read: false, council_review: false }),
        }),
      }),
    );
    expect(abortIds(session)).toEqual([
      "councillor-a",
      "councillor-b",
      "aggregator-session",
    ]);
  });

  it("resolves the parent directory once per review and reuses it for all child sessions", async () => {
    const session = createSessionMocks();
    session.get.mockResolvedValue({ data: { directory: "/resolved-parent" } });
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockResolvedValue({});
    session.messages
      .mockResolvedValueOnce({ data: assistantMessages("response a") })
      .mockResolvedValueOnce({ data: assistantMessages("response b") })
      .mockResolvedValueOnce({ data: assistantMessages("aggregated response") });
    const execute = await createExecute(session, validCouncil());

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(session.get).toHaveBeenCalledTimes(1);
    expect(session.create.mock.calls.map(([input]) => input.query)).toEqual([
      { directory: "/resolved-parent" },
      { directory: "/resolved-parent" },
      { directory: "/resolved-parent" },
    ]);
  });
});

describe("child session permissions", () => {
  it("passes session-level permissions for bundled agents without explicit overrides", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "bundled-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("success") });
    const execute = await createExecute(session, { models: [MODEL_A, MODEL_B] });

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    for (const permission of createPermissions(session)) {
      expect(permission).toEqual([
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "external_directory", pattern: "*", action: "allow" },
      ]);
      expectNoAskRules(permission);
    }
  });

  it("passes bash allow and deny rules from the cached config hook permission after catch-all allows", async () => {
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
    const appLog = vi.fn(async () => ({}));
    const session = createSessionMocks();
    session.get.mockResolvedValue({ data: { directory } });
    session.create
      .mockResolvedValueOnce({ data: { id: "permission-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("success") });
    const execute = await createExecute(session, validCouncil(), directory, appLog, {
      permission: {
        bash: {
          "*": "ask",
          "git status*": "allow",
          "npm install*": "ask",
          "rm *": "deny",
        },
      },
    });

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          permission: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "external_directory", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "git status*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      }),
    );
    expectNoAskRules(createPermissions(session)[0]);
    expect(appLog).toHaveBeenCalledWith({
      body: expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("Stripping ask permission from workspace"),
      }),
    });
  });

  it("passes external_directory allow and deny rules from the cached config hook permission", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "council-tool-"));
    fs.writeFileSync(
      path.join(directory, "opencode.json"),
      JSON.stringify({
        permission: {
          external_directory: {
            "*": "ask",
            "/Users/hunter/code/*": "allow",
            "/Users/hunter/secrets/*": "deny",
          },
        },
      }),
    );
    const appLog = vi.fn(async () => ({}));
    const session = createSessionMocks();
    session.get.mockResolvedValue({ data: { directory } });
    session.create
      .mockResolvedValueOnce({ data: { id: "permission-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("success") });
    const execute = await createExecute(session, validCouncil(), directory, appLog, {
      permission: {
        external_directory: {
          "*": "ask",
          "/Users/hunter/code/*": "allow",
          "/Users/hunter/secrets/*": "deny",
        },
      },
    });

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(createPermissions(session)[0]).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      {
        permission: "external_directory",
        pattern: "/Users/hunter/code/*",
        action: "allow",
      },
      {
        permission: "external_directory",
        pattern: "/Users/hunter/secrets/*",
        action: "deny",
      },
    ]);
    expectNoAskRules(createPermissions(session)[0]);
    expect(appLog).toHaveBeenCalledWith({
      body: expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("Stripping ask permission from workspace"),
      }),
    });
  });

  it("appends explicit reviewer permission overrides after workspace rules", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "council-tool-"));
    fs.writeFileSync(
      path.join(directory, "opencode.json"),
      JSON.stringify({
        permission: {
          bash: { "git *": "allow" },
        },
      }),
    );
    const session = createSessionMocks();
    session.get.mockResolvedValue({ data: { directory } });
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ data: { id: "reviewer-b" } })
      .mockResolvedValueOnce({ data: { id: "aggregator-session" } });
    session.prompt.mockResolvedValue({});
    session.messages
      .mockResolvedValueOnce({ data: assistantMessages("response a") })
      .mockResolvedValueOnce({ data: assistantMessages("response b") })
      .mockResolvedValueOnce({ data: assistantMessages("aggregated response") });
    const execute = await createExecute(
      session,
      {
        ...validCouncil(),
        reviewer_permission: {
          bash: "deny",
        },
      },
      directory,
      undefined,
      { permission: { bash: { "git *": "allow" } } },
    );

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(createPermissions(session)[0]).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "git *", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ]);
  });

  it("does not pass aggregator session permissions without explicit overrides", async () => {
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
    const execute = await createExecute(session, validCouncil());

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect((session.create.mock.calls[2][0] as { body: Record<string, unknown> }).body)
      .not.toHaveProperty("permission");
  });

  it("passes only explicit aggregator permission overrides", async () => {
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
    const execute = await createExecute(session, {
      ...validCouncil(),
      aggregator_permission: { bash: "deny" },
    });

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(createPermissions(session)[2]).toEqual([
      { permission: "bash", pattern: "*", action: "deny" },
    ]);
  });

  it("converts nested reviewer permission overrides to pattern rules", async () => {
    const session = createSessionMocks();
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("response a") });
    const execute = await createExecute(session, {
      models: [MODEL_A, MODEL_B],
      reviewer_permission: {
        bash: { "git *": "allow", "sudo *": "deny" },
        external_directory: { "/tmp/*": "allow" },
      },
    });

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(createPermissions(session)[0]).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "git *", action: "allow" },
      { permission: "bash", pattern: "sudo *", action: "deny" },
      { permission: "external_directory", pattern: "/tmp/*", action: "allow" },
    ]);
  });

  it("converts nested aggregator permission overrides to pattern rules only", async () => {
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
    const execute = await createExecute(session, {
      ...validCouncil(),
      aggregator_permission: {
        external_directory: { "/tmp/*": "deny" },
      },
    });

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(createPermissions(session)[2]).toEqual([
      { permission: "external_directory", pattern: "/tmp/*", action: "deny" },
    ]);
  });

  it("omits aggregator permissions when explicit overrides are empty after ask stripping", async () => {
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
    const execute = await createExecute(session, {
      ...validCouncil(),
      aggregator_permission: { bash: "ask" },
    });

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect((session.create.mock.calls[2][0] as { body: Record<string, unknown> }).body)
      .not.toHaveProperty("permission");
  });

  it("uses cached config hook permission rules instead of reading parent or fallback opencode files", async () => {
    const fallbackDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "council-fallback-"));
    const parentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "council-parent-"));
    fs.writeFileSync(
      path.join(fallbackDirectory, "opencode.json"),
      JSON.stringify({ permission: { bash: { "fallback *": "deny" } } }),
    );
    fs.writeFileSync(
      path.join(parentDirectory, "opencode.json"),
      JSON.stringify({ permission: { bash: { "parent *": "deny" } } }),
    );
    const session = createSessionMocks();
    session.get.mockResolvedValue({ data: { directory: parentDirectory } });
    session.create
      .mockResolvedValueOnce({ data: { id: "reviewer-a" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("response a") });
    const execute = await createExecute(
      session,
      validCouncil(),
      fallbackDirectory,
      undefined,
      { permission: { bash: { "cached *": "deny" } } },
    );

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(createPermissions(session)[0]).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "cached *", action: "deny" },
    ]);
    expect(createPermissions(session)[0]).toEqual(
      expect.not.arrayContaining([
        { permission: "bash", pattern: "fallback *", action: "deny" },
        { permission: "bash", pattern: "parent *", action: "deny" },
      ]),
    );
  });

  it("uses catch-all allows when the cached config hook permission is missing", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "council-tool-"));
    const session = createSessionMocks();
    session.get.mockResolvedValue({ data: { directory } });
    session.create
      .mockResolvedValueOnce({ data: { id: "permission-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("success") });
    const execute = await createExecute(session, validCouncil(), directory);

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(createPermissions(session)[0]).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ]);
  });

  it("uses catch-all allows when the cached config hook permission is not an object", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "council-tool-"));
    fs.writeFileSync(path.join(directory, "opencode.json"), "not json");
    const session = createSessionMocks();
    session.get.mockResolvedValue({ data: { directory } });
    session.create
      .mockResolvedValueOnce({ data: { id: "permission-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("success") });
    const execute = await createExecute(
      session,
      validCouncil(),
      directory,
      undefined,
      { permission: "allow" },
    );

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(createPermissions(session)[0]).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ]);
  });

  it("preserves cached permission object key order in the session ruleset", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "council-tool-"));
    fs.writeFileSync(
      path.join(directory, "opencode.json"),
      JSON.stringify({
        permission: {
          bash: {
            "first *": "allow",
            "second *": "deny",
            "third *": "allow",
          },
        },
      }),
    );
    const session = createSessionMocks();
    session.get.mockResolvedValue({ data: { directory } });
    session.create
      .mockResolvedValueOnce({ data: { id: "permission-session" } })
      .mockResolvedValueOnce({ error: "create failed" })
      .mockResolvedValueOnce({ error: "retry create failed" });
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("success") });
    const execute = await createExecute(
      session,
      validCouncil(),
      directory,
      undefined,
      {
        permission: {
          bash: {
            "first *": "allow",
            "second *": "deny",
            "third *": "allow",
          },
        },
      },
    );

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    expect(createPermissions(session)[0]).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "first *", action: "allow" },
      { permission: "bash", pattern: "second *", action: "deny" },
      { permission: "bash", pattern: "third *", action: "allow" },
    ]);
  });

  it("passes explicit reviewer and aggregator permission overrides at session level", async () => {
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
    const execute = await createExecute(session, {
      models: [MODEL_A, MODEL_B],
      reviewer_permission: {
        bash: "deny",
        read: "allow",
        question: "ask",
      },
      aggregator_permission: { "*": "deny" },
    });

    await execute({ prompt: "review this" }, { sessionID: "parent-session" });

    const createCalls = session.create.mock.calls as unknown as Array<[
      { body: Record<string, unknown> },
    ]>;
    expect(createCalls[0][0].body.permission).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ]);
    expect(createCalls[1][0].body.permission).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ]);
    expect(createCalls[2][0].body.permission).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
    ]);
    expectNoAskRules(createCalls[0][0].body.permission);
    expectNoAskRules(createCalls[1][0].body.permission);
    expectNoAskRules(createCalls[2][0].body.permission);
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

  it("aborts a timed-out session immediately without waiting for the underlying prompt to settle", async () => {
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
    expect(abortIds(session)).toContain("slow-session");

    slowPrompt.resolve({});

    await eventually(() => {
      expect(abortIds(session)).toContain("slow-session");
    });
  });

  it("aborts a councillor session when create resolves after the attempt timeout", async () => {
    const session = createSessionMocks();
    const slowCreate = deferred<{ data: { id: string } }>();
    session.create.mockImplementation(() => {
      const callNumber = session.create.mock.calls.length;
      if (callNumber === 1) return slowCreate.promise;
      if (callNumber === 2) return Promise.resolve({ data: { id: "other-councillor" } });
      if (callNumber === 3) return Promise.resolve({ data: { id: "retry-councillor" } });
      if (callNumber === 4) return Promise.resolve({ data: { id: "aggregator-session" } });
      return Promise.resolve({ error: "unexpected create" });
    });
    session.prompt.mockResolvedValue({});
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "other-councillor") {
        return { data: assistantMessages("other response") };
      }
      if (input.path.id === "retry-councillor") {
        return { data: assistantMessages("retry response") };
      }
      if (input.path.id === "aggregator-session") {
        return { data: assistantMessages("aggregated response") };
      }
      return { data: assistantMessages("late response") };
    });
    const execute = await createExecute(session, validCouncil({
      timeouts: {
        councillor_ms: 50,
        councillor_retry_ms: 1_000,
        aggregator_ms: 1_000,
        hard_cap_ms: 5_000,
      },
    }));

    const resultPromise = execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    await eventually(() => {
      expect(session.create.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(abortIds(session)).not.toContain("slow-created-session");
    });

    slowCreate.resolve({ data: { id: "slow-created-session" } });

    const result = await resultPromise;

    expect(result).toBe("aggregated response");
    expect(abortIds(session)).toEqual(
      expect.arrayContaining([
        "other-councillor",
        "retry-councillor",
        "aggregator-session",
      ]),
    );
    await eventually(() => {
      expect(abortIds(session)).toContain("slow-created-session");
    });
  });

  it("aborts the aggregator child session when aggregator synthesis times out", async () => {
    const session = createSessionMocks();
    const slowAggregatorPrompt = deferred<Record<string, unknown>>();
    createIds(session, ["councillor-a", "councillor-b", "aggregator-session"]);
    session.prompt.mockImplementation((input: { path: { id: string } }) => {
      if (input.path.id === "aggregator-session") return slowAggregatorPrompt.promise;
      return Promise.resolve({});
    });
    session.messages.mockImplementation(async (input: { path: { id: string } }) => {
      if (input.path.id === "councillor-a") {
        return { data: assistantMessages("response a") };
      }
      if (input.path.id === "councillor-b") {
        return { data: assistantMessages("response b") };
      }
      return { data: assistantMessages("late aggregate") };
    });
    const execute = await createExecute(session, validCouncil({
      timeouts: {
        councillor_ms: 1_000,
        councillor_retry_ms: 1_000,
        aggregator_ms: 50,
        hard_cap_ms: 5_000,
      },
    }));

    const result = await execute(
      { prompt: "review this" },
      { sessionID: "parent-session" },
    );

    expect(result).toContain("Error: council_review failed:");
    expect(result).toContain("aggregator synthesis timed out");
    expect(abortIds(session)).toContain("aggregator-session");

    slowAggregatorPrompt.resolve({});
    await eventually(() => {
      expect(abortIds(session)).toContain("aggregator-session");
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
