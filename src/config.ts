import { readPermissionOverride } from "./permissions";
import {
  BUNDLED_AGGREGATOR_AGENT,
  BUNDLED_REVIEWER_AGENT,
  type CouncilConfig,
  isModelConfig,
  isPlainObject,
  type TimeoutConfig,
  type WarningLogger,
} from "./types";

export const COUNCILLOR_TIMEOUT_MS = 270_000;
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

export function parseCouncilConfig(
  raw: unknown,
  warn: WarningLogger = () => {},
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

  const models = source.models.filter(isModelConfig);
  if (models.length < 2) {
    throw new Error("council.models must include at least 2 valid model entries");
  }

  const aggregatorModel = isModelConfig(source.aggregator_model)
    ? source.aggregator_model
    : null;

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
  const quorumGraceMs = readNonNegativeMs(timeoutSource, "quorum_grace_ms", 0);
  const computedHardCapMs =
    councillorMs + aggregatorMs + quorumGraceMs + 30_000;
  const hasExplicitHardCap =
    typeof timeoutSource.hard_cap_ms === "number" &&
    Number.isFinite(timeoutSource.hard_cap_ms);
  const hardCapMs = readTimeoutMs(
    timeoutSource,
    "hard_cap_ms",
    hasExplicitHardCap ? DEFAULT_HARD_CAP_MS : computedHardCapMs,
  );

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
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 2 && raw <= models.length) {
      return raw;
    }
    if (raw !== undefined) {
      warn(
        `Invalid council.quorum: ${JSON.stringify(raw)}. Must be integer in [2, ${models.length}]. Falling back to ${models.length}.`,
      );
    }
    return models.length;
  })();

  return {
    reviewer: optionalAgentName(source.reviewer, BUNDLED_REVIEWER_AGENT),
    aggregator: optionalAgentName(source.aggregator, BUNDLED_AGGREGATOR_AGENT),
    models,
    quorum,
    aggregator_model: aggregatorModel,
    reviewer_temperature: readReviewerTemperature(source),
    reviewer_permission: readPermissionOverride(source.reviewer_permission, warn),
    aggregator_permission: readPermissionOverride(source.aggregator_permission, warn),
    timeouts: {
      councillor_ms: councillorMs,
      aggregator_ms: aggregatorMs,
      quorum_grace_ms: quorumGraceMs,
      hard_cap_ms: hardCapMs,
    },
  };
}

export function composeCouncilConfig(
  raw: unknown,
  warn: WarningLogger = () => {},
): CouncilConfig {
  return { ...parseCouncilConfig(raw, warn), debug: resolveDebug(raw) };
}
