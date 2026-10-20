// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/consumer-compile.mjs
// Local modifications (see test/PROVENANCE.md): none.
// Strict evaluation of a clean-consumer `tsc` run (spawnSync result shape).
//
// Pass rule: the compiler completed, exited 0, and reported no diagnostics.
// Any error, non-zero exit, signal, spawn error, or timeout fails. There is
// deliberately no baseline or waiver input: a host-types-only baseline may be
// printed to help attribute errors, but it never changes the outcome.

// Any `error TSnnnn:` line, with or without a `file(line,col): ` location, so
// compiler-wide diagnostics such as `error TS5058: ...` are also caught.
const DIAGNOSTIC = /(?:^|\s|:\s)error TS\d+:/;

/** One entry per `error TSnnnn:` diagnostic line; continuation lines dropped. */
export function parseDiagnostics(output) {
  return String(output ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => DIAGNOSTIC.test(line));
}

export function evaluateCompile(result) {
  const reasons = [];
  if (result.error) {
    reasons.push(`compiler did not complete: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
  }
  if (result.signal) reasons.push(`compiler terminated by signal ${result.signal}`);
  if (result.status !== 0 && result.status !== null && result.status !== undefined) {
    reasons.push(`compiler exited with status ${result.status}`);
  }
  if ((result.status === null || result.status === undefined) && !result.signal && !result.error) {
    reasons.push("compiler exit status unavailable");
  }
  const errors = parseDiagnostics(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (errors.length > 0) reasons.push(`${errors.length} compiler error(s) reported`);
  return { ok: reasons.length === 0, reasons, errors };
}
