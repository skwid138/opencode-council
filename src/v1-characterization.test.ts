/**
 * Characterization tests for V1 host behavior, written against the pre-seam
 * code and kept green through the host-seam refactor.
 *
 * - Request-body goldens freeze the exact SDK bodies sent on V1 (session.create,
 *   session.prompt, session.abort, app.log). Any change here is a V1 behavior change.
 * - Awaited cleanup: a councillor/aggregator result is not used until its
 *   awaited session abort settles.
 * - Detached cleanup: timeout, laggard-sweep, hard-cap, and late-quorum aborts are
 *   fire-and-forget and never block the review on a never-settling abort.
 */
import { describe, expect, it, vi } from "vitest";

import { CouncilToolPlugin } from "./index";
import { createChildSession } from "./session";
import type { ReviewState } from "./types";
import { createV1Host } from "./v1";

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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function track(promise: Promise<unknown>) {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionIdForTitle(title: string): string {
  if (title === AGGREGATOR_TITLE) return "aggregator-session";
  // "council: provider-x/model-x" -> "reviewer-x"
  return `reviewer-${title.slice(-1)}`;
}

function assistantMessages(text: string) {
  return [
    {
      info: { role: "assistant", time: { created: 1 } },
      parts: [{ type: "text", text }],
    },
  ];
}

function createSdkContext() {
  const session = {
    get: vi.fn(async (_input: { path: { id: string } }) => ({
      data: { directory: "/parent-directory" },
    })),
    create: vi.fn(
      async (input: { body: { title: string } }): Promise<SdkResult> => ({
        data: { id: sessionIdForTitle(input.body.title) },
      }),
    ),
    prompt: vi.fn(
      async (_input: { path: { id: string }; body: Record<string, unknown> }): Promise<SdkResult> =>
        ({}),
    ),
    messages: vi.fn(async (input: { path: { id: string } }) => ({
      data: assistantMessages(
        input.path.id === "aggregator-session"
          ? "aggregated response"
          : `response from ${input.path.id}`,
      ),
    })),
    abort: vi.fn(async (_input: { path: { id: string } }): Promise<SdkResult> => ({})),
  };
  const appLog = vi.fn(async (_input: unknown) => ({}));
  return {
    session,
    appLog,
    ctx: { client: { session, app: { log: appLog } }, directory: "/fallback-directory" },
  };
}

async function councilReviewTool(
  ctx: unknown,
  council: Record<string, unknown>,
  workspacePermission?: unknown,
) {
  const hooks = await CouncilToolPlugin(ctx as never, { council } as never);
  await hooks.config?.({ permission: workspacePermission } as never);
  const councilReview = hooks.tool?.council_review;
  if (!councilReview) throw new Error("council_review not registered");
  return (prompt = "review this") =>
    councilReview.execute({ prompt }, { sessionID: "parent-session" } as never);
}

function abortIds(session: ReturnType<typeof createSdkContext>["session"]) {
  return session.abort.mock.calls.map(([input]) => input.path.id);
}

function aggregatorPromptText(session: ReturnType<typeof createSdkContext>["session"]) {
  const call = session.prompt.mock.calls.find(([input]) => input.path.id === "aggregator-session");
  const parts = call?.[0].body.parts as Array<{ text?: string }> | undefined;
  return parts?.[0]?.text ?? "";
}

const FROZEN_AGGREGATOR_TOOLS = {
  "chrome-devtools": false,
  context7: false,
  exa: false,
  figma: false,
  read: false,
  write: false,
  edit: false,
  bash: false,
  glob: false,
  grep: false,
  list: false,
  task: false,
  question: false,
  todowrite: false,
  webfetch: false,
  websearch: false,
  skill: false,
  compress: false,
  vision: false,
  council_review: false,
};

describe("V1 request-body goldens", () => {
  it("sends frozen create, prompt, abort, and log bodies for a fully configured review", async () => {
    const { ctx, session, appLog } = createSdkContext();
    const run = await councilReviewTool(
      ctx,
      {
        debug: true,
        models: [MODEL_A, MODEL_B],
        aggregator_model: { providerID: "provider-agg", modelID: "model-agg" },
        reviewer_permission: { read: "allow", bash: { "npm *": "deny", "rm *": "ask" } },
        aggregator_permission: { bash: "deny" },
      },
      { bash: { "git *": "allow", "sudo *": "ask" }, external_directory: { "/tmp/*": "deny" } },
    );

    await expect(run("  review this  ")).resolves.toBe("aggregated response");

    const reviewerRuleset = [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "git *", action: "allow" },
      { permission: "external_directory", pattern: "/tmp/*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "npm *", action: "deny" },
      // Step-2 recursion fix (E2): appended LAST, after reviewer_permission overrides.
      { permission: "council_review", pattern: "*", action: "deny" },
    ];

    expect(session.get.mock.calls).toStrictEqual([[{ path: { id: "parent-session" } }]]);
    expect(session.create.mock.calls).toStrictEqual([
      [
        {
          body: {
            parentID: "parent-session",
            title: "council: provider-a/model-a",
            permission: reviewerRuleset,
          },
          query: { directory: "/parent-directory" },
        },
      ],
      [
        {
          body: {
            parentID: "parent-session",
            title: "council: provider-b/model-b",
            permission: reviewerRuleset,
          },
          query: { directory: "/parent-directory" },
        },
      ],
      [
        {
          body: {
            parentID: "parent-session",
            title: AGGREGATOR_TITLE,
            permission: [{ permission: "bash", pattern: "*", action: "deny" }],
          },
          query: { directory: "/parent-directory" },
        },
      ],
    ]);

    // Reviewer prompt bodies carry NO `tools` field: a nonempty V1 prompt tools map
    // replaces the session ruleset. toStrictEqual fails if any extra key appears.
    expect(session.prompt.mock.calls).toStrictEqual([
      [
        {
          path: { id: "reviewer-a" },
          body: {
            agent: "council-plugin-reviewer",
            parts: [{ type: "text", text: "review this" }],
            model: { providerID: "provider-a", modelID: "model-a" },
          },
        },
      ],
      [
        {
          path: { id: "reviewer-b" },
          body: {
            agent: "council-plugin-reviewer",
            parts: [{ type: "text", text: "review this" }],
            model: { providerID: "provider-b", modelID: "model-b" },
          },
        },
      ],
      [
        {
          path: { id: "aggregator-session" },
          body: {
            agent: "council-plugin-aggregator",
            parts: [
              {
                type: "text",
                text: `You are aggregating multiple reviewer responses to one review prompt.

Do structural aggregation only. Do not issue your own verdict.

# Original review prompt

review this

# Participation summary supplied by council_review

Responded:
- provider-a/model-a
- provider-b/model-b

Failed or timed out:
- none

# Reviewer responses

## Reviewer 1: provider-a/model-a

response from reviewer-a

---

## Reviewer 2: provider-b/model-b

response from reviewer-b`,
              },
            ],
            model: { providerID: "provider-agg", modelID: "model-agg" },
            tools: FROZEN_AGGREGATOR_TOOLS,
          },
        },
      ],
    ]);
    for (const [input] of session.prompt.mock.calls.slice(0, 2)) {
      expect(Object.keys(input.body)).toStrictEqual([
        "agent",
        "parts",
        "model",
      ]);
    }

    expect(session.messages.mock.calls).toStrictEqual([
      [{ path: { id: "reviewer-a" } }],
      [{ path: { id: "reviewer-b" } }],
      [{ path: { id: "aggregator-session" } }],
    ]);
    expect(session.abort.mock.calls).toStrictEqual([
      [{ path: { id: "reviewer-a" } }],
      [{ path: { id: "reviewer-b" } }],
      [{ path: { id: "aggregator-session" } }],
    ]);

    const logBody = (
      level: string,
      message: string,
      extra?: Record<string, unknown>,
    ) => [
      {
        body:
          extra === undefined
            ? { service: "council-plugin", level, message }
            : { service: "council-plugin", level, message, extra },
      },
    ];
    expect(appLog.mock.calls).toStrictEqual([
      logBody(
        "warn",
        "Stripping ask permission override for bash.rm *; child sessions cannot prompt interactively (anomalyco/opencode#28037)",
      ),
      logBody(
        "warn",
        "Stripping ask permission from workspace bash.sudo *; child sessions cannot prompt interactively (anomalyco/opencode#28037)",
      ),
      logBody("debug", "buildReviewerRuleset permission output", {
        permission_json: JSON.stringify(reviewerRuleset),
      }),
      logBody("debug", "councillor request started", {
        model: "provider-a/model-a",
        timeout_ms: 270_000,
      }),
      logBody("debug", "councillor request started", {
        model: "provider-b/model-b",
        timeout_ms: 270_000,
      }),
      logBody("debug", "councillor request completed", {
        model: "provider-a/model-a",
        success: true,
        duration_ms: expect.any(Number),
      }),
      logBody("debug", "councillor request completed", {
        model: "provider-b/model-b",
        success: true,
        duration_ms: expect.any(Number),
      }),
      logBody("debug", "aggregator synthesis started", {
        model: "provider-agg/model-agg",
        timeout_ms: 120_000,
        successes: 2,
        failures: 0,
      }),
      logBody("debug", "aggregator synthesis ended", {
        success: true,
        duration_ms: expect.any(Number),
      }),
    ]);
  });

  it("sends frozen bodies for a minimal review with no permissions or aggregator model", async () => {
    const { ctx, session, appLog } = createSdkContext();
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B] });

    await expect(run()).resolves.toBe("aggregated response");

    expect(session.create.mock.calls.map(([input]) => input)).toStrictEqual([
      {
        body: {
          parentID: "parent-session",
          title: "council: provider-a/model-a",
          permission: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "external_directory", pattern: "*", action: "allow" },
            { permission: "council_review", pattern: "*", action: "deny" },
          ],
        },
        query: { directory: "/parent-directory" },
      },
      {
        body: {
          parentID: "parent-session",
          title: "council: provider-b/model-b",
          permission: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "external_directory", pattern: "*", action: "allow" },
            { permission: "council_review", pattern: "*", action: "deny" },
          ],
        },
        query: { directory: "/parent-directory" },
      },
      {
        body: { parentID: "parent-session", title: AGGREGATOR_TITLE },
        query: { directory: "/parent-directory" },
      },
    ]);
    const aggregatorBody = session.prompt.mock.calls[2][0].body;
    expect(Object.keys(aggregatorBody)).toStrictEqual(["agent", "parts", "tools"]);
    expect(aggregatorBody.agent).toBe("council-plugin-aggregator");
    expect(aggregatorBody.tools).toStrictEqual(FROZEN_AGGREGATOR_TOOLS);
    expect(abortIds(session)).toStrictEqual(["reviewer-a", "reviewer-b", "aggregator-session"]);
    expect(appLog).not.toHaveBeenCalled();
  });
});

describe("V1 review preparation ordering (baseline)", () => {
  it("looks up the parent session before composing permissions or emitting their logs", async () => {
    const { ctx, session, appLog } = createSdkContext();
    const run = await councilReviewTool(
      ctx,
      { debug: true, models: [MODEL_A, MODEL_B] },
      { bash: { "sudo *": "ask" } },
    );

    await expect(run()).resolves.toBe("aggregated response");

    const lookupOrder = session.get.mock.invocationCallOrder[0];
    const logOrder = (message: string) => {
      const index = appLog.mock.calls.findIndex(([input]) =>
        String((input as { body: { message: string } }).body.message).startsWith(message),
      );
      return appLog.mock.invocationCallOrder[index];
    };
    expect(lookupOrder).toBeLessThan(logOrder("Stripping ask permission from workspace bash.sudo *"));
    expect(lookupOrder).toBeLessThan(logOrder("buildReviewerRuleset permission output"));
  });
});

describe("awaited child cleanup ordering", () => {
  it("does not start aggregation until a councillor's awaited session abort settles", async () => {
    const { ctx, session } = createSdkContext();
    const reviewerAAbort = deferred<SdkResult>();
    session.abort.mockImplementation((input) =>
      input.path.id === "reviewer-a" ? reviewerAAbort.promise : Promise.resolve({}),
    );
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B] });

    const result = run();
    const state = track(result);
    await settle();

    expect(abortIds(session)).toContain("reviewer-a");
    expect(session.create.mock.calls.map(([input]) => input.body.title)).not.toContain(
      AGGREGATOR_TITLE,
    );
    expect(state.settled).toBe(false);

    reviewerAAbort.resolve({});

    await expect(result).resolves.toBe("aggregated response");
    expect(session.create.mock.calls.map(([input]) => input.body.title)).toContain(
      AGGREGATOR_TITLE,
    );
  });

  it("does not return the aggregation until the aggregator's awaited session abort settles", async () => {
    const { ctx, session } = createSdkContext();
    const aggregatorAbort = deferred<SdkResult>();
    session.abort.mockImplementation((input) =>
      input.path.id === "aggregator-session" ? aggregatorAbort.promise : Promise.resolve({}),
    );
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B] });

    const result = run();
    const state = track(result);
    await settle();

    expect(abortIds(session)).toContain("aggregator-session");
    expect(state.settled).toBe(false);

    aggregatorAbort.resolve({});

    await expect(result).resolves.toBe("aggregated response");
  });

  it("waits for the session abort before rejecting when the hard cap fires during create", async () => {
    const { ctx, session } = createSdkContext();
    const lateAbort = deferred<SdkResult>();
    const reviewState: ReviewState = {
      activeSessions: new Set(),
      hardCapTimedOut: false,
      quorumReached: false,
    };
    session.create.mockImplementationOnce(async () => {
      reviewState.hardCapTimedOut = true;
      return { data: { id: "late-child" } };
    });
    session.abort.mockReturnValueOnce(lateAbort.promise);

    const result = createChildSession(
      createV1Host(ctx as never),
      "parent",
      "title",
      "/dir",
      undefined,
      reviewState,
    );
    const state = track(result);
    await settle();

    expect(session.abort).toHaveBeenCalledWith({ path: { id: "late-child" } });
    expect(state.settled).toBe(false);

    lateAbort.resolve({});

    await expect(result).rejects.toThrow("council_review hard cap already triggered");
    expect(reviewState.activeSessions.has("late-child")).toBe(false);
  });
});

describe("detached child cleanup never blocks on a never-settling abort", () => {
  it("councillor timeout", async () => {
    const { ctx, session } = createSdkContext();
    session.prompt.mockImplementation((input) =>
      input.path.id === "reviewer-c" ? never() : Promise.resolve({}),
    );
    session.abort.mockImplementation((input) =>
      input.path.id === "reviewer-c" ? never() : Promise.resolve({}),
    );
    const run = await councilReviewTool(ctx, {
      models: [MODEL_A, MODEL_B, MODEL_C],
      timeouts: { councillor_ms: 40 },
    });

    await expect(run()).resolves.toBe("aggregated response");
    expect(abortIds(session)).toContain("reviewer-c");
    expect(aggregatorPromptText(session)).toContain(
      "- provider-c/model-c: provider-c/model-c timed out after 0s",
    );
  }, 2_000);

  it("aggregator timeout", async () => {
    const { ctx, session } = createSdkContext();
    session.prompt.mockImplementation((input) =>
      input.path.id === "aggregator-session" ? never() : Promise.resolve({}),
    );
    session.abort.mockImplementation((input) =>
      input.path.id === "aggregator-session" ? never() : Promise.resolve({}),
    );
    const run = await councilReviewTool(ctx, {
      models: [MODEL_A, MODEL_B],
      timeouts: { aggregator_ms: 40 },
    });

    await expect(run()).resolves.toBe(
      "Error: council_review failed: aggregator synthesis timed out after 0s",
    );
    expect(abortIds(session)).toContain("aggregator-session");
  }, 2_000);

  it("laggard abort sweep", async () => {
    const { ctx, session } = createSdkContext();
    session.prompt.mockImplementation((input) =>
      input.path.id === "reviewer-c" ? never() : Promise.resolve({}),
    );
    session.abort.mockImplementation((input) =>
      input.path.id === "reviewer-c" ? never() : Promise.resolve({}),
    );
    const run = await councilReviewTool(ctx, {
      models: [MODEL_A, MODEL_B, MODEL_C],
      quorum: 2,
    });

    await expect(run()).resolves.toBe("aggregated response");
    expect(abortIds(session)).toContain("reviewer-c");
    expect(aggregatorPromptText(session)).toContain(
      "## Aborted (quorum reached)\n\n- provider-c/model-c",
    );
  }, 2_000);

  it("hard cap", async () => {
    const { ctx, session } = createSdkContext();
    session.prompt.mockImplementation(() => never());
    session.abort.mockImplementation(() => never());
    const run = await councilReviewTool(ctx, {
      models: [MODEL_A, MODEL_B],
      timeouts: { hard_cap_ms: 40 },
    });

    await expect(run()).resolves.toBe(
      "Error: council_review failed: council_review timed out after 0s",
    );
    expect(abortIds(session)).toEqual(expect.arrayContaining(["reviewer-a", "reviewer-b"]));
  }, 2_000);

  it("late reviewer created after quorum", async () => {
    const { ctx, session } = createSdkContext();
    const lateCreate = deferred<SdkResult>();
    session.create.mockImplementation(async (input) =>
      input.body.title === "council: provider-c/model-c"
        ? await lateCreate.promise
        : { data: { id: sessionIdForTitle(input.body.title) } },
    );
    session.abort.mockImplementation((input) =>
      input.path.id === "reviewer-c" ? never() : Promise.resolve({}),
    );
    const run = await councilReviewTool(ctx, {
      models: [MODEL_A, MODEL_B, MODEL_C],
      quorum: 2,
      timeouts: { quorum_grace_ms: 10_000 },
    });

    const result = run();
    await settle();
    lateCreate.resolve({ data: { id: "reviewer-c" } });

    await expect(result).resolves.toBe("aggregated response");
    expect(abortIds(session)).toContain("reviewer-c");
    expect(aggregatorPromptText(session)).toContain(
      "- provider-c/model-c: Council quorum reached; aborting late reviewer session.",
    );
    expect(aggregatorPromptText(session)).not.toContain("Aborted");
  }, 2_000);
});
