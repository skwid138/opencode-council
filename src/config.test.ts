import { describe, expect, it, vi } from "vitest";

import {
  AGGREGATOR_TIMEOUT_MS,
  councilOptions,
  DEFAULT_HARD_CAP_MS,
  hasUserSpecifiedAgent,
  optionalAgentName,
  parseCouncilConfig,
  readReviewerTemperature,
  readTimeoutMs,
  REVIEWER_TEMPERATURE_IGNORED_WARNING,
} from "./config";

const MODEL_A = { providerID: "provider-a", modelID: "model-a" };
const MODEL_B = { providerID: "provider-b", modelID: "model-b" };

function validCouncil(overrides: Record<string, unknown> = {}) {
  return {
    reviewer: "test-reviewer",
    aggregator: "test-aggregator",
    models: [MODEL_A, MODEL_B],
    ...overrides,
  };
}

describe("config helpers", () => {
  it("reads nested council options or returns raw object options", () => {
    expect(councilOptions({ council: { models: [] }, debug: true })).toEqual({
      models: [],
    });
    expect(councilOptions({ models: [] })).toEqual({ models: [] });
    expect(councilOptions(null)).toEqual({});
  });

  it("reads optional agent names and detects user-specified agents", () => {
    expect(optionalAgentName(" custom ", "fallback")).toBe("custom");
    expect(optionalAgentName(" ", "fallback")).toBe("fallback");
    expect(hasUserSpecifiedAgent({ reviewer: " custom " }, "reviewer")).toBe(true);
    expect(hasUserSpecifiedAgent({ reviewer: " " }, "reviewer")).toBe(false);
  });

  it("reads finite timeout values without upper clamping", () => {
    expect(readTimeoutMs({ aggregator_ms: 999_999_999 }, "aggregator_ms", 1)).toBe(
      999_999_999,
    );
    expect(readTimeoutMs({ aggregator_ms: 0 }, "aggregator_ms", 1_000)).toBe(1);
    expect(readTimeoutMs({ aggregator_ms: "500" }, "aggregator_ms", 1_000)).toBe(
      1_000,
    );
  });

  it("validates reviewer_temperature", () => {
    expect(readReviewerTemperature({})).toBeNull();
    expect(readReviewerTemperature({ reviewer_temperature: null })).toBeNull();
    expect(readReviewerTemperature({ reviewer_temperature: 1.5 })).toBe(1.5);
    expect(() => readReviewerTemperature({ reviewer_temperature: 3 })).toThrow(
      "council.reviewer_temperature must be a finite number between 0 and 2",
    );
  });
});

describe("parseCouncilConfig", () => {
  it("defaults reviewer and aggregator to bundled agent names", () => {
    const config = parseCouncilConfig({ council: { models: [MODEL_A, MODEL_B] } });

    expect(config.reviewer).toBe("council-plugin-reviewer");
    expect(config.aggregator).toBe("council-plugin-aggregator");
  });

  it("reads configured agents, debug, models, aggregator model, and temperature", () => {
    const aggregatorModel = { providerID: "provider-c", modelID: "model-c" };

    const config = parseCouncilConfig({
      council: validCouncil({
        debug: true,
        aggregator_model: aggregatorModel,
        reviewer_temperature: 0.7,
      }),
    });

    expect(config).toEqual(
      expect.objectContaining({
        reviewer: "test-reviewer",
        aggregator: "test-aggregator",
        debug: true,
        models: [MODEL_A, MODEL_B],
        aggregator_model: aggregatorModel,
        reviewer_temperature: 0.7,
      }),
    );
  });

  it("throws when models are missing or fewer than two are valid", () => {
    expect(() => parseCouncilConfig({ council: {} })).toThrow("council.models is required");
    expect(() =>
      parseCouncilConfig({
        council: validCouncil({ models: [MODEL_A, { providerID: "", modelID: "bad" }] }),
      }),
    ).toThrow("council.models must include at least 2 valid model entries");
  });

  it("computes default hard caps from default and configured phase timeouts", () => {
    expect(
      parseCouncilConfig({ council: { models: [MODEL_A, MODEL_B] } }).timeouts,
    ).toEqual({
      councillor_ms: 180_000,
      councillor_retry_ms: 90_000,
      aggregator_ms: AGGREGATOR_TIMEOUT_MS,
      hard_cap_ms: DEFAULT_HARD_CAP_MS,
    });

    expect(
      parseCouncilConfig({
        council: validCouncil({
          timeouts: {
            councillor_ms: 2_000,
            councillor_retry_ms: 3_000,
            aggregator_ms: 4_000,
          },
        }),
      }).timeouts.hard_cap_ms,
    ).toBe(39_000);
  });

  it("honors explicit hard caps and warns when below the computed budget", () => {
    const warn = vi.fn();

    const config = parseCouncilConfig(
      { council: validCouncil({ timeouts: { hard_cap_ms: 2_000 } }) },
      warn,
    );

    expect(config.timeouts.hard_cap_ms).toBe(2_000);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Configured hard_cap_ms is below computed phase timeout budget"),
      expect.objectContaining({ configured_hard_cap_ms: 2_000, computed_hard_cap_ms: 420_000 }),
    );
  });

  it("parses permission overrides through the supplied warning logger", () => {
    const warn = vi.fn();

    const config = parseCouncilConfig(
      {
        council: validCouncil({
          reviewer_permission: { bash: "deny", question: "ask" },
          aggregator_permission: { external_directory: { "/tmp/*": "allow" } },
        }),
      },
      warn,
    );

    expect(config.reviewer_permission).toEqual({ bash: "deny" });
    expect(config.aggregator_permission).toEqual({
      external_directory: { "/tmp/*": "allow" },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Stripping ask permission override for question"),
    );
  });

  it("exports the custom reviewer temperature warning text", () => {
    expect(REVIEWER_TEMPERATURE_IGNORED_WARNING).toContain(
      "reviewer_temperature is configured but will be ignored",
    );
  });
});
