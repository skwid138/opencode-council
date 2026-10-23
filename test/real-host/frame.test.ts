import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { encodeFrame, FRAME_PREFIX, MAX_RESULT_BYTES, parseResultFrame, resultProblems } from "./frame.mjs";

const result = (overrides: Record<string, unknown> = {}) => ({
  schema: "council-rh-result/1",
  cellId: "v2-2.0.32:s1:1",
  verdict: "PASS",
  checks: [{ id: "s1.parent-advertises", ok: true, detail: "" }],
  host: { id: "v2-2.0.32", executableSha256: "a".repeat(64) },
  durationMs: 1234,
  ...overrides,
});

describe("result frame", () => {
  it("round-trips one frame as the final stdout line", () => {
    const line = encodeFrame(result());
    expect(line.startsWith(`${FRAME_PREFIX} `)).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseResultFrame(line)).toEqual({ ok: true, result: result() });
  });

  it("carries the sha256 of the exact JSON bytes", () => {
    const [, b64, digest] = encodeFrame(result()).trim().split(" ");
    const json = Buffer.from(b64, "base64");
    expect(createHash("sha256").update(json).digest("hex")).toBe(digest);
  });

  const failsWith = (stdout: string, message: RegExp) => {
    const parsed = parseResultFrame(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(message);
  };

  it("rejects missing, duplicate, non-final, and stray stdout", () => {
    failsWith("", /missing result frame/);
    failsWith(encodeFrame(result()) + encodeFrame(result()), /expected exactly one result frame/);
    failsWith(`noise\n${encodeFrame(result())}`, /stdout must contain only the result frame/);
    failsWith(`${encodeFrame(result())}trailing\n`, /stdout must contain only the result frame/);
    failsWith(encodeFrame(result()).trimEnd(), /must end with a newline/);
  });

  it("rejects a corrupt digest, bad base64, and non-JSON", () => {
    const [prefix, b64] = encodeFrame(result()).trim().split(" ");
    failsWith(`${prefix} ${b64} ${"0".repeat(64)}\n`, /digest mismatch/);
    failsWith(`${prefix} not*base64 ${"0".repeat(64)}\n`, /malformed result frame/);
    const garbage = Buffer.from("{not json");
    failsWith(`${prefix} ${garbage.toString("base64")} ${createHash("sha256").update(garbage).digest("hex")}\n`, /not JSON/);
  });

  it("rejects oversized results", () => {
    const big = Buffer.from(JSON.stringify(result({ pad: "x".repeat(MAX_RESULT_BYTES) })));
    failsWith(`${FRAME_PREFIX} ${big.toString("base64")} ${createHash("sha256").update(big).digest("hex")}\n`, /exceeds/);
    expect(() => encodeFrame(result({ pad: "x".repeat(MAX_RESULT_BYTES) }))).toThrow(/exceeds/);
  });

  it("validates the result schema", () => {
    expect(resultProblems(result())).toEqual([]);
    expect(resultProblems(result({ verdict: "MAYBE" }))).toContain("verdict must be PASS, FAIL, or INVALID-FIXTURE");
    expect(resultProblems(result({ cellId: "nope" }))).toContain("cellId is not a valid cell id");
    expect(resultProblems(result({ checks: [{ id: 1 }] }))).toContain("checks[0] is malformed");
    expect(resultProblems(result({ schema: "other" }))).toContain("schema must be council-rh-result/1");
    expect(resultProblems(result({ verdict: "PASS", checks: [{ id: "x", ok: false, detail: "" }] }))).toContain("PASS verdict with a failed check");
    expect(resultProblems(result({ verdict: "PASS", checks: [] }))).toContain("PASS verdict with no checks");
  });
});
