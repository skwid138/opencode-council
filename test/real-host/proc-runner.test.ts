// Exercised with plain `node -e` children only (never docker).
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLEANUP_SCOPE_NOTE, createProcRunner, markGroupGone, probeGroup, signalGroup } from "./proc-runner.mjs";

const node = process.execPath;
const runner = createProcRunner({ env: { PATH: "/usr/bin:/bin" } });

describe("attached process runner", () => {
  it("resolves after EOF/exit with full stdout and stderr", async () => {
    const result = await runner.runAttached([node, "-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"], { timeoutMs: 10_000, stdoutCap: 1024, stderrCap: 1024 });
    expect(result).toEqual({ exitCode: 3, signal: null, stdout: "out", stderr: "err", timedOut: false, capExceeded: null, cancelled: false, cleanupUncertain: false, survivorsKilled: false, cleanupScope: "original-process-group" });
  });

  it("waits for 'close' (all stdio EOF), not just the leader's exit, when a grandchild still holds the pipe", async () => {
    // node-only: the child spawns a node grandchild that inherits stdout, then exits at once.
    const child = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write('late'), 400)"], { stdio: ["ignore", "inherit", "inherit"] }); process.stdout.write("early"); process.exit(0);`;
    const started = Date.now();
    const result = await runner.runAttached([node, "-e", child], { timeoutMs: 10_000, stdoutCap: 1024, stderrCap: 1024 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "earlylate", timedOut: false, cancelled: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it("kills the attached client when the caller's signal aborts (operator termination) and reports cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runner.runAttached([node, "-e", "process.stdout.write('x');setInterval(() => {}, 1000)"], { timeoutMs: 10_000, stdoutCap: 1024, stderrCap: 1024, signal: controller.signal });
    expect(result).toMatchObject({ cancelled: true, timedOut: false, signal: "SIGKILL", stdout: "x" });
  });

  it("does not launch at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runner.runAttached([node, "-e", "require('node:fs').writeFileSync('/dev/stderr', 'ran')"], { timeoutMs: 10_000, stdoutCap: 1024, stderrCap: 1024, signal: controller.signal });
    expect(result).toEqual({ exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, capExceeded: null, cancelled: true, launched: false });
  });

  it("killAttached() kills every in-flight attached client but leaves bounded cleanup commands (run) alone", async () => {
    const local = createProcRunner({ env: { PATH: "/usr/bin:/bin" } });
    const pending = local.runAttached([node, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 10_000, stdoutCap: 1024, stderrCap: 1024 });
    const cleanup = local.run([node, "-e", "setTimeout(() => process.stdout.write('cleaned'), 300)"], { timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(local.killAttached()).toBe(1);
    expect(await pending).toMatchObject({ signal: "SIGKILL", timedOut: false });
    expect(await cleanup).toEqual({ status: 0, stdout: "cleaned", stderr: "", timedOut: false, cancelled: false, cleanupUncertain: false, survivorsKilled: false, cleanupScope: "original-process-group" });
    expect(local.killAttached()).toBe(0);
  });

  it("kills the client when stdout exceeds the cap and still waits for it to close", async () => {
    const result = await runner.runAttached([node, "-e", "setInterval(() => process.stdout.write('x'.repeat(4096)), 1)"], { timeoutMs: 10_000, stdoutCap: 16_384, stderrCap: 1024 });
    expect(result.capExceeded).toBe("stdout");
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout.length).toBeLessThanOrEqual(16_384);
  });

  it("kills the client when stderr exceeds the cap", async () => {
    const result = await runner.runAttached([node, "-e", "setInterval(() => process.stderr.write('y'.repeat(4096)), 1)"], { timeoutMs: 10_000, stdoutCap: 1024, stderrCap: 8_192 });
    expect(result.capExceeded).toBe("stderr");
  });

  it("kills on timeout and keeps the partial output it captured", async () => {
    const result = await runner.runAttached([node, "-e", "process.stdout.write('partial');setInterval(() => {}, 1000)"], { timeoutMs: 300, stdoutCap: 1024, stderrCap: 1024 });
    expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL", stdout: "partial" });
  });

  it("runs a bounded command and reports status / timeout", async () => {
    expect(await runner.run([node, "-e", "process.stdout.write('ok')"], { timeoutMs: 10_000 })).toEqual({ status: 0, stdout: "ok", stderr: "", timedOut: false, cancelled: false, cleanupUncertain: false, survivorsKilled: false, cleanupScope: "original-process-group" });
    expect(await runner.run([node, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 200 })).toMatchObject({ status: null, timedOut: true });
  });

  it("passes only the given environment (nothing inherited) and no shell", async () => {
    const result = await runner.run([node, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"], { timeoutMs: 10_000 });
    // macOS itself injects __CF_USER_TEXT_ENCODING into every child; nothing else may appear.
    expect(JSON.parse(result.stdout).filter((key: string) => key !== "__CF_USER_TEXT_ENCODING")).toEqual(["PATH"]);
    await expect(runner.run(["relative-cmd"], { timeoutMs: 1000 })).rejects.toThrow(/absolute/);
  });
});

describe("run(): cancellation of non-attached commands (node-only children)", () => {
  it("on abort sends SIGTERM and resolves cancelled (status null), keeping captured output", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await runner.run([node, "-e", "process.stdout.write('begun');setInterval(() => {}, 1000)"], { timeoutMs: 10_000, signal: controller.signal });
    expect(result).toEqual({ status: null, stdout: "begun", stderr: "", timedOut: false, cancelled: true, signal: "SIGTERM", cleanupUncertain: false, survivorsKilled: false, cleanupScope: "original-process-group" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("escalates to SIGKILL after the bounded grace when the child ignores SIGTERM", async () => {
    const local = createProcRunner({ env: { PATH: "/usr/bin:/bin" }, killGraceMs: 200 });
    const controller = new AbortController();
    const child = "process.on('SIGTERM', () => process.stdout.write('ignored-term'));process.stdout.write('ready');setInterval(() => {}, 1000)";
    const pending = local.run([node, "-e", child], { timeoutMs: 10_000, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const aborted = Date.now();
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: null, cancelled: true, signal: "SIGKILL", stdout: "readyignored-term" });
    expect(Date.now() - aborted).toBeGreaterThanOrEqual(180);
    expect(Date.now() - aborted).toBeLessThan(3_000);
  });

  it("does not launch at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runner.run([node, "-e", "process.stdout.write('ran')"], { timeoutMs: 10_000, signal: controller.signal });
    expect(result).toEqual({ status: null, stdout: "", stderr: "", timedOut: false, cancelled: true, launched: false });
  });
});

describe("tripwire and cwd", () => {
  it("refuses every spawn when the caller's environment carries COUNCIL_RH_FORBID_SPAWN=1", async () => {
    const tripped = createProcRunner({ env: { PATH: "/usr/bin:/bin" }, guardEnv: { COUNCIL_RH_FORBID_SPAWN: "1" } });
    await expect(tripped.run([node, "-e", "0"], { timeoutMs: 1000 })).rejects.toThrow(/TRIPWIRE: spawn refused \(COUNCIL_RH_FORBID_SPAWN\)/);
    await expect(tripped.runAttached([node, "-e", "0"], { timeoutMs: 1000, stdoutCap: 10, stderrCap: 10 })).rejects.toThrow(/TRIPWIRE/);
  });

  it("runs in the requested cwd", async () => {
    const result = await runner.run([node, "-e", "process.stdout.write(process.cwd())"], { timeoutMs: 10_000, cwd: "/" });
    expect(result.stdout).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// Process groups (node-only children + grandchildren). Every child is its own process
// group leader; timeouts, caps, cancellation, escalation and killAttached() signal the GROUP.

/** A node child that starts a node grandchild sharing its stdout/stderr, prints `GC:<pid>`, then idles. */
const withGrandchild = (extra = "", { escape = false } = {}) =>
  `const { spawn } = require("node:child_process");` +
  `const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"], detached: ${escape} });` +
  `process.stdout.write("GC:" + g.pid + "\\n");${extra}setInterval(() => {}, 1000);`;
const grandchildPid = (stdout: string) => Number(/GC:(\d+)/.exec(stdout)?.[1]);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function goneWithin(pid: number, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}
const escaped: number[] = [];
afterEach(() => {
  for (const pid of escaped.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

describe("process-group termination (node child + grandchild holding the pipes)", () => {
  const grouped = createProcRunner({ env: { PATH: "/usr/bin:/bin" }, killGraceMs: 200, closeBoundMs: 400 });

  it("timeout: the whole group (grandchild included) is SIGKILLed and settlement is prompt", async () => {
    const started = Date.now();
    const result = await grouped.runAttached([node, "-e", withGrandchild()], { timeoutMs: 400, stdoutCap: 1024, stderrCap: 1024 });
    expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL", cleanupUncertain: false });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await goneWithin(grandchildPid(result.stdout), 2_000)).toBe(true);
  });

  it("cap violation: the group is killed (grandchild too)", async () => {
    const flood = `setInterval(() => process.stdout.write("x".repeat(4096)), 1);`;
    const result = await grouped.runAttached([node, "-e", withGrandchild(flood)], { timeoutMs: 10_000, stdoutCap: 16_384, stderrCap: 1024 });
    expect(result).toMatchObject({ capExceeded: "stdout", cleanupUncertain: false });
    expect(result.stdout.length).toBeLessThanOrEqual(16_384);
    expect(await goneWithin(grandchildPid(result.stdout), 2_000)).toBe(true);
  });

  it("attached cancellation: the group is killed", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await grouped.runAttached([node, "-e", withGrandchild()], { timeoutMs: 10_000, stdoutCap: 1024, stderrCap: 1024, signal: controller.signal });
    expect(result).toMatchObject({ cancelled: true, cleanupUncertain: false });
    expect(await goneWithin(grandchildPid(result.stdout), 2_000)).toBe(true);
  });

  it("run() cancellation: SIGTERM to the group, escalated to group SIGKILL when the leader ignores it", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await grouped.run([node, "-e", withGrandchild("process.on('SIGTERM', () => {});")], { timeoutMs: 10_000, signal: controller.signal });
    expect(result).toMatchObject({ cancelled: true, status: null, signal: "SIGKILL", cleanupUncertain: false });
    expect(await goneWithin(grandchildPid(result.stdout), 2_000)).toBe(true);
  });

  it("killAttached(): the group is killed", async () => {
    const pending = grouped.runAttached([node, "-e", withGrandchild()], { timeoutMs: 10_000, stdoutCap: 1024, stderrCap: 1024 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(grouped.killAttached()).toBe(1);
    const result = await pending;
    expect(result.cleanupUncertain).toBe(false);
    expect(await goneWithin(grandchildPid(result.stdout), 2_000)).toBe(true);
  });

  it("bounded settlement: a grandchild that ESCAPED the group keeps the pipes open -> streams destroyed, cleanupUncertain, no hang", async () => {
    const started = Date.now();
    const result = await grouped.runAttached([node, "-e", withGrandchild("", { escape: true })], { timeoutMs: 300, stdoutCap: 1024, stderrCap: 1024 });
    const pid = grandchildPid(result.stdout);
    escaped.push(pid);
    expect(result).toMatchObject({ timedOut: true, cleanupUncertain: true });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(alive(pid)).toBe(true); // honestly reported: it escaped the group kill
  });

  it("run() with an escaped grandchild after cancellation also settles within the bound and says so", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await grouped.run([node, "-e", withGrandchild("", { escape: true })], { timeoutMs: 10_000, signal: controller.signal });
    escaped.push(grandchildPid(result.stdout));
    expect(result).toMatchObject({ cancelled: true, cleanupUncertain: true });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

// ---------------------------------------------------------------------------
// Round 4: termination is only "clean" once the GROUP is proven gone (ESRCH).

/** Leader that exits on SIGTERM, with a grandchild that IGNORES SIGTERM and does not hold the pipes. */
const stubbornGrandchild =
  `const { spawn } = require("node:child_process");` +
  `const g = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });` +
  `process.stdout.write("GC:" + g.pid + "\\n");setInterval(() => {}, 1000);`;

describe("group settlement after the leader closes (termination requested)", () => {
  const runnerWith = (extra: Record<string, unknown> = {}) => createProcRunner({ env: { PATH: "/usr/bin:/bin" }, killGraceMs: 300, closeBoundMs: 600, ...extra });

  it("run() cancel: leader dies on SIGTERM, the SIGTERM-ignoring grandchild (stdio ignored) is still escalated to SIGKILL; result is clean only after ESRCH", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await runnerWith().run([node, "-e", stubbornGrandchild], { timeoutMs: 10_000, signal: controller.signal });
    const pid = grandchildPid(result.stdout);
    escaped.push(pid);
    expect(result).toMatchObject({ cancelled: true, cleanupUncertain: false });
    expect(alive(pid)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("attached timeout: same stubborn grandchild is killed and confirmed gone", async () => {
    const result = await runnerWith().runAttached([node, "-e", stubbornGrandchild], { timeoutMs: 300, stdoutCap: 1024, stderrCap: 1024 });
    const pid = grandchildPid(result.stdout);
    escaped.push(pid);
    expect(result).toMatchObject({ timedOut: true, cleanupUncertain: false });
    expect(await goneWithin(pid, 1_000)).toBe(true);
  });

  it.each([
    ["the group still answers the probe at the bound", "alive"],
    ["the probe is ambiguous (e.g. EPERM)", "ambiguous"],
  ])("cleanupUncertain when %s", async (_label, answer) => {
    const probes: number[] = [];
    const runner = runnerWith({ groupProbe: (pgid: number) => (probes.push(pgid), answer) });
    const started = Date.now();
    const result = await runner.runAttached([node, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 200, stdoutCap: 1024, stderrCap: 1024 });
    expect(result).toMatchObject({ timedOut: true, cleanupUncertain: true });
    expect(probes.length).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

});

describe("normal leader exit: the original group is still probed (round 5)", () => {
  const runnerWith = (extra: Record<string, unknown> = {}) => createProcRunner({ env: { PATH: "/usr/bin:/bin" }, killGraceMs: 300, closeBoundMs: 600, ...extra });
  /**
   * Leader that leaves a same-group grandchild (stdio 'ignore') and exits 0 -- but only after the
   * grandchild installed its SIGTERM handler (ready file), so the handler is really in effect.
   * "graceful": on SIGTERM writes a marker and exits; "stubborn": ignores SIGTERM (needs SIGKILL).
   */
  const leaveGrandchild = (dir: string, behavior: "graceful" | "stubborn") => {
    const ready = join(dir, "ready");
    const marker = join(dir, "got-sigterm");
    const onTerm = behavior === "graceful" ? `require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(0);` : "";
    const grandchild = `process.on('SIGTERM', () => { ${onTerm} }); require('fs').writeFileSync(${JSON.stringify(ready)}, '1'); setInterval(() => {}, 1000)`;
    return (
      `const { spawn } = require("node:child_process"); const fs = require("node:fs");` +
      `const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });` +
      `const wait = () => (fs.existsSync(${JSON.stringify(ready)}) ? (process.stdout.write("GC:" + g.pid + "\\n"), process.exit(0)) : setTimeout(wait, 10)); wait();`
    );
  };

  it.each([
    ["dies on SIGTERM (SIGTERM is sent first: marker written)", "graceful"],
    ["ignores SIGTERM (needs the SIGKILL escalation)", "stubborn"],
  ] as const)("a same-group survivor that %s is killed; exit status and stdout are unchanged; survivorsKilled recorded", async (_label, behavior) => {
    for (const mode of ["run", "runAttached"] as const) {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-surv-")));
      try {
        const runner = runnerWith();
        const script = leaveGrandchild(dir, behavior);
        const result =
          mode === "run"
            ? await runner.run([node, "-e", script], { timeoutMs: 10_000 })
            : await runner.runAttached([node, "-e", script], { timeoutMs: 10_000, stdoutCap: 1024, stderrCap: 1024 });
        const pid = grandchildPid(result.stdout);
        escaped.push(pid);
        expect(result.stdout).toBe(`GC:${pid}\n`);
        expect(mode === "run" ? (result as { status: number }).status : (result as { exitCode: number }).exitCode).toBe(0);
        expect(result).toMatchObject({ cleanupUncertain: false, survivorsKilled: true, cleanupScope: "original-process-group" });
        expect(await goneWithin(pid, 1_000)).toBe(true);
        expect(existsSync(join(dir, "got-sigterm"))).toBe(behavior === "graceful");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("a normal exit with no survivors is clean and the group is probed exactly once", async () => {
    const probes: number[] = [];
    const result = await runnerWith({ groupProbe: (pgid: number) => (probes.push(pgid), probeGroup(pgid)) }).run([node, "-e", "process.stdout.write('done')"], { timeoutMs: 10_000 });
    expect(result).toEqual({ status: 0, stdout: "done", stderr: "", timedOut: false, cancelled: false, cleanupUncertain: false, survivorsKilled: false, cleanupScope: "original-process-group" });
    expect(probes).toHaveLength(1);
  });

  it.each([["alive"], ["ambiguous"]])("normal exit, group still %s at the bound -> cleanupUncertain (exit status kept)", async (answer) => {
    const result = await runnerWith({ groupProbe: () => answer }).run([node, "-e", "process.stdout.write('x')"], { timeoutMs: 10_000 });
    expect(result).toMatchObject({ status: 0, stdout: "x", cleanupUncertain: true, cleanupScope: "original-process-group" });
  });
});

describe("escaped descendants are OUTSIDE the claim (new session/group, no inherited pipes)", () => {
  it("the result reports only the original group gone, with an explicit scope -- it does not claim every started process stopped", async () => {
    const leader =
      `const { spawn } = require("node:child_process");` +
      `const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });` +
      `process.stdout.write("GC:" + g.pid + "\\n"); process.exit(0);`;
    const result = await createProcRunner({ env: { PATH: "/usr/bin:/bin" }, killGraceMs: 300, closeBoundMs: 600 }).run([node, "-e", leader], { timeoutMs: 10_000 });
    const pid = grandchildPid(result.stdout);
    escaped.push(pid);
    expect(result).toMatchObject({ status: 0, cleanupUncertain: false, cleanupScope: "original-process-group" });
    expect(CLEANUP_SCOPE_NOTE).toMatch(/escaped descendants .* not tracked/);
    // Honest: the escapee is NOT covered by the claim (and is in fact still alive; afterEach kills it).
    expect(alive(pid)).toBe(true);
  });
});

describe("PID-reuse guard: never signal pid <= 1 / undefined, and stop signalling a group confirmed gone", () => {
  it.each([[undefined], [0], [1], [-5]])("signalGroup(pid %s) sends nothing", (pid) => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = { pid, kill: vi.fn(() => true) };
    try {
      expect(signalGroup(child as never, "SIGKILL")).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("after the group is confirmed gone (ESRCH), signalGroup is a no-op", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = { pid: 424242, kill: vi.fn(() => true) };
    try {
      markGroupGone(child as never);
      expect(signalGroup(child as never, "SIGKILL")).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("killAttached() never signals a finished client", async () => {
    const runner = createProcRunner({ env: { PATH: "/usr/bin:/bin" } });
    await runner.runAttached([node, "-e", "0"], { timeoutMs: 10_000, stdoutCap: 1024, stderrCap: 1024 });
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(runner.killAttached()).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
