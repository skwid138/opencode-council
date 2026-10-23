// Council-only. Shell-free child process runner used by run.mjs for docker and
// curl (only after gate approval). Unit tests exercise it with `node -e` only.
//
// Every child is spawned `detached` (its own process group) and every termination
// signals the GROUP (process.kill(-pid)): timeout, cap violation, cancellation,
// escalation, and killAttached().
//
// runAttached: captures stdout/stderr through pipes up to their caps; exceeding a cap or
// the deadline group-SIGKILLs the client. It resolves on "close" (all stdio EOF + exit),
// so callers never act on a container before the attached client is gone -- except that
// after a group SIGKILL the wait for "close" is BOUNDED (`closeBoundMs`): if the pipes are
// still held (a descendant that left the group), the streams are destroyed and the result
// says `cleanupUncertain: true` instead of hanging.
// Operator termination: an aborted `signal` group-SIGKILLs the client (`cancelled: true`),
// and killAttached() group-SIGKILLs every in-flight ATTACHED client (used by the signal
// handlers in run.mjs). Bounded cleanup commands started with run() (docker rm -f / ps)
// run in their own groups and are left alone.
// run() honors its own `signal`: on abort the group gets SIGTERM, then SIGKILL after a
// bounded grace (`killGraceMs`), and the result is { status: null, cancelled: true }.
// After EVERY leader close (normal or after a cancel / timeout / cap) the leader closing is NOT
// proof: the original group is probed (signal 0); alive -> group SIGTERM (normal close), the
// remaining grace, group SIGKILL, poll within `closeBoundMs`; only ESRCH reports clean (with
// `survivorsKilled` when something had to be killed), otherwise `cleanupUncertain: true`.
// Every result carries `cleanupScope: "original-process-group"`: escaped descendants are not
// covered (CLEANUP_SCOPE_NOTE).
// An already-aborted signal never launches anything (`launched: false`).
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export const TRIPWIRE_ENV = "COUNCIL_RH_FORBID_SPAWN";

function launch(argv, env, cwd, guardEnv) {
  // Test tripwire: CLI tests set this in the CLI's own environment so any path that
  // would reach a real spawn fails loudly instead (distinct from the intended refusals).
  if (guardEnv?.[TRIPWIRE_ENV] === "1") throw new Error(`TRIPWIRE: spawn refused (${TRIPWIRE_ENV}): ${argv?.[0]}`);
  if (!Array.isArray(argv) || typeof argv[0] !== "string" || !isAbsolute(argv[0])) throw new Error("command path must be absolute");
  if (cwd !== undefined && !isAbsolute(cwd)) throw new Error("cwd must be absolute");
  // detached: the child leads its OWN process group, so every kill below reaches its
  // descendants too (process.kill(-pid)). Never unref'd: we always wait for it.
  return spawn(argv[0], argv.slice(1), { env, cwd, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: true });
}

const GONE = Symbol("council-rh.groupGone");

/** Records that the child's group was confirmed gone (ESRCH): it is never signalled again. */
export function markGroupGone(child) {
  child[GONE] = true;
}

/**
 * Signals the child's whole process group. Never signals when the pid is undefined or <= 1,
 * or once the group was confirmed gone (ESRCH) -- which narrows, but cannot close, the
 * PID-reuse window (a residual documented in test/PROVENANCE.md).
 */
export function signalGroup(child, sig) {
  if (!Number.isInteger(child?.pid) || child.pid <= 1 || child[GONE]) return false;
  try {
    process.kill(-child.pid, sig);
    return true;
  } catch {
    try {
      return child.kill(sig);
    } catch {
      return false;
    }
  }
}

/** "alive" | "gone" | "ambiguous" for a process group (signal 0 probe; only ESRCH proves it gone). */
export function probeGroup(pgid) {
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (error) {
    return error?.code === "ESRCH" ? "gone" : "ambiguous";
  }
}

/**
 * The scope of every "clean" claim this runner makes: the ORIGINAL process group (leader +
 * every descendant still in its group) is confirmed gone (ESRCH). A descendant that left the
 * group (setsid / new process group) without holding our pipes is NOT tracked -- portable
 * process-tree tracking is not available on macOS -- so no result claims that every started
 * process stopped.
 */
export const CLEANUP_SCOPE = "original-process-group";
export const CLEANUP_SCOPE_NOTE = "only the original process group is verified gone (ESRCH); escaped descendants (new session / process group, no inherited pipes) are not tracked";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 25;

function collect(child, { timeoutMs, stdoutCap = Infinity, stderrCap = Infinity, signal, abortGraceMs = null, closeBoundMs, groupProbe = probeGroup, survivorGraceMs }) {
  return new Promise((resolve, reject) => {
    const out = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0 };
    let timedOut = false;
    let cancelled = false;
    let capExceeded = null;
    let settled = false;
    let exit = { code: null, signal: null };
    let graceTimer = null;
    let boundTimer = null;
    let terminationRequested = false;
    let graceDeadline = 0;
    const finish = (code, exitSignal, cleanupUncertain, survivorsKilled = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(boundTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal: exitSignal, stdout: Buffer.concat(out.stdout).toString("utf8"), stderr: Buffer.concat(out.stderr).toString("utf8"), timedOut, capExceeded, cancelled, cleanupUncertain, survivorsKilled });
    };
    /** Group SIGKILL, then a bounded wait for "close": pipes still held (e.g. a descendant that left the group) -> destroy the streams and settle with cleanupUncertain. */
    const kill = () => {
      terminationRequested = true;
      signalGroup(child, "SIGKILL");
      if (boundTimer || settled) return;
      boundTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exit.code, exit.signal ?? "SIGKILL", true);
      }, closeBoundMs);
    };
    const take = (stream, key, cap) => (chunk) => {
      if (capExceeded) return;
      const bytes = `${key}Bytes`;
      if (out[bytes] + chunk.length > cap) {
        out[key].push(chunk.subarray(0, Math.max(0, cap - out[bytes])));
        out[bytes] = cap;
        capExceeded = key;
        kill();
        return;
      }
      out[key].push(chunk);
      out[bytes] += chunk.length;
    };
    child.stdout.on("data", take("stdout", "stdout", stdoutCap));
    child.stderr.on("data", take("stderr", "stderr", stderrCap));
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      terminationRequested = true;
      if (abortGraceMs === null) return kill();
      // Non-attached commands: SIGTERM to the group first, group SIGKILL after a bounded grace.
      signalGroup(child, "SIGTERM");
      graceDeadline = Date.now() + abortGraceMs;
      graceTimer = setTimeout(kill, abortGraceMs);
    };
    /**
     * After EVERY leader close (normal or after a termination request) the original group is
     * probed; only ESRCH is clean. Survivors: a normal close sends group SIGTERM now (a
     * termination request already did), the remaining grace is honored, then group SIGKILL and
     * polling within the bound. Still alive or ambiguous at the bound -> cleanupUncertain.
     * Returns { uncertain, survivorsKilled }.
     */
    const settleGroup = async () => {
      const probe = () => {
        const answer = groupProbe(child.pid);
        if (answer === "gone") markGroupGone(child);
        return answer;
      };
      if (probe() === "gone") return { uncertain: false, survivorsKilled: false };
      if (!terminationRequested) {
        signalGroup(child, "SIGTERM");
        graceDeadline = Date.now() + survivorGraceMs;
      }
      while (Date.now() < graceDeadline) {
        await sleep(POLL_MS);
        if (probe() === "gone") return { uncertain: false, survivorsKilled: true };
      }
      if (probe() === "gone") return { uncertain: false, survivorsKilled: true };
      signalGroup(child, "SIGKILL");
      const deadline = Date.now() + closeBoundMs;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        if (probe() === "gone") return { uncertain: false, survivorsKilled: true };
      }
      return { uncertain: true, survivorsKilled: false };
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("exit", (code, exitSignal) => {
      exit = { code, signal: exitSignal };
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(boundTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      // A leader close is never proof by itself (normal exit or not): probe the original group.
      // Escalation and the pipe bound are superseded by the group settlement below.
      clearTimeout(graceTimer);
      clearTimeout(boundTimer);
      settleGroup().then(({ uncertain, survivorsKilled }) => finish(code, exitSignal, uncertain, survivorsKilled), () => finish(code, exitSignal, true));
    });
  });
}

export const DEFAULT_KILL_GRACE_MS = 5_000;

/** After a group SIGKILL, how long to wait for "close" before destroying the pipes. */
export const DEFAULT_CLOSE_BOUND_MS = 5_000;

export function createProcRunner({ env, guardEnv = process.env, killGraceMs = DEFAULT_KILL_GRACE_MS, closeBoundMs = DEFAULT_CLOSE_BOUND_MS, groupProbe = probeGroup }) {
  const attached = new Set();
  const track = async (child, options, set) => {
    set?.add(child);
    try {
      return await collect(child, options);
    } finally {
      set?.delete(child);
    }
  };
  return {
    async runAttached(argv, { timeoutMs, stdoutCap, stderrCap, signal }) {
      if (signal?.aborted) return { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, capExceeded: null, cancelled: true, launched: false };
      const result = await track(launch(argv, env, undefined, guardEnv), { timeoutMs, stdoutCap, stderrCap, signal, closeBoundMs, groupProbe, survivorGraceMs: killGraceMs }, attached);
      return { exitCode: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, capExceeded: result.capExceeded, cancelled: result.cancelled, cleanupUncertain: result.cleanupUncertain, survivorsKilled: result.survivorsKilled, cleanupScope: CLEANUP_SCOPE };
    },
    async run(argv, { timeoutMs, env: override, cwd, signal }) {
      if (signal?.aborted) return { status: null, stdout: "", stderr: "", timedOut: false, cancelled: true, launched: false };
      const result = await track(launch(argv, override ?? env, cwd, guardEnv), { timeoutMs, stdoutCap: 4 * 1024 * 1024, stderrCap: 256 * 1024, signal, abortGraceMs: killGraceMs, closeBoundMs, groupProbe, survivorGraceMs: killGraceMs }, null);
      const claim = { cleanupUncertain: result.cleanupUncertain, survivorsKilled: result.survivorsKilled, cleanupScope: CLEANUP_SCOPE };
      if (result.cancelled) return { status: null, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, cancelled: true, signal: result.signal, ...claim };
      // The exit status is the leader's own (a survivor cleanup never changes it); an unsettled
      // timeout keeps the old null status.
      return { status: result.timedOut ? null : result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, cancelled: false, ...claim };
    },
    /** Group-SIGKILLs every in-flight attached client; returns how many were signalled. */
    killAttached() {
      let count = 0;
      for (const child of attached) if (signalGroup(child, "SIGKILL")) count += 1;
      return count;
    },
  };
}
