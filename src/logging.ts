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
  try {
    if (typeof error === "string") return error || "[empty string error]";

    if (error instanceof Error) {
      let base = "Error";
      try {
        const message = error.message;
        if (typeof message === "string" && message.length > 0) {
          base = message;
        } else {
          const name = error.name;
          base = typeof name === "string" && name.length > 0 ? name : "Error";
        }
      } catch {
        base = "Error";
      }

      const extra: Record<string, unknown> = {};
      for (const key of Object.keys(error).filter(
        (key) => key !== "message" && key !== "stack" && key !== "name",
      )) {
        try {
          extra[key] = (error as unknown as Record<string, unknown>)[key];
        } catch {
          extra[key] = "[unreadable property]";
        }
      }

      if (Object.keys(extra).length > 0) {
        try {
          const json = JSON.stringify(extra);
          if (typeof json === "string" && json.length > 0) {
            return `${base} ${json} (json)`;
          }
        } catch {
          // Keep the base Error message if extra metadata cannot be serialized.
        }
      }

      return base;
    }

    if (
      typeof error === "number" ||
      typeof error === "boolean" ||
      typeof error === "bigint"
    ) {
      return String(error);
    }

    if (error === null || error === undefined) return String(error);

    if (typeof error === "symbol") return error.toString();

    if (typeof error === "object") {
      try {
        const json = JSON.stringify(error);
        if (typeof json === "string") return json;
      } catch {
        return `[unserializable error: ${unserializableErrorName(error)}]`;
      }
      return `[unserializable error: ${unserializableErrorName(error)}]`;
    }

    return String(error);
  } catch {
    return "[errorMessage threw]";
  }
}

function unserializableErrorName(error: object): string {
  try {
    const name = (error as { constructor?: { name?: unknown } })?.constructor?.name;
    return typeof name === "string" && name.length > 0
      ? name
      : typeof error || "unknown";
  } catch {
    return "unknown";
  }
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
