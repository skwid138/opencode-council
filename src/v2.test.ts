import * as fs from "node:fs";
import * as path from "node:path";
import { inspect } from "node:util";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sandbox HOME / XDG_* / TMPDIR before importing the adapter (debug-log safety).
const sandbox = await vi.hoisted(async () => {
  const nodeFs = await import("node:fs");
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  const root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "council-v2-")));
  const saved: Record<string, string | undefined> = {};
  for (const key of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR", "COUNCIL_DEBUG"]) {
    saved[key] = process.env[key];
  }
  process.env.HOME = nodePath.join(root, "home");
  process.env.XDG_STATE_HOME = nodePath.join(root, "state");
  process.env.XDG_CONFIG_HOME = nodePath.join(root, "config");
  process.env.XDG_DATA_HOME = nodePath.join(root, "data");
  process.env.XDG_CACHE_HOME = nodePath.join(root, "cache");
  process.env.TMPDIR = nodePath.join(root, "tmp");
  delete process.env.COUNCIL_DEBUG;
  nodeFs.mkdirSync(process.env.HOME, { recursive: true });
  nodeFs.mkdirSync(process.env.TMPDIR, { recursive: true });
  return { root, saved };
});

const { createV2Host, createV2Setup, extractV2ChildText, setup, V2_ASK_DENIED_MESSAGE } = await import("./v2");
const { COUNCIL_REVIEW_DESCRIPTION, COUNCIL_REVIEW_PROMPT_ARG_DESCRIPTION, REVIEWER_PROMPT, AGGREGATOR_PROMPT, REVIEWER_PERMISSION } =
  await import("./prompts");
const { translatePermissionOverride } = await import("./v2-permissions");

import type {
  V2AgentDraft,
  V2PermissionEvaluation,
  V2SetupContext,
  V2ToolInfo,
} from "./v2-contract";

const HOME = path.join(sandbox.root, "home");
const MODEL_A = { providerID: "provider-a", modelID: "model-a" };
const MODEL_B = { providerID: "provider-b", modelID: "model-b" };
const AGGREGATOR_TITLE = "council: aggregator synthesis";
const CANCELLED = "Council review cancelled.";
const CHILD_REFUSAL = "Error: council_review cannot run inside a council child session.";

afterAll(() => {
  for (const [key, value] of Object.entries(sandbox.saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  vi.useRealTimers();
});

/** Every captured console.error argument, rendered structurally (incl. hidden props). */
function consoleArgsText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .flat()
    .map((arg: unknown) =>
      typeof arg === "string" ? arg : inspect(arg, { depth: null, showHidden: true }),
    )
    .join("\n");
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settle(ms = 20) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionIdForTitle(title: string): string {
  if (title === AGGREGATOR_TITLE) return "aggregator-session";
  return `reviewer-${title.slice(-1)}`;
}

function succeeded(text: string) {
  return [
    { type: "user", text: "prompt" },
    { type: "assistant", content: [{ type: "text", text }] },
    { type: "idle", outcome: "succeeded" },
  ];
}

function freshAgentDraft(): V2AgentDraft {
  return {
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
  };
}

function registration() {
  return { dispose: vi.fn(async () => {}) };
}

function createV2Fake(options: unknown) {
  const registrations = { agent: registration(), tool: registration(), hook: registration() };
  const agentCallbacks: Array<(editor: { update(id: string, fn: (draft: V2AgentDraft) => void): void }) => void> = [];
  const tools: V2ToolInfo[] = [];
  const hooks: Array<(event: V2PermissionEvaluation) => void | Promise<void>> = [];
  const agentModels: Record<string, { providerID: string; id: string; variant?: string } | undefined> = {};

  const session = {
    create: vi.fn(async (input: { title: string } & Record<string, unknown>) => ({
      id: sessionIdForTitle(input.title),
    })),
    get: vi.fn(async (_input: { sessionID: string }): Promise<{ permissions?: unknown[] }> => ({
      permissions: [],
    })),
    prompt: vi.fn(async (_input: { sessionID: string; text: string }): Promise<unknown> => ({})),
    wait: vi.fn(async (_input: { sessionID: string }): Promise<unknown> => undefined),
    context: vi.fn(async (input: { sessionID: string }): Promise<unknown[]> =>
      succeeded(
        input.sessionID === "aggregator-session"
          ? "aggregated response"
          : `response from ${input.sessionID}`,
      ),
    ),
    interrupt: vi.fn(
      async (_input: { sessionID: string; resume?: boolean }) => ({ interrupted: false }),
    ),
  };

  const ctx = {
    options,
    app: { name: "opencode", version: "2.0.32" },
    agent: {
      transform: vi.fn(async (callback: (typeof agentCallbacks)[number]) => {
        agentCallbacks.push(callback);
        return registrations.agent;
      }),
      get: vi.fn(async (input: { agentID: string }) => ({
        data: agentModels[input.agentID] ? { model: agentModels[input.agentID] } : {},
      })),
    },
    tool: {
      transform: vi.fn(async (callback: (editor: { add(tool: V2ToolInfo): void }) => void) => {
        callback({ add: (tool) => tools.push(tool) });
        return registrations.tool;
      }),
    },
    session,
    permission: {
      hook: vi.fn(async (_name: "evaluate", callback: (typeof hooks)[number]) => {
        hooks.push(callback);
        return registrations.hook;
      }),
    },
  };

  return {
    ctx: ctx as unknown as V2SetupContext,
    raw: ctx,
    session,
    tools,
    registrations,
    agentModels,
    replayAgents() {
      const drafts = new Map<string, V2AgentDraft>();
      const editor = {
        update(id: string, fn: (draft: V2AgentDraft) => void) {
          if (!drafts.has(id)) drafts.set(id, freshAgentDraft());
          fn(drafts.get(id)!);
        },
      };
      for (const callback of agentCallbacks) callback(editor);
      return Object.fromEntries(drafts);
    },
    evaluate(event: Partial<V2PermissionEvaluation> & { sessionID: string }) {
      const evaluation: V2PermissionEvaluation = {
        action: "shell",
        resources: ["git push"],
        effect: "ask",
        ...event,
      };
      for (const hook of hooks) void hook(evaluation);
      return evaluation;
    },
  };
}

async function setupCouncil(council: Record<string, unknown>, wrap = true) {
  const fake = createV2Fake(wrap ? { council } : council);
  const cleanup = await setup(fake.ctx);
  const tool = fake.tools.find((entry) => entry.name === "council_review");
  if (!tool) throw new Error("council_review not registered");
  const run = (sessionID = "parent-session", prompt: unknown = "review this", signal = new AbortController().signal) =>
    tool.execute(
      typeof prompt === "string" ? { prompt } : prompt,
      { sessionID, agent: "build", messageID: "m1", id: "call-1", signal },
    );
  return { ...fake, cleanup, tool, run };
}

function interruptIds(session: ReturnType<typeof createV2Fake>["session"]) {
  return session.interrupt.mock.calls.map(([input]) => input.sessionID);
}

describe("V2 setup registration", () => {
  it("registers council_review with a JSON-schema input, codemode disabled, and the shared description", async () => {
    const { tool, raw } = await setupCouncil({ models: [MODEL_A, MODEL_B] });

    expect(raw.tool.transform).toHaveBeenCalledTimes(1);
    expect(tool.name).toBe("council_review");
    expect(tool.description).toBe(COUNCIL_REVIEW_DESCRIPTION);
    expect(tool.input).toStrictEqual({
      type: "object",
      properties: {
        prompt: { type: "string", description: COUNCIL_REVIEW_PROMPT_ARG_DESCRIPTION },
      },
      required: ["prompt"],
    });
    expect(tool.options).toStrictEqual({ codemode: false });
  });

  it("upserts bundled agents on every transform replay against fresh host defaults", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B], reviewer_temperature: 1.2 });
    const expected = {
      "council-plugin-reviewer": {
        request: { settings: {}, headers: {}, body: { temperature: 1.2 } },
        mode: "subagent",
        hidden: true,
        permissions: translatePermissionOverride(REVIEWER_PERMISSION, HOME),
        description: "Council plugin adversarial code reviewer",
        system: REVIEWER_PROMPT,
      },
      "council-plugin-aggregator": {
        request: { settings: {}, headers: {}, body: { temperature: 0 } },
        mode: "subagent",
        hidden: true,
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
        description: "Council plugin structural aggregator",
        system: AGGREGATOR_PROMPT,
      },
    };

    expect(fake.replayAgents()).toStrictEqual(expected);
    expect(fake.replayAgents()).toStrictEqual(expected);
    expect(expected["council-plugin-reviewer"].permissions).toContainEqual({
      action: "shell",
      resource: "*",
      effect: "allow",
    });
  });

  it("defaults the bundled reviewer temperature to 0.3", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });

    expect(fake.replayAgents()["council-plugin-reviewer"].request.body.temperature).toBe(0.3);
  });

  it("does not upsert bundled agents the user replaced", async () => {
    const both = await setupCouncil({
      models: [MODEL_A, MODEL_B],
      reviewer: "my-reviewer",
      aggregator: "my-aggregator",
    });
    expect(both.raw.agent.transform).not.toHaveBeenCalled();

    const reviewerOnly = await setupCouncil({ models: [MODEL_A, MODEL_B], reviewer: "my-reviewer" });
    expect(Object.keys(reviewerOnly.replayAgents())).toEqual(["council-plugin-aggregator"]);
  });

  it("accepts direct (unwrapped) council options", async () => {
    const { run, session } = await setupCouncil({ models: [MODEL_A, MODEL_B] }, false);

    await expect(run()).resolves.toEqual({ content: "aggregated response" });
    expect(session.create).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid options like V1", async () => {
    await expect(setup(createV2Fake({ council: {} }).ctx)).rejects.toThrow("council.models is required");
  });
});

describe("V2 child creation", () => {
  it("creates reviewer and aggregator children with exact ordered payloads", async () => {
    const fake = await setupCouncil({
      models: [MODEL_A, MODEL_B],
      aggregator_model: { providerID: "provider-agg", modelID: "model-agg" },
      reviewer_permission: { bash: { "npm *": "deny", "git push*": "ask" } },
      aggregator_permission: { read: "allow" },
    });
    fake.session.get.mockResolvedValueOnce({
      permissions: [
        { action: "shell", resource: "rm *", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "ask" },
      ],
    });

    await expect(fake.run()).resolves.toEqual({ content: "aggregated response" });

    expect(fake.session.get.mock.calls).toStrictEqual([[{ sessionID: "parent-session" }]]);
    const parentDeny = { action: "shell", resource: "rm *", effect: "deny" };
    const reviewerPermissions = [
      parentDeny,
      { action: "edit", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "todowrite", resource: "*", effect: "deny" },
      { action: "shell", resource: "npm *", effect: "deny" },
      { action: "shell", resource: "git push*", effect: "ask" },
      { action: "council_review", resource: "*", effect: "deny" },
    ];
    expect(fake.session.create.mock.calls).toStrictEqual([
      [
        {
          parentID: "parent-session",
          title: "council: provider-a/model-a",
          agent: "council-plugin-reviewer",
          model: { providerID: "provider-a", id: "model-a" },
          permissions: reviewerPermissions,
        },
      ],
      [
        {
          parentID: "parent-session",
          title: "council: provider-b/model-b",
          agent: "council-plugin-reviewer",
          model: { providerID: "provider-b", id: "model-b" },
          permissions: reviewerPermissions,
        },
      ],
      [
        {
          parentID: "parent-session",
          title: AGGREGATOR_TITLE,
          agent: "council-plugin-aggregator",
          model: { providerID: "provider-agg", id: "model-agg" },
          permissions: [
            parentDeny,
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
            { action: "council_review", resource: "*", effect: "deny" },
          ],
        },
      ],
    ]);
    for (const [input] of fake.session.create.mock.calls) {
      expect(Object.keys(input)).toEqual(["parentID", "title", "agent", "model", "permissions"]);
    }
    expect(fake.session.prompt.mock.calls.map(([input]) => input)).toStrictEqual([
      { sessionID: "reviewer-a", text: "review this" },
      { sessionID: "reviewer-b", text: "review this" },
      { sessionID: "aggregator-session", text: expect.stringContaining("response from reviewer-a") },
    ]);
    expect(fake.raw.agent.get).not.toHaveBeenCalled();
  });

  it("resolves the aggregator model from the bundled agent at runtime, without variant", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    fake.agentModels["council-plugin-aggregator"] = { providerID: "p", id: "agg", variant: "high" };

    await fake.run();

    expect(fake.raw.agent.get).toHaveBeenCalledWith({ agentID: "council-plugin-aggregator" });
    expect(fake.session.create.mock.calls[2][0]).toMatchObject({
      agent: "council-plugin-aggregator",
      model: { providerID: "p", id: "agg" },
    });
    expect(fake.session.create.mock.calls[2][0].model).not.toHaveProperty("variant");
  });

  it("uses a custom aggregator agent's runtime model", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B], aggregator: "my-aggregator" });
    fake.agentModels["my-aggregator"] = { providerID: "custom", id: "custom-model" };

    await fake.run();

    expect(fake.session.create.mock.calls[2][0]).toMatchObject({
      agent: "my-aggregator",
      model: { providerID: "custom", id: "custom-model" },
    });
  });

  it("omits the model when the agent has none or the lookup fails", async () => {
    const none = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    await none.run();
    expect(Object.keys(none.session.create.mock.calls[2][0])).toEqual([
      "parentID",
      "title",
      "agent",
      "permissions",
    ]);

    const failing = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    failing.raw.agent.get.mockRejectedValueOnce(new Error("agent lookup failed"));
    await expect(failing.run()).resolves.toEqual({ content: "aggregated response" });
    expect(failing.session.create.mock.calls[2][0]).not.toHaveProperty("model");
  });

  it("fails closed without creating children when the parent session cannot be read", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    fake.session.get.mockRejectedValueOnce(new Error("no such session"));

    await expect(fake.run()).resolves.toEqual({
      content: "Error: council_review failed: failed to read parent session permissions: no such session",
    });
    expect(fake.session.create).not.toHaveBeenCalled();
  });

  it.each([
    ["non-array permissions", { permissions: { action: "shell", resource: "*", effect: "deny" } }],
    ["a malformed permission entry", { permissions: [{ action: "shell", resource: "*", effect: "deny" }, { action: "x" }] }],
  ])("fails closed without creating children when the parent session has %s", async (_label, parent) => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    fake.session.get.mockResolvedValueOnce(parent as never);

    await expect(fake.run()).resolves.toEqual({
      content: "Error: council_review failed: malformed parent session permissions",
    });
    expect(fake.session.create).not.toHaveBeenCalled();
  });

  it("accepts a parent session without a permissions field", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    fake.session.get.mockResolvedValueOnce({});

    await expect(fake.run()).resolves.toEqual({ content: "aggregated response" });
    expect(fake.session.create).toHaveBeenCalledTimes(3);
  });

  it("narrows unknown tool input", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });

    await expect(fake.run("parent-session", { prompt: 42 })).resolves.toEqual({
      content: "Error: Must provide a non-empty prompt",
    });
    await expect(fake.run("parent-session", null)).resolves.toEqual({
      content: "Error: Must provide a non-empty prompt",
    });
    expect(fake.session.create).not.toHaveBeenCalled();
  });
});

describe("V2 child result detection", () => {
  const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
    type: "assistant",
    content: [{ type: "text", text }],
    ...extra,
  });
  const idle = (outcome: string) => ({ type: "idle", outcome });

  it("returns the last assistant text when the last idle succeeded", () => {
    expect(extractV2ChildText([{ type: "user" }, assistant("answer"), idle("succeeded")])).toBe("answer");
  });

  it("joins only text content amid reasoning and tool content", () => {
    expect(
      extractV2ChildText([
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "first" },
            { type: "tool", name: "read", text: "tool text" },
            { type: "text", text: "second" },
          ],
        },
        idle("succeeded"),
      ]),
    ).toBe("first\nsecond");
  });

  it("fails when there is no idle marker", () => {
    expect(() => extractV2ChildText([assistant("answer")])).toThrow("did not settle");
  });

  it("uses the last idle: an old success followed by a failed idle fails", () => {
    expect(() =>
      extractV2ChildText([assistant("old"), idle("succeeded"), assistant("new"), idle("failed")]),
    ).toThrow("child session failed");
  });

  it("fails on partial text with a failed idle", () => {
    expect(() => extractV2ChildText([assistant("partial"), idle("failed")])).toThrow("failed");
  });

  it("fails on an interrupted idle", () => {
    expect(() => extractV2ChildText([assistant("partial"), idle("interrupted")])).toThrow(
      "child session interrupted",
    );
  });

  it("fails when the last assistant carries an error", () => {
    expect(() =>
      extractV2ChildText([assistant("text", { error: { name: "ProviderError" } }), idle("succeeded")]),
    ).toThrow("assistant error");
  });

  it("does not backtrack to earlier text when the latest assistant is empty", () => {
    expect(() =>
      extractV2ChildText([assistant("earlier"), { type: "assistant", content: [] }, idle("succeeded")]),
    ).toThrow("empty response");
  });

  it("fails on a non-array context", () => {
    expect(() => extractV2ChildText({ messages: [] })).toThrow("invalid session context");
  });
});

describe("V2 child stop", () => {
  function host(session: Partial<V2SetupContext["session"]>) {
    const fake = createV2Fake({});
    Object.assign(fake.session, session);
    return { host: createV2Host(fake.ctx, { log: vi.fn(), home: HOME }), session: fake.session };
  }

  it("interrupts without resume, then waits, and confirms", async () => {
    const { host: v2, session } = host({});

    await expect(v2.stopChild("child")).resolves.toEqual({ ok: true });
    expect(session.interrupt).toHaveBeenCalledWith({ sessionID: "child", resume: false });
    expect(session.wait).toHaveBeenCalledWith({ sessionID: "child" });
  });

  it("memoizes duplicate stops of the same child", async () => {
    const { host: v2, session } = host({});

    const first = v2.stopChild("child");
    const second = v2.stopChild("child", { deadline: Date.now() + 1 });

    expect(second).toBe(first);
    await first;
    expect(session.interrupt).toHaveBeenCalledTimes(1);
  });

  it("reports a stalled interrupt unconfirmed at the default 5 s deadline", async () => {
    vi.useFakeTimers();
    const { host: v2 } = host({ interrupt: () => never() });

    const result = v2.stopChild("child");
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({ ok: false });
  });

  it("reports a never-settling wait unconfirmed within the shared deadline", async () => {
    vi.useFakeTimers();
    const { host: v2, session } = host({ wait: () => never() });

    const result = v2.stopChild("child", { deadline: Date.now() + 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toMatchObject({ ok: false });
    expect(session.interrupt).toHaveBeenCalledTimes(1);
  });

  it("reports an interrupt rejection unconfirmed", async () => {
    const { host: v2 } = host({ interrupt: () => Promise.reject(new Error("gone")) });

    await expect(v2.stopChild("child")).resolves.toMatchObject({ ok: false });
  });

  it("stops every child of two concurrent reviews exactly once", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    let next = 0;
    fake.session.create.mockImplementation(async () => ({ id: `child-${++next}` }));
    fake.session.context.mockImplementation(async (input) => succeeded(`text from ${input.sessionID}`));

    const [first, second] = await Promise.all([fake.run("parent-1"), fake.run("parent-2")]);

    expect(first.content).toContain("text from child-");
    expect(second.content).toContain("text from child-");
    expect(interruptIds(fake.session).sort()).toEqual(
      ["child-1", "child-2", "child-3", "child-4", "child-5", "child-6"],
    );
    for (let i = 1; i <= 6; i++) {
      expect(fake.evaluate({ sessionID: `child-${i}` }).effect).toBe("ask");
    }
  });
});

describe("V2 evaluate hook (ask -> deny for owned children)", () => {
  it("denies asks from a council child during its prompt and refuses its council_review calls", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    const observed: Array<{ effect: string; message?: string }> = [];
    let nested: Promise<unknown> | undefined;
    fake.session.prompt.mockImplementation(async (input) => {
      if (input.sessionID === "reviewer-a") {
        observed.push(fake.evaluate({ sessionID: "reviewer-a" }));
        observed.push(fake.evaluate({ sessionID: "reviewer-a", effect: "allow" }));
        observed.push(fake.evaluate({ sessionID: "unrelated-session" }));
        nested ??= fake.run("reviewer-a", "nested");
      }
      return {};
    });

    await expect(fake.run()).resolves.toEqual({ content: "aggregated response" });

    expect(observed).toEqual([
      expect.objectContaining({ effect: "deny", message: V2_ASK_DENIED_MESSAGE }),
      expect.objectContaining({ effect: "allow" }),
      expect.objectContaining({ effect: "ask" }),
    ]);
    expect(observed[1]).not.toHaveProperty("message");
    await expect(nested).resolves.toEqual({ content: CHILD_REFUSAL });
    expect(fake.session.create).toHaveBeenCalledTimes(3);
  });

  it("keeps denying while a stop is pending and stops after the confirmed release", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    const interruptA = deferred<{ interrupted: boolean }>();
    fake.session.interrupt.mockImplementation((input) =>
      input.sessionID === "reviewer-a" ? interruptA.promise : Promise.resolve({ interrupted: false }),
    );

    const result = fake.run();
    await settle();
    expect(interruptIds(fake.session)).toContain("reviewer-a");
    expect(fake.evaluate({ sessionID: "reviewer-a" }).effect).toBe("deny");

    interruptA.resolve({ interrupted: false });
    await expect(result).resolves.toEqual({ content: "aggregated response" });

    expect(fake.evaluate({ sessionID: "reviewer-a" }).effect).toBe("ask");
    expect(fake.evaluate({ sessionID: "aggregator-session" }).effect).toBe("ask");
    await expect(fake.run("reviewer-a")).resolves.toEqual({ content: "aggregated response" });
  });

  it("keeps protecting a child whose stop was never confirmed", async () => {
    vi.useFakeTimers();
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    fake.session.interrupt.mockImplementation((input) =>
      input.sessionID === "reviewer-a" ? never() : Promise.resolve({ interrupted: false }),
    );

    const result = fake.run();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toEqual({ content: "aggregated response" });
    expect(fake.evaluate({ sessionID: "reviewer-a" }).effect).toBe("deny");
    await expect(fake.run("reviewer-a")).resolves.toEqual({ content: CHILD_REFUSAL });
  });
});

describe("V2 cancellation through the registered tool", () => {
  it("aborting the tool signal cancels: bounded completion, child interrupts, no aggregation", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    fake.session.wait.mockImplementation(() => never());
    fake.session.interrupt.mockImplementation(() => never());
    const controller = new AbortController();

    const result = fake.run("parent-session", "review this", controller.signal);
    await settle();
    expect(fake.session.prompt).toHaveBeenCalledTimes(2);
    controller.abort();

    await expect(result).resolves.toEqual({ content: CANCELLED });
    expect(fake.session.interrupt.mock.calls.map(([input]) => input)).toEqual([
      { sessionID: "reviewer-a", resume: false },
      { sessionID: "reviewer-b", resume: false },
    ]);
    expect(fake.session.create.mock.calls.map(([input]) => input.title)).not.toContain(AGGREGATOR_TITLE);
  }, 2_000);
});

describe("V2 plugin cleanup", () => {
  it("stops owned children within 5 s, disposes registrations, then clears ownership (unsettled-child residual)", async () => {
    vi.useFakeTimers();
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    fake.session.wait.mockImplementation(() => never());
    fake.session.interrupt.mockImplementation((input) =>
      input.sessionID === "reviewer-a" ? never() : Promise.resolve({ interrupted: true }),
    );
    const controller = new AbortController();
    void fake.run("parent-session", "review this", controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.evaluate({ sessionID: "reviewer-a" }).effect).toBe("deny");

    let done = false;
    const cleanup = fake.cleanup().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    expect(interruptIds(fake.session).sort()).toEqual(["reviewer-a", "reviewer-b"]);
    await vi.advanceTimersByTimeAsync(1);
    await cleanup;

    expect(fake.registrations.hook.dispose).toHaveBeenCalledTimes(1);
    expect(fake.registrations.tool.dispose).toHaveBeenCalledTimes(1);
    expect(fake.registrations.agent.dispose).toHaveBeenCalledTimes(1);
    // Documented residual: an unsettled child loses ask -> deny and the guard after cleanup.
    expect(fake.evaluate({ sessionID: "reviewer-a" }).effect).toBe("ask");

    await fake.cleanup();
    expect(fake.registrations.hook.dispose).toHaveBeenCalledTimes(1);
    controller.abort();
  });
});

describe("V2 logging", () => {
  it("logs warnings to console.error with the council prefix", async () => {
    await setupCouncil({ models: [MODEL_A, MODEL_B], reviewer: "my-reviewer", reviewer_temperature: 1 });

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/^\[council-plugin\] warn: reviewer_temperature is configured/),
    );
  });

  it("writes debug records to the sandboxed debug log only when debug is enabled", async () => {
    const logPath = path.join(sandbox.root, "state", "opencode-council", "debug.log");
    const quiet = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    await quiet.run();
    await quiet.cleanup();
    expect(fs.existsSync(logPath)).toBe(false);

    const loud = await setupCouncil({ models: [MODEL_A, MODEL_B], debug: true });
    await loud.run("parent-session", "SENTINEL-PROMPT review");
    await loud.cleanup();

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain('"event":"councillor request completed"');
    expect(content).not.toContain("SENTINEL");
  });
});

/**
 * A running child: `wait` settles only once the child has been interrupted.
 * Fake semantics only — real V2 interrupt/wait/admission settlement remains
 * unverified until the real-host plan.
 */
function interruptibleSession(
  session: ReturnType<typeof createV2Fake>["session"],
  interruptDelayMs: (sessionID: string) => number = () => 0,
  stopWaitAt?: number,
) {
  const interrupted = new Set<string>();
  session.interrupt.mockImplementation(
    (input) =>
      new Promise((resolve) => {
        const delay = interruptDelayMs(input.sessionID);
        const done = () => {
          interrupted.add(input.sessionID);
          resolve({ interrupted: true });
        };
        if (delay > 0) setTimeout(done, delay);
        else done();
      }),
  );
  session.wait.mockImplementation((input) => {
    if (!interrupted.has(input.sessionID)) return never();
    if (stopWaitAt === undefined) return Promise.resolve(undefined);
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, stopWaitAt - Date.now())));
  });
  return interrupted;
}

describe("V2 pending prompt admission vs. stop (Must 1)", () => {
  it("holds the stop until a pending prompt admission settles, then interrupts the woken execution", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    const admissionA = deferred<unknown>();
    fake.session.prompt.mockImplementation((input) =>
      input.sessionID === "reviewer-a" ? admissionA.promise : Promise.resolve({}),
    );
    interruptibleSession(fake.session);
    const controller = new AbortController();

    const result = fake.run("parent-session", "review this", controller.signal);
    await settle();
    controller.abort();
    await expect(result).resolves.toEqual({ content: CANCELLED });
    await settle();

    expect(interruptIds(fake.session)).toEqual(["reviewer-b"]);
    expect(fake.evaluate({ sessionID: "reviewer-a" }).effect).toBe("deny");
    expect(fake.evaluate({ sessionID: "reviewer-b" }).effect).toBe("ask");

    admissionA.resolve({});
    await settle();

    expect(interruptIds(fake.session)).toEqual(["reviewer-b", "reviewer-a"]);
    expect(fake.evaluate({ sessionID: "reviewer-a" }).effect).toBe("ask");
    // The stop-requested child never proceeds to wait/context for its result.
    expect(fake.session.context).not.toHaveBeenCalled();
    expect(fake.session.wait.mock.calls.filter(([input]) => input.sessionID === "reviewer-a"))
      .toHaveLength(1);
  });

  it("keeps a child owned and unconfirmed when its admission outlives the stop deadline", async () => {
    vi.useFakeTimers();
    // Debug on: the stop's `{ok:false}` result is observable through its
    // "council child stop unconfirmed" log at exactly the deadline.
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B], debug: true });
    const unconfirmedFor = (id: string) =>
      consoleError.mock.calls.filter(
        ([line]: unknown[]) =>
          String(line).includes("council child stop unconfirmed") &&
          String(line).includes(`"sessionID":"${id}"`),
      ).length;
    fake.session.prompt.mockImplementation((input) =>
      input.sessionID === "reviewer-a" ? never() : Promise.resolve({}),
    );
    interruptibleSession(fake.session);
    const controller = new AbortController();

    const result = fake.run("parent-session", "review this", controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(result).resolves.toEqual({ content: CANCELLED });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(unconfirmedFor("reviewer-a")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(unconfirmedFor("reviewer-a")).toBe(1);

    expect(interruptIds(fake.session)).toEqual(["reviewer-b"]);
    expect(fake.evaluate({ sessionID: "reviewer-a" }).effect).toBe("deny");
    await expect(fake.run("reviewer-a")).resolves.toEqual({ content: CHILD_REFUSAL });
    await fake.cleanup();
  });

  it("resolves a stop {ok:false} at the deadline while the prompt admission is still pending (host level)", async () => {
    vi.useFakeTimers();
    // Fake-host semantics only; real interrupt/wait/admission settlement stays
    // unverified until the real-host plan.
    const fake = createV2Fake({});
    fake.session.prompt.mockImplementation(() => never());
    const v2 = createV2Host(fake.ctx, { log: vi.fn(), home: HOME });
    const id = await v2.createChild({ parentID: "p", title: "council: provider-a/model-a", directory: "" });
    void v2.runChild({ sessionID: id, agent: "a", prompt: "x" }).catch(() => {});
    let outcome: unknown;

    const stop = v2.stopChild(id, { deadline: Date.now() + 5_000 });
    void stop.then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toMatchObject({ ok: false });
    expect(fake.session.interrupt).not.toHaveBeenCalled();
    expect(v2.trackedChildren).toBe(1);
  });
});

describe("V2 cleanup cancels in-flight reviews (Must 2)", () => {
  const SHUTTING_DOWN = "Error: council_review is unavailable: the council plugin is shutting down.";

  it("cancels a review pending on the parent lookup without creating children", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    fake.session.get.mockImplementation(() => never());

    const result = fake.run();
    await settle();
    await fake.cleanup();

    await expect(result).resolves.toEqual({ content: CANCELLED });
    expect(fake.session.create).not.toHaveBeenCalled();
  });

  it("stops a child whose create resolves after cleanup and never prompts it", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    const createA = deferred<{ id: string }>();
    fake.session.create.mockImplementation(async (input) =>
      input.title.endsWith("model-a") ? await createA.promise : { id: sessionIdForTitle(input.title) },
    );
    interruptibleSession(fake.session);

    const result = fake.run();
    await settle();
    await fake.cleanup();
    await expect(result).resolves.toEqual({ content: CANCELLED });

    createA.resolve({ id: "reviewer-a" });
    await settle();

    expect(interruptIds(fake.session)).toEqual(["reviewer-b", "reviewer-a"]);
    expect(fake.session.prompt.mock.calls.map(([input]) => input.sessionID)).toEqual(["reviewer-b"]);
    expect(fake.session.create.mock.calls.map(([input]) => input.title)).not.toContain(AGGREGATOR_TITLE);
  });

  it("refuses council_review immediately after cleanup", async () => {
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    await fake.cleanup();

    await expect(fake.run()).resolves.toEqual({ content: SHUTTING_DOWN });
    expect(fake.session.get).not.toHaveBeenCalled();
    expect(fake.session.create).not.toHaveBeenCalled();
  });

  it("stays bounded at 5 s when in-flight children never stop", async () => {
    vi.useFakeTimers();
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B] });
    fake.session.wait.mockImplementation(() => never());
    fake.session.interrupt.mockImplementation(() => never());
    const result = fake.run();
    await vi.advanceTimersByTimeAsync(0);

    let done = false;
    const cleanup = fake.cleanup().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cleanup;

    await expect(result).resolves.toEqual({ content: CANCELLED });
    expect(interruptIds(fake.session).sort()).toEqual(["reviewer-a", "reviewer-b"]);
  });
});

describe("V2 stop deadline and memo (Should 3, 4)", () => {
  function host(session: Partial<V2SetupContext["session"]> = {}) {
    const fake = createV2Fake({});
    Object.assign(fake.session, session);
    return { host: createV2Host(fake.ctx, { log: vi.fn(), home: HOME }), session: fake.session };
  }

  it("settles at the original shared deadline even when the interrupt is admitted late", async () => {
    vi.useFakeTimers();
    const { host: v2 } = host({
      interrupt: () => new Promise((resolve) => setTimeout(() => resolve({ interrupted: true }), 3_000)),
      wait: () => never(),
    });
    let settled = false;

    const result = v2.stopChild("child", { deadline: Date.now() + 5_000 });
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe(true);
    await expect(result).resolves.toMatchObject({ ok: false });
  });

  it("stops staggered children concurrently within one shared sweep deadline", async () => {
    vi.useFakeTimers();
    const fake = await setupCouncil({
      models: [MODEL_A, MODEL_B, { providerID: "provider-c", modelID: "model-c" }],
    });
    const start = Date.now();
    const delays: Record<string, number> = { "reviewer-a": 1_000, "reviewer-b": 2_000, "reviewer-c": 3_000 };
    interruptibleSession(fake.session, (id) => delays[id] ?? 0, start + 4_500);
    const controller = new AbortController();

    const result = fake.run("parent-session", "review this", controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(result).resolves.toEqual({ content: CANCELLED });
    expect(interruptIds(fake.session)).toEqual(["reviewer-a", "reviewer-b", "reviewer-c"]);

    await vi.advanceTimersByTimeAsync(4_400);
    expect(fake.evaluate({ sessionID: "reviewer-c" }).effect).toBe("deny");
    await vi.advanceTimersByTimeAsync(200);
    for (const id of ["reviewer-a", "reviewer-b", "reviewer-c"]) {
      expect(fake.evaluate({ sessionID: id }).effect).toBe("ask");
    }
  });

  it("drops a child's stop memo once its stop is confirmed and keeps it while unconfirmed", async () => {
    const confirmed = host();
    await expect(confirmed.host.stopChild("child")).resolves.toEqual({ ok: true });
    expect(confirmed.host.trackedChildren).toBe(0);
    await confirmed.host.stopChild("child");
    expect(confirmed.session.interrupt).toHaveBeenCalledTimes(2);

    const failing = host({ interrupt: vi.fn(() => Promise.reject(new Error("gone"))) });
    const first = failing.host.stopChild("child");
    await first;
    expect(failing.host.trackedChildren).toBe(1);
    expect(failing.host.stopChild("child")).toBe(first);
    expect(failing.session.interrupt).toHaveBeenCalledTimes(1);

    failing.host.resetStops();
    expect(failing.host.trackedChildren).toBe(0);
  });

  it("forgets completed children after a normal review", async () => {
    const fake = createV2Fake({});
    const v2 = createV2Host(fake.ctx, { log: vi.fn(), home: HOME });
    const id = await v2.createChild({ parentID: "p", title: "council: provider-a/model-a", directory: "" });
    await expect(v2.runChild({ sessionID: id, agent: "a", prompt: "x" })).resolves.toBe(
      "response from reviewer-a",
    );
    await v2.stopChild(id);

    expect(v2.trackedChildren).toBe(0);
  });
});

describe("V2 console and debug-file sanitization (Should 6)", () => {
  it("never prints error message text or enumerable error props to the console or debug file", async () => {
    const logPath = path.join(sandbox.root, "state", "opencode-council", "debug.log");
    fs.rmSync(logPath, { force: true });
    const sentinelError = () =>
      Object.assign(new Error("SENTINEL-PROMPT-TEXT in message"), { detail: "SENTINEL-PROP" });
    const fake = await setupCouncil({
      models: [MODEL_A, MODEL_B, { providerID: "provider-c", modelID: "model-c" }],
      debug: true,
    });
    fake.raw.agent.get.mockRejectedValue(sentinelError());
    fake.session.prompt.mockImplementation(async (input) => {
      if (input.sessionID === "reviewer-c") throw sentinelError();
      return {};
    });
    fake.session.interrupt.mockImplementation(async (input) => {
      if (input.sessionID === "reviewer-a") throw sentinelError();
      return { interrupted: false };
    });
    fake.registrations.hook.dispose.mockRejectedValue(sentinelError());

    await fake.run();
    await fake.cleanup();

    const consoleText = consoleArgsText(consoleError);
    expect(consoleText).toContain("[council-plugin]");
    expect(consoleText).toContain("council permission hook registration dispose failed");
    expect(consoleText).not.toContain("SENTINEL");
    expect(fs.readFileSync(logPath, "utf8")).not.toContain("SENTINEL");
  });
});

describe("V2 never prints raw user config values (round 2 Must 1)", () => {
  it("keeps parser warnings free of raw config values on the console and in the debug file", async () => {
    const logPath = path.join(sandbox.root, "state", "opencode-council", "debug.log");
    fs.rmSync(logPath, { force: true });
    const S = "SENTINEL-CONFIG-VALUE";

    const fake = await setupCouncil({
      debug: true,
      models: [MODEL_A, MODEL_B, { providerID: "provider-c", modelID: "model-c", optional: S }],
      quorum: { value: S },
      aggregator_model: { providerID: "provider-agg", modelID: "model-agg", optional: S },
      timeouts: {
        councillor_retry_ms: S,
        councillor_ms: 1_000,
        optional_councillor_ms: 5_000,
        aggregator_ms: S,
        quorum_grace_ms: S,
        hard_cap_ms: 10,
      },
      reviewer_permission: { bash: S, read: { "~/x": S }, write: { [S]: "maybe" } },
      aggregator_permission: { webfetch: { "*": S } },
    });
    await fake.cleanup();

    const consoleText = consoleArgsText(consoleError);
    expect(consoleText).toContain("Invalid council.quorum: <object>.");
    expect(consoleText).toContain("council.models optional flag must be boolean");
    expect(consoleText).toContain("Configured hard_cap_ms is below computed phase timeout budget");
    expect(consoleText).not.toContain(S);
    expect(fs.readFileSync(logPath, "utf8")).not.toContain(S);
  });

  it.each([
    [{ value: "x" }, "<object>"],
    [["x"], "<array>"],
    ["x", "<string>"],
    [1.5, "<number>"],
    [true, "<boolean>"],
    [null, "<null>"],
  ])("describes an invalid quorum %j by type only (%s)", async (quorum, described) => {
    await setupCouncil({ models: [MODEL_A, MODEL_B], quorum });

    expect(consoleArgsText(consoleError)).toContain(`Invalid council.quorum: ${described}.`);
  });
});

describe("V2 debug log after cleanup (round 2 Should 2)", () => {
  it("never reopens or recreates the debug file for logs emitted after cleanup", async () => {
    const logPath = path.join(sandbox.root, "state", "opencode-council", "debug.log");
    fs.rmSync(logPath, { force: true });
    const fake = await setupCouncil({ models: [MODEL_A, MODEL_B], debug: true });
    const createA = deferred<{ id: string }>();
    fake.session.create.mockImplementation(async (input) =>
      input.title.endsWith("model-a") ? await createA.promise : { id: sessionIdForTitle(input.title) },
    );
    interruptibleSession(fake.session);
    const interruptRunning = fake.session.interrupt.getMockImplementation()!;
    fake.session.interrupt.mockImplementation(async (input) => {
      if (input.sessionID === "reviewer-a") throw new Error("late stop failure");
      return await interruptRunning(input);
    });

    const result = fake.run();
    await settle();
    await fake.cleanup();
    await expect(result).resolves.toEqual({ content: CANCELLED });
    expect(fs.existsSync(logPath)).toBe(true);
    fs.rmSync(logPath);

    createA.resolve({ id: "reviewer-a" });
    await settle(50);

    expect(consoleArgsText(consoleError)).toContain("council child stop unconfirmed");
    expect(fs.existsSync(logPath)).toBe(false);
  });
});

describe("V2 cleanup is always bounded (round 2 Should 3)", () => {
  it("returns even when registration disposal and the debug-file close never settle", async () => {
    vi.useFakeTimers();
    const fakeDebugFile = {
      write: vi.fn(),
      flush: () => never<void>(),
      close: vi.fn(() => never<void>()),
      path: "/never",
      disabled: false,
    };
    const fake = createV2Fake({ council: { models: [MODEL_A, MODEL_B], debug: true } });
    fake.registrations.hook.dispose.mockImplementation(() => never());
    fake.registrations.tool.dispose.mockImplementation(() => never());
    const cleanup = await createV2Setup({ createDebugFile: () => fakeDebugFile })(fake.ctx);

    let done = false;
    const finished = cleanup().then(() => {
      done = true;
    });
    // No owned children; hook (1 s) + tool (1 s) + agent (settles) + debug close (1 s) = 3 s.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await finished;

    expect(fake.registrations.agent.dispose).toHaveBeenCalledTimes(1);
    expect(fakeDebugFile.close).toHaveBeenCalledTimes(1);
    const consoleText = consoleArgsText(consoleError);
    expect(consoleText).toContain("council permission hook registration dispose timed out");
    expect(consoleText).toContain("council tool registration dispose timed out");
    expect(consoleText).toContain("council debug log close timed out");
  });
});

describe("V2 late child after a phase timeout", () => {
  it("never prompts a reviewer created after its councillor timeout and stops it; fallback result unchanged", async () => {
    vi.useFakeTimers();
    const fake = await setupCouncil({
      models: [MODEL_A, MODEL_B],
      timeouts: { councillor_ms: 50, hard_cap_ms: 60_000 },
    });
    const createA = deferred<{ id: string }>();
    fake.session.create.mockImplementation(async (input) =>
      input.title.endsWith("model-a") ? await createA.promise : { id: sessionIdForTitle(input.title) },
    );

    const result = fake.run();
    await vi.advanceTimersByTimeAsync(50);
    const { content } = await result;
    expect(content).toContain("fewer than 2 successful councillor responses (1/2; required: 1/2)");
    expect(content).toContain("- provider-a/model-a: provider-a/model-a timed out after 0s");

    createA.resolve({ id: "reviewer-a" });
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.session.prompt.mock.calls.map(([input]) => input.sessionID)).toEqual(["reviewer-b"]);
    expect(interruptIds(fake.session)).toEqual(["reviewer-b", "reviewer-a"]);
  });

  it("never prompts an aggregator created after the aggregator timeout and stops it; timeout error unchanged", async () => {
    vi.useFakeTimers();
    const fake = await setupCouncil({
      models: [MODEL_A, MODEL_B],
      timeouts: { aggregator_ms: 50, hard_cap_ms: 60_000 },
    });
    const createAggregator = deferred<{ id: string }>();
    fake.session.create.mockImplementation(async (input) =>
      input.title === AGGREGATOR_TITLE ? await createAggregator.promise : { id: sessionIdForTitle(input.title) },
    );

    const result = fake.run();
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toEqual({
      content: "Error: council_review failed: aggregator synthesis timed out after 0s",
    });

    createAggregator.resolve({ id: "aggregator-session" });
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.session.prompt.mock.calls.map(([input]) => input.sessionID)).not.toContain("aggregator-session");
    expect(interruptIds(fake.session)).toContain("aggregator-session");
  });
});
