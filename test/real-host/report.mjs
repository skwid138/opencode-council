// Provenance: ADAPTED (rewritten) from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/report.mjs.
// Retained: the sanitize() redaction approach and the "complete only when every
// required item actually ran and passed" rule. Replaced: the normalizer MATRIX /
// scenario rows with council cells and qualification receipts (test/PROVENANCE.md).
//
// A run is "complete" only when every expected cell (cells.mjs) has exactly one
// receipt of runKind "qualification" from the current runId, archive, and the
// host's current image, and every gating cell passed. Observational cells must
// be present once; their verdict is recorded but does not gate. Anything else
// is "incomplete" (not proven) or "failed" (disproven / inconsistent).
import { expectedCells } from "./cells.mjs";

export const RECEIPT_SCHEMA = "council-rh-receipt/1";

/** Amendment A2: what a V1 result claims (and does not). */
export const V1_RESULT_SCOPE =
  "V1 result = host version + frozen peer @opencode-ai/plugin 1.19.3 + closure receipt id + local archive 0.3.0. NOT equivalent to a fresh install and NOT host Arborist peer placement. S1 claims only that the import completed. Native msgpackr acceleration is not claimed. Both V1 hosts use the same closure.";

/**
 * `cleanupConfirmed` (scope `cleanupScope`): the cell's container was removed by exact id and its
 * absence verified, and the attached client's ORIGINAL process group is gone. Escaped
 * descendants are not covered; no receipt claims every started process stopped.
 * `evidence`: the bounded evidence object from the result frame (summary.evidence), persisted
 * so a receipt alone shows what a PASS rests on (null when the cell produced none).
 */
export function makeReceipt({ runKind, runId, archiveSha256, imageId, cellId, cellClass, verdict, resultSha256, closureReceiptId = null, cleanupConfirmed = null, cleanupScope = null, evidence = null }) {
  return { schema: RECEIPT_SCHEMA, runKind, runId, archiveSha256, imageId, cellId, cellClass, verdict, resultSha256, closureReceiptId, cleanupConfirmed, cleanupScope, evidence };
}

/**
 * Plan §8 "Risks and open questions": the residual UNVERIFIED list (verbatim) and the harness
 * residuals, carried by every Gate D report so a "complete" result never reads as covering them.
 */
export const PLAN_RESIDUALS = Object.freeze({
  unverified: Object.freeze([
    "other-plugin hook ordering",
    "path normalization",
    "saved approvals + full precedence",
    "recursion hiding under wildcard-allow incl. the aggregator",
    "plugin cleanup/unload, pending create, stop > 5 s",
    "compaction",
    "V2 console/TUI",
    "plugin execute-time guard (unit-only)",
    "late-create / pending-admission races (unit-only)",
  ]),
  harness: Object.freeze([
    Object.freeze({ id: "hard-crash-orphans", text: "every harness child runs in its own detached process group; there is no parent-death handling, so a hard-killed harness can orphan those groups (an attached docker run client could leave a container running). Recovery: list by the owner label (council-rh.owner=<run>) and remove by exact id." }),
    Object.freeze({ id: "escaped-descendants", text: "a descendant that leaves the original process group and does not hold the harness pipes is not tracked; every cleanup claim is scoped (cleanupScope) and no result claims that every started process stopped." }),
    Object.freeze({ id: "version-probe-capture-size", text: "the probe's stdout/stderr files are bounded only by the /scratch tmpfs (512 MiB) and the probe timeout; the 4 KiB cap applies to what is read back as evidence." }),
    Object.freeze({ id: "pid-reuse-window", text: "between the leader being reaped and the final ESRCH probe a reused pid could theoretically name an unrelated group (accepted residual)." }),
  ]),
});

export function verifyQualification({ receipts, runId, archiveSha256, imageIds, closureReceiptId = null, expected = expectedCells() }) {
  const problems = [];
  let failed = false;
  const expectedById = new Map(expected.map((cell) => [cell.id, cell]));
  const accepted = new Map();
  for (const receipt of receipts) {
    const id = receipt?.cellId;
    const cell = expectedById.get(id);
    if (!cell) {
      problems.push(`receipt for unexpected cell ${id}`);
      failed = true;
      continue;
    }
    if (receipt.schema !== RECEIPT_SCHEMA) {
      problems.push(`malformed receipt for ${id}`);
      continue;
    }
    if (receipt.runKind !== "qualification") {
      problems.push(`${id}: not a qualification receipt (${receipt.runKind})`);
      continue;
    }
    if (receipt.runId !== runId) {
      problems.push(`${id}: stale receipt (runId)`);
      continue;
    }
    if (receipt.archiveSha256 !== archiveSha256) {
      problems.push(`${id}: stale receipt (archive)`);
      continue;
    }
    if (receipt.imageId !== imageIds[cell.host]) {
      problems.push(`${id}: stale receipt (image)`);
      continue;
    }
    if (closureReceiptId !== null && cell.host.startsWith("v1-") && receipt.closureReceiptId !== closureReceiptId) {
      problems.push(`${id}: closure receipt ${receipt.closureReceiptId} != ${closureReceiptId}`);
      continue;
    }
    // Frame-2 MA5: a cell whose container removal / client settlement was not confirmed is
    // never part of a complete run (cleanup uncertainty = FAIL + stop in the plan).
    if (receipt.cleanupConfirmed !== true) {
      problems.push(`${id}: cleanup not confirmed`);
      failed = true;
      continue;
    }
    if (receipt.cellClass !== cell.class) {
      problems.push(`receipt class mismatch for ${id}`);
      failed = true;
      continue;
    }
    if (accepted.has(id)) {
      problems.push(`duplicate receipt for ${id}`);
      failed = true;
      continue;
    }
    accepted.set(id, receipt);
  }
  let passed = 0;
  for (const cell of expected) {
    const receipt = accepted.get(cell.id);
    if (!receipt) {
      problems.push(`missing cell ${cell.id}`);
      continue;
    }
    if (receipt.verdict === "PASS") passed += 1;
    else if (cell.class === "gating") {
      problems.push(`gating cell ${cell.id} verdict ${receipt.verdict}`);
      failed = true;
    }
  }
  const counts = {
    gating: expected.filter((cell) => cell.class === "gating").length,
    observational: expected.filter((cell) => cell.class === "observational").length,
    passed,
  };
  const status = failed ? "failed" : problems.length > 0 ? "incomplete" : "complete";
  return { status, problems, counts };
}

const SECRET_KEY = /(token|secret|password|passwd|authorization|cookie|api[-_]?key|credential)/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|rh-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/;

/** Redacts secret-shaped keys/values and replaces machine paths with placeholders. */
export function sanitize(value, { realHome, repoRoot, fixtureRoot, secrets = [] }) {
  const replacements = [
    ...secrets.filter((secret) => typeof secret === "string" && secret.length >= 8).map((secret) => [secret, "[redacted]"]),
    [fixtureRoot, "<FIXTURE>"],
    [repoRoot, "<REPO>"],
    [realHome, "<HOME>"],
  ].filter(([from]) => typeof from === "string" && from.length > 1);
  const visit = (current) => {
    if (typeof current === "string") {
      if (SECRET_VALUE.test(current)) return "[redacted]";
      let out = current;
      for (const [from, to] of replacements) out = out.split(from).join(to);
      return out;
    }
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, inner]) => [key, SECRET_KEY.test(key) ? "[redacted]" : visit(inner)]));
    }
    return current;
  };
  return visit(value);
}
