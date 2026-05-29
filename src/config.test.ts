import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGGREGATOR_TIMEOUT_MS,
  composeCouncilConfig,
  councilOptions,
  DEFAULT_HARD_CAP_MS,
  hasUserSpecifiedAgent,
  optionalAgentName,
  parseCouncilConfig,
  readReviewerTemperature,
  readTimeoutMs,
  REVIEWER_TEMPERATURE_IGNORED_WARNING,
  resolveDebug,
} from "./config";

const MODEL_A = { providerID: "provider-a", modelID: "model-a" };
const MODEL_B = { providerID: "provider-b", modelID: "model-b" };

function models(count: number) {
  return Array.from({ length: count }, (_value, index) => ({
    providerID: `provider-${index}`,
    modelID: `model-${index}`,
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe("resolveDebug", () => {
  it("enables debug from COUNCIL_DEBUG=1 with empty raw options", () => {
    vi.stubEnv("COUNCIL_DEBUG", "1");

    expect(resolveDebug({})).toBe(true);
  });

  it("enables debug from top-level options when env is unset", () => {
    vi.stubEnv("COUNCIL_DEBUG", undefined);

    expect(resolveDebug({ debug: true, models: [MODEL_A, MODEL_B] })).toBe(true);
  });

  it("enables debug from nested council options when env is unset", () => {
    vi.stubEnv("COUNCIL_DEBUG", undefined);

    expect(resolveDebug({ council: { debug: true, models: [MODEL_A, MODEL_B] } })).toBe(
      true,
    );
  });

  it("preserves top-level debug for mixed top-level plus council-wrapper options", () => {
    vi.stubEnv("COUNCIL_DEBUG", undefined);

    expect(resolveDebug({ debug: true, council: { models: [MODEL_A, MODEL_B] } })).toBe(
      true,
    );
  });

  it("lets env true win over nested debug false", () => {
    vi.stubEnv("COUNCIL_DEBUG", "1");

    expect(resolveDebug({ council: { debug: false, models: [MODEL_A, MODEL_B] } })).toBe(
      true,
    );
  });

  it("lets top-level debug true win over nested debug false", () => {
    vi.stubEnv("COUNCIL_DEBUG", undefined);

    expect(
      resolveDebug({ debug: true, council: { debug: false, models: [MODEL_A, MODEL_B] } }),
    ).toBe(true);
  });

  it("does not let COUNCIL_DEBUG=0 block nested debug true", () => {
    vi.stubEnv("COUNCIL_DEBUG", "0");

    expect(resolveDebug({ council: { debug: true, models: [MODEL_A, MODEL_B] } })).toBe(
      true,
    );
  });

  it("does not let top-level debug false block nested debug true", () => {
    vi.stubEnv("COUNCIL_DEBUG", undefined);

    expect(
      resolveDebug({ debug: false, council: { debug: true, models: [MODEL_A, MODEL_B] } }),
    ).toBe(true);
  });

  it("disables debug when none of the three sources are true", () => {
    vi.stubEnv("COUNCIL_DEBUG", undefined);

    expect(resolveDebug({ council: { models: [MODEL_A, MODEL_B] } })).toBe(false);
  });

  it.each(["0", "true", "", undefined])(
    "treats COUNCIL_DEBUG=%s as false with otherwise empty config",
    (value) => {
      vi.stubEnv("COUNCIL_DEBUG", value);

      expect(resolveDebug({})).toBe(false);
    },
  );

  it.each([null, undefined, [], "string", 42])(
    "returns false for malformed raw options %s without env debug",
    (raw) => {
      vi.stubEnv("COUNCIL_DEBUG", undefined);

      expect(resolveDebug(raw)).toBe(false);
    },
  );

  it.each([null, undefined, [], "string", 42])(
    "returns true for malformed raw options %s when env debug is set",
    (raw) => {
      vi.stubEnv("COUNCIL_DEBUG", "1");

      expect(resolveDebug(raw)).toBe(true);
    },
  );

  it.each([" 1", "1 "])(
    "requires strict env equality and rejects whitespace value %s",
    (value) => {
      vi.stubEnv("COUNCIL_DEBUG", value);

      expect(resolveDebug({})).toBe(false);
    },
  );
});

describe("parseCouncilConfig", () => {
  it("defaults reviewer and aggregator to bundled agent names", () => {
    const config = parseCouncilConfig({ council: { models: [MODEL_A, MODEL_B] } });

    expect(config.reviewer).toBe("council-plugin-reviewer");
    expect(config.aggregator).toBe("council-plugin-aggregator");
  });

  it("reads configured agents, models, aggregator model, and temperature", () => {
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
        models: [MODEL_A, MODEL_B],
        aggregator_model: aggregatorModel,
        reviewer_temperature: 0.7,
      }),
    );
  });

  it("does not include a debug own property", () => {
    const config = parseCouncilConfig({ council: validCouncil({ debug: true }) });

    expect(Object.prototype.hasOwnProperty.call(config, "debug")).toBe(false);
  });

  it("does not let COUNCIL_DEBUG leak into parser output", () => {
    const validConfig = { council: validCouncil() };
    vi.stubEnv("COUNCIL_DEBUG", "1");
    const envSetConfig = parseCouncilConfig(validConfig);
    vi.unstubAllEnvs();
    const envUnsetConfig = parseCouncilConfig(validConfig);

    expect(envSetConfig).toEqual(envUnsetConfig);
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
      councillor_ms: 270_000,
      aggregator_ms: AGGREGATOR_TIMEOUT_MS,
      quorum_grace_ms: 0,
      hard_cap_ms: DEFAULT_HARD_CAP_MS,
    });

    expect(
      parseCouncilConfig({
        council: validCouncil({
          timeouts: {
            councillor_ms: 2_000,
            aggregator_ms: 4_000,
          },
        }),
      }).timeouts.hard_cap_ms,
    ).toBe(36_000);
  });

  it("warns once for deprecated retry timeout in wrapped options", () => {
    const warn = vi.fn();

    parseCouncilConfig(
      { council: validCouncil({ timeouts: { councillor_retry_ms: 3_000 } }) },
      warn,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("councillor_retry_ms is deprecated; fold the value into councillor_ms"),
    );
  });

  it("warns once for deprecated retry timeout in direct options", () => {
    const warn = vi.fn();

    parseCouncilConfig(validCouncil({ timeouts: { councillor_retry_ms: 3_000 } }), warn);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("councillor_retry_ms is deprecated; fold the value into councillor_ms"),
    );
  });

  it("does not warn for retry deprecation when the old timeout key is absent", () => {
    const warn = vi.fn();

    parseCouncilConfig({ council: validCouncil({ timeouts: { councillor_ms: 3_000 } }) }, warn);

    expect(warn).not.toHaveBeenCalled();
  });

  it.each([2, 3, 5, 8])("defaults quorum to the model count for N=%i", (count) => {
    const config = parseCouncilConfig({ council: validCouncil({ models: models(count) }) });

    expect(config.quorum).toBe(count);
  });

  it("accepts explicit quorum values between 2 and the model count", () => {
    expect(
      parseCouncilConfig({ council: validCouncil({ models: models(5), quorum: 2 }) }).quorum,
    ).toBe(2);
    expect(
      parseCouncilConfig({ council: validCouncil({ models: models(5), quorum: 5 }) }).quorum,
    ).toBe(5);
  });

  it.each([1, 4, 2.5, "3", -1])(
    "warns and falls back to the model count for invalid quorum %s",
    (quorum) => {
      const warn = vi.fn();

      const config = parseCouncilConfig(
        { council: validCouncil({ models: models(3), quorum }) },
        warn,
      );

      expect(config.quorum).toBe(3);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Invalid council.quorum"),
      );
    },
  );

  it("defaults quorum_grace_ms to 0", () => {
    expect(parseCouncilConfig({ council: validCouncil() }).timeouts.quorum_grace_ms).toBe(0);
  });

  it("preserves explicit positive quorum_grace_ms values", () => {
    expect(
      parseCouncilConfig({
        council: validCouncil({ timeouts: { quorum_grace_ms: 12_345 } }),
      }).timeouts.quorum_grace_ms,
    ).toBe(12_345);
  });

  it("coerces negative quorum_grace_ms values to 0", () => {
    expect(
      parseCouncilConfig({
        council: validCouncil({ timeouts: { quorum_grace_ms: -50 } }),
      }).timeouts.quorum_grace_ms,
    ).toBe(0);
  });

  it("includes quorum_grace_ms in the computed hard cap", () => {
    expect(
      parseCouncilConfig({
        council: validCouncil({
          timeouts: {
            councillor_ms: 2_000,
            aggregator_ms: 4_000,
            quorum_grace_ms: 5_000,
          },
        }),
      }).timeouts.hard_cap_ms,
    ).toBe(41_000);
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

  it("includes quorum_grace_ms in under-cap warning payloads", () => {
    const warn = vi.fn();

    parseCouncilConfig(
      { council: validCouncil({ timeouts: { quorum_grace_ms: 5_000, hard_cap_ms: 2_000 } }) },
      warn,
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Configured hard_cap_ms is below computed phase timeout budget"),
      expect.objectContaining({ quorum_grace_ms: 5_000, computed_hard_cap_ms: 425_000 }),
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

describe("composeCouncilConfig", () => {
  it.each([
    ["top-level", { debug: true, models: [MODEL_A, MODEL_B] }],
    ["nested", { council: { debug: true, models: [MODEL_A, MODEL_B] } }],
    ["mixed", { debug: true, council: { models: [MODEL_A, MODEL_B] } }],
  ])("matches resolveDebug for %s user-facing options", (_label, options) => {
    vi.stubEnv("COUNCIL_DEBUG", undefined);

    expect(composeCouncilConfig(options).debug).toBe(resolveDebug(options));
  });

  it("propagates warn callbacks through parsing", () => {
    const warn = vi.fn();

    composeCouncilConfig({ council: validCouncil({ timeouts: { hard_cap_ms: 2_000 } }) }, warn);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Configured hard_cap_ms is below computed phase timeout budget"),
      expect.objectContaining({ configured_hard_cap_ms: 2_000, computed_hard_cap_ms: 420_000 }),
    );
  });
});
