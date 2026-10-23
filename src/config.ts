import { type OverrideAskHandling, readPermissionOverride } from "./permissions.js";
import {
  BUNDLED_AGGREGATOR_AGENT,
  BUNDLED_REVIEWER_AGENT,
  type CouncilConfig,
  isModelConfig,
  isPlainObject,
  type ModelConfig,
  type TimeoutConfig,
  type WarningLogger,
} from "./types.js";

export const COUNCILLOR_TIMEOUT_MS = 270_000;
export const OPTIONAL_COUNCILLOR_TIMEOUT_MS = 60_000;
export const AGGREGATOR_TIMEOUT_MS = 120_000;
export const DEFAULT_HARD_CAP_MS = COUNCILLOR_TIMEOUT_MS + AGGREGATOR_TIMEOUT_MS + 30_000;
export const REVIEWER_TEMPERATURE_IGNORED_WARNING =
  "reviewer_temperature is configured but will be ignored because a custom reviewer agent is specified — temperature only applies to the bundled reviewer";

export function councilOptions(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) return {};
  return isPlainObject(raw.council) ? raw.council : raw;
}

/**
 * Env-aware debug resolver. NOT pure (reads `process.env.COUNCIL_DEBUG`).
 *
 * Precedence is first true wins:
 * 1. `process.env.COUNCIL_DEBUG === "1"` (strict equality; no trim and no other truthy values)
 * 2. Top-level `debug === true` on the raw plugin options
 * 3. Nested `council.debug === true` after `councilOptions(rawPluginOptions)` resolution
 *
 * The top-level check is load-bearing for the `{ debug: true, council: { models: [...] } }`
 * shape because `councilOptions` descends into `.council` and drops top-level `debug`.
 */
export function resolveDebug(rawPluginOptions: unknown): boolean {
  if (process.env.COUNCIL_DEBUG === "1") return true;
  if (
    isPlainObject(rawPluginOptions) &&
    (rawPluginOptions as { debug?: unknown }).debug === true
  ) {
    return true;
  }
  const nested = councilOptions(rawPluginOptions);
  if (isPlainObject(nested) && (nested as { debug?: unknown }).debug === true) {
    return true;
  }
  return false;
}

export function optionalAgentName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

export function hasUserSpecifiedAgent(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0;
}

export function readTimeoutMs(
  source: Record<string, unknown>,
  key: keyof TimeoutConfig,
  fallback: number,
): number {
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.round(raw));
}

/**
 * Reads a non-negative millisecond value from a config source.
 * Floors at 0 (vs readTimeoutMs which floors at 1).
 * Use for timeouts that legitimately accept 0 (e.g. quorum_grace_ms).
 */
function readNonNegativeMs(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.round(raw));
}

export function readReviewerTemperature(source: Record<string, unknown>): number | null {
  const raw = source.reviewer_temperature;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 2) {
    throw new Error("council.reviewer_temperature must be a finite number between 0 and 2");
  }
  return raw;
}

export function normalizeModelConfig(raw: ModelConfig, warn: WarningLogger): ModelConfig {
  const normalized: ModelConfig = {
    providerID: raw.providerID,
    modelID: raw.modelID,
  };
  const optional = (raw as Record<string, unknown>).optional;

  if (optional === undefined) return normalized;
  if (typeof optional === "boolean") {
    normalized.optional = optional;
    return normalized;
  }

  warn("council.models optional flag must be boolean; treating model as required", {
    providerID: raw.providerID,
    modelID: raw.modelID,
    optional,
  });
  normalized.optional = false;
  return normalized;
}

function hasExplicitPositiveTimeout(source: Record<string, unknown>, key: string): boolean {
  const raw = source[key];
  return (
    Object.prototype.hasOwnProperty.call(source, key) &&
    typeof raw === "number" &&
    Number.isFinite(raw) &&
    raw > 0
  );
}

function readOptionalCouncillorMs(
  timeoutSource: Record<string, unknown>,
  councillorMs: number,
  warn: WarningLogger,
): number {
  const hasExplicitOptional = hasExplicitPositiveTimeout(timeoutSource, "optional_councillor_ms");
  const parsed = hasExplicitOptional
    ? readTimeoutMs(timeoutSource, "optional_councillor_ms", OPTIONAL_COUNCILLOR_TIMEOUT_MS)
    : OPTIONAL_COUNCILLOR_TIMEOUT_MS;

  if (parsed <= councillorMs) return parsed;

  if (hasExplicitOptional) {
    warn("optional_councillor_ms cannot exceed councillor_ms; clamping to councillor_ms", {
      optional_councillor_ms: parsed,
      councillor_ms: councillorMs,
    });
  }
  return councillorMs;
}

export type ParseCouncilConfigOptions = {
  /** `ask` handling for permission overrides; defaults to "strip" (V1). */
  overrideAsk?: OverrideAskHandling;
  /**
   * How user-supplied values appear in warning MESSAGE text. "raw" (V1 default)
   * keeps the existing JSON text; "type" (V2) prints only a type tag such as
   * `<object>`, so host consoles/log files never receive raw config values.
   */
  describeValue?: "raw" | "type";
};

function describeConfigValue(value: unknown, mode: "raw" | "type" = "raw"): string {
  if (mode === "raw") return JSON.stringify(value);
  if (value === null) return "<null>";
  if (Array.isArray(value)) return "<array>";
  return `<${typeof value}>`;
}

export function parseCouncilConfig(
  raw: unknown,
  warn: WarningLogger = () => {},
  options: ParseCouncilConfigOptions = {},
): Omit<CouncilConfig, "debug"> {
  const source = councilOptions(raw);
  const timeoutSource = isPlainObject(source.timeouts) ? source.timeouts : {};

  if (Object.prototype.hasOwnProperty.call(timeoutSource, "councillor_retry_ms")) {
    warn(
      "councillor_retry_ms is deprecated; fold the value into councillor_ms. Increase councillor_ms to preserve your prior total councillor budget.",
    );
  }

  if (!Array.isArray(source.models)) {
    throw new Error("council.models is required");
  }

  const models = source.models
    .filter(isModelConfig)
    .map((model) => normalizeModelConfig(model, warn));
  const requiredCount = models.filter((model) => !model.optional).length;
  if (requiredCount < 2) {
    throw new Error("council.models must include at least 2 required (non-optional) model entries");
  }

  const aggregatorModel = (() => {
    const raw = source.aggregator_model;
    if (!isModelConfig(raw)) return null;

    const aggOptional = (raw as Record<string, unknown>).optional;
    if (aggOptional !== undefined && aggOptional !== false) {
      warn("council.aggregator_model cannot be optional; ignoring optional flag", {
        providerID: raw.providerID,
        modelID: raw.modelID,
        optional: aggOptional,
      });
    }

    return { providerID: raw.providerID, modelID: raw.modelID };
  })();

  const councillorMs = readTimeoutMs(
    timeoutSource,
    "councillor_ms",
    COUNCILLOR_TIMEOUT_MS,
  );
  const aggregatorMs = readTimeoutMs(
    timeoutSource,
    "aggregator_ms",
    AGGREGATOR_TIMEOUT_MS,
  );
  const optionalCouncillorMs = readOptionalCouncillorMs(timeoutSource, councillorMs, warn);
  const quorumGraceMs = readNonNegativeMs(timeoutSource, "quorum_grace_ms", 0);
  const computedHardCapMs =
    councillorMs + aggregatorMs + quorumGraceMs + 30_000;
  const hasExplicitHardCap =
    typeof timeoutSource.hard_cap_ms === "number" &&
    Number.isFinite(timeoutSource.hard_cap_ms);
  const hardCapMs = readTimeoutMs(timeoutSource, "hard_cap_ms", computedHardCapMs);

  if (hasExplicitHardCap && hardCapMs < computedHardCapMs) {
    warn("Configured hard_cap_ms is below computed phase timeout budget; honoring explicit hard cap", {
      configured_hard_cap_ms: hardCapMs,
      computed_hard_cap_ms: computedHardCapMs,
      councillor_ms: councillorMs,
      aggregator_ms: aggregatorMs,
      quorum_grace_ms: quorumGraceMs,
    });
  }

  const quorum = (() => {
    const raw = source.quorum;
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 2 && raw <= requiredCount) {
      return raw;
    }
    if (raw !== undefined) {
      warn(
        `Invalid council.quorum: ${describeConfigValue(raw, options.describeValue)}. Must be integer in [2, ${requiredCount}]. Falling back to ${requiredCount}.`,
      );
    }
    return requiredCount;
  })();

  return {
    reviewer: optionalAgentName(source.reviewer, BUNDLED_REVIEWER_AGENT),
    aggregator: optionalAgentName(source.aggregator, BUNDLED_AGGREGATOR_AGENT),
    models,
    quorum,
    aggregator_model: aggregatorModel,
    reviewer_temperature: readReviewerTemperature(source),
    reviewer_permission: readPermissionOverride(
      source.reviewer_permission,
      warn,
      options.overrideAsk,
    ),
    aggregator_permission: readPermissionOverride(
      source.aggregator_permission,
      warn,
      options.overrideAsk,
    ),
    timeouts: {
      councillor_ms: councillorMs,
      optional_councillor_ms: optionalCouncillorMs,
      aggregator_ms: aggregatorMs,
      quorum_grace_ms: quorumGraceMs,
      hard_cap_ms: hardCapMs,
    },
  };
}

export function composeCouncilConfig(
  raw: unknown,
  warn: WarningLogger = () => {},
  options: ParseCouncilConfigOptions = {},
): CouncilConfig {
  return { ...parseCouncilConfig(raw, warn, options), debug: resolveDebug(raw) };
}
