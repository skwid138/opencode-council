import { describe, expect, it, vi } from "vitest";

import {
  createChildSession,
  extractLatestAssistantText,
  promptAndExtract,
} from "./session";
import type { ReviewState } from "./types";
import { createV1Host } from "./v1";

function createSessionMocks() {
  return {
    get: vi.fn(async () => ({ data: { directory: "/parent-directory" } })),
    create: vi.fn(),
    prompt: vi.fn(),
    messages: vi.fn(),
    abort: vi.fn(async () => ({})),
  };
}

function createContext(session = createSessionMocks(), directory = "/fallback-directory") {
  return {
    client: { session },
    directory,
  };
}

function assistantMessages(text: string, created = 1) {
  return [
    {
      info: { role: "assistant", time: { created } },
      parts: [{ type: "text", text }],
    },
  ];
}

class StructuredError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

describe("extractLatestAssistantText", () => {
  it("extracts the newest assistant text parts", () => {
    expect(
      extractLatestAssistantText([
        { info: { role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: "old" }] },
        { info: { role: "user", time: { created: 3 } }, parts: [{ type: "text", text: "user" }] },
        {
          info: { role: "assistant", time: { created: 2 } },
          parts: [
            { type: "text", text: "new" },
            { type: "tool", text: "ignored" },
            { type: "text", text: "response" },
          ],
        },
      ]),
    ).toBe("new\nresponse");
  });

  it("returns null for empty or non-text assistant responses", () => {
    expect(extractLatestAssistantText([])).toBeNull();
    expect(extractLatestAssistantText([{ info: { role: "assistant" }, parts: [] }])).toBeNull();
  });
});

// E3: a V1 assistant message the host marked as errored is a failure, even with partial text.
const PARTIAL = "PARTIAL-SECRET-TEXT";
const HOSTILE_ERROR = {
  name: "HOSTILE-NAME",
  data: {
    message: "HOSTILE-MESSAGE",
    responseHeaders: { authorization: "Bearer HOSTILE-HEADER" },
    responseBody: "HOSTILE-BODY",
    metadata: { url: "HOSTILE-METADATA" },
  },
};
const HOSTILE_STRINGS = [PARTIAL, "HOSTILE-NAME", "HOSTILE-MESSAGE", "HOSTILE-HEADER", "HOSTILE-BODY", "HOSTILE-METADATA"];

function assistant(created: number, text: string | null, error?: unknown) {
  return {
    info: { role: "assistant", time: { created }, ...(error === undefined ? {} : { error }) },
    parts: text === null ? [] : [{ type: "text", text }],
  };
}

/** The thrown error is exactly the fixed literal: no host error fields, no partial text, nothing attached. */
function expectFixedAssistantError(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("assistant error: failed");
  expect((error as Error).cause).toBeUndefined();
  expect(Object.keys(error as object)).toEqual([]);
  const rendered = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
  for (const hostile of HOSTILE_STRINGS) expect(rendered).not.toContain(hostile);
}

describe("E3: V1 failed-assistant classification", () => {
  it("(a) messages only: the newest assistant has partial text and a named info.error -> assistant error: failed (clean prompt)", async () => {
    const session = createSessionMocks();
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: [assistant(1, PARTIAL, HOSTILE_ERROR)] });

    const error = await promptAndExtract(createV1Host(createContext(session) as never), { sessionID: "child", agent: "reviewer", prompt: "review this" }).catch((caught: unknown) => caught);
    expectFixedAssistantError(error);
  });

  it("(b) prompt only: a successful prompt response whose assistant info.error is set fails even when messages are clean", async () => {
    const session = createSessionMocks();
    session.prompt.mockResolvedValueOnce({ data: { info: { role: "assistant", time: { created: 2 }, error: HOSTILE_ERROR }, parts: [{ type: "text", text: PARTIAL }] } });
    session.messages.mockResolvedValueOnce({ data: assistantMessages("clean response") });

    const error = await promptAndExtract(createV1Host(createContext(session) as never), { sessionID: "child", agent: "reviewer", prompt: "review this" }).catch((caught: unknown) => caught);
    expectFixedAssistantError(error);
    // Short-circuit: the failed prompt response is decisive; messages are never read.
    expect(session.messages).not.toHaveBeenCalled();
  });

  it("prompt responses without data, with a null error, or from a non-assistant info stay compatible", async () => {
    for (const promptResult of [{}, { data: { info: { role: "assistant", error: null }, parts: [] } }, { data: { info: { role: "assistant" }, parts: [] } }, { data: { info: { role: "user", error: HOSTILE_ERROR } } }]) {
      const session = createSessionMocks();
      session.prompt.mockResolvedValueOnce(promptResult);
      session.messages.mockResolvedValueOnce({ data: assistantMessages("clean response") });
      await expect(promptAndExtract(createV1Host(createContext(session) as never), { sessionID: "child", agent: "reviewer", prompt: "p" })).resolves.toBe("clean response");
    }
  });

  it("null / absent errors succeed; an error object without data.message is still caught", () => {
    expect(extractLatestAssistantText([assistant(1, "ok", null)])).toBe("ok");
    expect(extractLatestAssistantText([assistant(1, "ok")])).toBe("ok");
    let error: unknown;
    try {
      extractLatestAssistantText([assistant(1, PARTIAL, { name: "APIError" })]);
    } catch (caught) {
      error = caught;
    }
    expectFixedAssistantError(error);
  });

  it("unsorted arrays, distinct timestamps: the newest assistant decides (no backtracking)", () => {
    // older clean / newer failed -> rejects (never falls back to the older clean reply)
    expect(() => extractLatestAssistantText([assistant(9, PARTIAL, HOSTILE_ERROR), assistant(1, "older clean")])).toThrow(/^assistant error: failed$/);
    expect(() => extractLatestAssistantText([assistant(1, "older clean"), assistant(9, PARTIAL, HOSTILE_ERROR)])).toThrow(/^assistant error: failed$/);
    // older failed / newer clean -> succeeds
    expect(extractLatestAssistantText([assistant(9, "newer clean"), assistant(1, PARTIAL, HOSTILE_ERROR)])).toBe("newer clean");
    // newer empty / older good -> still empty (unchanged)
    expect(extractLatestAssistantText([assistant(1, "older good"), assistant(9, null)])).toBeNull();
  });
});

describe("createChildSession", () => {
  it("creates a child session with title, directory, and optional permissions", async () => {
    const session = createSessionMocks();
    session.create.mockResolvedValueOnce({ data: { id: "child" } });
    const reviewState: ReviewState = {
      activeSessions: new Set(),
      hardCapTimedOut: false,
      quorumReached: false,
    };

    await expect(
      createChildSession(
        createV1Host(createContext(session) as never),
        "parent",
        "title",
        "/dir",
        [{ permission: "bash", pattern: "*", action: "allow" }],
        reviewState,
      ),
    ).resolves.toBe("child");

    expect(session.create).toHaveBeenCalledWith({
      body: {
        parentID: "parent",
        title: "title",
        permission: [{ permission: "bash", pattern: "*", action: "allow" }],
      },
      query: { directory: "/dir" },
    });
    expect(reviewState.activeSessions.has("child")).toBe(true);
  });

  it("throws before create when the hard cap already triggered", async () => {
    const session = createSessionMocks();

    await expect(
      createChildSession(
        createV1Host(createContext(session) as never),
        "parent",
        "title",
        "/dir",
        undefined,
        { activeSessions: new Set(), hardCapTimedOut: true, quorumReached: false },
      ),
    ).rejects.toThrow("council_review hard cap already triggered");
    expect(session.create).not.toHaveBeenCalled();
  });

  it("aborts and removes a child when hard cap triggers after create", async () => {
    const session = createSessionMocks();
    const reviewState: ReviewState = {
      activeSessions: new Set(),
      hardCapTimedOut: false,
      quorumReached: false,
    };
    session.create.mockImplementation(async () => {
      reviewState.hardCapTimedOut = true;
      return { data: { id: "late-child" } };
    });

    await expect(
      createChildSession(
        createV1Host(createContext(session) as never),
        "parent",
        "title",
        "/dir",
        undefined,
        reviewState,
      ),
    ).rejects.toThrow("council_review hard cap already triggered");

    expect(reviewState.activeSessions.has("late-child")).toBe(false);
    expect(session.abort).toHaveBeenCalledWith({ path: { id: "late-child" } });
  });

  it("throws on create errors or missing session ids", async () => {
    const errorSession = createSessionMocks();
    errorSession.create.mockResolvedValueOnce({ error: "create failed" });
    await expect(
      createChildSession(createV1Host(createContext(errorSession) as never), "parent", "title", "/dir"),
    ).rejects.toThrow("failed to create child session: create failed");

    const missingSession = createSessionMocks();
    missingSession.create.mockResolvedValueOnce({ data: {} });
    await expect(
      createChildSession(createV1Host(createContext(missingSession) as never), "parent", "title", "/dir"),
    ).rejects.toThrow("failed to create child session: missing session id");
  });

  it("renders structured create errors with enumerable metadata", async () => {
    const session = createSessionMocks();
    session.create.mockResolvedValueOnce({ error: new StructuredError("create boom", "E_CREATE") });

    await expect(
      createChildSession(createV1Host(createContext(session) as never), "parent", "title", "/dir"),
    ).rejects.toThrow('failed to create child session: create boom {"code":"E_CREATE"} (json)');
  });

  it("renders plain object create errors as JSON", async () => {
    const session = createSessionMocks();
    session.create.mockResolvedValueOnce({ error: { code: "E_CREATE" } });

    await expect(
      createChildSession(createV1Host(createContext(session) as never), "parent", "title", "/dir"),
    ).rejects.toThrow('failed to create child session: {"code":"E_CREATE"}');
  });

  it("swallows abort failures during post-create hard-cap cleanup", async () => {
    const session = createSessionMocks();
    const reviewState: ReviewState = {
      activeSessions: new Set(),
      hardCapTimedOut: false,
      quorumReached: false,
    };
    session.create.mockImplementation(async () => {
      reviewState.hardCapTimedOut = true;
      return { data: { id: "late-child" } };
    });
    session.abort.mockRejectedValueOnce(new Error("abort failed"));

    await expect(
      createChildSession(
        createV1Host(createContext(session) as never),
        "parent",
        "title",
        "/dir",
        undefined,
        reviewState,
      ),
    ).rejects.toThrow("council_review hard cap already triggered");
  });

  it("aborts and removes a reviewer child when quorum is reached after create", async () => {
    const session = createSessionMocks();
    const reviewState: ReviewState = {
      activeSessions: new Set(),
      hardCapTimedOut: false,
      quorumReached: true,
    };
    session.create.mockResolvedValueOnce({ data: { id: "late-reviewer" } });

    await expect(
      createChildSession(
        createV1Host(createContext(session) as never),
        "parent",
        "title",
        "/dir",
        undefined,
        reviewState,
        true,
      ),
    ).rejects.toThrow("Council quorum reached; aborting late reviewer session.");

    expect(reviewState.activeSessions.has("late-reviewer")).toBe(false);
    expect(session.abort).toHaveBeenCalledWith({ path: { id: "late-reviewer" } });
  });
});

describe("promptAndExtract", () => {
  it("prompts a session and extracts the assistant response", async () => {
    const session = createSessionMocks();
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("response") });

    await expect(
      promptAndExtract(createV1Host(createContext(session) as never), {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
        model: { providerID: "provider", modelID: "model" },
        tools: { bash: false },
      }),
    ).resolves.toBe("response");

    expect(session.prompt).toHaveBeenCalledWith({
      path: { id: "child" },
      body: {
        agent: "agent",
        parts: [{ type: "text", text: "review this" }],
        model: { providerID: "provider", modelID: "model" },
        tools: { bash: false },
      },
    });
  });

  it("strips optional and arbitrary fields from councillor model payloads", async () => {
    const session = createSessionMocks();
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("response") });

    await promptAndExtract(createV1Host(createContext(session) as never), {
      sessionID: "child",
      agent: "reviewer",
      prompt: "review this",
      model: { providerID: "provider", modelID: "model", optional: true, extra: "removed" } as never,
    });

    expect(session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ model: { providerID: "provider", modelID: "model" } }),
      }),
    );
  });

  it("strips optional and arbitrary fields from aggregator model payloads", async () => {
    const session = createSessionMocks();
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("response") });

    await promptAndExtract(createV1Host(createContext(session) as never), {
      sessionID: "child",
      agent: "aggregator",
      prompt: "aggregate this",
      model: { providerID: "provider", modelID: "model", optional: true, extra: "removed" } as never,
    });

    expect(session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ model: { providerID: "provider", modelID: "model" } }),
      }),
    );
  });

  it("omits model from the prompt body when no model is provided", async () => {
    const session = createSessionMocks();
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ data: assistantMessages("response") });

    await promptAndExtract(createV1Host(createContext(session) as never), {
      sessionID: "child",
      agent: "aggregator",
      prompt: "aggregate this",
    });

    expect((session.prompt.mock.calls[0][0] as { body: Record<string, unknown> }).body).not.toHaveProperty(
      "model",
    );
  });

  it("throws on prompt, messages, and empty-response failures", async () => {
    const promptFailure = createSessionMocks();
    promptFailure.prompt.mockResolvedValueOnce({ error: "bad prompt" });
    await expect(
      promptAndExtract(createV1Host(createContext(promptFailure) as never), {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
      }),
    ).rejects.toThrow("prompt failed: bad prompt");

    const messagesFailure = createSessionMocks();
    messagesFailure.prompt.mockResolvedValueOnce({});
    messagesFailure.messages.mockResolvedValueOnce({ error: "bad messages" });
    await expect(
      promptAndExtract(createV1Host(createContext(messagesFailure) as never), {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
      }),
    ).rejects.toThrow("failed to get messages: bad messages");

    const emptyFailure = createSessionMocks();
    emptyFailure.prompt.mockResolvedValueOnce({});
    emptyFailure.messages.mockResolvedValueOnce({ data: [] });
    await expect(
      promptAndExtract(createV1Host(createContext(emptyFailure) as never), {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
      }),
    ).rejects.toThrow("empty response");
  });

  it("renders structured prompt errors with enumerable metadata", async () => {
    const session = createSessionMocks();
    session.prompt.mockResolvedValueOnce({ error: new StructuredError("prompt boom", "E_PROMPT") });

    await expect(
      promptAndExtract(createV1Host(createContext(session) as never), {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
      }),
    ).rejects.toThrow('prompt failed: prompt boom {"code":"E_PROMPT"} (json)');
  });

  it("renders plain object prompt errors as JSON", async () => {
    const session = createSessionMocks();
    session.prompt.mockResolvedValueOnce({ error: { code: "E_PROMPT" } });

    await expect(
      promptAndExtract(createV1Host(createContext(session) as never), {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
      }),
    ).rejects.toThrow('prompt failed: {"code":"E_PROMPT"}');
  });

  it("renders structured message errors with enumerable metadata", async () => {
    const session = createSessionMocks();
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ error: new StructuredError("messages boom", "E_MESSAGES") });

    await expect(
      promptAndExtract(createV1Host(createContext(session) as never), {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
      }),
    ).rejects.toThrow('failed to get messages: messages boom {"code":"E_MESSAGES"} (json)');
  });

  it("renders plain object message errors as JSON", async () => {
    const session = createSessionMocks();
    session.prompt.mockResolvedValueOnce({});
    session.messages.mockResolvedValueOnce({ error: { code: "E_MESSAGES" } });

    await expect(
      promptAndExtract(createV1Host(createContext(session) as never), {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
      }),
    ).rejects.toThrow('failed to get messages: {"code":"E_MESSAGES"}');
  });
});
