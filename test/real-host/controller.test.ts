import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { expectedCells, probeCell, SPIKE_CELLS } from "./cells.mjs";
import { allowlistFor, runBatch } from "./controller.mjs";
import { createProcRunner } from "./proc-runner.mjs";
import { encodeFrame } from "./frame.mjs";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-ctl-")));
  created.push(dir);
  return dir;
}

const IMAGES = { "v1-1.18.29": "sha256:" + "1".repeat(64), "v1-1.19.3": "sha256:" + "2".repeat(64), "v2-2.0.28": "sha256:" + "3".repeat(64), "v2-2.0.32": "sha256:" + "4".repeat(64) };
const frame = (cellId: string, verdict = "PASS") => encodeFrame({ schema: "council-rh-result/1", cellId, verdict, checks: [{ id: "x", ok: verdict === "PASS", detail: "" }], host: { id: cellId.split(":")[0], executableSha256: "a".repeat(64) }, durationMs: 1 });

type Outcome = { stdout?: string; stderr?: string; exitCode?: number | null; timedOut?: boolean; capExceeded?: string | null; cancelled?: boolean; cleanupUncertain?: boolean };

/** Fake docker runner. `outcomes(cellId)` decides the attached run; rm/absence answers are configurable. Records an ordered event log. */
const timeouts: [string, number][] = [];
function fakeDocker({ outcomes = (id: string): Outcome => ({ stdout: frame(id) }), rm = () => ({ status: 0, stdout: "", stderr: "", timedOut: false }), absence = () => ({ status: 0, stdout: "", stderr: "", timedOut: false }) }: Record<string, unknown> = {}) {
  const log: string[] = [];
  const runner = {
    async runAttached(argv: string[], options: { timeoutMs: number; stdoutCap: number; stderrCap: number; signal?: AbortSignal }) {
      const cellId = argv.at(-1) as string;
      const cid = argv[argv.indexOf("--cidfile") + 1];
      // Per-scenario controller deadline (S4 budget option B): 270 s for S4, 210 s otherwise.
      expect(options).toMatchObject({ timeoutMs: cellId.split(":")[1] === "s4" ? 270_000 : 210_000, stdoutCap: 1_048_576, stderrCap: 262_144 });
      timeouts.push([cellId, options.timeoutMs]);
      log.push(`run-start ${cellId}`);
      await writeFile(cid, `cid-${cellId}`);
      const outcome = await (outcomes as (id: string, signal?: AbortSignal) => Outcome | Promise<Outcome>)(cellId, options.signal);
      log.push(`run-settled ${cellId}`);
      return { exitCode: outcome.exitCode ?? 0, signal: null, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "", timedOut: outcome.timedOut ?? false, capExceeded: outcome.capExceeded ?? null, cancelled: (outcome as { cancelled?: boolean }).cancelled ?? false, cleanupUncertain: (outcome as { cleanupUncertain?: boolean }).cleanupUncertain ?? false };
    },
    async run(argv: string[], options: { timeoutMs: number }) {
      if (argv[1] === "rm") {
        expect(options.timeoutMs).toBe(30_000);
        log.push(`rm ${argv[3]}`);
        return (rm as (id: string) => unknown)(argv[3]);
      }
      if (argv[1] === "ps") {
        expect(options.timeoutMs).toBe(15_000);
        log.push(`absent? ${argv[argv.indexOf("--filter") + 1]}`);
        return (absence as () => unknown)();
      }
      throw new Error(`unexpected docker call ${argv.join(" ")}`);
    },
  };
  return { runner, log };
}

async function batch(overrides: Record<string, unknown> = {}) {
  const sessionDir = await scratch();
  const { fake, ...rest } = overrides as { fake?: Record<string, unknown> };
  const docker = fakeDocker(fake);
  const result = await runBatch({ runKind: "spike", runId: "r1", archiveSha256: "b".repeat(64), images: IMAGES, cells: [...SPIKE_CELLS], docker: "/usr/local/bin/docker", sessionDir, runner: docker.runner, ...rest });
  return { ...result, log: docker.log, sessionDir };
}

describe("controller allowlists", () => {
  it("derives the allowlist from the run kind", () => {
    expect([...allowlistFor("spike")]).toEqual(SPIKE_CELLS);
    expect(allowlistFor("qualification").size).toBe(94);
    expect([...allowlistFor("probe")]).toEqual(["v1-1.18.29", "v1-1.19.3", "v2-2.0.28", "v2-2.0.32"].map((host) => probeCell(host).id));
    expect(() => allowlistFor("other")).toThrow(/run kind/);
  });

  it("rejects an unknown or duplicate cell before any docker call", async () => {
    const unknown = await batch({ cells: ["v2-2.0.32:s1:1", "v2-2.0.32:s9:1"] });
    expect(unknown.status).toBe("stopped");
    expect(unknown.stoppedAt).toMatchObject({ cellId: "v2-2.0.32:s9:1", reason: expect.stringContaining("not in the allowlist") });
    expect(unknown.log.filter((entry) => entry.startsWith("run-start"))).toEqual(["run-start v2-2.0.32:s1:1"]);
    const duplicate = await batch({ cells: ["v2-2.0.32:s1:1", "v2-2.0.32:s1:1"] });
    expect(duplicate.stoppedAt.reason).toMatch(/duplicate cell id/);
    expect(duplicate.log.filter((entry) => entry.startsWith("run-start"))).toHaveLength(1);
  });
});

describe("V1 closure identity in cell reports (Amendment A2)", () => {
  it("copies the result's closure receipt id into the record and the receipt", async () => {
    const closure = { receiptId: "closure-r1-abcdef012345", lockfileSha256: "c".repeat(64), plugin: "@opencode-ai/plugin@1.19.3" };
    const v1Frame = (cellId: string) => encodeFrame({ schema: "council-rh-result/1", cellId, verdict: "PASS", checks: [{ id: "x", ok: true, detail: "" }], host: { id: cellId.split(":")[0], executableSha256: "a".repeat(64) }, durationMs: 1, closure });
    const result = await batch({ cells: ["v1-1.19.3:s1:1"], runKind: "spike", fake: { outcomes: (id: string) => ({ stdout: v1Frame(id) }) } });
    expect(result.results[0].closure).toEqual(closure);
    expect(result.receipts[0].closureReceiptId).toBe("closure-r1-abcdef012345");
  });
});

describe("bounded evidence is persisted in the receipt", () => {
  it("a PASS receipt carries the result frame's summary.evidence; a cell without evidence records null", async () => {
    const evidence = { sessions: [{ id: "P", parentID: null }], requests: [{ seq: 1, sessionID: "P", model: "parent", tools: ["council_review"] }], observations: { "v2.agentsRoute": { status: 200 } } };
    const withEvidence = (cellId: string) => encodeFrame({ schema: "council-rh-result/1", cellId, verdict: "PASS", checks: [{ id: "x", ok: true, detail: "" }], host: { id: cellId.split(":")[0], executableSha256: "a".repeat(64) }, durationMs: 1, summary: { evidence } });
    const result = await batch({ cells: ["v2-2.0.32:s1:1"], fake: { outcomes: (id: string) => ({ stdout: withEvidence(id) }) } });
    expect(result.receipts[0]).toMatchObject({ verdict: "PASS", cleanupConfirmed: true, evidence });
    const bare = await batch({ cells: ["v2-2.0.32:s1:1"] });
    expect(bare.receipts[0].evidence).toBeNull();
  });
});

describe("controller per-cell protocol", () => {
  it("runs each spike cell attached, removes the exact container only after the run settled, verifies absence, and writes a receipt", async () => {
    const result = await batch();
    expect(result.status).toBe("completed");
    expect(result.receipts.map((receipt: { cellId: string; runKind: string; imageId: string }) => [receipt.cellId, receipt.runKind, receipt.imageId])).toEqual(SPIKE_CELLS.map((id) => [id, "spike", IMAGES[id.split(":")[0] as keyof typeof IMAGES]]));
    expect(result.log.slice(0, 4)).toEqual(["run-start v2-2.0.32:s1:1", "run-settled v2-2.0.32:s1:1", "rm cid-v2-2.0.32:s1:1", "absent? id=cid-v2-2.0.32:s1:1"]);
    const files = await readdir(join(result.sessionDir, "results"));
    expect(files).toHaveLength(4);
    expect(JSON.parse(await readFile(join(result.sessionDir, "results", files[0]), "utf8")).verdict).toBe("PASS");
  });

  it.each([
    ["a FAIL verdict", { outcomes: (id: string) => ({ stdout: frame(id, "FAIL") }) }, /verdict FAIL/],
    ["a timeout even with a valid partial frame", { outcomes: (id: string) => ({ stdout: frame(id), timedOut: true }) }, /timed out/],
    ["stdout over the cap", { outcomes: (id: string) => ({ stdout: frame(id), capExceeded: "stdout" }) }, /stdout cap/],
    ["a missing frame", { outcomes: () => ({ stdout: "" }) }, /missing result frame/],
    ["a duplicate frame", { outcomes: (id: string) => ({ stdout: frame(id) + frame(id) }) }, /exactly one result frame/],
    ["a corrupt frame", { outcomes: (id: string) => ({ stdout: frame(id).replace(/ [0-9a-f]{64}\n$/, ` ${"0".repeat(64)}\n`) }) }, /digest mismatch/],
    ["a frame for another cell", { outcomes: () => ({ stdout: frame("v2-2.0.32:s2:1") }) }, /cell id mismatch/],
    ["a non-zero container exit", { outcomes: (id: string) => ({ stdout: frame(id), exitCode: 3 }) }, /exit code 3/],
  ])("FAILs and stops on %s, still removing that container", async (_label, fake, reason) => {
    const result = await batch({ fake });
    expect(result.status).toBe("stopped");
    expect(result.stoppedAt.cellId).toBe("v2-2.0.32:s1:1");
    expect(result.stoppedAt.reason).toMatch(reason);
    expect(result.log).toEqual(["run-start v2-2.0.32:s1:1", "run-settled v2-2.0.32:s1:1", "rm cid-v2-2.0.32:s1:1", "absent? id=cid-v2-2.0.32:s1:1"]);
    expect(result.receipts[0].verdict).toBe("FAIL");
  });

  it.each([
    ["an rm error", { rm: () => ({ status: 1, stdout: "", stderr: "no such container", timedOut: false }) }, /container removal failed/],
    ["an rm timeout", { rm: () => ({ status: null, stdout: "", stderr: "", timedOut: true }) }, /container removal failed/],
    ["a residual container", { absence: () => ({ status: 0, stdout: "cid\n", stderr: "", timedOut: false }) }, /still present/],
    ["an absence check timeout", { absence: () => ({ status: null, stdout: "", stderr: "", timedOut: true }) }, /absence not verified/],
  ])("stops on cleanup uncertainty: %s (even after a PASS)", async (_label, fake, reason) => {
    const result = await batch({ fake });
    expect(result.status).toBe("stopped");
    expect(result.stoppedAt.reason).toMatch(reason);
    expect(result.log.filter((entry) => entry.startsWith("run-start"))).toHaveLength(1);
  });

  it("stops on cleanup uncertainty for observational and probe cells too", async () => {
    const observational = await batch({ runKind: "qualification", cells: ["v1-1.18.29:obs-ask:1", "v1-1.18.29:s1:1"], fake: { rm: () => ({ status: 1, stdout: "", stderr: "", timedOut: false }) } });
    expect(observational.stoppedAt.cellId).toBe("v1-1.18.29:obs-ask:1");
    const probe = await batch({ runKind: "probe", cells: [probeCell("v2-2.0.32").id, probeCell("v1-1.19.3").id], fake: { absence: () => ({ status: 0, stdout: "x", stderr: "", timedOut: false }) } });
    expect(probe.stoppedAt.cellId).toBe("v2-2.0.32:probe:1");
  });

  it("does not stop on an observational cell's FAIL verdict, but does on its harness failure", async () => {
    const verdictFail = await batch({ runKind: "qualification", cells: ["v1-1.18.29:obs-ask:1", "v1-1.18.29:s1:1"], fake: { outcomes: (id: string) => ({ stdout: frame(id, id.includes("obs") ? "FAIL" : "PASS") }) } });
    expect(verdictFail.status).toBe("completed");
    const harnessFail = await batch({ runKind: "qualification", cells: ["v1-1.18.29:obs-ask:1", "v1-1.18.29:s1:1"], fake: { outcomes: () => ({ stdout: "" }) } });
    expect(harnessFail.status).toBe("stopped");
  });

  it.each(["driver.host-hash", "driver.deadline", "driver.frame-encode", "driver.cleanup-unconfirmed", "cell.cleanup", "cell.collect", "cell.launch"])("post-P1b audit (frame-2 MA4): an infrastructure check %s failing INSIDE a valid observational frame is a harness failure -> stop", async (checkId) => {
    const infra = (id: string) => encodeFrame({ schema: "council-rh-result/1", cellId: id, verdict: "FAIL", checks: [{ id: checkId, ok: false, detail: "x" }], host: { id: id.split(":")[0], executableSha256: "a".repeat(64) }, durationMs: 1 });
    const result = await batch({ runKind: "qualification", cells: ["v1-1.18.29:obs-ask:1", "v1-1.18.29:s1:1"], fake: { outcomes: (id: string) => ({ stdout: id.includes("obs") ? infra(id) : frame(id) }) } });
    expect(result.status).toBe("stopped");
    expect(result.stoppedAt).toMatchObject({ cellId: "v1-1.18.29:obs-ask:1" });
    expect(result.stoppedAt.reason).toBe(`infrastructure failure: ${checkId}`);
    expect(result.results[0]).toMatchObject({ verdict: "FAIL", reason: `infrastructure failure: ${checkId}` });
  });

  it("stops when the container id file is missing (removal impossible to target)", async () => {
    const sessionDir = await scratch();
    const runner = {
      runAttached: async () => ({ exitCode: 0, signal: null, stdout: frame("v2-2.0.32:s1:1"), stderr: "", timedOut: false, capExceeded: null }),
      run: async () => {
        throw new Error("must not run rm without an exact id");
      },
    };
    const result = await runBatch({ runKind: "spike", runId: "r1", archiveSha256: "b".repeat(64), images: IMAGES, cells: ["v2-2.0.32:s1:1"], docker: "/usr/local/bin/docker", sessionDir, runner });
    expect(result.stoppedAt.reason).toMatch(/container id unknown/);
  });

  it("refuses to reuse a cidfile or results path", async () => {
    const sessionDir = await scratch();
    await writeFile(join(sessionDir, "v2-2.0.32_s1_1.cid"), "old");
    const result = await batch({ sessionDir, cells: ["v2-2.0.32:s1:1"] });
    expect(result.stoppedAt.reason).toMatch(/cidfile already exists/);
    expect(existsSync(join(sessionDir, "results"))).toBe(false);
  });

  it("refuses an image map missing the cell's host", async () => {
    const { "v2-2.0.32": _drop, ...images } = IMAGES;
    const result = await batch({ images, cells: ["v2-2.0.32:s1:1"] });
    expect(result.stoppedAt.reason).toMatch(/no image id for host v2-2.0.32/);
  });

  it("covers the full qualification set with expectedCells()", () => {
    expect(allowlistFor("qualification")).toEqual(new Set(expectedCells().map((cell: { id: string }) => cell.id)));
  });
});

describe("operator termination (first SIGINT/SIGTERM aborts the batch signal)", () => {
  /** The attached run "hangs" until the batch signal aborts, then returns like a killed client. */
  const hangUntilAborted = (onStart?: () => void) => (_id: string, signal?: AbortSignal) =>
    new Promise<Outcome>((resolve) => {
      onStart?.();
      signal?.addEventListener("abort", () => resolve({ stdout: "", exitCode: null, cancelled: true }), { once: true });
    });

  it("launches nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await batch({ signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(result.log).toEqual([]);
    expect(result.cancelled).toEqual({ cellId: null, cleanupConfirmed: true, cleanupScope: "original-process-group+owned-container", cleanupScopeNote: expect.stringMatching(/escaped descendants/), detail: "no container in flight" });
  });

  it("kills the in-flight client, still removes the owned container by id and verifies absence, records it, and launches no further cell", async () => {
    const controller = new AbortController();
    const result = await batch({ signal: controller.signal, fake: { outcomes: hangUntilAborted(() => setTimeout(() => controller.abort(), 5)) } });
    expect(result.status).toBe("cancelled");
    expect(result.log).toEqual(["run-start v2-2.0.32:s1:1", "run-settled v2-2.0.32:s1:1", "rm cid-v2-2.0.32:s1:1", "absent? id=cid-v2-2.0.32:s1:1"]);
    expect(result.stoppedAt).toMatchObject({ cellId: "v2-2.0.32:s1:1", reason: expect.stringMatching(/cancelled by operator/) });
    expect(result.cancelled).toMatchObject({ cellId: "v2-2.0.32:s1:1", cleanupConfirmed: true });
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({ verdict: "FAIL", cleanupConfirmed: true });
    const record = JSON.parse(await readFile(join(result.sessionDir, "results", "v2-2.0.32_s1_1.json"), "utf8"));
    expect(record).toMatchObject({ verdict: "FAIL", reason: expect.stringMatching(/cancelled by operator/), cleanup: { ok: true } });
  });

  it("records cleanup as unconfirmed when the targeted removal fails after a cancel", async () => {
    const controller = new AbortController();
    const result = await batch({ signal: controller.signal, fake: { outcomes: hangUntilAborted(() => setTimeout(() => controller.abort(), 5)), rm: () => ({ status: 1, stdout: "", stderr: "x", timedOut: false }) } });
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toMatchObject({ cleanupConfirmed: false, detail: expect.stringMatching(/container removal failed/) });
    expect(result.receipts[0].cleanupConfirmed).toBe(false);
  });

  it("records cleanup as unconfirmed when the container id was never written (cannot target removal)", async () => {
    const sessionDir = await scratch();
    const controller = new AbortController();
    const runner = {
      runAttached: async (_argv: string[], options: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          setTimeout(() => controller.abort(), 5);
          options.signal?.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: false, capExceeded: null, cancelled: true }), { once: true });
        }),
      run: async () => {
        throw new Error("must not run rm without an exact id");
      },
    };
    const result = await runBatch({ runKind: "spike", runId: "r1", archiveSha256: "b".repeat(64), images: IMAGES, cells: [...SPIKE_CELLS], docker: "/usr/local/bin/docker", sessionDir, runner, signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toMatchObject({ cellId: "v2-2.0.32:s1:1", cleanupConfirmed: false, detail: expect.stringMatching(/container id unknown/) });
  });
});

describe("cancellation is re-read after cleanup and after the result write (never 'completed' once cancelled)", () => {
  const ok = { status: 0, stdout: "", stderr: "", timedOut: false };

  it.each([
    ["during the container removal", "rm"],
    ["during the absence check", "absence"],
  ])("a signal %s -> cancelled, with the in-flight cell and its confirmed cleanup", async (_label, where) => {
    const controller = new AbortController();
    const fake = where === "rm" ? { rm: () => (controller.abort(), ok) } : { absence: () => (controller.abort(), ok) };
    const result = await batch({ signal: controller.signal, fake });
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toMatchObject({ cellId: "v2-2.0.32:s1:1", cleanupConfirmed: true });
    // Cleanup still finished (rm AND absence ran), and no further cell launched.
    expect(result.log).toEqual(["run-start v2-2.0.32:s1:1", "run-settled v2-2.0.32:s1:1", "rm cid-v2-2.0.32:s1:1", "absent? id=cid-v2-2.0.32:s1:1"]);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0].cleanupConfirmed).toBe(true);
    // Seen right after cleanup, i.e. before the result record was written.
    expect(JSON.parse(await readFile(join(result.sessionDir, "results", "v2-2.0.32_s1_1.json"), "utf8")).cancelledByOperator).toBe(true);
  });

  it("a signal during the final result write of the LAST cell -> cancelled, not completed", async () => {
    const controller = new AbortController();
    const sessionDir = await scratch();
    const docker = fakeDocker();
    const writeRecord = async (path: string, text: string) => {
      controller.abort();
      await writeFile(path, text, { flag: "wx", mode: 0o600 });
    };
    const result = await runBatch({ runKind: "spike", runId: "r1", archiveSha256: "b".repeat(64), images: IMAGES, cells: ["v2-2.0.32:s1:1"], docker: "/usr/local/bin/docker", sessionDir, runner: docker.runner, signal: controller.signal, writeRecord });
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toMatchObject({ cellId: "v2-2.0.32:s1:1", cleanupConfirmed: true });
    const written = JSON.parse(await readFile(join(sessionDir, "results", "v2-2.0.32_s1_1.json"), "utf8"));
    expect(written).toMatchObject({ verdict: "PASS", cancelledByOperator: false });
  });

  it("a cleanup failure while cancelled reports cleanupConfirmed:false", async () => {
    const controller = new AbortController();
    const result = await batch({ signal: controller.signal, fake: { rm: () => (controller.abort(), { status: 1, stdout: "", stderr: "x", timedOut: false }) } });
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toMatchObject({ cellId: "v2-2.0.32:s1:1", cleanupConfirmed: false, detail: expect.stringMatching(/container removal failed/) });
  });
});

describe("attached client in its own process group: targeted cleanup still works; uncertain settlement is reported", () => {
  it("REAL proc-runner + a node fake CLI (never docker): cancel group-kills the attached client, then `rm -f <exact id>` + absence check still run and confirm", async () => {
    const sessionDir = await scratch();
    const cli = join(sessionDir, "fake-cli.cjs");
    const log = join(sessionDir, "cli.log");
    // A node script standing in for the docker CLI: `run` writes the cidfile and hangs (with a
    // grandchild holding the pipes); `rm -f <id>` and `ps` append to a log. Not named docker.
    await writeFile(
      cli,
      `#!${process.execPath}\n` +
        `const fs = require("node:fs"); const a = process.argv.slice(2); const log = ${JSON.stringify(log)};\n` +
        `if (a[0] === "run") { fs.writeFileSync(a[a.indexOf("--cidfile") + 1], "cid-xyz"); require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] }); setInterval(() => {}, 1000); }\n` +
        `else if (a[0] === "rm") { fs.appendFileSync(log, "rm " + a.slice(1).join(" ") + "\\n"); }\n` +
        `else if (a[0] === "ps") { fs.appendFileSync(log, "ps " + a.slice(1).join(" ") + "\\n"); }\n`,
    );
    await chmod(cli, 0o755);
    const runner = createProcRunner({ env: { PATH: "/usr/bin:/bin" }, closeBoundMs: 1_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    const started = Date.now();
    const result = await runBatch({ runKind: "spike", runId: "r1", archiveSha256: "b".repeat(64), images: IMAGES, cells: [...SPIKE_CELLS], docker: cli, sessionDir, runner, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toMatchObject({ cellId: "v2-2.0.32:s1:1", cleanupConfirmed: true });
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines[0]).toBe("rm -f cid-xyz");
    expect(lines[1]).toBe("ps -a --no-trunc --filter id=cid-xyz --filter label=council-rh.owner=r1 --format {{.ID}}");
    expect(lines).toHaveLength(2);
  });

  it("an attached client whose settlement is uncertain (pipes held after group SIGKILL) stops the batch; cleanup still runs", async () => {
    const result = await batch({ fake: { outcomes: (id: string) => ({ stdout: frame(id), timedOut: true, cleanupUncertain: true }) } });
    expect(result.status).toBe("stopped");
    expect(result.stoppedAt.reason).toMatch(/did not settle/);
    expect(result.log).toEqual(["run-start v2-2.0.32:s1:1", "run-settled v2-2.0.32:s1:1", "rm cid-v2-2.0.32:s1:1", "absent? id=cid-v2-2.0.32:s1:1"]);
    expect(result.receipts[0]).toMatchObject({ verdict: "FAIL", cleanupConfirmed: false });
  });

  it("cancelled with an uncertain client settlement -> cleanupConfirmed: false even though the container was removed", async () => {
    const controller = new AbortController();
    const result = await batch({ signal: controller.signal, fake: { outcomes: () => (controller.abort(), { stdout: "", exitCode: null, cancelled: true, cleanupUncertain: true }) } });
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toMatchObject({ cleanupConfirmed: false, detail: expect.stringMatching(/did not settle/) });
  });
});

describe("scoped cleanup claims (round 5): original process group + owned container, never 'everything stopped'", () => {
  it("every cell receipt and the cancelled summary carry cleanupScope", async () => {
    const result = await batch({ cells: ["v2-2.0.32:s1:1"] });
    expect(result.receipts[0]).toMatchObject({ cleanupConfirmed: true, cleanupScope: "original-process-group+owned-container" });
    const controller = new AbortController();
    const cancelled = await batch({ signal: controller.signal, fake: { rm: () => (controller.abort(), { status: 0, stdout: "", stderr: "", timedOut: false }) } });
    expect(cancelled.cancelled).toMatchObject({ cleanupConfirmed: true, cleanupScope: "original-process-group+owned-container", cleanupScopeNote: expect.stringMatching(/escaped descendants/) });
  });

  it.each([
    ["the removal command", { rm: () => ({ status: 0, stdout: "", stderr: "", timedOut: false, cleanupUncertain: true }) }],
    ["the absence check", { absence: () => ({ status: 0, stdout: "", stderr: "", timedOut: false, cleanupUncertain: true }) }],
  ])("an unsettled process group of %s means cleanup is NOT confirmed (stop)", async (_label, fake) => {
    const result = await batch({ cells: ["v2-2.0.32:s1:1"], fake });
    expect(result.status).toBe("stopped");
    expect(result.stoppedAt.reason).toMatch(/did not settle/);
    expect(result.receipts[0].cleanupConfirmed).toBe(false);
  });
});

describe("S4 budget option B: the attached docker run deadline comes from the per-scenario table", () => {
  it("S4 cells get 270 s, every other cell 210 s", async () => {
    timeouts.length = 0;
    await batch({ runKind: "qualification", cells: ["v1-1.18.29:s3:1", "v1-1.18.29:s4:1", "v1-1.18.29:s5:1"] });
    expect(timeouts).toEqual([["v1-1.18.29:s3:1", 210_000], ["v1-1.18.29:s4:1", 270_000], ["v1-1.18.29:s5:1", 210_000]]);
  });
});

describe("round-3 Must 2: onCleanupUnconfirmed fires before any fallible await", () => {
  it("is called (with the cell id) before the result write; a rejecting write still leaves the caller informed", async () => {
    const order: string[] = [];
    await expect(
      batch({
        cells: ["v2-2.0.32:s1:1"],
        fake: { rm: () => ({ status: 0, stdout: "", stderr: "", timedOut: false, cleanupUncertain: true }) },
        onCleanupUnconfirmed: (cellId: string, problem: string) => order.push(`unconfirmed ${cellId}: ${problem}`),
        writeRecord: async () => {
          order.push("write");
          throw new Error("disk");
        },
      }),
    ).rejects.toThrow("disk");
    expect(order).toEqual(["unconfirmed v2-2.0.32:s1:1: docker rm process group did not settle (original group not confirmed gone) for cid-v2-2.0.32:s1:1", "write"]);
  });

  it("is not called when cleanup is confirmed", async () => {
    const calls: string[] = [];
    await batch({ cells: ["v2-2.0.32:s1:1"], onCleanupUnconfirmed: (cellId: string) => calls.push(cellId) });
    expect(calls).toEqual([]);
  });
});
