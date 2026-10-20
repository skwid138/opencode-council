// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/supervisor.test.ts
// Local modifications (see test/PROVENANCE.md): none.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSupervisor, pidLiveness, readLineagePids } from "./supervisor.mjs";

// Every process these tests start is a bounded Node fixture that the test
// owns. afterEach SIGKILLs any pid a test recorded, so a failing assertion
// never leaks a process.
const leftovers = new Set<number>();
afterEach(() => {
  for (const pid of leftovers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  leftovers.clear();
});

const node = process.execPath;
const LIFETIME = "setTimeout(() => {}, 20000)";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`no line; got ${buffer}`)), 5000);
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(buffer.slice(0, newline));
      }
    });
  });
}

describe("process supervisor", () => {
  it("reports a startup failure without registering any owned group", async () => {
    const supervisor = createSupervisor();
    await expect(supervisor.spawnOwned("/nonexistent/real-host-binary", [], { stdio: "ignore" })).rejects.toThrow(/ENOENT/);
    expect(supervisor.ownedAlive()).toEqual([]);
  });

  it("stops a cooperative process with TERM only", async () => {
    const supervisor = createSupervisor({ graceMs: 2000 });
    const owned = await supervisor.spawnOwned(node, ["-e", LIFETIME], { stdio: "ignore" });
    leftovers.add(owned.pid);

    const result = await supervisor.stopGroup(owned.pgid);

    expect(result).toMatchObject({ pgid: owned.pgid, termSent: true, killSent: false, aliveAfter: false });
    expect(alive(owned.pid)).toBe(false);
  });

  it("escalates to KILL for a process that ignores TERM", async () => {
    const supervisor = createSupervisor({ graceMs: 300 });
    const owned = await supervisor.spawnOwned(node, ["-e", `process.on('SIGTERM', () => {}); console.log('ready'); ${LIFETIME}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    leftovers.add(owned.pid);
    await firstLine(owned.child.stdout!);

    const result = await supervisor.stopGroup(owned.pgid);

    expect(result).toMatchObject({ termSent: true, killSent: true, aliveAfter: false });
    expect(alive(owned.pid)).toBe(false);
  });

  it("stops a descendant that outlives its group leader", async () => {
    const supervisor = createSupervisor({ graceMs: 1000 });
    const leaderScript = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); ${LIFETIME}`)}], { stdio: 'ignore' });
      console.log(child.pid);
      child.unref();
      setTimeout(() => process.exit(0), 100);
    `;
    const owned = await supervisor.spawnOwned(node, ["-e", leaderScript], { stdio: ["ignore", "pipe", "ignore"] });
    const descendant = Number(await firstLine(owned.child.stdout!));
    leftovers.add(descendant);
    await owned.exited;
    expect(alive(descendant)).toBe(true);
    expect(supervisor.ownedAlive()).toEqual([owned.pgid]);

    const results = await supervisor.stopAll();

    expect(results).toEqual([expect.objectContaining({ pgid: owned.pgid, aliveAfter: false })]);
    expect(alive(descendant)).toBe(false);
    expect(supervisor.ownedAlive()).toEqual([]);
  });

  it("never signals an unrelated process", async () => {
    const supervisor = createSupervisor({ graceMs: 300 });
    const unrelated = spawn(node, ["-e", LIFETIME], { detached: true, stdio: "ignore" });
    leftovers.add(unrelated.pid!);
    const owned = await supervisor.spawnOwned(node, ["-e", LIFETIME], { stdio: "ignore" });
    leftovers.add(owned.pid);

    await supervisor.stopAll();

    expect(alive(owned.pid)).toBe(false);
    expect(alive(unrelated.pid!)).toBe(true);
  });

  it("refuses to remove a root while an owned process is alive, and removes it after stopping", async () => {
    const supervisor = createSupervisor({ graceMs: 1000 });
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-sup-")));
    const parent = join(root, "..");
    try {
      const owned = await supervisor.spawnOwned(node, ["-e", LIFETIME], { stdio: "ignore" });
      leftovers.add(owned.pid);

      await expect(supervisor.removeRootIfSafe(root)).rejects.toThrow(/owned process group/);
      expect((await readdir(parent)).includes(root.split("/").pop()!)).toBe(true);

      await supervisor.stopAll();
      await supervisor.removeRootIfSafe(root);
      expect((await readdir(parent)).includes(root.split("/").pop()!)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains the root while a lineage-recorded descendant that escaped its group (setsid) is alive, without signaling it", async () => {
    const supervisor = createSupervisor({ graceMs: 500 });
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-sup-")));
    const lineage = join(root, "lineage");
    await mkdir(lineage);
    try {
      // Leader starts a grandchild in a NEW session (detached => setsid), which
      // records its own pid in the lineage dir and keeps running.
      const leaderScript = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(
          `require('node:fs').writeFileSync(${JSON.stringify(lineage)} + '/' + process.pid + '.pid', String(process.pid)); console.log('ok'); ${LIFETIME}`,
        )}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.once('data', () => { console.log(child.pid); process.exit(0); });
      `;
      const owned = await supervisor.spawnOwned(node, ["-e", leaderScript], { stdio: ["ignore", "pipe", "ignore"] });
      const escaped = Number(await firstLine(owned.child.stdout!));
      leftovers.add(escaped);
      await owned.exited;

      const stopped = await supervisor.stopAll();
      expect(stopped.every((entry: { aliveAfter: boolean }) => !entry.aliveAfter)).toBe(true);
      expect(alive(escaped)).toBe(true); // escaped the owned group; supervisor never signaled it
      expect(await readLineagePids(lineage)).toEqual([escaped]);

      await expect(supervisor.removeRootIfSafe(root, { lineagePids: () => readLineagePids(lineage) })).rejects.toThrow(new RegExp(`retaining .*lineage process\\(es\\) alive: ${escaped}`));
      expect((await readdir(root)).includes("lineage")).toBe(true);
      expect(alive(escaped)).toBe(true);

      process.kill(escaped, "SIGKILL");
      for (let i = 0; i < 100 && alive(escaped); i += 1) await new Promise((r) => setTimeout(r, 20));
      await supervisor.removeRootIfSafe(root, { lineagePids: () => readLineagePids(lineage) });
      await expect(readdir(root)).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats every pid it spawned as lineage, and an unreadable lineage source as a reason to retain the root", async () => {
    const supervisor = createSupervisor({ graceMs: 500 });
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-sup-")));
    try {
      const owned = await supervisor.spawnOwned(node, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await owned.exited;
      expect(supervisor.spawnedPids()).toEqual([owned.pid]);
      await expect(supervisor.removeRootIfSafe(root, { lineagePids: async () => { throw new Error("EIO"); } })).rejects.toThrow(/lineage unreadable/);
      await supervisor.removeRootIfSafe(root, { lineagePids: async () => [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies liveness as dead only on ESRCH, alive on success or EPERM, and unknown on any other error", () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(pidLiveness(1, fail("ESRCH"))).toBe("dead");
    expect(pidLiveness(1, fail("EPERM"))).toBe("alive");
    expect(pidLiveness(1, () => true)).toBe("alive");
    for (const code of ["EINVAL", "EIO", "UNKNOWN"]) expect(pidLiveness(1, fail(code)), code).toBe("unknown");
  });

  it("retains the root when a lineage pid's liveness is unknown, and never signals it", async () => {
    const signals: Array<[number, unknown]> = [];
    const kill = (pid: number, signal: unknown) => {
      signals.push([pid, signal]);
      throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
    };
    const supervisor = createSupervisor({ kill });
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-sup-")));
    try {
      await expect(supervisor.removeRootIfSafe(root, { lineagePids: async () => [424242] })).rejects.toThrow(/retaining .*liveness unknown for 424242/);
      await expect(readdir(root)).resolves.toEqual([]);
      expect(signals).toEqual([[424242, 0]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the root when every lineage pid is genuinely gone (ESRCH)", async () => {
    const supervisor = createSupervisor({ kill: () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); } });
    const root = await realpath(await mkdtemp(join(tmpdir(), "rh-sup-")));
    await supervisor.removeRootIfSafe(root, { lineagePids: async () => [424242] });
    await expect(readdir(root)).rejects.toThrow(/ENOENT/);
  });

  it("overlapping stopAll calls (signal handler + normal teardown) settle without throwing and stop every owned group once", async () => {
    const supervisor = createSupervisor({ graceMs: 1000 });
    const a = await supervisor.spawnOwned(node, ["-e", LIFETIME], { stdio: "ignore" });
    const b = await supervisor.spawnOwned(node, ["-e", LIFETIME], { stdio: "ignore" });
    leftovers.add(a.pid);
    leftovers.add(b.pid);

    const results = await Promise.allSettled([supervisor.stopAll(), supervisor.stopAll(), supervisor.stopGroup(a.pgid)]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(alive(a.pid) || alive(b.pid)).toBe(false);
    expect(supervisor.ownedAlive()).toEqual([]);
    const all = results.flatMap((result) => (result.status === "fulfilled" ? [result.value].flat() : []));
    expect(all.every((entry: { aliveAfter: boolean }) => entry.aliveAfter === false)).toBe(true);
  });

  it("deterministic interleaving: a group that exits on its own while another stop is in flight is not a 'not owned' error", async () => {
    const supervisor = createSupervisor({ graceMs: 300 });
    const stubborn = await supervisor.spawnOwned(node, ["-e", `process.on('SIGTERM', () => {}); console.log('ready'); ${LIFETIME}`], { stdio: ["ignore", "pipe", "ignore"] });
    leftovers.add(stubborn.pid);
    await firstLine(stubborn.child.stdout!);
    const quick = await supervisor.spawnOwned(node, ["-e", "setTimeout(() => process.exit(0), 50)"], { stdio: "ignore" });
    leftovers.add(quick.pid);

    const results = await Promise.allSettled([supervisor.stopAll(), supervisor.stopAll()]);

    expect(results.map((result) => (result.status === "rejected" ? String(result.reason) : "fulfilled"))).toEqual(["fulfilled", "fulfilled"]);
    expect(alive(stubborn.pid)).toBe(false);
    expect(supervisor.ownedAlive()).toEqual([]);
  });

  it("still refuses to signal a pgid it never owned", async () => {
    await expect(createSupervisor().stopGroup(1)).rejects.toThrow(/not owned/);
  });

  it("a stop after a completed stop returns the recorded result and signals nothing again (pgid may be reused)", async () => {
    const supervisor = createSupervisor({ graceMs: 1000 });
    const owned = await supervisor.spawnOwned(node, ["-e", LIFETIME], { stdio: "ignore" });
    leftovers.add(owned.pid);
    const [first] = await supervisor.stopAll();
    await expect(supervisor.stopGroup(owned.pgid)).resolves.toEqual(first);
    await expect(supervisor.stopAll()).resolves.toEqual([]);
  });
});
