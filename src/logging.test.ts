import { describe, expect, it, vi } from "vitest";

import { createLogger, errorMessage, modelLabel } from "./logging";

function createContext(appLog = vi.fn(async () => ({}))) {
  return {
    client: { app: { log: appLog } },
  };
}

describe("logging helpers", () => {
  it("formats model labels as provider/model", () => {
    expect(modelLabel({ providerID: "provider", modelID: "model" })).toBe(
      "provider/model",
    );
  });

  it("renders strings and primitive errors", () => {
    expect(errorMessage("failed")).toBe("failed");
    expect(errorMessage("")).toBe("[empty string error]");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(false)).toBe("false");
    expect(errorMessage(10n)).toBe("10");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(Symbol("bad"))).toBe("Symbol(bad)");
  });

  it("renders Error messages and enumerable Error metadata", () => {
    class CodedError extends Error {
      code = "E_BOOM";
    }

    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new CodedError("boom"))).toBe(
      'boom {"code":"E_BOOM"} (json)',
    );
  });

  it("falls back for hostile Error message and name getters", () => {
    const messageThrows = new Error("boom");
    Object.defineProperty(messageThrows, "message", {
      get() {
        throw new Error("message getter failed");
      },
    });

    const nameThrows = new Error("");
    Object.defineProperty(nameThrows, "name", {
      get() {
        throw new Error("name getter failed");
      },
    });

    expect(errorMessage(messageThrows)).toBe("Error");
    expect(errorMessage(nameThrows)).toBe("Error");
  });

  it("renders object errors as JSON or unserializable sentinels", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(errorMessage({ code: "E_OBJECT" })).toBe('{"code":"E_OBJECT"}');
    expect(errorMessage({})).toBe("{}");
    expect(errorMessage(Object.create(null))).toBe("{}");
    expect(errorMessage(circular)).toBe("[unserializable error: Object]");
    expect(errorMessage({ value: 1n })).toBe("[unserializable error: Object]");
  });

  it("uses an unknown sentinel when constructor name lookup is hostile", () => {
    const hostile = {
      toJSON() {
        throw new Error("cannot serialize");
      },
    };
    Object.defineProperty(hostile, "constructor", {
      get() {
        throw new Error("constructor getter failed");
      },
    });

    expect(errorMessage(hostile)).toBe("[unserializable error: unknown]");
  });

  it("does not return bare object stringification for covered branches", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const values = [
      "failed",
      "",
      new Error("boom"),
      42,
      true,
      10n,
      null,
      undefined,
      Symbol("bad"),
      { code: "E_OBJECT" },
      circular,
      { value: 1n },
      Object.create(null),
    ].map(errorMessage);

    expect(values.every((value) => !value.includes("[object Object]"))).toBe(true);
  });

  it("emits structured non-debug logs through opencode app logging", () => {
    const appLog = vi.fn(async () => ({}));
    const log = createLogger(createContext(appLog) as never, false);

    log("warn", "careful", { detail: true });

    expect(appLog).toHaveBeenCalledWith({
      body: {
        service: "council-plugin",
        level: "warn",
        message: "careful",
        extra: { detail: true },
      },
    });
  });

  it("gates debug logs with the supplied boolean", () => {
    const disabledAppLog = vi.fn(async () => ({}));
    createLogger(createContext(disabledAppLog) as never, false)("debug", "hidden");
    expect(disabledAppLog).not.toHaveBeenCalled();

    const enabledAppLog = vi.fn(async () => ({}));
    createLogger(createContext(enabledAppLog) as never, true)("debug", "visible");
    expect(enabledAppLog).toHaveBeenCalledWith({
      body: { service: "council-plugin", level: "debug", message: "visible" },
    });
  });
});
