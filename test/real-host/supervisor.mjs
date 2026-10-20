// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/supervisor.mjs
// Local modifications (see test/PROVENANCE.md): none.
// Owned process supervision for real-host runs.
//
// Ownership is explicit: every process the harness starts gets its own new
// process group (detached spawn, pgid === leader pid), and only groups this
// supervisor created are ever signaled. No process-table snapshot (ps, pgrep,
// pkill) is used to decide what to kill. Shutdown sends TERM to the group,
// waits a bounded time, then sends KILL to the same group only.
//
// A descendant that calls setsid()/setpgid() leaves its owned group. It is
// never signaled (it is not owned), but it can still hold the fixture: the
// root-retention gate keeps the fixture root while any process from the
// creation lineage is alive. Lineage authority is explicit: every pid this
// supervisor spawned plus pids recorded by harness fixture commands. Liveness
// is tri-state (pidLiveness); "unknown" retains the root. Coverage boundary
// (UNVERIFIED): a descendant that escapes WITHOUT recording itself is outside
// the gate's lineage; no claim is made that such processes are gone.
import { spawn } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** true when any process remains in the group; "unsafe" when it cannot be probed (EPERM). */
export function groupState(pgid) {
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (error) {
    if (error && error.code === "ESRCH") return "gone";
    return "unsafe";
  }
}

/** Pids recorded as `<pid>.pid` files by harness fixture commands. */
export async function readLineagePids(dir) {
  const names = await readdir(dir);
  const pids = [];
  for (const name of names.filter((entry) => entry.endsWith(".pid")).sort()) {
    const text = (await readFile(join(dir, name), "utf8")).trim();
    if (!/^\d+$/.test(text)) throw new Error(`malformed lineage record ${name}`);
    pids.push(Number(text));
  }
  return pids;
}

/**
 * Signal-0 liveness probe: "dead" only on ESRCH; "alive" on success or EPERM
 * (exists, not ours to signal); "unknown" on any other error. Callers treat
 * "unknown" like "alive" for retention and never as permission to delete.
 */
export function pidLiveness(pid, kill = (target, signal) => process.kill(target, signal)) {
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code === "EPERM") return "alive";
    return "unknown";
  }
}

export function createSupervisor({ graceMs = 3000, killWaitMs = 3000, pollMs = 25, kill = (target, signal) => process.kill(target, signal) } = {}) {
  const owned = new Map();
  const spawned = new Set();
  // Stops are idempotent and serialized per group: a concurrent stop shares
  // the in-flight promise, and a group this supervisor owned that is already
  // finished returns its recorded result without being signaled again (its
  // pgid may have been reused). Only never-owned pgids are refused.
  const everOwned = new Set();
  const inFlight = new Map();
  const finished = new Map();

  // Darwin reports EPERM for a group whose only members are unreaped zombies,
  // so "unsafe" is polled like "alive" until the deadline.
  async function waitGone(pgid, budgetMs) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const state = groupState(pgid);
      if (state === "gone" || Date.now() >= deadline) return state;
      await sleep(pollMs);
    }
  }

  function signalGroup(pgid, signal) {
    try {
      process.kill(-pgid, signal);
      return true;
    } catch {
      return false;
    }
  }

  return {
    /** Spawns a process as the leader of a new owned group. Rejects (and owns nothing) if it fails to start. */
    spawnOwned(command, args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, detached: true });
        const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
        child.once("error", (error) => reject(error));
        child.once("spawn", () => {
          const pgid = child.pid;
          owned.set(pgid, { pgid, command });
          everOwned.add(pgid);
          spawned.add(child.pid);
          resolve({ pid: child.pid, pgid, child, exited });
        });
      });
    },

    /** Owned groups that still contain at least one process. */
    ownedAlive() {
      const result = [];
      for (const pgid of owned.keys()) {
        if (groupState(pgid) === "gone") {
          owned.delete(pgid);
          if (!finished.has(pgid)) finished.set(pgid, { pgid, termSent: false, killSent: false, aliveAfter: false, unsafe: false, alreadyGone: true });
        }
        else result.push(pgid);
      }
      return result;
    },

    stopGroup(pgid) {
      if (inFlight.has(pgid)) return inFlight.get(pgid);
      if (!owned.has(pgid)) {
        if (everOwned.has(pgid)) {
          return Promise.resolve(finished.get(pgid) ?? { pgid, termSent: false, killSent: false, aliveAfter: false, unsafe: false, alreadyGone: true });
        }
        return Promise.reject(new Error(`refusing to signal process group ${pgid}: not owned by this supervisor`));
      }
      const stopping = (async () => {
        const result = { pgid, termSent: false, killSent: false, aliveAfter: false, unsafe: false };
        let state = groupState(pgid);
        if (state !== "gone") {
          result.termSent = signalGroup(pgid, "SIGTERM");
          state = await waitGone(pgid, graceMs);
        }
        if (state !== "gone") {
          result.killSent = signalGroup(pgid, "SIGKILL");
          state = await waitGone(pgid, killWaitMs);
        }
        result.unsafe = state === "unsafe";
        result.aliveAfter = state !== "gone";
        if (state === "gone") {
          owned.delete(pgid);
          finished.set(pgid, result);
        }
        return result;
      })().finally(() => inFlight.delete(pgid));
      inFlight.set(pgid, stopping);
      return stopping;
    },

    async stopAll() {
      const results = [];
      for (const pgid of [...owned.keys()]) results.push(await this.stopGroup(pgid));
      return results;
    },

    /** Every pid this supervisor has spawned (lineage authority). */
    spawnedPids() {
      return [...spawned];
    },

    /**
     * Removes `root` only when no owned group is alive AND no lineage process
     * (spawned leaders plus recorded fixture pids) is alive. If the lineage
     * cannot be read, the root is retained. Nothing is signaled here.
     */
    async removeRootIfSafe(root, { lineagePids = async () => [] } = {}) {
      const alive = this.ownedAlive();
      if (alive.length > 0) throw new Error(`refusing to remove ${root}: owned process group(s) still alive: ${alive.join(", ")}`);
      let recorded;
      try {
        recorded = await lineagePids();
      } catch (error) {
        throw new Error(`retaining ${root}: lineage unreadable (${error instanceof Error ? error.message : String(error)})`);
      }
      const lineage = [...new Set([...spawned, ...recorded])].map((pid) => [pid, pidLiveness(pid, kill)]);
      const unknown = lineage.filter(([, state]) => state === "unknown").map(([pid]) => pid);
      const living = lineage.filter(([, state]) => state === "alive").map(([pid]) => pid);
      if (unknown.length > 0) throw new Error(`retaining ${root}: liveness unknown for ${unknown.join(", ")}`);
      if (living.length > 0) throw new Error(`retaining ${root}: lineage process(es) alive: ${living.join(", ")}`);
      await rm(root, { recursive: true, force: true });
    },
  };
}
