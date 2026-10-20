// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/consumer-compile.test.ts
// Local modifications (see test/PROVENANCE.md): OWN fixture path renamed to this package.
import { describe, expect, it } from "vitest";

import { evaluateCompile, parseDiagnostics } from "./consumer-compile.mjs";

const UPSTREAM =
  "node_modules/@ai-sdk/provider/dist/index.d.ts(1,29): error TS7016: Could not find a declaration file for module 'json-schema'.";
const OWN = "node_modules/@skwid138/opencode-council/dist/index.d.ts(3,1): error TS2307: Cannot find module 'x'.";

function fake(overrides: Record<string, unknown>) {
  return { status: 0, signal: null, error: undefined, stdout: "", stderr: "", ...overrides };
}

describe("consumer compile evaluation", () => {
  it("passes only a zero exit with no diagnostics", () => {
    expect(evaluateCompile(fake({}))).toEqual({ ok: true, reasons: [], errors: [] });
  });

  it("fails on third-party errors even when they also occur in a host-types-only baseline", () => {
    const result = evaluateCompile(fake({ status: 2, stdout: `${UPSTREAM}\n` }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([UPSTREAM]);
  });

  it("does not accept a baseline or any waiver input", () => {
    expect(evaluateCompile.length).toBe(1);
    const result = evaluateCompile(fake({ status: 2, stdout: UPSTREAM, baseline: [UPSTREAM], waive: [UPSTREAM] }));
    expect(result.ok).toBe(false);
  });

  it("fails on errors in this package's declarations", () => {
    expect(evaluateCompile(fake({ status: 2, stdout: OWN })).ok).toBe(false);
  });

  it("fails on a non-zero exit even without any diagnostics", () => {
    const result = evaluateCompile(fake({ status: 1, stderr: "something went wrong" }));

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("compiler exited with status 1");
  });

  it("fails on a compiler-wide diagnostic without a file location even when the exit status is 0", () => {
    const result = evaluateCompile(fake({ status: 0, stderr: "error TS5058: The specified path does not exist: 'tsconfig.json'.\n" }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["error TS5058: The specified path does not exist: 'tsconfig.json'."]);
  });

  it("fails when diagnostics are reported despite a zero exit", () => {
    expect(evaluateCompile(fake({ status: 0, stdout: UPSTREAM })).ok).toBe(false);
  });

  it("fails when the compiler is killed by a signal", () => {
    const result = evaluateCompile(fake({ status: null, signal: "SIGKILL" }));

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("compiler terminated by signal SIGKILL");
  });

  it("fails on a spawn error or timeout", () => {
    const timeout = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" });
    const result = evaluateCompile(fake({ status: null, signal: "SIGTERM", error: timeout }));

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("compiler did not complete: spawnSync node ETIMEDOUT");
  });

  it("parses multi-line tsc diagnostics into one entry per error", () => {
    expect(parseDiagnostics(`${UPSTREAM}\n  Try \`npm i\`\n${OWN}\n`)).toEqual([UPSTREAM, OWN]);
  });
});
