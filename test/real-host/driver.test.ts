import { describe, expect, it, vi } from "vitest";

import { runDriver } from "./driver.mjs";
import { evaluate, fixtureFor, MAX_DETAIL_BYTES } from "./scenarios.mjs";
import { parseResultFrame } from "./frame.mjs";

const SHA = "a".repeat(64);
const MANIFEST = { host: { id: "v2-2.0.32", executablePath: "/opt/council-rh/bin/opencode-2.0.32", executableSha256: SHA }, runId: "r1", archiveSha256: "b".repeat(64) };
const CELLS = ["v2-2.0.32:s1:1", "v2-2.0.32:s2:1", "v2-2.0.32:s3:1", "v2-2.0.32:s4:1"];

function deps(overrides: Record<string, unknown> = {}) {
  const writes: string[] = [];
  const stderr: string[] = [];
  const runCell = vi.fn(async ({ cell }: { cell: { id: string } }) => ({ verdict: "PASS", checks: [{ id: `${cell.id}.ok`, ok: true, detail: "" }], summary: {} }));
  return {
    writes,
    stderr,
    runCell,
    options: {
      argv: ["v2-2.0.32:s1:1"],
      loadManifest: async () => MANIFEST,
      loadCells: async () => CELLS,
      hashFile: async () => SHA,
      runCell,
      stdout: (text: string) => writes.push(text),
      stderr: (text: string) => stderr.push(text),
      deadlineMs: 180_000,
      cleanupGraceMs: 1_000,
      ...overrides,
    },
  };
}

const onlyFrame = (writes: string[]) => {
  expect(writes).toHaveLength(1);
  const parsed = parseResultFrame(writes[0]);
  expect(parsed.ok).toBe(true);
  return parsed.result;
};

describe("driver", () => {
  it("runs an allowlisted, implemented cell and writes exactly one frame in one write", async () => {
    const d = deps();
    await expect(runDriver(d.options)).resolves.toBe(0);
    const result = onlyFrame(d.writes);
    expect(result).toMatchObject({ cellId: "v2-2.0.32:s1:1", verdict: "PASS", host: { id: "v2-2.0.32", executableSha256: SHA } });
    expect(d.runCell).toHaveBeenCalledTimes(1);
  });

  it("carries the image's Gate P closure identity into every result (V1 report scope, Amendment A2)", async () => {
    const closure = { receiptId: "closure-r1-abcdef012345", lockfileSha256: "c".repeat(64), plugin: "@opencode-ai/plugin@1.19.3" };
    const d = deps({ argv: ["v1-1.19.3:s1:1"], loadCells: async () => ["v1-1.19.3:s1:1"], loadManifest: async () => ({ ...MANIFEST, host: { ...MANIFEST.host, id: "v1-1.19.3" }, closure }) });
    await runDriver(d.options);
    expect(onlyFrame(d.writes).closure).toEqual(closure);
    const v2 = deps();
    await runDriver(v2.options);
    expect(onlyFrame(v2.writes).closure).toBeNull();
  });

  it("refuses to launch when the host executable hash does not match", async () => {
    const d = deps({ hashFile: async () => "f".repeat(64) });
    await runDriver(d.options);
    expect(d.runCell).not.toHaveBeenCalled();
    const result = onlyFrame(d.writes);
    expect(result.verdict).toBe("FAIL");
    expect(result.checks).toEqual([{ id: "driver.host-hash", ok: false, detail: expect.stringContaining("executable sha256") }]);
  });

  it.each([
    ["an unknown cell", ["v2-2.0.32:s1:1"], { loadCells: async () => ["v2-2.0.32:s2:1"] }, "driver.allowlist"],
    ["a cell for another host", ["v1-1.19.3:s1:1"], { loadCells: async () => ["v1-1.19.3:s1:1"] }, "driver.allowlist"],
    ["a malformed cell id", ["bogus"], {}, "driver.allowlist"],
    ["extra argv", ["v2-2.0.32:s1:1", "x"], {}, "driver.argv"],
  ])("writes a FAIL frame without launching for %s", async (_label, argv, overrides, checkId) => {
    const d = deps({ argv, ...overrides });
    await runDriver(d.options);
    expect(d.runCell).not.toHaveBeenCalled();
    const writes = d.writes;
    expect(writes).toHaveLength(1);
    const parsed = parseResultFrame(writes[0]);
    // A malformed cell id cannot appear in a valid result; the frame then carries the placeholder cell.
    if (parsed.ok) {
      expect(parsed.result.verdict).toBe("FAIL");
      expect(parsed.result.checks[0].id).toBe(checkId);
    } else {
      expect(parsed.error).toMatch(/cellId/);
    }
  });

  it("turns the 180 s work deadline into a FAIL frame after aborting the cell", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const d = deps({
        runCell: ({ signal }: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve({ verdict: "PASS", checks: [{ id: "late", ok: true, detail: "" }] });
            });
          }),
      });
      const done = runDriver(d.options);
      await vi.advanceTimersByTimeAsync(180_000);
      await done;
      expect(aborted).toBe(true);
      const result = onlyFrame(d.writes);
      expect(result.verdict).toBe("FAIL");
      expect(result.checks.map((c: { id: string }) => c.id)).toContain("driver.deadline");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still writes one FAIL frame when the cell neither finishes nor honors the abort", async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ runCell: () => new Promise(() => {}) });
      const done = runDriver(d.options);
      await vi.advanceTimersByTimeAsync(181_000);
      await done;
      expect(onlyFrame(d.writes).checks.map((c: { id: string }) => c.id)).toEqual(["driver.deadline", "driver.cleanup-unconfirmed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("converts a thrown cell error into a FAIL frame without leaking the message to stdout", async () => {
    const d = deps({ runCell: async () => { throw Object.assign(new Error("secret detail /home/x"), { code: "EBOOM" }); } });
    await runDriver(d.options);
    const result = onlyFrame(d.writes);
    expect(result.verdict).toBe("FAIL");
    expect(result.checks[0]).toEqual({ id: "driver.cell-error", ok: false, detail: "Error EBOOM" });
    expect(d.writes[0]).not.toContain("secret detail");
  });

  it("never writes a PASS frame for a cell result with a failed check", async () => {
    const d = deps({ runCell: async () => ({ verdict: "PASS", checks: [{ id: "x", ok: false, detail: "" }] }) });
    await runDriver(d.options);
    expect(onlyFrame(d.writes).verdict).toBe("FAIL");
  });
});

describe("bounded check details and a safe frame encode (round 4)", () => {
  it("an oversized V2 aggregator-permission failure goes end to end: bounded detail with a sha256 marker, valid frame", async () => {
    const fx = fixtureFor("s2", { nonce: "big" });
    const hugeRules = Array.from({ length: 20_000 }, (_, i) => ({ action: `act-${i}`, resource: "r".repeat(60), effect: "deny" }));
    const children = [
      ...fx.expected.reviewers.map((reviewer: { modelID: string }, index: number) => ({ id: `r${index}`, parentID: "P", agent: "council-plugin-reviewer", model: { providerID: "fake", modelID: reviewer.modelID } })),
      { id: "agg", parentID: "P", agent: "council-plugin-aggregator", model: { providerID: "fake", modelID: fx.expected.aggregator.modelID }, permissions: hugeRules },
    ];
    const evidence = { scenario: "s2", family: "v2", parentSessionID: "P", expected: fx.expected, plugin: null, agents: [], children, created: [], ledger: [], parentToolCalls: [], finals: {}, parentSessionRead: true, parentPermissionsPresent: false, observations: {} };
    const evaluated = evaluate(evidence);
    const permissionCheck = evaluated.checks.find((entry: { id: string }) => entry.id === "s2.v2-aggregator-permissions");
    expect(permissionCheck.ok).toBe(false);
    expect(Buffer.byteLength(permissionCheck.detail)).toBeLessThanOrEqual(MAX_DETAIL_BYTES);
    expect(permissionCheck.detail).toMatch(/\[truncated \d+ bytes sha256 [0-9a-f]{64}\]$/);
    const d = deps({ argv: ["v2-2.0.32:s2:1"], runCell: async () => ({ ...evaluated, summary: {} }) });
    await runDriver(d.options);
    const result = onlyFrame(d.writes);
    expect(result.verdict).toBe("FAIL");
    expect(result.checks.find((entry: { id: string }) => entry.id === "s2.v2-aggregator-permissions").detail).toBe(permissionCheck.detail);
  });

  it("the driver bounds any check detail it emits (defense in depth)", async () => {
    const d = deps({ runCell: async () => ({ verdict: "FAIL", checks: [{ id: "x", ok: false, detail: "y".repeat(100_000) }], summary: {} }) });
    await runDriver(d.options);
    const detail = onlyFrame(d.writes).checks[0].detail;
    expect(Buffer.byteLength(detail)).toBeLessThanOrEqual(MAX_DETAIL_BYTES);
    expect(detail).toMatch(/sha256 [0-9a-f]{64}\]$/);
  });

  it("a result too large to encode -> exactly one bounded fallback FAIL frame with the reason (written only after a successful encode)", async () => {
    const d = deps({ runCell: async () => ({ verdict: "PASS", checks: [{ id: "x", ok: true, detail: "" }], summary: { blob: "z".repeat(600 * 1024) } }) });
    await expect(runDriver(d.options)).resolves.toBe(0);
    const result = onlyFrame(d.writes);
    expect(result.verdict).toBe("FAIL");
    expect(result.checks).toEqual([{ id: "driver.frame-encode", ok: false, detail: expect.stringMatching(/result JSON exceeds 524288 bytes/) }]);
    expect(result.summary).toBeUndefined();
  });
});

describe("post-P1b audit (frame-2 MA1): the cell's work deadline and process exit", () => {
  it("runCell gets the absolute work deadline (driver deadline minus the work margin) with the signal", async () => {
    const { WORK_MARGIN_MS } = await import("./driver.mjs");
    const d = deps({ now: () => 1_000 });
    await runDriver(d.options);
    const args = d.runCell.mock.calls[0][0] as { deadlineAt: number; signal: AbortSignal };
    expect(args.deadlineAt).toBe(1_000 + 180_000 - WORK_MARGIN_MS);
    expect(WORK_MARGIN_MS).toBeGreaterThan(0);
    expect(args.signal).toBeInstanceOf(AbortSignal);
  });

  it("driver main exits explicitly after the frame is flushed (does not just set exitCode)", async () => {
    const { exitAfterFlush } = await import("./driver.mjs");
    const order: string[] = [];
    await exitAfterFlush(0, { flush: async () => void order.push("flush"), exit: (code: number) => void order.push(`exit ${code}`) });
    expect(order).toEqual(["flush", "exit 0"]);
  });
});

describe("S4 budget option B: the driver deadline comes from the per-scenario table", () => {
  it.each([["v2-2.0.32:s4:1", 240_000], ["v2-2.0.32:s1:1", 180_000], ["v2-2.0.32:s3:1", 180_000]])("%s -> %d ms work deadline (no injected deadlineMs)", async (cellId, expected) => {
    const { WORK_MARGIN_MS } = await import("./driver.mjs");
    const d = deps({ argv: [cellId], now: () => 5_000, deadlineMs: undefined });
    await runDriver(d.options);
    expect((d.runCell.mock.calls[0][0] as { deadlineAt: number }).deadlineAt).toBe(5_000 + expected - WORK_MARGIN_MS);
  });

  it("an S4 cell is NOT cut at 180 s; it is cut at 240 s", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const d = deps({ argv: ["v2-2.0.32:s4:1"], deadlineMs: undefined, runCell: ({ signal }: { signal: AbortSignal }) => new Promise((resolve) => signal.addEventListener("abort", () => ((aborted = true), resolve({ verdict: "PASS", checks: [{ id: "late", ok: true, detail: "" }] })))) });
      const done = runDriver(d.options);
      await vi.advanceTimersByTimeAsync(200_000);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(40_000);
      await done;
      expect(aborted).toBe(true);
      expect(onlyFrame(d.writes).checks.map((c: { id: string }) => c.id)).toContain("driver.deadline");
      expect(onlyFrame(d.writes).checks.find((c: { id: string }) => c.id === "driver.deadline").detail).toBe("cell exceeded the 240000 ms work deadline");
    } finally {
      vi.useRealTimers();
    }
  });
});

it("an injected deadlineMs (test seam) overrides the per-scenario table", async () => {
  const { WORK_MARGIN_MS } = await import("./driver.mjs");
  const d = deps({ argv: ["v2-2.0.32:s4:1"], now: () => 0, deadlineMs: 50_000 });
  await runDriver(d.options);
  expect((d.runCell.mock.calls[0][0] as { deadlineAt: number }).deadlineAt).toBe(50_000 - WORK_MARGIN_MS);
});
