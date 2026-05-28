import * as fs from "node:fs";
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

import defaultExport, {
  CouncilToolPlugin,
  parseCouncilConfig,
  raceWithTimeout,
  validateCouncilConfig,
} from "./index";
import {
  AGGREGATOR_PERMISSION,
  AGGREGATOR_PROMPT,
  REVIEWER_PERMISSION,
  REVIEWER_PROMPT,
} from "./prompts";

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

function createContext(appLog = vi.fn(async () => ({}))) {
  return {
    client: { session: createSessionMocks(), app: { log: appLog } },
    directory: "/fallback-directory",
  };
}

describe("plugin module shape", () => {
  it("default export preserves the server property", () => {
    expect(defaultExport).toEqual({ server: CouncilToolPlugin });
    expect(typeof defaultExport.server).toBe("function");
  });

  it("server function returns config hook and council_review tool", async () => {
    const hooks = await CouncilToolPlugin(createContext() as never, {
      council: { models: [MODEL_A, MODEL_B] },
    } as never);

    expect(typeof hooks.config).toBe("function");
    expect(hooks.tool).toHaveProperty("council_review");
    expect(hooks.tool?.council_review.description).toContain("Fan out a review prompt");
  });
});

describe("public re-exports", () => {
  it("re-exports parseCouncilConfig and validateCouncilConfig as the same function reference", () => {
    expect(validateCouncilConfig).toBe(parseCouncilConfig);
    expect(parseCouncilConfig({ council: { models: [MODEL_A, MODEL_B] } }).reviewer).toBe(
      "council-plugin-reviewer",
    );
  });

  it("re-exports raceWithTimeout", async () => {
    await expect(raceWithTimeout(Promise.resolve("ok"), 250, "fast operation"))
      .resolves.toBe("ok");
  });
});

describe("config hook bundled agents", () => {
  it("injects bundled reviewer and aggregator agents when not user-specified", async () => {
    const hooks = await CouncilToolPlugin(createContext() as never, {
      council: { models: [MODEL_A, MODEL_B] },
    } as never);
    const config: Record<string, unknown> = {};

    await hooks.config?.(config as never);

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

  it("uses reviewer_temperature for the injected bundled reviewer", async () => {
    const hooks = await CouncilToolPlugin(createContext() as never, {
      council: { models: [MODEL_A, MODEL_B], reviewer_temperature: 1.5 },
    } as never);
    const config: Record<string, unknown> = {};

    await hooks.config?.(config as never);

    expect(config.agent).toEqual(
      expect.objectContaining({
        "council-plugin-reviewer": expect.objectContaining({ temperature: 1.5 }),
      }),
    );
  });

  it("does not inject bundled agents when reviewer and aggregator are user-specified", async () => {
    const hooks = await CouncilToolPlugin(createContext() as never, {
      council: {
        models: [MODEL_A, MODEL_B],
        reviewer: "my-reviewer",
        aggregator: "my-aggregator",
      },
    } as never);
    const config: Record<string, unknown> = { agent: { existing: { mode: "subagent" } } };

    await hooks.config?.(config as never);

    expect(config.agent).toEqual({ existing: { mode: "subagent" } });
  });
});

describe("package.json exports", () => {
  it("keeps both package root and ./server resolving to dist/index.js", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
    );

    expect(pkg.exports["."]).toEqual({
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(pkg.exports["./server"]).toEqual({ import: "./dist/index.js" });
  });
});
