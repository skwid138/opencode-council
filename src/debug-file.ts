/**
 * Debug-only council log file for hosts without a persisted plugin logger (V2, D6).
 *
 * Safety spec (plan "Debug log spec"):
 * - Enabled only when council debug is set; win32 is console-only (no fs access at all).
 * - Path: `$XDG_STATE_HOME/opencode-council/debug.log` when XDG_STATE_HOME is absolute,
 *   else `~/.local/state/opencode-council/debug.log`. Ancestors above
 *   `opencode-council/` are not validated.
 * - Directory: mkdir 0700; lstat must be a real directory owned by the current
 *   uid (else disable + one warn); chmod 0700.
 * - File: open O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW|O_NONBLOCK mode 0600; fstat
 *   must be a regular file owned by uid with nlink == 1 (else close + disable);
 *   fchmod 0600.
 * - Rotation at >= 1 MiB: close, rename to `.1`, reopen with the same checks.
 * - One serialized write/rotation queue per instance (cross-instance rotation is
 *   best effort).
 * - Records carry only {ts, level, event, model, sessionID, role, durationMs,
 *   count, error {kind, class}} — never error message text — and are <= 2 KB.
 * - Any failure disables the file after one warning; nothing ever throws.
 */
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type { LogLevel } from "./logging.js";

export const DEBUG_LOG_MAX_BYTES = 1024 * 1024;
export const DEBUG_RECORD_MAX_BYTES = 2048;
const MAX_FIELD_CHARS = 200;
const EVENT_PATTERN = /^[a-z][a-z0-9 _-]{0,79}$/i;
const CLASS_PATTERN = /^[A-Za-z_$][\w$]{0,63}$/;

export type DebugFileDeps = {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  homedir?: () => string;
  getuid?: () => number | undefined;
  /** Test seam: report a different owner for the opened log file. */
  fileOwnerOverride?: () => number;
  warn?: (message: string) => void;
};

export type DebugFile = {
  write(level: LogLevel, message: string, extra?: Record<string, unknown>): void;
  /** Resolves once every queued write has been attempted. Never rejects. */
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly path: string | undefined;
  readonly disabled: boolean;
};

export function resolveDebugLogPath(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const stateHome = env.XDG_STATE_HOME;
  const base =
    typeof stateHome === "string" && isAbsolute(stateHome)
      ? stateHome
      : join(home, ".local", "state");
  return join(base, "opencode-council", "debug.log");
}

function cap(value: string): string {
  return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

function errorKind(error: unknown): string {
  const text = typeof error === "string" ? error.toLowerCase() : "";
  if (text.includes("timed out")) return "timeout";
  if (text.includes("cancelled")) return "cancelled";
  if (text.includes("hard cap")) return "hard_cap";
  if (text.includes("quorum")) return "quorum";
  if (text.startsWith("prompt failed")) return "prompt";
  if (text.includes("create child session")) return "create";
  if (text.includes("empty response")) return "empty";
  if (text.includes("context")) return "context";
  return "other";
}

function errorClass(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  try {
    const name = error.constructor?.name;
    return typeof name === "string" && CLASS_PATTERN.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Build an allowlisted debug record. Never includes message text from errors or prompts. */
export function toDebugRecord(
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event: typeof message === "string" && EVENT_PATTERN.test(message) ? message : "log",
  };
  try {
    if (extra && typeof extra === "object") {
      if (typeof extra.model === "string") record.model = cap(extra.model);
      if (typeof extra.sessionID === "string") record.sessionID = cap(extra.sessionID);
      if (typeof extra.role === "string") record.role = cap(extra.role);
      const duration = extra.duration_ms ?? extra.durationMs;
      if (typeof duration === "number" && Number.isFinite(duration)) record.durationMs = duration;
      const count = extra.count ?? extra.active_sessions;
      if (typeof count === "number" && Number.isFinite(count)) record.count = count;
      if (extra.error !== undefined) {
        const cls = errorClass(extra.error);
        record.error = cls ? { kind: errorKind(extra.error), class: cls } : { kind: errorKind(extra.error) };
      }
    }
  } catch {
    // Hostile extras: keep the minimal record.
  }
  if (Buffer.byteLength(JSON.stringify(record)) > DEBUG_RECORD_MAX_BYTES) {
    return { ts: record.ts, level, event: record.event };
  }
  return record;
}

const OPEN_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_NONBLOCK;

class DebugFileUnsafe extends Error {}

export function createDebugFile(deps: DebugFileDeps = {}): DebugFile {
  const platform = deps.platform ?? process.platform;
  const warn = deps.warn ?? ((message: string) => console.error(`[council-plugin] ${message}`));

  if (platform === "win32") {
    // Fail closed before any file-system access.
    return {
      write() {},
      flush: async () => {},
      close: async () => {},
      path: undefined,
      disabled: true,
    };
  }

  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? homedir)();
  const logPath = resolveDebugLogPath(env, home);
  const dir = dirname(logPath);
  const uid = (deps.getuid ?? (() => process.getuid?.()))();

  let handle: FileHandle | undefined;
  let size = 0;
  let disabled = false;
  // Set by close(): permanent. Writes are refused, and queued writes never open,
  // reopen, or rotate the file (they only use a handle that is still open).
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  async function closeHandle() {
    const current = handle;
    handle = undefined;
    if (current) await current.close().catch(() => {});
  }

  function disable(reason: string, error?: unknown) {
    if (disabled) return;
    disabled = true;
    const code =
      typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
        ? ` (${(error as { code: string }).code})`
        : "";
    try {
      warn(`debug log file disabled: ${reason}${code}`);
    } catch {
      // never throw
    }
  }

  async function openChecked() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirStat = await lstat(dir);
    if (!dirStat.isDirectory() || (uid !== undefined && dirStat.uid !== uid)) {
      throw new DebugFileUnsafe("log directory is not a real directory owned by the current user");
    }
    await chmod(dir, 0o700);

    const opened = await open(logPath, OPEN_FLAGS, 0o600);
    try {
      const fileStat = await opened.stat();
      const owner = deps.fileOwnerOverride ? deps.fileOwnerOverride() : fileStat.uid;
      if (!fileStat.isFile() || (uid !== undefined && owner !== uid) || fileStat.nlink !== 1) {
        throw new DebugFileUnsafe(
          "log file is not a regular, singly linked file owned by the current user",
        );
      }
      await opened.chmod(0o600);
      handle = opened;
      size = fileStat.size;
    } catch (error) {
      await opened.close().catch(() => {});
      throw error;
    }
  }

  async function writeLine(line: string) {
    if (disabled) return;
    try {
      if (!handle) {
        if (closed) return;
        await openChecked();
      }
      if (size >= DEBUG_LOG_MAX_BYTES) {
        if (closed) return;
        await closeHandle();
        await rename(logPath, `${logPath}.1`);
        await openChecked();
      }
      const bytes = Buffer.from(line);
      await handle!.write(bytes);
      size += bytes.length;
    } catch (error) {
      await closeHandle();
      disable(error instanceof DebugFileUnsafe ? error.message : "file system error", error);
    }
  }

  return {
    write(level, message, extra) {
      if (disabled || closed) return;
      try {
        const line = `${JSON.stringify(toDebugRecord(level, message, extra))}\n`;
        queue = queue.then(() => writeLine(line)).catch(() => {});
      } catch {
        // never throw
      }
    },
    flush() {
      return queue.catch(() => {});
    },
    // Permanent. Note: close() stops accepting writes and waits for queued ones,
    // but it cannot cancel a file-system operation already in flight. If such an
    // op never settles, close() never settles either (callers bound how long they
    // WAIT, e.g. V2 cleanup), and the descriptor may stay open or the op may
    // complete after the caller has moved on. Documented residual; unverified on
    // a real host.
    async close() {
      closed = true;
      await queue.catch(() => {});
      await closeHandle();
    },
    get path() {
      return logPath;
    },
    get disabled() {
      return disabled;
    },
  };
}
