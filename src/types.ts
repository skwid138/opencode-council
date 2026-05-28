export const BUNDLED_REVIEWER_AGENT = "council-plugin-reviewer";
export const BUNDLED_AGGREGATOR_AGENT = "council-plugin-aggregator";

export type CouncilPluginOptions = {
  council?: Record<string, unknown>;
  debug?: boolean;
} & Record<string, unknown>;

export type TimeoutConfig = {
  councillor_ms: number;
  councillor_retry_ms: number;
  aggregator_ms: number;
  hard_cap_ms: number;
};

export type ModelConfig = {
  providerID: string;
  modelID: string;
};

export type PermissionOverrideConfig = Record<string, string | Record<string, string>>;

export type CouncilConfig = {
  reviewer: string;
  aggregator: string;
  debug: boolean;
  models: ModelConfig[];
  aggregator_model: ModelConfig | null;
  reviewer_temperature: number | null;
  reviewer_permission: PermissionOverrideConfig | null;
  aggregator_permission: PermissionOverrideConfig | null;
  timeouts: TimeoutConfig;
};

export type PermissionRuleset = Array<{
  permission: string;
  pattern: string;
  action: "allow" | "deny";
}>;

export type CouncillorSuccess = {
  model: ModelConfig;
  response: string;
  attempts: number;
};

export type CouncillorFailure = {
  model: ModelConfig;
  error: string;
};

export type WarningLogger = (message: string, extra?: Record<string, unknown>) => void;

export type ReviewState = {
  activeSessions: Set<string>;
  hardCapTimedOut: boolean;
};

export function isModelConfig(value: unknown): value is ModelConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.providerID === "string" &&
    candidate.providerID.trim().length > 0 &&
    typeof candidate.modelID === "string" &&
    candidate.modelID.trim().length > 0
  );
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPermissionAction(value: unknown): value is "allow" | "deny" {
  return value === "allow" || value === "deny";
}
