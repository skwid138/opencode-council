import { describe, expect, it } from "vitest";

import { expectedCells } from "./cells.mjs";
import { makeReceipt, sanitize, V1_RESULT_SCOPE, verifyQualification } from "./report.mjs";

const RUN = { runId: "run-1", archiveSha256: "a".repeat(64), imageIds: { "v1-1.18.29": "sha256:" + "1".repeat(64), "v1-1.19.3": "sha256:" + "2".repeat(64), "v2-2.0.28": "sha256:" + "3".repeat(64), "v2-2.0.32": "sha256:" + "4".repeat(64) } };

function allPass() {
  return expectedCells().map((cell: { id: string; host: string; class: string }) =>
    makeReceipt({ runKind: "qualification", ...RUN, imageId: RUN.imageIds[cell.host as keyof typeof RUN.imageIds], cellId: cell.id, cellClass: cell.class, verdict: "PASS", resultSha256: "b".repeat(64), cleanupConfirmed: true }),
  );
}

describe("qualification report verifier", () => {
  it("is complete only when every expected cell has exactly one current qualification receipt and every gating cell passed", () => {
    expect(verifyQualification({ receipts: allPass(), ...RUN })).toEqual({ status: "complete", problems: [], counts: { gating: 92, observational: 2, passed: 94 } });
  });

  it("is incomplete when a cell is missing", () => {
    const report = verifyQualification({ receipts: allPass().slice(1), ...RUN });
    expect(report.status).toBe("incomplete");
    expect(report.problems).toContain("missing cell v1-1.18.29:s1:1");
  });

  it("is incomplete when only one repetition of a repeated scenario is dropped (the other reps do not stand in)", () => {
    const receipts = allPass().filter((receipt: { cellId: string }) => receipt.cellId !== "v2-2.0.28:s5:2");
    expect(receipts.some((receipt: { cellId: string }) => receipt.cellId === "v2-2.0.28:s5:1")).toBe(true);
    expect(receipts.some((receipt: { cellId: string }) => receipt.cellId === "v2-2.0.28:s5:3")).toBe(true);
    const report = verifyQualification({ receipts, ...RUN });
    expect(report.status).toBe("incomplete");
    expect(report.problems).toEqual(["missing cell v2-2.0.28:s5:2"]);
  });

  it("fails on a duplicate or unknown cell receipt", () => {
    const receipts = allPass();
    expect(verifyQualification({ receipts: [...receipts, receipts[0]], ...RUN }).problems).toContain("duplicate receipt for v1-1.18.29:s1:1");
    expect(verifyQualification({ receipts: [...receipts, receipts[0]], ...RUN }).status).toBe("failed");
    const unknown = { ...receipts[0], cellId: "v2-2.0.32:probe:1" };
    expect(verifyQualification({ receipts: [...receipts, unknown], ...RUN }).problems).toContain("receipt for unexpected cell v2-2.0.32:probe:1");
  });

  it("fails when any gating cell did not pass, but records observational verdicts without gating on them", () => {
    const receipts = allPass();
    receipts[1] = { ...receipts[1], verdict: "FAIL" };
    const failed = verifyQualification({ receipts, ...RUN });
    expect(failed.status).toBe("failed");
    expect(failed.problems).toContain(`gating cell ${receipts[1].cellId} verdict FAIL`);

    const observational = allPass().map((receipt: { cellId: string }) => (receipt.cellId.includes(":obs-ask:") ? { ...receipt, verdict: "FAIL" } : receipt));
    expect(verifyQualification({ receipts: observational, ...RUN }).status).toBe("complete");
  });

  it("rejects spike receipts and receipts from another run, archive, or image", () => {
    const receipts = allPass();
    for (const [field, value, message] of [
      ["runKind", "spike", "not a qualification receipt"],
      ["runId", "run-0", "stale receipt (runId)"],
      ["archiveSha256", "c".repeat(64), "stale receipt (archive)"],
      ["imageId", "sha256:" + "9".repeat(64), "stale receipt (image)"],
    ] as const) {
      const mutated = [...receipts];
      mutated[0] = { ...mutated[0], [field]: value };
      const report = verifyQualification({ receipts: mutated, ...RUN });
      expect(report.status).not.toBe("complete");
      expect(report.problems.join("\n")).toContain(message);
    }
  });

  it("rejects a receipt whose class disagrees with the expected cell class", () => {
    const receipts = allPass();
    receipts[0] = { ...receipts[0], cellClass: "observational" };
    expect(verifyQualification({ receipts, ...RUN }).problems).toContain("receipt class mismatch for v1-1.18.29:s1:1");
  });

  it("requires every V1 receipt to carry the expected Gate P closure receipt id when one is given", () => {
    const closureReceiptId = "closure-run-1-abcdef012345";
    const withClosure = allPass().map((receipt: { cellId: string }) => (receipt.cellId.startsWith("v1-") ? { ...receipt, closureReceiptId } : receipt));
    expect(verifyQualification({ receipts: withClosure, ...RUN, closureReceiptId }).status).toBe("complete");
    const missing = verifyQualification({ receipts: allPass(), ...RUN, closureReceiptId });
    expect(missing.status).not.toBe("complete");
    expect(missing.problems.join("\n")).toMatch(/v1-1\.18\.29:s1:1: closure receipt/);
    const wrong = withClosure.map((receipt: { closureReceiptId?: string }) => (receipt.closureReceiptId ? { ...receipt, closureReceiptId: "closure-other" } : receipt));
    expect(verifyQualification({ receipts: wrong, ...RUN, closureReceiptId }).status).not.toBe("complete");
  });

  it("states the V1 result scope exactly (frozen peer closure; not a fresh install)", () => {
    expect(V1_RESULT_SCOPE).toBe(
      "V1 result = host version + frozen peer @opencode-ai/plugin 1.19.3 + closure receipt id + local archive 0.3.0. NOT equivalent to a fresh install and NOT host Arborist peer placement. S1 claims only that the import completed. Native msgpackr acceleration is not claimed. Both V1 hosts use the same closure.",
    );
  });

  it("sanitizes secrets and machine paths from summaries", () => {
    expect(
      sanitize({ path: "/Users/me/x", password: "rh-abc", note: "Bearer abcdef" }, { realHome: "/Users/me", repoRoot: null, fixtureRoot: null }),
    ).toEqual({ path: "<HOME>/x", password: "[redacted]", note: "[redacted]" });
  });
});

describe("post-P1b audit (frame-2 MA5): complete requires confirmed cleanup on every receipt", () => {
  it.each([[false], [null], [undefined]])("a receipt with cleanupConfirmed %s is not complete", (value) => {
    const receipts = allPass();
    receipts[7] = { ...receipts[7], cleanupConfirmed: value };
    const report = verifyQualification({ receipts, ...RUN });
    expect(report.status).toBe("failed");
    expect(report.problems).toContain(`${receipts[7].cellId}: cleanup not confirmed`);
  });
});

describe("post-P1b audit (frame-1 Should2): the plan §8 residual UNVERIFIED list is carried verbatim", () => {
  it("lists every residual and the harness residuals", async () => {
    const { PLAN_RESIDUALS } = await import("./report.mjs");
    expect(PLAN_RESIDUALS.unverified).toEqual([
      "other-plugin hook ordering",
      "path normalization",
      "saved approvals + full precedence",
      "recursion hiding under wildcard-allow incl. the aggregator",
      "plugin cleanup/unload, pending create, stop > 5 s",
      "compaction",
      "V2 console/TUI",
      "plugin execute-time guard (unit-only)",
      "late-create / pending-admission races (unit-only)",
    ]);
    expect(PLAN_RESIDUALS.harness.map((entry: { id: string }) => entry.id)).toEqual(["hard-crash-orphans", "escaped-descendants", "version-probe-capture-size", "pid-reuse-window"]);
  });
});
