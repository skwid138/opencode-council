// S11 diagnostic amendment (plan .project-plans/2026-10-18_council-real-host-qualification.md,
// "Amendment A3"): the opt-in V1 1.18.29 S11 diagnostic run. Injected runners / transports only
// (never a real docker / npm / curl; the no-docker guard is active).
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DIAGNOSTIC_CELLS, DIAGNOSTIC_HOST, expectedCells, probeCell } from "./cells.mjs";
import { allowlistFor, runBatch } from "./controller.mjs";
import { classifyDiagnostic, DIAGNOSTIC_INTERPRETATION } from "./diagnostic.mjs";
import { encodeFrame, RESULT_SCHEMA } from "./frame.mjs";
import { createHttpClient, HarnessError } from "./http.mjs";
import { makeReceipt, verifyQualification } from "./report.mjs";
import { markReceiptCancelled } from "./receipts.mjs";
import { collectEvidence, runCell } from "./runner.mjs";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-diag-")));
  created.push(dir);
  return dir;
}

const CELL = "v1-1.18.29:s11:1";
const PROBE = "v1-1.18.29:probe:1";
const IMAGES = { "v1-1.18.29": "sha256:" + "1".repeat(64), "v1-1.19.3": "sha256:" + "2".repeat(64), "v2-2.0.28": "sha256:" + "3".repeat(64), "v2-2.0.32": "sha256:" + "4".repeat(64) };
const ARCHIVE = "e".repeat(64);
const PASSWORD = "rh-" + "Q".repeat(43);
const BASIC = Buffer.from(`opencode:${PASSWORD}`).toString("base64");
const PROJECT = "/scratch/rh-SECRETPROJ/project";
type Any = Record<string, any>;

const frameOf = (cellId: string, result: Any) => encodeFrame({ schema: RESULT_SCHEMA, cellId, verdict: result.verdict, checks: result.checks, host: { id: cellId.split(":")[0], executableSha256: "a".repeat(64) }, closure: null, durationMs: 1, ...(result.summary ? { summary: result.summary } : {}) });
const passFrame = (cellId: string) => frameOf(cellId, { verdict: "PASS", checks: [{ id: "x", ok: true, detail: "" }] });
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", timedOut: false });

/** Fake docker runner: attached run answered by `attached(cellId)`; rm / ps answered by `rm` / `ps`. */
function fakeDocker({ attached = (id: string): Any => ({ stdout: passFrame(id) }), rm = (): Any => ok(), ps = (): Any => ok("") } = {}) {
  const log: string[] = [];
  return {
    log,
    runner: {
      async runAttached(argv: string[]) {
        const cellId = argv.at(-1) as string;
        log.push(`run ${cellId}`);
        await writeFile(argv[argv.indexOf("--cidfile") + 1], `cid-${cellId}`);
        const outcome = attached(cellId);
        return { exitCode: 0, signal: null, stderr: "", timedOut: false, capExceeded: null, cancelled: false, cleanupUncertain: false, stdout: "", ...outcome };
      },
      async run(argv: string[]) {
        log.push(argv[1]);
        if (argv[1] === "rm") return rm();
        if (argv[1] === "ps") return ps();
        throw new Error(`unexpected docker call ${argv.join(" ")}`);
      },
    },
  };
}
const batchOf = async (runKind: string, cells: string[], fake = fakeDocker()) => {
  const sessionDir = await scratch();
  const result = await runBatch({ runKind, runId: "d1", archiveSha256: ARCHIVE, images: IMAGES, cells, docker: "/usr/local/bin/docker", sessionDir, runner: fake.runner });
  return { ...result, sessionDir, log: fake.log };
};

/** The real runCell + collectEvidence, with a client whose raw handshake transport is injected. */
async function s11Cell(handshake: (req: { headers: Record<string, string>; path: string }) => Promise<Any>) {
  const deps = {
    createFixture: async () => ({ root: "/scratch/rh-SECRETPROJ", project: PROJECT, run: "/scratch/rh-SECRETPROJ/run", logs: "/scratch/rh-SECRETPROJ/logs", home: "/h", tmp: "/t", xdg: { XDG_DATA_HOME: "/d" } }),
    seedPluginCache: async () => {},
    startProvider: async () => ({ baseURL: "http://127.0.0.1:4200/v1", provider: { ledger: () => [] }, close: async () => [{ status: "closed" }] }),
    writeConfig: async () => "/scratch/rh-SECRETPROJ/run/config.json",
    writeProjectFiles: async () => {},
    launchHost: async () => ({ port: 4100, password: PASSWORD }),
    connect: async ({ launched, signal }: Any) => ({ client: createHttpClient({ baseURL: `http://127.0.0.1:${launched.port}`, auth: { username: "opencode", password: launched.password }, handshakeTransport: handshake as never, transport: (async () => new Response("", { status: 500 })) as never, signal }), events: { subscribe: async () => {} }, close: async () => [] }),
    collect: collectEvidence,
    evaluate: () => ({ verdict: "PASS", checks: [{ id: "x", ok: true, detail: "" }] }),
    stopAll: async () => [],
    removeFixture: async () => {},
  };
  return runCell({ cell: { id: CELL, host: "v1-1.18.29", scenario: "s11", rep: 1 }, manifest: { host: { id: "v1-1.18.29", version: "1.18.29", executablePath: "/x", executableSha256: "a".repeat(64) } }, signal: new AbortController().signal }, deps as never);
}
const challenge = async () => ({ status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' }, text: "" });
const timeoutOn = (leg: "anonymous" | "authenticated") => async ({ headers, path }: { headers: Record<string, string>; path: string }) => {
  if ((headers.authorization ? "authenticated" : "anonymous") !== leg) return challenge();
  throw new HarnessError("EHTTPTIMEOUT", `GET ${path.split("?")[0]} no response within 10000 ms`);
};

describe("diagnostic cells and allowlist", () => {
  it("exactly the V1 1.18.29 version probe + v1-1.18.29:s11:1; the 94-cell qualification set is unchanged", () => {
    expect(DIAGNOSTIC_HOST).toBe("v1-1.18.29");
    expect(DIAGNOSTIC_CELLS).toEqual([CELL]);
    expect(probeCell(DIAGNOSTIC_HOST).id).toBe(PROBE);
    expect([...allowlistFor("diagnostic")]).toEqual([CELL]);
    expect(expectedCells()).toHaveLength(94);
    expect(expectedCells().filter((cell: Any) => cell.class === "gating")).toHaveLength(92);
  });

  it.each([
    ["an unapproved cell", ["v1-1.19.3:s11:1"], "v1-1.19.3:s11:1", []],
    ["a probe as a diagnostic cell", [PROBE], PROBE, []],
    ["an extra cell after the approved one", [CELL, "v1-1.18.29:s1:1"], "v1-1.18.29:s1:1", [`run ${CELL}`]],
    ["the approved cell twice", [CELL, CELL], CELL, [`run ${CELL}`]],
  ])("the controller refuses %s (no docker run for it)", async (_label, cells, stoppedAt, runs) => {
    const batch = await batchOf("diagnostic", cells);
    expect(batch.status).toBe("stopped");
    expect(batch.stoppedAt.cellId).toBe(stoppedAt);
    expect(batch.log.filter((line: string) => line.startsWith("run "))).toEqual(runs);
  });

  it("diagnostic receipts never complete a qualification: swapping one into an otherwise complete 94-cell set fails the verifier", () => {
    const receipt = (cell: Any, fields: Any = {}) => makeReceipt({ runKind: "qualification", runId: "q1", archiveSha256: ARCHIVE, imageId: IMAGES[cell.host as keyof typeof IMAGES], cellId: cell.id, cellClass: cell.class, verdict: "PASS", resultSha256: null, cleanupConfirmed: true, ...fields });
    const full = expectedCells().map((cell: Any) => receipt(cell));
    const args = { runId: "q1", archiveSha256: ARCHIVE, imageIds: IMAGES };
    expect(verifyQualification({ ...args, receipts: full }).status).toBe("complete");
    const diag = makeReceipt({ runKind: "diagnostic", runId: "q1", archiveSha256: ARCHIVE, imageId: IMAGES["v1-1.18.29"], cellId: CELL, cellClass: "diagnostic", verdict: "PASS", resultSha256: null, cleanupConfirmed: true });
    const swapped = full.map((entry: Any) => (entry.cellId === CELL ? diag : entry));
    const verdict = verifyQualification({ ...args, receipts: swapped });
    expect(verdict.status).not.toBe("complete");
    expect(verdict.problems).toEqual(expect.arrayContaining([`${CELL}: not a qualification receipt (diagnostic)`, `missing cell ${CELL}`]));
    // Even relabelled as qualification, its class gives it away.
    expect(verifyQualification({ ...args, receipts: full.map((entry: Any) => (entry.cellId === CELL ? { ...diag, runKind: "qualification" } : entry)) }).status).toBe("failed");
  });

  it("a published terminal diagnostic receipt is cancel-markable; cancellation replaces its outcome (the stale one kept as previousOutcome)", async () => {
    const dir = await scratch();
    const path = join(dir, "gate-diag-d1.json");
    await writeFile(path, JSON.stringify({ schema: "council-rh-diagnostic/1", status: "terminal", outcome: "s11-pass-cleanup-confirmed" }));
    expect(await markReceiptCancelled(path, { cancelledBy: "operator signal", outcome: "s11-pass-cleanup-confirmed" })).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schema: "council-rh-diagnostic/1", status: "cancelled", previousStatus: "terminal", outcome: "cancelled", previousOutcome: "s11-pass-cleanup-confirmed", cancelledBy: "operator signal" });
    // Other receipts keep their semantics: an `outcome` field elsewhere is not touched.
    const other = join(dir, "gate-x.json");
    await writeFile(other, JSON.stringify({ status: "completed", outcome: "kept" }));
    expect(await markReceiptCancelled(other, { cancelledBy: "operator signal" })).toBe(true);
    expect(JSON.parse(await readFile(other, "utf8"))).toEqual({ status: "cancelled", previousStatus: "completed", outcome: "kept", cancelledBy: "operator signal" });
  });
});

describe("handshake failures reach the persisted cell record by leg, credential-free", () => {
  it.each([
    ["anonymous", "handshake-anonymous-timeout"],
    ["authenticated", "handshake-authenticated-timeout"],
  ] as const)("%s-leg timeout: persisted cell.collect keeps the code and leg; no password / Basic token / query value", async (leg, outcome) => {
    const result = await s11Cell(timeoutOn(leg));
    const fake = fakeDocker({ attached: (id) => ({ stdout: frameOf(id, result) }) });
    const probes = await batchOf("probe", [PROBE]);
    const batch = await batchOf("diagnostic", [CELL], fake);
    const text = await readFile(join(batch.sessionDir, "results", "v1-1.18.29_s11_1.json"), "utf8");
    const record = JSON.parse(text);
    const collect = record.result.checks.find((check: Any) => check.id === "cell.collect");
    expect(collect.detail).toBe(`Error EHTTPTIMEOUT: auth handshake ${leg} leg GET /session?directory=… -> GET /session no response within 10000 ms`);
    for (const secret of [PASSWORD, BASIC, "SECRETPROJ", "authorization"]) expect(text).not.toContain(secret);
    expect(record).toMatchObject({ runKind: "diagnostic", verdict: "FAIL" });
    expect(batch.receipts[0]).toMatchObject({ runKind: "diagnostic", cellClass: "diagnostic", cleanupConfirmed: true });
    expect(classifyDiagnostic({ probes, batch })).toMatchObject({ outcome, cellId: CELL, cleanupConfirmed: true });
  });

  it("handshake OK, later failure: a collection failure after the handshake is not a handshake outcome", async () => {
    const result = await s11Cell(async ({ headers }) => (headers.authorization ? { status: 200, headers: {}, text: "[]" } : challenge()));
    expect(result.checks.find((check: Any) => check.id === "cell.collect")?.detail ?? "").not.toMatch(/auth handshake/);
    const batch = await batchOf("diagnostic", [CELL], fakeDocker({ attached: (id) => ({ stdout: frameOf(id, result) }) }));
    expect(classifyDiagnostic({ probes: await batchOf("probe", [PROBE]), batch }).outcome).toBe("handshake-ok-later-failure");
  });
});

describe("classifyDiagnostic: distinct terminal outcomes", () => {
  const failFrame = (id: string, checks: Any[]) => frameOf(id, { verdict: "FAIL", checks });
  const outcomeOf = async (probeFake: ReturnType<typeof fakeDocker>, cellFake?: ReturnType<typeof fakeDocker>) => {
    const probes = await batchOf("probe", [PROBE], probeFake);
    const batch = cellFake ? await batchOf("diagnostic", [CELL], cellFake) : null;
    return classifyDiagnostic({ probes, batch });
  };

  it.each([
    ["a good S11 followed by an extra unapproved cell", [CELL, "v1-1.19.3:s11:1"]],
    ["a good S11 followed by an extra same-host cell", [CELL, "v1-1.18.29:s1:1"]],
    ["a good S11 followed by a duplicate of itself", [CELL, CELL]],
  ])("a STOPPED batch never classifies PASS, even with an earlier passing S11 record: %s", async (_label, cells) => {
    const batch = await batchOf("diagnostic", cells);
    expect(batch.status).toBe("stopped");
    expect(batch.results.map((record: Any) => [record.cellId, record.verdict, record.cleanup.ok])).toEqual([[CELL, "PASS", true]]);
    const verdict = classifyDiagnostic({ probes: await batchOf("probe", [PROBE]), batch });
    expect(verdict.outcome).not.toBe("s11-pass-cleanup-confirmed");
    expect(verdict).toMatchObject({ outcome: "inconclusive", detail: expect.stringMatching(/^batch stopped at /) });
  });

  it("S11 PASS with confirmed cleanup is the only success outcome", async () => {
    expect(await outcomeOf(fakeDocker(), fakeDocker())).toMatchObject({ outcome: "s11-pass-cleanup-confirmed", cleanupConfirmed: true, failedChecks: [] });
  });

  it.each([
    ["a probe FAIL verdict", () => fakeDocker({ attached: (id) => ({ stdout: failFrame(id, [{ id: "probe.version", ok: false, detail: "printed x" }]) }) }), "probe-failed"],
    ["a probe without a valid frame", () => fakeDocker({ attached: () => ({ stdout: "garbage\n" }) }), "frame-uncertain"],
    ["a probe whose container removal failed", () => fakeDocker({ rm: () => ({ status: 1, stdout: "", stderr: "x", timedOut: false }) }), "cleanup-uncertain"],
  ])("probe stage: %s -> %s (S11 never runs)", async (_label, probeFake, outcome) => {
    expect((await outcomeOf(probeFake())).outcome).toBe(outcome);
  });

  it.each([
    ["S11 PASS but the container removal did not settle", fakeDocker({ rm: () => ({ ...ok(), cleanupUncertain: true }) }), "cleanup-uncertain"],
    ["S11 PASS but the container is still present", fakeDocker({ ps: () => ok("cid\n") }), "cleanup-uncertain"],
    ["a missing result frame", fakeDocker({ attached: () => ({ stdout: "" }) }), "frame-uncertain"],
    ["an attached run timeout", fakeDocker({ attached: () => ({ timedOut: true }) }), "frame-uncertain"],
    ["an operator cancellation", fakeDocker({ attached: () => ({ cancelled: true }) }), "cancelled"],
    ["a host startup failure", fakeDocker({ attached: (id) => ({ stdout: failFrame(id, [{ id: "cell.launch", ok: false, detail: "Error EHOSTSTARTUP: host startup outcome timeout" }]) }) }), "failed-before-handshake"],
    ["an anonymous challenge mismatch", fakeDocker({ attached: (id) => ({ stdout: failFrame(id, [{ id: "cell.collect", ok: false, detail: "Error EAUTHCHALLENGE: auth challenge GET /session?directory=… -> 200, WWW-Authenticate absent; refusing to trust the port" }]) }) }), "handshake-failed"],
    ["a driver deadline (handshake state unknown)", fakeDocker({ attached: (id) => ({ stdout: failFrame(id, [{ id: "driver.deadline", ok: false, detail: "cell exceeded the 180000 ms work deadline" }]) }) }), "inconclusive"],
    ["an S11 predicate failure", fakeDocker({ attached: (id) => ({ stdout: failFrame(id, [{ id: "s11.denied-read", ok: false, detail: "denied content seen" }]) }) }), "handshake-ok-later-failure"],
  ])("S11 stage: %s -> %s", async (_label, cellFake, outcome) => {
    const verdict = await outcomeOf(fakeDocker(), cellFake);
    expect(verdict.outcome).toBe(outcome);
    if (outcome !== "s11-pass-cleanup-confirmed") expect(verdict.outcome).not.toBe("s11-pass-cleanup-confirmed");
  });

  it("the interpretation note: one pass is neither causal proof nor qualification; compare the fresh Gate P closure manifest with p1a05 first", () => {
    expect(DIAGNOSTIC_INTERPRETATION).toMatch(/not causal proof/);
    expect(DIAGNOSTIC_INTERPRETATION).toMatch(/not qualification/);
    expect(DIAGNOSTIC_INTERPRETATION).toMatch(/Gate P closure manifest.*p1a05/);
  });
});
