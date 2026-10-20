import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

// Isolate HOME / XDG_* / TMPDIR to a throwaway sandbox BEFORE importing the
// module under test, so nothing can touch the real home directory.
const sandbox = await vi.hoisted(async () => {
  const nodeFs = await import("node:fs");
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  const root = nodeFs.realpathSync(
    nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "council-debug-file-")),
  );
  const saved: Record<string, string | undefined> = {};
  for (const key of [
    "HOME",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "COUNCIL_DEBUG",
  ]) {
    saved[key] = process.env[key];
  }
  process.env.HOME = nodePath.join(root, "home");
  process.env.XDG_STATE_HOME = nodePath.join(root, "state");
  process.env.XDG_CONFIG_HOME = nodePath.join(root, "config");
  process.env.XDG_DATA_HOME = nodePath.join(root, "data");
  process.env.XDG_CACHE_HOME = nodePath.join(root, "cache");
  process.env.TMPDIR = nodePath.join(root, "tmp");
  delete process.env.COUNCIL_DEBUG;
  nodeFs.mkdirSync(process.env.HOME, { recursive: true });
  nodeFs.mkdirSync(process.env.TMPDIR, { recursive: true });
  return { root, saved };
});

const {
  createDebugFile,
  DEBUG_LOG_MAX_BYTES,
  DEBUG_RECORD_MAX_BYTES,
  resolveDebugLogPath,
  toDebugRecord,
} = await import("./debug-file");

afterAll(() => {
  for (const [key, value] of Object.entries(sandbox.saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

let caseCounter = 0;
function caseState() {
  const stateHome = path.join(sandbox.root, `case-${++caseCounter}`);
  const dir = path.join(stateHome, "opencode-council");
  return { stateHome, dir, file: path.join(dir, "debug.log") };
}

function debugFile(stateHome: string, overrides: Parameters<typeof createDebugFile>[0] = {}) {
  const warn = vi.fn();
  const file = createDebugFile({
    env: { XDG_STATE_HOME: stateHome, HOME: path.join(sandbox.root, "home") },
    warn,
    ...overrides,
  });
  return { file, warn };
}

function lines(file: string) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("debug log path", () => {
  it("uses an absolute XDG_STATE_HOME, else ~/.local/state", () => {
    expect(resolveDebugLogPath({ XDG_STATE_HOME: "/x/state" }, "/home/u")).toBe(
      "/x/state/opencode-council/debug.log",
    );
    expect(resolveDebugLogPath({ XDG_STATE_HOME: "relative/state" }, "/home/u")).toBe(
      "/home/u/.local/state/opencode-council/debug.log",
    );
    expect(resolveDebugLogPath({}, "/home/u")).toBe(
      "/home/u/.local/state/opencode-council/debug.log",
    );
  });

  it("stays inside the sandbox for the default environment", () => {
    expect(resolveDebugLogPath(process.env, process.env.HOME ?? "")).toBe(
      path.join(sandbox.root, "state", "opencode-council", "debug.log"),
    );
  });
});

describe("debug log file", () => {
  it("writes allowlisted JSON lines to a 0600 file in a 0700 directory", async () => {
    const { stateHome, dir, file: logPath } = caseState();
    const { file, warn } = debugFile(stateHome);

    file.write("debug", "councillor request completed", {
      model: "provider-a/model-a",
      success: true,
      duration_ms: 12,
    });
    file.write("warn", "council review cancelled", { active_sessions: 2 });
    await file.flush();

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    expect(lines(logPath)).toEqual([
      {
        ts: expect.any(String),
        level: "debug",
        event: "councillor request completed",
        model: "provider-a/model-a",
        durationMs: 12,
      },
      { ts: expect.any(String), level: "warn", event: "council review cancelled", count: 2 },
    ]);
    expect(warn).not.toHaveBeenCalled();
    await file.close();
  });

  it("never records error message text, enumerable error props, prompts, or free-form messages", async () => {
    const { stateHome, file: logPath } = caseState();
    const { file } = debugFile(stateHome);
    const error = Object.assign(new TypeError("SENTINEL-ERROR-MESSAGE"), {
      code: "SENTINEL-ENUMERABLE-PROP",
    });

    file.write("debug", "councillor request completed", {
      model: "provider-a/model-a",
      success: false,
      error: "prompt failed: SENTINEL-STRING-ERROR",
      prompt: "SENTINEL-PROMPT",
      permission_json: "SENTINEL-PERMISSIONS",
    });
    file.write("debug", "aggregator synthesis ended", { error });
    file.write("warn", "Invalid council.quorum: \"SENTINEL-CONFIG\". Must be integer");
    await file.flush();

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).not.toContain("SENTINEL");
    expect(lines(logPath).map((record) => record.error)).toEqual([
      { kind: "prompt" },
      { kind: "other", class: "TypeError" },
      undefined,
    ]);
    expect(lines(logPath)[2].event).toBe("log");
    await file.close();
  });

  it("caps each record at 2 KB", () => {
    const record = toDebugRecord("debug", "councillor request started", {
      model: "m".repeat(10_000),
      sessionID: "s".repeat(10_000),
    });

    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(DEBUG_RECORD_MAX_BYTES);
  });

  it("serializes writes in order and never throws on hostile extras", async () => {
    const { stateHome, file: logPath } = caseState();
    const { file } = debugFile(stateHome);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (let i = 0; i < 50; i++) file.write("debug", "councillor request started", { count: i });
    expect(() => file.write("debug", "x", { circular, big: 10n } as never)).not.toThrow();
    await file.flush();

    expect(lines(logPath).slice(0, 50).map((record) => record.count)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
    await file.close();
  });

  it("rotates to .1 once the file reaches 1 MiB", async () => {
    const { stateHome, dir, file: logPath } = caseState();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(logPath, "x".repeat(DEBUG_LOG_MAX_BYTES), { mode: 0o600 });
    const { file } = debugFile(stateHome);

    file.write("debug", "councillor request started", { count: 1 });
    await file.flush();

    expect(fs.statSync(`${logPath}.1`).size).toBe(DEBUG_LOG_MAX_BYTES);
    expect(lines(logPath)).toEqual([
      { ts: expect.any(String), level: "debug", event: "councillor request started", count: 1 },
    ]);
    await file.close();
  });

  it("is console-only on win32 and never touches the file system", async () => {
    const { stateHome } = caseState();
    const { file, warn } = debugFile(stateHome, { platform: "win32" });

    file.write("debug", "councillor request started");
    await file.flush();

    expect(fs.existsSync(stateHome)).toBe(false);
    expect(file.path).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("debug log file close", () => {
  it("permanently disables the instance: later writes never reopen or recreate the file", async () => {
    const { stateHome, file: logPath } = caseState();
    const { file } = debugFile(stateHome);
    file.write("debug", "councillor request started");
    await file.flush();
    expect(fs.existsSync(logPath)).toBe(true);

    await file.close();
    fs.rmSync(logPath);
    file.write("debug", "councillor request started");
    await file.flush();
    await file.close();

    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("does not open the file for a write queued before close when close happens first", async () => {
    // Fresh state dir: neither the directory nor the log file exists yet, so any
    // open by the queued write would leave visible evidence (nothing is deleted).
    const { stateHome, dir, file: logPath } = caseState();
    expect(fs.existsSync(stateHome)).toBe(false);
    const { file, warn } = debugFile(stateHome);

    // Queued synchronously; its writeLine runs only after close() marked the file closed.
    file.write("debug", "councillor request started");
    await file.close();
    await file.flush();

    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(stateHome)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("debug log file safety checks disable logging without hanging or modifying targets", () => {
  it("FIFO at the log path", async () => {
    const { stateHome, dir, file: logPath } = caseState();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", [logPath]);
    const { file, warn } = debugFile(stateHome);

    file.write("debug", "councillor request started");
    file.write("debug", "councillor request started");
    await file.flush();

    expect(file.disabled).toBe(true);
    expect(fs.lstatSync(logPath).isFIFO()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  }, 5_000);

  it("symlink at the log path", async () => {
    const { stateHome, dir, file: logPath } = caseState();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(sandbox.root, `symlink-target-${caseCounter}`);
    fs.writeFileSync(target, "original", { mode: 0o644 });
    fs.symlinkSync(target, logPath);
    const { file, warn } = debugFile(stateHome);

    file.write("debug", "councillor request started");
    await file.flush();

    expect(file.disabled).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("hard link at the log path (nlink > 1)", async () => {
    const { stateHome, dir, file: logPath } = caseState();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const original = path.join(sandbox.root, `hardlink-original-${caseCounter}`);
    fs.writeFileSync(original, "original", { mode: 0o644 });
    fs.linkSync(original, logPath);
    const { file, warn } = debugFile(stateHome);

    file.write("debug", "councillor request started");
    await file.flush();

    expect(file.disabled).toBe(true);
    expect(fs.readFileSync(original, "utf8")).toBe("original");
    expect(fs.statSync(original).mode & 0o777).toBe(0o644);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("log file owned by another user (simulated uid)", async () => {
    const { stateHome, dir, file: logPath } = caseState();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(logPath, "existing", { mode: 0o644 });
    const realUid = process.getuid?.() ?? 0;
    const { file, warn } = debugFile(stateHome, {
      // Directory check sees the real owner; the file check sees a mismatch.
      getuid: () => realUid,
      fileOwnerOverride: () => realUid + 1,
    });

    file.write("debug", "councillor request started");
    await file.flush();

    expect(file.disabled).toBe(true);
    expect(fs.readFileSync(logPath, "utf8")).toBe("existing");
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o644);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("log directory owned by another user (simulated uid)", async () => {
    const { stateHome } = caseState();
    const realUid = process.getuid?.() ?? 0;
    const { file, warn } = debugFile(stateHome, { getuid: () => realUid + 1 });

    file.write("debug", "councillor request started");
    await file.flush();

    expect(file.disabled).toBe(true);
    expect(fs.existsSync(path.join(stateHome, "opencode-council", "debug.log"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("symlinked log directory", async () => {
    const { stateHome, dir } = caseState();
    const realDir = path.join(sandbox.root, `real-dir-${caseCounter}`);
    fs.mkdirSync(realDir, { mode: 0o755 });
    fs.mkdirSync(stateHome, { recursive: true });
    fs.symlinkSync(realDir, dir);
    const { file, warn } = debugFile(stateHome);

    file.write("debug", "councillor request started");
    await file.flush();

    expect(file.disabled).toBe(true);
    expect(fs.readdirSync(realDir)).toEqual([]);
    expect(fs.statSync(realDir).mode & 0o777).toBe(0o755);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
