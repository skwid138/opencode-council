import { describe, expect, it } from "vitest";

import {
  BUNDLED_AGGREGATOR_AGENT,
  BUNDLED_REVIEWER_AGENT,
  isModelConfig,
  isPermissionAction,
  isPlainObject,
} from "./types";

describe("types helpers", () => {
  it("exports the bundled agent names used by the plugin", () => {
    expect(BUNDLED_REVIEWER_AGENT).toBe("council-plugin-reviewer");
    expect(BUNDLED_AGGREGATOR_AGENT).toBe("council-plugin-aggregator");
  });

  it("recognizes valid model config objects", () => {
    expect(isModelConfig({ providerID: "provider", modelID: "model" })).toBe(true);
    expect(isModelConfig({ providerID: "", modelID: "model" })).toBe(false);
    expect(isModelConfig({ providerID: "provider", modelID: "" })).toBe(false);
    expect(isModelConfig(null)).toBe(false);
  });

  it("recognizes plain objects but not arrays or null", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });

  it("recognizes allow and deny permission actions only", () => {
    expect(isPermissionAction("allow")).toBe(true);
    expect(isPermissionAction("deny")).toBe(true);
    expect(isPermissionAction("ask")).toBe(false);
  });
});
