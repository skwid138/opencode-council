import { describe, expect, it, vi } from "vitest";

import { createV1Host } from "./v1";

function hostWithAbort(abort: (input: { path: { id: string } }) => unknown) {
  const session = { abort: vi.fn(abort) };
  return {
    session,
    host: createV1Host({ client: { session }, directory: "/fallback-directory" } as never),
  };
}

describe("createV1Host stopChild", () => {
  it("reports a confirmed stop when session.abort resolves without an error", async () => {
    const { host, session } = hostWithAbort(async () => ({ data: true }));

    await expect(host.stopChild("child")).resolves.toEqual({ ok: true });
    expect(session.abort).toHaveBeenCalledWith({ path: { id: "child" } });
  });

  it("reports a failed stop when session.abort resolves with an SDK error", async () => {
    const { host } = hostWithAbort(async () => ({ error: { name: "NotFound" } }));

    await expect(host.stopChild("child")).resolves.toEqual({
      ok: false,
      error: { name: "NotFound" },
    });
  });

  it("never rejects when session.abort rejects or throws synchronously", async () => {
    const rejection = new Error("network down");
    const rejecting = hostWithAbort(async () => {
      throw rejection;
    });
    await expect(rejecting.host.stopChild("child")).resolves.toEqual({
      ok: false,
      error: rejection,
    });

    const syncError = new Error("sync boom");
    const throwing = hostWithAbort(() => {
      throw syncError;
    });
    await expect(throwing.host.stopChild("child")).resolves.toEqual({
      ok: false,
      error: syncError,
    });
  });
});

const AGGREGATOR_TITLE = "council: aggregator synthesis";
const CHILD_REFUSAL = "Error: council_review cannot run inside a council child session.";
const MODEL_A = { providerID: "provider-a", modelID: "model-a" };
const MODEL_B = { providerID: "provider-b", modelID: "model-b" };
const MODEL_C = { providerID: "provider-c", modelID: "model-c" };

type SdkResult = Record<string, unknown>;

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function sessionIdForTitle(title: string): string {
  if (title === AGGREGATOR_TITLE) return "aggregator-session";
  return `reviewer-${title.slice(-1)}`;
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
  const appLog = vi.fn(async (_input: unknown) => ({}));
  return {
    session,
    appLog,
    ctx: { client: { session, app: { log: appLog } }, directory: "/fallback-directory" },
  };
}

async function councilReviewTool(ctx: unknown, council: Record<string, unknown>) {
  const { CouncilToolPlugin } = await import("./v1");
  const hooks = await CouncilToolPlugin(ctx as never, { council } as never);
  await hooks.config?.({} as never);
  const councilReview = hooks.tool?.council_review;
  if (!councilReview) throw new Error("council_review not registered");
  return (sessionID: string, prompt = "review this") =>
    councilReview.execute({ prompt }, { sessionID } as never);
}

describe("council_review child ownership guard (V1)", () => {
  it("refuses a council child that invokes council_review during its first prompt, without creating children", async () => {
    const { ctx, session } = createSdkContext();
    let nested: Promise<unknown> | undefined;
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B] });
    session.prompt.mockImplementation(async (input) => {
      // Nest at most once so a missing guard fails instead of recursing forever.
      if (input.path.id === "reviewer-a" && !nested) nested = run("reviewer-a", "nested review");
      return {};
    });

    await expect(run("parent-session")).resolves.toBe("aggregated response");

    await expect(nested).resolves.toBe(CHILD_REFUSAL);
    expect(session.create).toHaveBeenCalledTimes(3);
    expect(session.prompt).toHaveBeenCalledTimes(3);
  });

  it("keeps refusing a child whose abort never settles", async () => {
    const { ctx, session } = createSdkContext();
    session.abort.mockImplementation((input) =>
      input.path.id === "reviewer-a" ? never() : Promise.resolve({}),
    );
    const run = await councilReviewTool(ctx, {
      models: [MODEL_A, MODEL_B, MODEL_C],
      quorum: 2,
      timeouts: { councillor_ms: 40 },
    });

    await expect(run("parent-session")).resolves.toBe("aggregated response");
    const creates = session.create.mock.calls.length;

    await expect(run("reviewer-a")).resolves.toBe(CHILD_REFUSAL);
    expect(session.create).toHaveBeenCalledTimes(creates);
  });

  it("keeps refusing a child whose abort reports an SDK error", async () => {
    const { ctx, session } = createSdkContext();
    session.abort.mockImplementation(async (input) =>
      input.path.id === "reviewer-a" ? { error: { name: "NotFound" } } : {},
    );
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B] });

    await expect(run("parent-session")).resolves.toBe("aggregated response");

    await expect(run("reviewer-a")).resolves.toBe(CHILD_REFUSAL);
    expect(session.create).toHaveBeenCalledTimes(3);
  });

  it("keeps refusing a child whose abort rejects", async () => {
    const { ctx, session } = createSdkContext();
    session.abort.mockImplementation(async (input) => {
      if (input.path.id === "reviewer-a") throw new Error("network down");
      return {};
    });
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B] });

    await expect(run("parent-session")).resolves.toBe("aggregated response");

    await expect(run("reviewer-a")).resolves.toBe(CHILD_REFUSAL);
    expect(session.create).toHaveBeenCalledTimes(3);
  });

  it("releases a child once its abort is confirmed", async () => {
    const { ctx, session } = createSdkContext();
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B] });

    await expect(run("parent-session")).resolves.toBe("aggregated response");

    await expect(run("reviewer-a")).resolves.toBe("aggregated response");
    expect(session.create).toHaveBeenCalledTimes(6);
  });

  it("leaves parent and unrelated sessions unaffected", async () => {
    const { ctx, session } = createSdkContext();
    session.abort.mockImplementation(async (input) =>
      input.path.id === "reviewer-a" ? { error: "retained" } : {},
    );
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B] });

    await expect(run("parent-session")).resolves.toBe("aggregated response");
    await expect(run("parent-session")).resolves.toBe("aggregated response");
    await expect(run("unrelated-session")).resolves.toBe("aggregated response");
    await expect(run("unrelated-session", "   ")).resolves.toBe(
      "Error: Must provide a non-empty prompt",
    );
  });

  it("isolates ownership between plugin instances", async () => {
    const first = createSdkContext();
    first.session.abort.mockImplementation(async (input) =>
      input.path.id === "reviewer-a" ? { error: "retained" } : {},
    );
    const second = createSdkContext();
    const runFirst = await councilReviewTool(first.ctx, { models: [MODEL_A, MODEL_B] });
    const runSecond = await councilReviewTool(second.ctx, { models: [MODEL_A, MODEL_B] });

    await expect(runFirst("parent-session")).resolves.toBe("aggregated response");

    await expect(runFirst("reviewer-a")).resolves.toBe(CHILD_REFUSAL);
    await expect(runSecond("reviewer-a")).resolves.toBe("aggregated response");
    expect(second.session.create).toHaveBeenCalledTimes(3);
  });
});

describe("council_review cancellation through the V1 tool context", () => {
  it("aborting the tool context cancels the review: bounded completion, child stops, no aggregation", async () => {
    const { ctx, session } = createSdkContext();
    session.prompt.mockImplementation(() => never());
    session.abort.mockImplementation(() => never());
    const { CouncilToolPlugin } = await import("./v1");
    const hooks = await CouncilToolPlugin(ctx as never, {
      council: { models: [MODEL_A, MODEL_B] },
    } as never);
    await hooks.config?.({} as never);
    const controller = new AbortController();

    const result = hooks.tool?.council_review.execute({ prompt: "review this" }, {
      sessionID: "parent-session",
      abort: controller.signal,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.prompt).toHaveBeenCalledTimes(2);
    controller.abort();

    await expect(result).resolves.toBe("Council review cancelled.");
    expect(session.abort.mock.calls.map(([input]) => input.path.id)).toEqual([
      "reviewer-a",
      "reviewer-b",
    ]);
    expect(session.create.mock.calls.map(([input]) => input.body.title)).not.toContain(
      AGGREGATOR_TITLE,
    );
  }, 2_000);

  it("returns the cancellation result without creating children when the tool context is already aborted", async () => {
    const { ctx, session } = createSdkContext();
    const { CouncilToolPlugin } = await import("./v1");
    const hooks = await CouncilToolPlugin(ctx as never, {
      council: { models: [MODEL_A, MODEL_B] },
    } as never);

    await expect(
      hooks.tool?.council_review.execute({ prompt: "review this" }, {
        sessionID: "parent-session",
        abort: AbortSignal.abort(),
      } as never),
    ).resolves.toBe("Council review cancelled.");
    expect(session.create).not.toHaveBeenCalled();
  });
});

describe("V1 observable behavior pinned in audit round 2", () => {
  it("keeps the raw value in the V1 invalid-quorum app.log warning", async () => {
    const { ctx, appLog } = createSdkContext();
    const { CouncilToolPlugin } = await import("./v1");

    await CouncilToolPlugin(ctx as never, {
      council: { models: [MODEL_A, MODEL_B], quorum: { value: "raw" } },
    } as never);

    expect(appLog).toHaveBeenCalledWith({
      body: {
        service: "council-plugin",
        level: "warn",
        message: 'Invalid council.quorum: {"value":"raw"}. Must be integer in [2, 2]. Falling back to 2.',
      },
    });
  });

  it("falls back to the plugin directory and still reviews when the parent lookup rejects", async () => {
    const { ctx, session } = createSdkContext();
    session.get.mockRejectedValue(new Error("lookup failed"));
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B] });

    await expect(run("parent-session")).resolves.toBe("aggregated response");

    expect(session.get).toHaveBeenCalledWith({ path: { id: "parent-session" } });
    expect(session.create.mock.calls.map(([input]) => (input as { query?: unknown }).query)).toEqual([
      { directory: "/fallback-directory" },
      { directory: "/fallback-directory" },
      { directory: "/fallback-directory" },
    ]);
    expect(
      (session.create.mock.calls[0][0] as unknown as { body: { permission: unknown } }).body.permission,
    ).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "council_review", pattern: "*", action: "deny" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// E3: an errored V1 assistant reply (host info.error) is a failure, even with partial text.

const E3_PARTIAL = "PARTIAL-SECRET-TEXT";
const E3_ERROR = {
  name: "HOSTILE-NAME",
  data: { message: "HOSTILE-MESSAGE", responseHeaders: { authorization: "Bearer HOSTILE-HEADER" }, responseBody: "HOSTILE-BODY", metadata: { url: "HOSTILE-METADATA" } },
};
const E3_HOSTILE = [E3_PARTIAL, "HOSTILE-NAME", "HOSTILE-MESSAGE", "HOSTILE-HEADER", "HOSTILE-BODY", "HOSTILE-METADATA"];
const E3_FAILED_MESSAGES = { data: [{ info: { role: "assistant", time: { created: 1 }, error: E3_ERROR }, parts: [{ type: "text", text: E3_PARTIAL }] }] };

/** Messages for `failing` session ids are an errored assistant with partial text; others are healthy. */
function withFailedChildren(session: ReturnType<typeof createSdkContext>["session"], failing: string[]) {
  const healthy = session.messages.getMockImplementation()!;
  session.messages.mockImplementation(async (input) => (failing.includes(input.path.id) ? E3_FAILED_MESSAGES : healthy(input)) as never);
}
function aggregatorPrompt(session: ReturnType<typeof createSdkContext>["session"]): string {
  const call = session.prompt.mock.calls.find(([input]) => input.path.id === "aggregator-session");
  return (call?.[0] as unknown as { body: { parts: { text: string }[] } } | undefined)?.body.parts[0].text ?? "";
}
function expectNoHostile(...texts: string[]) {
  for (const text of texts) for (const hostile of E3_HOSTILE) expect(text).not.toContain(hostile);
}
const createdTitles = (session: ReturnType<typeof createSdkContext>["session"]) => session.create.mock.calls.map(([input]) => input.body.title);
type LogBody = { level: string; message: string; extra?: Record<string, unknown> };
const logBodies = (appLog: ReturnType<typeof createSdkContext>["appLog"]) => appLog.mock.calls.map(([input]) => (input as { body: LogBody }).body);
/** The recorded failure event must exist (debug logging on), carrying only the fixed E3 literal. */
function expectFailureEvent(appLog: ReturnType<typeof createSdkContext>["appLog"], message: string, extra: Record<string, unknown>) {
  expect(logBodies(appLog)).toContainEqual({ service: "council-plugin", level: "debug", message, extra: expect.objectContaining({ success: false, error: "assistant error: failed", ...extra }) });
}
const E3_DEBUG = { debug: true };
/** A stop whose request is observable and whose result is released explicitly. */
function deferredStop() {
  let markCalled!: () => void;
  let release!: () => void;
  const called = new Promise<void>((resolve) => (markCalled = resolve));
  const settled = new Promise<SdkResult>((resolve) => (release = () => resolve({})));
  return { called, release: () => release(), request: () => (markCalled(), settled) };
}

describe("E3: V1 failed-assistant classification through the registered tool", () => {
  it("two healthy + one failed-partial reviewer: the failure is listed under 'Failed or timed out', no partial success section", async () => {
    const { ctx, session, appLog } = createSdkContext();
    withFailedChildren(session, ["reviewer-b"]);
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B, MODEL_C], ...E3_DEBUG });

    await expect(run("parent-session")).resolves.toBe("aggregated response");
    expectFailureEvent(appLog, "councillor request completed", { model: "provider-b/model-b" });
    const prompt = aggregatorPrompt(session);
    expect(prompt).toContain("Failed or timed out:\n- provider-b/model-b: assistant error: failed");
    expect(prompt).toContain("Responded:\n- provider-a/model-a\n- provider-c/model-c\n");
    expect(prompt).not.toMatch(/## Reviewer \d+: provider-b\/model-b/);
    expectNoHostile(prompt, JSON.stringify(appLog.mock.calls));
  });

  it("one healthy + one failed-partial reviewer: fewer-than-two fallback, no aggregator", async () => {
    const { ctx, session, appLog } = createSdkContext();
    withFailedChildren(session, ["reviewer-b"]);
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B], ...E3_DEBUG });

    const result = (await run("parent-session")) as string;
    expect(result).toMatch(/^Error: council_review received fewer than 2 successful councillor responses \(1\/2; required: 1\/2\)/);
    expect(result).toContain("- provider-b/model-b: assistant error: failed");
    expect(createdTitles(session)).not.toContain(AGGREGATOR_TITLE);
    expectFailureEvent(appLog, "councillor request completed", { model: "provider-b/model-b" });
    expectNoHostile(result, JSON.stringify(appLog.mock.calls));
  });

  it("quorum 2 of 3: a healthy + a failed-partial completion (stops awaited) never reach quorum; releasing the held third aggregates only the healthy two", async () => {
    const { ctx, session, appLog } = createSdkContext();
    withFailedChildren(session, ["reviewer-b"]);
    // Held third reviewer.
    let releaseC!: () => void;
    const heldC = new Promise<SdkResult>((resolve) => {
      releaseC = () => resolve({});
    });
    session.prompt.mockImplementation(async (input) => (input.path.id === "reviewer-c" ? heldC : {}));
    // Controllable stops for A and B: `called` fires when the stop is requested; it resolves only on release().
    const stops = new Map(["reviewer-a", "reviewer-b"].map((id) => [id, deferredStop()] as const));
    session.abort.mockImplementation((input) => stops.get(input.path.id)?.request() ?? Promise.resolve({}));
    // Progress hook: the councillor's own "request completed" debug event (logged after its stop was awaited).
    const completed = new Map<string, () => void>();
    const completedEvent = (model: string) => new Promise<void>((resolve) => completed.set(model, resolve));
    const aDone = completedEvent("provider-a/model-a");
    const bDone = completedEvent("provider-b/model-b");
    appLog.mockImplementation(async (input) => {
      const body = (input as { body: LogBody }).body;
      if (body.message === "councillor request completed") completed.get(String(body.extra?.model))?.();
      return {};
    });
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B, MODEL_C], quorum: 2, ...E3_DEBUG });

    const result = run("parent-session");
    await Promise.all([stops.get("reviewer-a")!.called, stops.get("reviewer-b")!.called]);
    // Stops pending: neither attempt has completed yet.
    expect(logBodies(appLog).filter((body) => body.message === "councillor request completed")).toEqual([]);
    stops.get("reviewer-a")!.release();
    stops.get("reviewer-b")!.release();
    await Promise.all([aDone, bDone]);
    // Barrier: drain the microtasks that hand both attempts to the orchestrator (no timer sleep).
    await new Promise((resolve) => setImmediate(resolve));
    expectFailureEvent(appLog, "councillor request completed", { model: "provider-b/model-b" });
    expect(createdTitles(session)).not.toContain(AGGREGATOR_TITLE);
    expect(session.abort.mock.calls.map(([input]) => input.path.id).sort()).toEqual(["reviewer-a", "reviewer-b"]);

    releaseC();
    await expect(result).resolves.toBe("aggregated response");
    const prompt = aggregatorPrompt(session);
    expect(prompt).toContain("Responded:\n- provider-a/model-a\n- provider-c/model-c\n");
    expect(prompt).toContain("- provider-b/model-b: assistant error: failed");
    expect(prompt).not.toContain("Aborted (quorum reached)");
    expectNoHostile(prompt, JSON.stringify(appLog.mock.calls));
  });

  it("an errored aggregator with nonempty partial text: the tool resolves the fixed failure, never the partial synthesis", async () => {
    const { ctx, session, appLog } = createSdkContext();
    withFailedChildren(session, ["aggregator-session"]);
    const run = await councilReviewTool(ctx, { models: [MODEL_A, MODEL_B], ...E3_DEBUG });

    const result = (await run("parent-session")) as string;
    expect(result).toBe("Error: council_review failed: assistant error: failed");
    expectFailureEvent(appLog, "aggregator synthesis ended", {});
    expectNoHostile(result, JSON.stringify(appLog.mock.calls));
  });
});
