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

  it("extracts messages from Error values and stringifies non-Errors", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("failed")).toBe("failed");
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
