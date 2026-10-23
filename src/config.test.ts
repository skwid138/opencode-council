import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGGREGATOR_TIMEOUT_MS,
  composeCouncilConfig,
  councilOptions,
  DEFAULT_HARD_CAP_MS,
  hasUserSpecifiedAgent,
  normalizeModelConfig,
  optionalAgentName,
  OPTIONAL_COUNCILLOR_TIMEOUT_MS,
  parseCouncilConfig,
  readReviewerTemperature,
  readTimeoutMs,
  REVIEWER_TEMPERATURE_IGNORED_WARNING,
  resolveDebug,
} from "./config";
import { isModelConfig } from "./types";

const MODEL_A = { providerID: "provider-a", modelID: "model-a" };
const MODEL_B = { providerID: "provider-b", modelID: "model-b" };
const NON_DEFAULT_PHASE_TIMEOUTS = {
  councillor_ms: 2_000,
  aggregator_ms: 4_000,
  quorum_grace_ms: 5_000,
};
const NON_DEFAULT_COMPUTED_HARD_CAP_MS = 41_000;

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

  it.each([
    ["missing", { providerID: "provider", modelID: "model" }, { providerID: "provider", modelID: "model" }, false],
    ["undefined", { providerID: "provider", modelID: "model", optional: undefined }, { providerID: "provider", modelID: "model" }, false],
    ["true", { providerID: "provider", modelID: "model", optional: true }, { providerID: "provider", modelID: "model", optional: true }, false],
    ["false", { providerID: "provider", modelID: "model", optional: false }, { providerID: "provider", modelID: "model", optional: false }, false],
    ["string", { providerID: "provider", modelID: "model", optional: "yes" }, { providerID: "provider", modelID: "model", optional: false }, true],
    ["number", { providerID: "provider", modelID: "model", optional: 1 }, { providerID: "provider", modelID: "model", optional: false }, true],
    ["null", { providerID: "provider", modelID: "model", optional: null }, { providerID: "provider", modelID: "model", optional: false }, true],
  ])("normalizes model optional flag for %s", (_label, raw, expected, shouldWarn) => {
    const warn = vi.fn();

    expect(normalizeModelConfig({ ...raw, stray: "removed" } as never, warn)).toEqual(expected);
    if (shouldWarn) {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("council.models optional flag must be boolean"),
        expect.objectContaining({ providerID: "provider", modelID: "model" }),
      );
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("keeps isModelConfig narrow and side-effect free", () => {
    const raw = { providerID: "provider", modelID: "model", optional: "yes" };

    expect(isModelConfig(raw)).toBe(true);
    expect(raw).toEqual({ providerID: "provider", modelID: "model", optional: "yes" });
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

  it("throws when models are missing or fewer than two are required", () => {
    expect(() => parseCouncilConfig({ council: {} })).toThrow("council.models is required");
    expect(() =>
      parseCouncilConfig({
        council: validCouncil({ models: [MODEL_A, { providerID: "", modelID: "bad" }] }),
      }),
    ).toThrow("council.models must include at least 2 required (non-optional) model entries");
  });

  it("throws when fewer than two model entries are required", () => {
    expect(() =>
      parseCouncilConfig({
        council: validCouncil({
          models: [MODEL_A, ...models(3).map((model) => ({ ...model, optional: true }))],
        }),
      }),
    ).toThrow("council.models must include at least 2 required (non-optional) model entries");
    expect(() =>
      parseCouncilConfig({
        council: validCouncil({ models: models(5).map((model) => ({ ...model, optional: true })) }),
      }),
    ).toThrow("council.models must include at least 2 required (non-optional) model entries");
  });

  it("computes default hard caps from default and configured phase timeouts", () => {
    expect(
      parseCouncilConfig({ council: { models: [MODEL_A, MODEL_B] } }).timeouts,
    ).toEqual({
      councillor_ms: 270_000,
      optional_councillor_ms: OPTIONAL_COUNCILLOR_TIMEOUT_MS,
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

  it("defaults quorum to the required model count on mixed councils", () => {
    const config = parseCouncilConfig({
      council: validCouncil({
        models: [MODEL_A, MODEL_B, { providerID: "provider-c", modelID: "model-c", optional: true }],
      }),
    });

    expect(config.quorum).toBe(2);
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
    "warns and falls back to the required model count for invalid quorum %s",
    (quorum) => {
      const warn = vi.fn();

      const config = parseCouncilConfig(
        { council: validCouncil({ models: models(3), quorum }) },
        warn,
      );

      expect(config.quorum).toBe(3);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Must be integer in [2, 3]. Falling back to 3."),
      );
    },
  );

  it("warns and falls back when quorum exceeds required model count", () => {
    const warn = vi.fn();

    const config = parseCouncilConfig(
      {
        council: validCouncil({
          models: [MODEL_A, MODEL_B, { providerID: "provider-c", modelID: "model-c", optional: true }],
          quorum: 3,
        }),
      },
      warn,
    );

    expect(config.quorum).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Must be integer in [2, 2]. Falling back to 2."),
    );
  });

  it("migrates all-model quorum to required-count quorum when optionals are introduced", () => {
    const warn = vi.fn();

    const config = parseCouncilConfig(
      {
        council: validCouncil({
          models: [
            MODEL_A,
            MODEL_B,
            { providerID: "provider-c", modelID: "model-c", optional: true },
            { providerID: "provider-d", modelID: "model-d", optional: true },
            { providerID: "provider-e", modelID: "model-e", optional: true },
          ],
          quorum: 5,
        }),
      },
      warn,
    );

    expect(config.quorum).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Must be integer in [2, 2]. Falling back to 2."),
    );
  });

  it.each([
    ["wrapped", (overrides: Record<string, unknown>) => ({ council: validCouncil(overrides) })],
    ["direct", (overrides: Record<string, unknown>) => validCouncil(overrides)],
  ])("normalizes aggregator_model optional warnings for %s options", (_shape, buildOptions) => {
    const cases = [
      ["aggregator_model absent", {}, null, 0],
      [
        "optional absent",
        { aggregator_model: { providerID: "provider-c", modelID: "model-c" } },
        { providerID: "provider-c", modelID: "model-c" },
        0,
      ],
      [
        "optional present undefined",
        { aggregator_model: { providerID: "provider-c", modelID: "model-c", optional: undefined } },
        { providerID: "provider-c", modelID: "model-c" },
        0,
      ],
      [
        "optional false",
        { aggregator_model: { providerID: "provider-c", modelID: "model-c", optional: false } },
        { providerID: "provider-c", modelID: "model-c" },
        0,
      ],
      [
        "optional true",
        { aggregator_model: { providerID: "provider-c", modelID: "model-c", optional: true } },
        { providerID: "provider-c", modelID: "model-c" },
        1,
      ],
      [
        "optional non-boolean",
        { aggregator_model: { providerID: "provider-c", modelID: "model-c", optional: "yes" } },
        { providerID: "provider-c", modelID: "model-c" },
        1,
      ],
      ["invalid aggregator_model", { aggregator_model: { providerID: "", modelID: "bad" } }, null, 0],
    ] as const;

    for (const [label, overrides, expectedAggregatorModel, expectedWarnCount] of cases) {
      const warn = vi.fn();

      const config = parseCouncilConfig(buildOptions(overrides), warn);

      expect(config.aggregator_model, label).toEqual(expectedAggregatorModel);
      expect(warn, label).toHaveBeenCalledTimes(expectedWarnCount);
      expect(
        warn.mock.calls.some(([message]) =>
          String(message).includes("council.models optional flag must be boolean"),
        ),
        label,
      ).toBe(false);
      if (expectedWarnCount === 1) {
        expect(warn, label).toHaveBeenCalledWith(
          "council.aggregator_model cannot be optional; ignoring optional flag",
          expect.objectContaining({ providerID: "provider-c", modelID: "model-c" }),
        );
      }
    }
  });

  it("parses optional_councillor_ms defaults, explicit values, clamps, and invalid values", () => {
    expect(parseCouncilConfig({ council: validCouncil() }).timeouts.optional_councillor_ms).toBe(
      OPTIONAL_COUNCILLOR_TIMEOUT_MS,
    );

    expect(
      parseCouncilConfig({
        council: validCouncil({ timeouts: { optional_councillor_ms: 45_000 } }),
      }).timeouts.optional_councillor_ms,
    ).toBe(45_000);

    const clampWarn = vi.fn();
    expect(
      parseCouncilConfig(
        { council: validCouncil({ timeouts: { councillor_ms: 30_000, optional_councillor_ms: 45_000 } }) },
        clampWarn,
      ).timeouts.optional_councillor_ms,
    ).toBe(30_000);
    expect(clampWarn).toHaveBeenCalledWith(
      expect.stringContaining("optional_councillor_ms cannot exceed councillor_ms; clamping"),
      expect.objectContaining({ optional_councillor_ms: 45_000, councillor_ms: 30_000 }),
    );

    for (const invalid of [-1, "60s", undefined, 0]) {
      const warn = vi.fn();
      const config = parseCouncilConfig(
        { council: validCouncil({ timeouts: { optional_councillor_ms: invalid } }) },
        warn,
      );

      expect(config.timeouts.optional_councillor_ms).toBe(OPTIONAL_COUNCILLOR_TIMEOUT_MS);
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("optional_councillor_ms cannot exceed councillor_ms; clamping"),
        expect.anything(),
      );
    }

    const silentClampWarn = vi.fn();
    expect(
      parseCouncilConfig(
        { council: validCouncil({ timeouts: { councillor_ms: 30_000 } }) },
        silentClampWarn,
      ).timeouts.optional_councillor_ms,
    ).toBe(30_000);
    expect(silentClampWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("optional_councillor_ms cannot exceed councillor_ms; clamping"),
      expect.anything(),
    );

    const boundaryWarn = vi.fn();
    expect(
      parseCouncilConfig(
        { council: validCouncil({ timeouts: { councillor_ms: 30_000, optional_councillor_ms: 30_000 } }) },
        boundaryWarn,
      ).timeouts.optional_councillor_ms,
    ).toBe(30_000);
    expect(boundaryWarn).not.toHaveBeenCalled();
  });

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

  it("uses the computed hard cap when hard_cap_ms is an invalid string", () => {
    const config = parseCouncilConfig({
      council: validCouncil({
        timeouts: {
          ...NON_DEFAULT_PHASE_TIMEOUTS,
          hard_cap_ms: "180000",
        },
      }),
    });

    expect(config.timeouts.hard_cap_ms).toBe(NON_DEFAULT_COMPUTED_HARD_CAP_MS);
  });

  it("uses the computed hard cap when hard_cap_ms is NaN", () => {
    const config = parseCouncilConfig({
      council: validCouncil({
        timeouts: {
          ...NON_DEFAULT_PHASE_TIMEOUTS,
          hard_cap_ms: NaN,
        },
      }),
    });

    expect(config.timeouts.hard_cap_ms).toBe(NON_DEFAULT_COMPUTED_HARD_CAP_MS);
  });

  it("uses the computed hard cap when hard_cap_ms is null", () => {
    const config = parseCouncilConfig({
      council: validCouncil({
        timeouts: {
          ...NON_DEFAULT_PHASE_TIMEOUTS,
          hard_cap_ms: null,
        },
      }),
    });

    expect(config.timeouts.hard_cap_ms).toBe(NON_DEFAULT_COMPUTED_HARD_CAP_MS);
  });

  it("uses the computed hard cap when hard_cap_ms is Infinity", () => {
    const config = parseCouncilConfig({
      council: validCouncil({
        timeouts: {
          ...NON_DEFAULT_PHASE_TIMEOUTS,
          hard_cap_ms: Infinity,
        },
      }),
    });

    expect(config.timeouts.hard_cap_ms).toBe(NON_DEFAULT_COMPUTED_HARD_CAP_MS);
  });

  it("uses the computed hard cap when hard_cap_ms is omitted", () => {
    const config = parseCouncilConfig({
      council: validCouncil({
        timeouts: NON_DEFAULT_PHASE_TIMEOUTS,
      }),
    });

    expect(config.timeouts.hard_cap_ms).toBe(NON_DEFAULT_COMPUTED_HARD_CAP_MS);
  });

  it("preserves a valid explicit hard_cap_ms", () => {
    const config = parseCouncilConfig({
      council: validCouncil({
        timeouts: {
          ...NON_DEFAULT_PHASE_TIMEOUTS,
          hard_cap_ms: 200_000,
        },
      }),
    });

    expect(config.timeouts.hard_cap_ms).toBe(200_000);
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

describe("permission override ask handling", () => {
  it("strips ask overrides by default (V1) and keeps them when requested (V2)", () => {
    const raw = {
      council: {
        models: [MODEL_A, { providerID: "provider-b", modelID: "model-b" }],
        reviewer_permission: { bash: { "git push*": "ask", "*": "allow" }, question: "ask" },
        aggregator_permission: { webfetch: "ask" },
      },
    };
    const warn = vi.fn();

    const v1 = composeCouncilConfig(raw, warn);
    expect(v1.reviewer_permission).toEqual({ bash: { "*": "allow" } });
    expect(v1.aggregator_permission).toEqual({});
    expect(warn).toHaveBeenCalledTimes(3);

    const keepWarn = vi.fn();
    const v2 = composeCouncilConfig(raw, keepWarn, { overrideAsk: "keep" });
    expect(v2.reviewer_permission).toEqual({
      bash: { "git push*": "ask", "*": "allow" },
      question: "ask",
    });
    expect(Object.keys((v2.reviewer_permission as Record<string, Record<string, string>>).bash))
      .toEqual(["git push*", "*"]);
    expect(v2.aggregator_permission).toEqual({ webfetch: "ask" });
    expect(keepWarn).not.toHaveBeenCalled();
  });
});

describe("invalid quorum warning value description", () => {
  it("keeps the raw JSON value in the V1 (default) warning text", () => {
    const warn = vi.fn();

    parseCouncilConfig({ council: validCouncil({ models: models(2), quorum: { value: "raw" } }) }, warn);

    expect(warn).toHaveBeenCalledWith(
      'Invalid council.quorum: {"value":"raw"}. Must be integer in [2, 2]. Falling back to 2.',
    );
  });

  it("describes the value by type only when requested (V2)", () => {
    const warn = vi.fn();

    parseCouncilConfig(
      { council: validCouncil({ models: models(2), quorum: { value: "raw" } }) },
      warn,
      { describeValue: "type" },
    );

    expect(warn).toHaveBeenCalledWith(
      "Invalid council.quorum: <object>. Must be integer in [2, 2]. Falling back to 2.",
    );
  });
});
