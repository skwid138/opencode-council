import { describe, expect, it } from "vitest";

import { assertAllowedCell, expectedCells, HOSTS, IMPLEMENTED_SCENARIOS, parseCellId, SPIKE_CELLS } from "./cells.mjs";

describe("cell model", () => {
  it("expects exactly 92 gating + 2 observational cells across the 4 hosts", () => {
    const cells = expectedCells();
    expect(HOSTS.map((host: { id: string }) => host.id)).toEqual(["v1-1.18.29", "v1-1.19.3", "v2-2.0.28", "v2-2.0.32"]);
    expect(cells.filter((cell: { class: string }) => cell.class === "gating")).toHaveLength(92);
    expect(cells.filter((cell: { class: string }) => cell.class === "observational").map((cell: { id: string }) => cell.id)).toEqual([
      "v1-1.18.29:obs-ask:1",
      "v1-1.19.3:obs-ask:1",
    ]);
    expect(new Set(cells.map((cell: { id: string }) => cell.id)).size).toBe(94);
  });

  it("repeats S3, S5, S6, S7, S13 three times per host and every other scenario once", () => {
    const ids = expectedCells().map((cell: { id: string }) => cell.id);
    for (const scenario of ["s3", "s5", "s6", "s7", "s13"]) expect(ids.filter((id: string) => id.startsWith(`v2-2.0.32:${scenario}:`))).toEqual([1, 2, 3].map((rep) => `v2-2.0.32:${scenario}:${rep}`));
    for (const scenario of ["s1", "s2", "s4", "s8", "s9", "s10", "s11", "s12"]) expect(ids.filter((id: string) => id.startsWith(`v1-1.18.29:${scenario}:`))).toEqual([`v1-1.18.29:${scenario}:1`]);
  });

  it("parses cell ids strictly", () => {
    expect(parseCellId("v2-2.0.28:s13:3")).toEqual({ host: "v2-2.0.28", scenario: "s13", rep: 3 });
    for (const bad of ["v2-2.0.28:s13", "v2-2.0.28:s14:1", "v3-1.0.0:s1:1", "v2-2.0.28:s1:0", "v2-2.0.28:s1:1:x", "v2-2.0.28:S1:1", ""]) {
      expect(() => parseCellId(bad)).toThrow(/invalid cell id/);
    }
  });

  it("rejects unknown and duplicate cell ids against an allowlist", () => {
    const allow = new Set(["v2-2.0.32:s1:1"]);
    const seen = new Set<string>();
    expect(() => assertAllowedCell("v2-2.0.32:s1:1", allow, seen)).not.toThrow();
    expect(() => assertAllowedCell("v2-2.0.32:s1:1", allow, seen)).toThrow(/duplicate cell id/);
    expect(() => assertAllowedCell("v2-2.0.32:s2:1", allow, seen)).toThrow(/not in the allowlist/);
    expect(() => assertAllowedCell("bogus", allow, seen)).toThrow(/invalid cell id/);
  });

  it("orders the spike as S1, S2 on V2 2.0.32 then V1 1.19.3; P1b implements every scenario of the 94-cell set plus the version probe", () => {
    expect(SPIKE_CELLS).toEqual(["v2-2.0.32:s1:1", "v2-2.0.32:s2:1", "v1-1.19.3:s1:1", "v1-1.19.3:s2:1"]);
    expect([...IMPLEMENTED_SCENARIOS]).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13", "obs-ask", "probe"]);
    for (const cell of expectedCells()) expect(IMPLEMENTED_SCENARIOS.has(cell.scenario)).toBe(true);
  });
});

describe("per-scenario cell deadlines (S4 budget option B, user-approved 2026-10-19)", () => {
  it("only S4 differs from the 180 s driver / 210 s controller default; S4 = 240 s / 270 s", async () => {
    const { cellDeadlines, CELL_DEADLINES, DEFAULT_CELL_DEADLINES, GATING_SCENARIOS, OBSERVATIONAL_SCENARIO, PROBE_SCENARIO } = await import("./cells.mjs");
    expect(DEFAULT_CELL_DEADLINES).toEqual({ driverMs: 180_000, controllerMs: 210_000 });
    expect(Object.keys(CELL_DEADLINES)).toEqual(["s4"]);
    expect(cellDeadlines("s4")).toEqual({ driverMs: 240_000, controllerMs: 270_000 });
    for (const scenario of [...GATING_SCENARIOS, OBSERVATIONAL_SCENARIO, PROBE_SCENARIO]) {
      if (scenario !== "s4") expect(cellDeadlines(scenario)).toEqual(DEFAULT_CELL_DEADLINES);
    }
  });

  it("for every scenario the driver deadline plus its cleanup grace ends before the controller deadline", async () => {
    const { cellDeadlines, GATING_SCENARIOS, OBSERVATIONAL_SCENARIO, PROBE_SCENARIO } = await import("./cells.mjs");
    const { CLEANUP_GRACE_MS } = await import("./driver.mjs");
    for (const scenario of [...GATING_SCENARIOS, OBSERVATIONAL_SCENARIO, PROBE_SCENARIO]) {
      const { driverMs, controllerMs } = cellDeadlines(scenario);
      expect(driverMs).toBeLessThan(controllerMs);
      expect(driverMs + CLEANUP_GRACE_MS).toBeLessThan(controllerMs);
    }
  });

  it("refuses an unknown scenario", async () => {
    const { cellDeadlines } = await import("./cells.mjs");
    expect(() => cellDeadlines("s99")).toThrow(/unknown scenario/);
  });
});
