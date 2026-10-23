import { describe, expect, it } from "vitest";

import { hostAdapter } from "./hosts.mjs";

const v1 = hostAdapter("v1");
const v2 = hostAdapter("v2");
const COUNCIL = { models: [{ providerID: "fake", modelID: "reviewer-a" }, { providerID: "fake", modelID: "reviewer-b" }], aggregator_model: { providerID: "fake", modelID: "aggregator" } };

describe("launch", () => {
  it("serves on loopback with an explicit port and exact executable path", () => {
    for (const host of [v1, v2]) {
      expect(host.launchArgv("/opt/council-rh/bin/opencode-x", 4100)).toEqual(["/opt/council-rh/bin/opencode-x", "serve", "--hostname", "127.0.0.1", "--port", "4100"]);
      expect(() => host.launchArgv("opencode", 4100)).toThrow(/absolute/);
    }
  });

  it("passes only allowlisted host switches", () => {
    expect(Object.keys(v1.hostEnvExtra({ configPath: "/f/c.json", password: "rh-x" })).sort()).toEqual(["OPENCODE_CONFIG", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_SERVER_PASSWORD"]);
    expect(Object.keys(v2.hostEnvExtra({ configPath: "/f/c.json", password: "rh-x" })).sort()).toEqual(["OPENCODE_CONFIG", "OPENCODE_SERVER_PASSWORD"]);
  });
});

describe("routes (source-verified, research §5)", () => {
  it("V1", () => {
    const r = v1.routes;
    expect(r.identity("/p")).toEqual({ method: "GET", path: "/session", query: { directory: "/p" } });
    expect(r.createSession("/p")).toEqual({ method: "POST", path: "/session", query: { directory: "/p" }, body: {} });
    expect(r.prompt({ sessionID: "s1", text: "hi", directory: "/p" })).toEqual({ method: "POST", path: "/session/s1/prompt_async", query: { directory: "/p" }, body: { parts: [{ type: "text", text: "hi" }] } });
    expect(r.children({ sessionID: "s1", directory: "/p" })).toEqual({ method: "GET", path: "/session/s1/children", query: { directory: "/p" } });
    expect(r.messages({ sessionID: "s1", directory: "/p" })).toEqual({ method: "GET", path: "/session/s1/message", query: { directory: "/p" } });
    expect(r.events("/p")).toEqual({ path: "/event", query: { directory: "/p" } });
    expect(r.cancel({ sessionID: "s1", directory: "/p" })).toEqual({ method: "POST", path: "/session/s1/abort", query: { directory: "/p" } });
    expect(r.dispose("/p")).toEqual({ method: "POST", path: "/instance/dispose", query: { directory: "/p" } });
  });

  it("V2 (wait is the experimental route; interrupt never resumes)", () => {
    const r = v2.routes;
    expect(r.identity("/p")).toEqual({ method: "GET", path: "/api/session" });
    expect(r.createSession("/p")).toEqual({ method: "POST", path: "/api/session", body: { location: { directory: "/p" } } });
    expect(r.prompt({ sessionID: "s1", text: "hi" })).toEqual({ method: "POST", path: "/api/session/s1/prompt", body: { text: "hi" } });
    expect(r.wait({ sessionID: "s1" })).toEqual({ method: "POST", path: "/api/experimental/session/s1/wait" });
    expect(r.cancel({ sessionID: "s1" })).toEqual({ method: "POST", path: "/api/session/s1/interrupt", query: { resume: "false" } });
    expect(r.children({ sessionID: "s1" })).toEqual({ method: "GET", path: "/api/session", query: { parentID: "s1" } });
    expect(r.session({ sessionID: "s1" })).toEqual({ method: "GET", path: "/api/session/s1" });
    expect(r.plugins("/p")).toEqual({ method: "GET", path: "/api/plugin", query: { location: { directory: "/p" } } });
    expect(r.reload()).toEqual({ method: "POST", path: "/api/location/reload" });
    expect(r.events()).toEqual({ path: "/api/event" });
  });

  it("encodes session ids in paths", () => {
    expect(v1.routes.messages({ sessionID: "a/b", directory: "/p" }).path).toBe("/session/a%2Fb/message");
    expect(v2.routes.wait({ sessionID: "a/b" }).path).toBe("/api/experimental/session/a%2Fb/wait");
  });

  it("lists every not-yet-source-verified shape so the spike must confirm it", () => {
    // The auxiliary (title / compaction) signatures are source-verified (research §12): not candidates.
    // Source-verified after Gate C p1a03 (research §12): v1.agentsRoute, v1.messageAgentModelFields, v2.toolOutputSource.
    expect(v1.candidates).toEqual([]);
    expect(v2.candidates).toEqual(["v2.providerConfig", "v2.modelRef", "v2.agentsRoute", "v2.sessionCreatedShape"]);
  });
});

describe("config (exact plugin spec, fake provider, council options)", () => {
  const input = { providerBaseURL: "http://127.0.0.1:4200/v1", models: ["parent", "reviewer-a", "reviewer-b", "aggregator"], parentModel: "parent", spec: "@skwid138/opencode-council@0.3.0", council: COUNCIL };

  it("V1: plugin tuple, @ai-sdk/openai-compatible provider with tool_call models", () => {
    expect(v1.buildConfig(input)).toEqual({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      share: "disabled",
      model: "fake/parent",
      provider: {
        fake: {
          npm: "@ai-sdk/openai-compatible",
          name: "real-host fake provider",
          options: { baseURL: "http://127.0.0.1:4200/v1", apiKey: "fixture-placeholder-not-a-credential" },
          models: Object.fromEntries(input.models.map((id) => [id, { name: id, tool_call: true }])),
        },
      },
      plugin: [["@skwid138/opencode-council@0.3.0", { council: COUNCIL }]],
      // Suppression (source-verified switches): no title generation, no auto-compaction.
      agent: { title: { disable: true } },
      compaction: { auto: false },
    });
  });

  it("V2: plugins entry with exact package spec and options passed through", () => {
    const config = v2.buildConfig(input);
    expect(config.plugins).toEqual([{ package: "@skwid138/opencode-council@0.3.0", options: { council: COUNCIL } }]);
    expect(config.providers.fake).toEqual({
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:4200/v1", apiKey: "fixture-placeholder-not-a-credential" },
      models: Object.fromEntries(input.models.map((id) => [id, { capabilities: { tools: true } }])),
    });
    expect(config.model).toBe("fake/parent");
    // Suppression (source-verified switches): no title agent, no auto-compaction, no warming.
    expect(config.agents).toEqual({ title: { disabled: true } });
    expect(config.compaction).toEqual({ auto: false });
    expect(config.warming).toBe(false);
    // small_model is NOT a disable switch and is not used for suppression.
    expect(config).not.toHaveProperty("small_model");
  });

  it("refuses non-loopback providers and inexact plugin specs", () => {
    for (const host of [v1, v2]) {
      expect(() => host.buildConfig({ ...input, providerBaseURL: "http://example.com:80/v1" })).toThrow(/loopback/);
      expect(() => host.buildConfig({ ...input, spec: "@skwid138/opencode-council" })).toThrow(/exact/);
      expect(() => host.buildConfig({ ...input, spec: "@skwid138/opencode-council@^0.3.0" })).toThrow(/exact/);
    }
  });
});

describe("event normalization", () => {
  it("V1", () => {
    expect(v1.normalizeEvent({ type: "session.created", properties: { info: { id: "c1", parentID: "p1" } } })).toEqual({ kind: "session-created", sessionID: "c1", parentID: "p1" });
    expect(v1.normalizeEvent({ type: "session.idle", properties: { sessionID: "p1" } })).toEqual({ kind: "session-idle", sessionID: "p1" });
    expect(
      v1.normalizeEvent({ type: "message.part.updated", properties: { part: { type: "tool", tool: "council_review", callID: "t1", sessionID: "p1", state: { status: "completed", output: "OUT" } } } }),
    ).toEqual({ kind: "tool-terminal", sessionID: "p1", callID: "t1", tool: "council_review", status: "completed", output: "OUT", error: null, interrupted: false });
    expect(v1.normalizeEvent({ type: "server.connected", properties: {} })).toEqual({ kind: "connected" });
    expect(v1.normalizeEvent({ type: "x" })).toEqual({ kind: "other", type: "x" });
    expect(v1.normalizeEvent(null)).toEqual({ kind: "other", type: null });
  });

  it("V2", () => {
    // The raw key shape is kept (bounded) as the v2.sessionCreatedShape observation.
    expect(v2.normalizeEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })).toEqual({ kind: "session-created", sessionID: "c1", parentID: "p1", shape: { keys: ["parentID", "sessionID"], infoKeys: [] } });
    expect(v2.normalizeEvent({ type: "session.created", data: { info: { parentID: "p1", id: "c2", title: "t" } } })).toEqual({ kind: "session-created", sessionID: "c2", parentID: "p1", shape: { keys: ["info"], infoKeys: ["id", "parentID", "title"] } });
    expect(v2.normalizeEvent({ type: "session.execution.succeeded", data: { sessionID: "c1" } })).toEqual({ kind: "session-final", sessionID: "c1", outcome: "succeeded" });
    expect(v2.normalizeEvent({ type: "session.inbox.enqueued", data: { sessionID: "c1" } })).toEqual({ kind: "admitted", sessionID: "c1" });
    // Source-verified V2 tool events: the name is only on input.started; success carries content[], failed carries error{}.
    expect(v2.normalizeEvent({ id: "evt1", type: "session.tool.input.started", data: { sessionID: "p1", assistantMessageID: "m1", id: "t1", name: "council_review" } })).toEqual({ kind: "tool-input-started", sessionID: "p1", callID: "t1", tool: "council_review" });
    expect(
      v2.normalizeEvent({ id: "evt2", type: "session.tool.success", data: { sessionID: "p1", assistantMessageID: "m1", id: "t1", content: [{ type: "text", text: "## A\n" }, { type: "file", uri: "file:///x", mime: "text/plain" }, { type: "text", text: "OUT" }], executed: true } }),
    ).toEqual({ kind: "tool-terminal", sessionID: "p1", callID: "t1", tool: null, status: "completed", output: "## A\nOUT", error: null, interrupted: false });
    expect(v2.normalizeEvent({ id: "evt3", type: "session.tool.failed", data: { sessionID: "p1", assistantMessageID: "m1", id: "t1", error: { type: "unknown", message: "boom" }, executed: true } })).toEqual({
      kind: "tool-terminal", sessionID: "p1", callID: "t1", tool: null, status: "error", output: null, error: "boom", interrupted: false,
    });
  });

  it("extracts session ids and V2 session metadata", () => {
    expect(v1.sessionIDFrom({ status: 200, json: { id: "s1" } })).toBe("s1");
    expect(v2.sessionIDFrom({ status: 200, json: { data: { id: "s1" } } })).toBe("s1");
    expect(v2.sessionIDFrom({ status: 500, json: { data: { id: "s1" } } })).toBeNull();
    expect(v1.childrenFrom({ status: 200, json: [{ id: "c1", parentID: "p" }] })).toEqual([{ id: "c1", parentID: "p" }]);
    expect(v2.childrenFrom({ status: 200, json: { data: [{ id: "c1", parentID: "p" }] } })).toEqual([{ id: "c1", parentID: "p" }]);
    expect(v2.childrenFrom({ status: 200, json: { data: "nope" } })).toBeNull();
  });
});

describe("startup readiness: the family-specific listening line (post Gate C p1a02)", () => {
  it("V2: only the exact source-verified line `server listening on http://127.0.0.1:<port>` (whole line)", () => {
    expect(v2.isListening("boot\nserver listening on http://127.0.0.1:4096\n", 4096)).toBe(true);
    expect(v2.isListening("server listening on http://127.0.0.1:4096\r\n", 4096)).toBe(true);
    expect(v2.isListening("server listening on http://127.0.0.1:40960\n", 4096)).toBe(false);
    expect(v2.isListening("server listening on http://127.0.0.1:4096 (pending)\n", 4096)).toBe(false);
    expect(v2.isListening("connecting to 127.0.0.1:4096\n", 4096)).toBe(false);
    expect(v2.isListening("", 4096)).toBe(false);
  });

  it("V1: not source-verified -> the existing `127.0.0.1:<port>` rule, but with a digit boundary", () => {
    expect(v1.isListening("opencode server listening on http://127.0.0.1:4096\n", 4096)).toBe(true);
    expect(v1.isListening("127.0.0.1:4096\n", 4096)).toBe(true);
    // An unterminated fragment never counts (it may still grow into :40960).
    expect(v1.isListening("127.0.0.1:4096", 4096)).toBe(false);
    expect(v1.isListening("http://127.0.0.1:40960\n", 4096)).toBe(false);
    expect(v1.isListening("", 4096)).toBe(false);
  });
});

describe("readiness counts only newline-terminated lines (audit)", () => {
  const line = "server listening on http://127.0.0.1:4096";
  it.each([["v2", v2], ["v1", v1]] as const)("%s: successive snapshots of a growing log are ready only once the newline arrives", (_family, host) => {
    const snapshots = ["boot\n", "boot\nserver listening on http://127.0.0.1:409", `boot\n${line}`, `boot\n${line}\r`, `boot\n${line}\n`];
    expect(snapshots.map((text) => host.isListening(text, 4096))).toEqual([false, false, false, false, true]);
    expect(host.isListening(`boot\n${line}\r\n`, 4096)).toBe(true);
  });

  it.each([["v2", v2], ["v1", v1]] as const)("%s: `...:4096` completed later by `0\\n` is never ready for 4096", (_family, host) => {
    const first = `boot\n${line}`;
    const later = `${first}0\n`;
    expect(host.isListening(first, 4096)).toBe(false);
    expect(host.isListening(later, 4096)).toBe(false);
    expect(host.isListening(later, 40960)).toBe(true);
  });
});

describe("durable parent tool results (source-verified shapes, post Gate C p1a03)", () => {
  describe("V2: GET /api/session/:id/message?type=assistant (paginated)", () => {
    it("first page: type=assistant, order=desc, limit=200; follow pages: type=assistant + cursor, never order", () => {
      expect(v2.routes.messages({ sessionID: "s/1" })).toEqual({ method: "GET", path: "/api/session/s%2F1/message", query: { type: "assistant", order: "desc", limit: 200 } });
      expect(v2.routes.messages({ sessionID: "s1", cursor: "c2" })).toEqual({ method: "GET", path: "/api/session/s1/message", query: { type: "assistant", cursor: "c2", limit: 200 } });
    });

    it("messagePageFrom: { data, cursor.next } or null for anything else", () => {
      expect(v2.messagePageFrom({ status: 200, json: { data: [{ id: "m" }], cursor: { next: "c2" } } })).toEqual({ messages: [{ id: "m" }], next: "c2" });
      expect(v2.messagePageFrom({ status: 200, json: { data: [], cursor: {} } })).toEqual({ messages: [], next: null });
      for (const response of [{ status: 500, json: {} }, { status: 200, json: { data: {} } }, { status: 200, json: null }]) expect(v2.messagePageFrom(response)).toBeNull();
    });

    it("toolCallsFromMessages: council_review tool content across assistant messages; text = concatenated text entries", () => {
      const messages = [
        { id: "m2", type: "assistant", content: [{ type: "text", text: "done" }] },
        {
          id: "m1",
          type: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool", id: "t1", name: "council_review", time: { created: 1 }, state: { status: "completed", input: {}, content: [{ type: "text", text: "## Agg\n" }, { type: "file", uri: "file:///x", mime: "text/plain" }, { type: "reasoning", text: "IGNORED" }, { type: "text", text: "AGGREGATE-x" }] } },
            { type: "tool", id: "t2", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "nope" }] } },
          ],
        },
        { id: "m0", type: "user", content: [{ type: "tool", id: "t9", name: "council_review", state: { status: "completed", content: [] } }] },
      ];
      expect(v2.toolCallsFromMessages(messages, "council_review")).toEqual([{ callID: "t1", status: "completed", text: "## Agg\nAGGREGATE-x", error: null, truncated: false }]);
      const failed = [{ id: "m", type: "assistant", content: [{ type: "tool", id: "t1", name: "council_review", state: { status: "error", input: {}, error: { type: "x", message: "aggregator failed" } } }] }];
      expect(v2.toolCallsFromMessages(failed, "council_review")).toEqual([{ callID: "t1", status: "error", text: "", error: "aggregator failed", truncated: false }]);
      expect(v2.toolCallsFromMessages([{ type: "assistant", content: [{ type: "tool", id: "t1", name: "council_review", state: { status: "running" } }] }], "council_review")).toEqual([{ callID: "t1", status: "running", text: "", error: null, truncated: false }]);
      expect(v2.toolCallsFromMessages(null as never, "council_review")).toEqual([]);
    });
  });

  describe.each(["1.18.29", "1.19.3"])("V1 %s: GET /session/:id/message -> [{ info, parts }]", () => {
    const toolPart = (state: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: "prt1", sessionID: "P", messageID: "msg1", type: "tool", tool: "council_review", callID: "call1", state, ...extra });

    it("toolCallsFromMessages: completed -> state.output; error -> state.error; truncation from state.metadata", () => {
      const messages = [
        { info: { id: "msg0", role: "user", sessionID: "P" }, parts: [{ type: "text", text: "go" }] },
        { info: { id: "msg1", role: "assistant", sessionID: "P", agent: "build", mode: "build", modelID: "parent", providerID: "fake" }, parts: [toolPart({ status: "completed", input: {}, output: "## Agg\nAGGREGATE-x", title: "t", metadata: {}, time: { start: 1, end: 2 } }), { type: "tool", tool: "read", callID: "c2", state: { status: "completed", output: "no" } }] },
      ];
      expect(v1.toolCallsFromMessages(messages, "council_review")).toEqual([{ callID: "call1", status: "completed", text: "## Agg\nAGGREGATE-x", error: null, truncated: false }]);
      const truncated = [{ info: { role: "assistant" }, parts: [toolPart({ status: "completed", output: "## Agg (cut)", metadata: { truncated: true, outputPath: "/scratch/x/out.txt" }, time: { start: 1, end: 2 } })] }];
      expect(v1.toolCallsFromMessages(truncated, "council_review")).toEqual([{ callID: "call1", status: "completed", text: "## Agg (cut)", error: null, truncated: true }]);
      const viaPath = [{ info: { role: "assistant" }, parts: [toolPart({ status: "completed", output: "x", metadata: { outputPath: "/scratch/x/out.txt" } })] }];
      expect(v1.toolCallsFromMessages(viaPath, "council_review")[0].truncated).toBe(true);
      const viaFlag = [{ info: { role: "assistant" }, parts: [toolPart({ status: "completed", output: "x", metadata: { truncated: true } })] }];
      expect(v1.toolCallsFromMessages(viaFlag, "council_review")[0].truncated).toBe(true);
      const notTruncated = [{ info: { role: "assistant" }, parts: [toolPart({ status: "completed", output: "x", metadata: { truncated: false } })] }];
      expect(v1.toolCallsFromMessages(notTruncated, "council_review")[0].truncated).toBe(false);
      const failed = [{ info: { role: "assistant" }, parts: [toolPart({ status: "error", input: {}, error: "Tool execution aborted", time: { start: 1, end: 2 } })] }];
      expect(v1.toolCallsFromMessages(failed, "council_review")).toEqual([{ callID: "call1", status: "error", text: "", error: "Tool execution aborted", truncated: false }]);
      expect(v1.toolCallsFromMessages([{ info: { role: "user" }, parts: [toolPart({ status: "completed", output: "x" })] }], "council_review")).toEqual([]);
    });

    it("SSE session.created (properties.info.id / .parentID), session.idle and session.status idle (properties.sessionID)", () => {
      expect(v1.normalizeEvent({ type: "session.created", properties: { info: { id: "C", parentID: "P", title: "t" } } })).toEqual({ kind: "session-created", sessionID: "C", parentID: "P" });
      expect(v1.normalizeEvent({ type: "session.idle", properties: { sessionID: "P" } })).toEqual({ kind: "session-idle", sessionID: "P" });
      expect(v1.normalizeEvent({ type: "session.status", properties: { sessionID: "P", status: { type: "idle" } } })).toEqual({ kind: "session-idle", sessionID: "P" });
      expect(v1.normalizeEvent({ type: "session.status", properties: { sessionID: "P", status: { type: "busy" } } })).toEqual({ kind: "other", type: "session.status" });
      expect(v1.normalizeEvent({ type: "session.status", properties: { sessionID: "P" } })).toEqual({ kind: "other", type: "session.status" });
    });

    it("a tool part without its own sessionID falls back to the sibling properties.sessionID", () => {
      const { sessionID: _omit, ...part } = toolPart({ status: "running", input: {}, time: { start: 1 } });
      expect(v1.normalizeEvent({ type: "message.part.updated", properties: { sessionID: "P", time: 1, part } })).toEqual({ kind: "tool-running", sessionID: "P", callID: "call1", tool: "council_review", status: "running" });
    });

    it("SSE message.part.updated carries the part at properties.part (sibling sessionID/time)", () => {
      expect(v1.normalizeEvent({ type: "message.part.updated", properties: { sessionID: "P", time: 1, part: toolPart({ status: "completed", input: {}, output: "OUT", title: "t", metadata: {}, time: { start: 1, end: 2 } }) } })).toEqual({
        kind: "tool-terminal", sessionID: "P", callID: "call1", tool: "council_review", status: "completed", output: "OUT", error: null, interrupted: false,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// P1b adapter surface.

describe("P1b: permission reply routes, events, and session-create permissions", () => {
  it("V1 reply: POST /permission/:id/reply?directory {reply} (research §5)", () => {
    expect(v1.routes.reply({ requestID: "per/1", decision: "once", directory: "/p" })).toEqual({ method: "POST", path: "/permission/per%2F1/reply", query: { directory: "/p" }, body: { reply: "once" } });
  });

  it("V2 reply: POST /api/session/:id/permission/:rid/reply {decision} (research §5); create may carry session permissions (UNVERIFIED body field)", () => {
    expect(v2.routes.reply({ sessionID: "s/1", requestID: "r1", decision: "reject" })).toEqual({ method: "POST", path: "/api/session/s%2F1/permission/r1/reply", body: { decision: "reject" } });
    const rules = [{ action: "shell", resource: "echo PAR-n*", effect: "deny" }];
    expect(v2.routes.createSession("/p", { permissions: rules })).toEqual({ method: "POST", path: "/api/session", body: { location: { directory: "/p" }, permissions: rules } });
    expect(v2.routes.createSession("/p")).toEqual({ method: "POST", path: "/api/session", body: { location: { directory: "/p" } } });
  });

  it("V1 permission.asked / replied, session.error (error name only)", () => {
    expect(v1.normalizeEvent({ type: "permission.asked", properties: { id: "per1", sessionID: "S", permission: "bash", patterns: ["echo ASK-n 42"], tool: { messageID: "m", callID: "c1" } } })).toEqual({ kind: "permission-asked", requestID: "per1", sessionID: "S", permission: "bash", patterns: ["echo ASK-n 42"], callID: "c1" });
    expect(v1.normalizeEvent({ type: "permission.replied", properties: { sessionID: "S", requestID: "per1", reply: "once" } })).toEqual({ kind: "permission-replied", requestID: "per1", sessionID: "S", reply: "once" });
    expect(v1.normalizeEvent({ type: "session.error", properties: { sessionID: "S", error: { name: "MessageAbortedError", data: { message: "secret" } } } })).toEqual({ kind: "session-error", sessionID: "S", errorName: "MessageAbortedError" });
    expect(v1.normalizeEvent({ type: "session.error", properties: { error: "x" } })).toEqual({ kind: "session-error", sessionID: null, errorName: null });
  });

  it("V2 permission.asked / replied, plugin.updated, execution.interrupted reason", () => {
    expect(v2.normalizeEvent({ type: "permission.asked", data: { id: "r1", sessionID: "S", action: "shell", resources: ["echo U-n 42"], source: { type: "tool", id: "c1" } } })).toEqual({ kind: "permission-asked", requestID: "r1", sessionID: "S", permission: "shell", patterns: ["echo U-n 42"], callID: "c1" });
    expect(v2.normalizeEvent({ type: "permission.replied", data: { requestID: "r1", sessionID: "S", reply: "once" } })).toEqual({ kind: "permission-replied", requestID: "r1", sessionID: "S", reply: "once" });
    expect(v2.normalizeEvent({ type: "plugin.updated", data: { secret: 1 } })).toEqual({ kind: "plugin-updated" });
    expect(v2.normalizeEvent({ type: "session.execution.interrupted", data: { sessionID: "S", reason: "user" } })).toEqual({ kind: "session-final", sessionID: "S", outcome: "interrupted", reason: "user" });
  });
});

describe("P1b: durable tool entries (every tool call, raw text kept in memory for classification only)", () => {
  it("V1: tool parts incl. the `invalid` repair target, interrupted flag, and the message's time.completed", () => {
    const messages = [
      { info: { id: "m0", role: "user" }, parts: [] },
      {
        info: { id: "m1", role: "assistant", time: { created: 1, completed: 9 } },
        parts: [
          { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "x" }, output: "OUT", metadata: {} } },
          { type: "tool", tool: "invalid", callID: "c2", state: { status: "completed", input: { tool: "council_review", error: "e" }, output: "bad" } },
          { type: "tool", tool: "council_review", callID: "c3", state: { status: "error", input: {}, error: "Tool execution aborted", metadata: { interrupted: true } } },
          { type: "text", text: "t" },
        ],
      },
    ];
    expect(v1.toolEntriesFromMessages(messages)).toEqual([
      { messageID: "m1", messageCompleted: 9, callID: "c1", name: "bash", status: "completed", output: "OUT", error: null, errorType: null, interrupted: false, truncated: false, invalidTarget: null },
      { messageID: "m1", messageCompleted: 9, callID: "c2", name: "invalid", status: "completed", output: "bad", error: null, errorType: null, interrupted: false, truncated: false, invalidTarget: "council_review" },
      { messageID: "m1", messageCompleted: 9, callID: "c3", name: "council_review", status: "error", output: null, error: "Tool execution aborted", errorType: null, interrupted: true, truncated: false, invalidTarget: null },
    ]);
    expect(v1.toolEntriesFromMessages(null as never)).toEqual([]);
  });

  it("V2: tool content entries (text from content[], error.message + error.type)", () => {
    const messages = [
      { id: "m1", type: "assistant", time: { created: 1, completed: 5 }, content: [
        { type: "tool", id: "c1", name: "shell", state: { status: "completed", input: {}, content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] } },
        { type: "tool", id: "c2", name: "shell", state: { status: "error", input: {}, error: { type: "permission.rejected", message: "Permission denied: shell" } } },
      ] },
      { id: "m0", type: "user", content: [{ type: "tool", id: "x", name: "shell", state: { status: "completed" } }] },
    ];
    expect(v2.toolEntriesFromMessages(messages)).toEqual([
      { messageID: "m1", messageCompleted: 5, callID: "c1", name: "shell", status: "completed", output: "AB", error: null, errorType: null, interrupted: false, truncated: false, invalidTarget: null },
      { messageID: "m1", messageCompleted: 5, callID: "c2", name: "shell", status: "error", output: null, error: "Permission denied: shell", errorType: "permission.rejected", interrupted: false, truncated: false, invalidTarget: null },
    ]);
  });
});

describe("P1b: config rendering (abstract permission rules) and fixture tool calls", () => {
  const base = { providerBaseURL: "http://127.0.0.1:4000/v1", models: ["parent", "r"], parentModel: "parent", spec: "@skwid138/opencode-council@0.3.0", council: { models: [] } };
  const rules = [
    { action: "shell", resource: "echo ASK-n*", effect: "ask" },
    { action: "shell", resource: "echo DENY-n*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: "ask" },
  ];

  it("V1: workspace `permission` map (shell -> bash; `*`-only -> flat value), insertion order kept", () => {
    const config = v1.buildConfig({ ...base, permissionRules: rules });
    expect(config.permission).toEqual({ bash: { "echo ASK-n*": "ask", "echo DENY-n*": "deny" }, webfetch: "ask" });
    expect(Object.keys(config.permission.bash)).toEqual(["echo ASK-n*", "echo DENY-n*"]);
    expect(v1.buildConfig(base).permission).toBeUndefined();
  });

  it("V2: `permissions` rule list (normalizer-observed config key at 2.0.28; UNVERIFIED here)", () => {
    expect(v2.buildConfig({ ...base, permissionRules: rules }).permissions).toEqual(rules);
    expect(v2.buildConfig(base).permissions).toBeUndefined();
  });

  it("fixture tool calls per family (V1 bash/read/webfetch; V2 shell/read)", () => {
    // Radagast M1: V1 bash input is { command } only.
    expect(v1.toolCall("shell", "echo X")).toEqual({ name: "bash", args: { command: "echo X" } });
    expect(v2.toolCall("shell", "echo X")).toEqual({ name: "shell", args: { command: "echo X" } });
    expect(v1.toolCall("read", "/p/f.txt")).toEqual({ name: "read", args: { filePath: "/p/f.txt" } });
    // Radagast M2: V2 read input is { path } only.
    expect(v2.toolCall("read", "/p/f.txt")).toEqual({ name: "read", args: { path: "/p/f.txt" } });
    expect(v1.toolCall("webfetch", "http://127.0.0.1:9/x")).toEqual({ name: "webfetch", args: { url: "http://127.0.0.1:9/x", format: "text" } });
    expect(() => v2.toolCall("webfetch", "x")).toThrow(/no V2 fixture tool/);
  });

  it("custom agent file: .opencode/agent/<name>.md, subagent, frontmatter permission map (read deny on an absolute path), prompt body", () => {
    for (const host of [v1, v2]) {
      const file = host.agentFile({ name: "rh-rev", description: "d", prompt: "MARKER-M review", permission: { read: { "*": "allow", "/scratch/p/custom-deny-n.txt": "deny" } } });
      expect(file.path).toBe(".opencode/agent/rh-rev.md");
      expect(file.content).toBe('---\ndescription: "d"\nmode: subagent\npermission:\n  read:\n    "*": allow\n    "/scratch/p/custom-deny-n.txt": deny\n---\nMARKER-M review\n');
    }
    expect(() => v1.agentFile({ name: "../x", description: "d", prompt: "p", permission: {} })).toThrow(/agent name/);
  });
});

describe("P1b: scenario-scoped UNVERIFIED candidates", () => {
  it("S1/S2 keep the base list; new scenarios add exactly the shapes they rely on (post-audit: source-verified shapes removed)", () => {
    expect(v2.candidatesFor("s2")).toEqual(["v2.providerConfig", "v2.modelRef", "v2.agentsRoute", "v2.sessionCreatedShape"]);
    expect(v1.candidatesFor("s1")).toEqual([]);
    expect(v1.candidatesFor("s8")).toEqual(["v1.permissionConfig", "v1.pluginLogFlush"]);
    expect(v2.candidatesFor("s8")).toEqual([...v2.candidates, "v2.permissionConfig", "v2.shellToolInput", "v2.sessionCreatePermissions"]);
    expect(v2.candidatesFor("s13")).toEqual([...v2.candidates]);
    expect(v1.candidatesFor("s9")).toEqual([]);
    expect(v2.candidatesFor("s9")).toEqual([...v2.candidates]);
    expect(v1.candidatesFor("s4")).toEqual(["v1.providerRetryPolicy", "v1.streamDestroyError"]);
    expect(v2.candidatesFor("s4")).toEqual([...v2.candidates, "v2.providerRetryPolicy", "v2.streamDestroyError"]);
    expect(v1.candidatesFor("s11")).toEqual(["v1.agentFileLocation", "v1.agentFrontmatterPermission", "v1.readToolInput"]);
    expect(v2.candidatesFor("s11")).toEqual([...v2.candidates, "v2.agentFileLocation", "v2.agentFrontmatterPermission"]);
    expect(v1.candidatesFor("s13")).toEqual(["v1.abortEvidence"]);
    for (const scenario of ["s3", "s5", "s6", "s7", "s12", "s13"]) expect(v1.candidatesFor(scenario)).toContain("v1.abortEvidence");
    expect(() => v1.candidatesFor("s99")).toThrow(/unknown scenario/);
  });
});

describe("post-P1b audit: source-verified shapes (Radagast, both pins per family) are recorded and never also UNVERIFIED", () => {
  const scenarios = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13", "obs-ask"];
  it.each([["v1", v1], ["v2", v2]] as const)("%s", (_family, host) => {
    const verified = Object.keys(host.verifiedShapes);
    expect(verified.length).toBeGreaterThan(0);
    for (const scenario of scenarios) for (const candidate of host.candidatesFor(scenario)) expect(verified).not.toContain(candidate);
  });

  it("records the verified V1 / V2 contract notes", () => {
    expect(Object.keys(v1.verifiedShapes)).toEqual(expect.arrayContaining(["v1.textDelta", "v1.permissionAskedShape", "v1.invalidToolRepair", "v1.bashToolInput", "v1.readRuleRelativeToWorktree"]));
    expect(Object.keys(v2.verifiedShapes)).toEqual(expect.arrayContaining(["v2.textDelta", "v2.permissionAskedShape", "v2.staticDenyError", "v2.noSuchToolRefusal", "v2.readToolInput", "v2.readRuleRelativeToLocation", "v2.reloadPluginUpdated"]));
    expect(v1.verifiedShapes["v1.textDelta"]).toMatch(/message\.part\.delta \{sessionID,messageID,partID,field,delta\}/);
    expect(v2.verifiedShapes["v2.noSuchToolRefusal"]).toMatch(/No tool named "x" is currently available/);
  });

  it("V1 project route (worktree for host-relative read rules; UNVERIFIED v1.projectCurrentRoute)", () => {
    expect(v1.routes.projectCurrent("/p")).toEqual({ method: "GET", path: "/project/current", query: { directory: "/p" } });
  });
});

describe("P1b re-audit round 2 (Should b): GET /project/current is SOURCE-VERIFIED at both V1 pins", () => {
  it("is a verified shape and no longer an S11 candidate", () => {
    expect(v1.verifiedShapes["v1.projectCurrentRoute"]).toMatch(/GET \/project\/current .*bare project .*worktree/);
    expect(v1.candidatesFor("s11")).toEqual(["v1.agentFileLocation", "v1.agentFrontmatterPermission", "v1.readToolInput"]);
  });
});
