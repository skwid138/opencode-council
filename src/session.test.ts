import { describe, expect, it, vi } from "vitest";

import {
  createChildSession,
  extractLatestAssistantText,
  parentDirectory,
  promptAndExtract,
} from "./session";
import type { ReviewState } from "./types";

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

describe("parentDirectory", () => {
  it("uses the parent session directory when available", async () => {
    const session = createSessionMocks();
    session.get.mockResolvedValueOnce({ data: { directory: "/resolved-parent" } });

    await expect(parentDirectory(createContext(session) as never, "parent")).resolves.toBe(
      "/resolved-parent",
    );
  });

  it("falls back to the plugin directory when parent lookup fails", async () => {
    const session = createSessionMocks();
    session.get.mockRejectedValueOnce(new Error("not found"));

    await expect(parentDirectory(createContext(session) as never, "parent")).resolves.toBe(
      "/fallback-directory",
    );
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
        createContext(session) as never,
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
        createContext(session) as never,
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
        createContext(session) as never,
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
      createChildSession(createContext(errorSession) as never, "parent", "title", "/dir"),
    ).rejects.toThrow("failed to create child session: create failed");

    const missingSession = createSessionMocks();
    missingSession.create.mockResolvedValueOnce({ data: {} });
    await expect(
      createChildSession(createContext(missingSession) as never, "parent", "title", "/dir"),
    ).rejects.toThrow("failed to create child session: missing session id");
  });

  it("renders structured create errors with enumerable metadata", async () => {
    const session = createSessionMocks();
    session.create.mockResolvedValueOnce({ error: new StructuredError("create boom", "E_CREATE") });

    await expect(
      createChildSession(createContext(session) as never, "parent", "title", "/dir"),
    ).rejects.toThrow('failed to create child session: create boom {"code":"E_CREATE"} (json)');
  });

  it("renders plain object create errors as JSON", async () => {
    const session = createSessionMocks();
    session.create.mockResolvedValueOnce({ error: { code: "E_CREATE" } });

    await expect(
      createChildSession(createContext(session) as never, "parent", "title", "/dir"),
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
        createContext(session) as never,
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
        createContext(session) as never,
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
      promptAndExtract(createContext(session) as never, {
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

  it("throws on prompt, messages, and empty-response failures", async () => {
    const promptFailure = createSessionMocks();
    promptFailure.prompt.mockResolvedValueOnce({ error: "bad prompt" });
    await expect(
      promptAndExtract(createContext(promptFailure) as never, {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
      }),
    ).rejects.toThrow("prompt failed: bad prompt");

    const messagesFailure = createSessionMocks();
    messagesFailure.prompt.mockResolvedValueOnce({});
    messagesFailure.messages.mockResolvedValueOnce({ error: "bad messages" });
    await expect(
      promptAndExtract(createContext(messagesFailure) as never, {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
      }),
    ).rejects.toThrow("failed to get messages: bad messages");

    const emptyFailure = createSessionMocks();
    emptyFailure.prompt.mockResolvedValueOnce({});
    emptyFailure.messages.mockResolvedValueOnce({ data: [] });
    await expect(
      promptAndExtract(createContext(emptyFailure) as never, {
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
      promptAndExtract(createContext(session) as never, {
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
      promptAndExtract(createContext(session) as never, {
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
      promptAndExtract(createContext(session) as never, {
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
      promptAndExtract(createContext(session) as never, {
        sessionID: "child",
        agent: "agent",
        prompt: "review this",
      }),
    ).rejects.toThrow('failed to get messages: {"code":"E_MESSAGES"}');
  });
});
