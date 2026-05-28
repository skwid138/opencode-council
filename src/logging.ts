import type { PluginInput } from "@opencode-ai/plugin";

import type { ModelConfig } from "./types";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
) => void;

export function modelLabel(model: ModelConfig): string {
  return `${model.providerID}/${model.modelID}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLogger(ctx: PluginInput, debugEnabled: boolean): Logger {
  return (level, message, extra) => {
    if (level === "debug" && !debugEnabled) return;
    const body: {
      service: string;
      level: LogLevel;
      message: string;
      extra?: Record<string, unknown>;
    } = { service: "council-plugin", level, message };
    if (extra !== undefined) body.extra = extra;
    void ctx.client.app.log({ body });
  };
}
