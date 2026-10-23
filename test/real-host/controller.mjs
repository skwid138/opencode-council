// Council-only controller (host side). Runs cells one at a time, one fresh
// container each, through an INJECTED runner. Nothing here spawns Docker itself:
// tests inject a fake; `run.mjs` injects proc-runner.mjs only after every gate
// flag and approval reference is present.
//
// Per cell:
//   1. allowlist + uniqueness (run kind's set; unknown/duplicate -> stop, no Docker);
//   2. attached `docker run` (gates.runArgv) with stdout/stderr caps and the 210 s
//      deadline; the runner resolves only after stdout EOF / exit, or after it killed
//      the client on cap/timeout;
//   3. verdict from the single result frame (timeout / cap / frame problems / cell id
//      mismatch / non-zero exit -> FAIL);
//   4. ALWAYS after (2) settled: `docker rm -f <exact id from --cidfile>`, then verify
//      absence by id + ownership label; any uncertainty -> stop;
//   5. result JSON (already schema-validated in memory) and a receipt are written.
// Stop rules: any non-PASS gating/spike/probe verdict, any harness failure, or any
// cleanup uncertainty stops the batch. An observational cell's FAIL verdict does not.
// Operator termination (`signal` aborted by the first SIGINT/SIGTERM, see run.mjs):
// no new cell is launched; the in-flight attached client is killed (the signal is passed
// to runAttached); the owned container is still removed by exact id and its absence
// verified (bounded deadlines); the cell is recorded FAIL with `cleanupConfirmed`, and
// the batch returns status "cancelled" with { cellId, cleanupConfirmed, detail }.
// The signal is RE-READ after the removal + absence check and after the result write: a
// signal arriving at any of those points still yields "cancelled" (never "completed"), with
// the in-flight cell's identity and whether its cleanup was confirmed. Cleanup commands are
// deliberately NOT given the signal, so a first signal never interrupts targeted removal.
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertAllowedCell, cellDeadlines, DIAGNOSTIC_CELLS, expectedCells, HOSTS, parseCellId, probeCell, SPIKE_CELLS } from "./cells.mjs";
import { parseResultFrame } from "./frame.mjs";
import { absenceArgv, DEADLINES, OUTPUT_CAPS, removeContainerArgv, runArgv } from "./gates.mjs";
import { CLEANUP_SCOPE, CLEANUP_SCOPE_NOTE } from "./proc-runner.mjs";
import { makeReceipt } from "./report.mjs";

/** What a cell's `cleanupConfirmed` covers (never "every started process stopped"). */
export const CELL_CLEANUP_SCOPE = `${CLEANUP_SCOPE}+owned-container`;

export function allowlistFor(runKind) {
  if (runKind === "spike") return new Set(SPIKE_CELLS);
  if (runKind === "diagnostic") return new Set(DIAGNOSTIC_CELLS);
  if (runKind === "qualification") return new Set(expectedCells().map((cell) => cell.id));
  if (runKind === "probe") return new Set(HOSTS.map((host) => probeCell(host.id).id));
  throw new Error(`unknown run kind ${runKind}`);
}

const classOf = (runKind, cellId) => {
  if (runKind === "probe") return "probe";
  if (runKind === "spike") return "spike";
  if (runKind === "diagnostic") return "diagnostic";
  return expectedCells().find((cell) => cell.id === cellId)?.class ?? "gating";
};
const slug = (cellId) => cellId.replaceAll(":", "_");

const exists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

async function removeContainer({ runner, docker, cidfile, runId }) {
  let containerId = "";
  try {
    containerId = (await readFile(cidfile, "utf8")).trim();
  } catch {
    containerId = "";
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(containerId)) return { ok: false, problem: "container id unknown (cidfile missing or invalid); removal cannot be targeted" };
  const removed = await runner.run(removeContainerArgv({ docker, containerId }), { timeoutMs: DEADLINES.containerRemove });
  if (removed.timedOut || removed.status !== 0) return { ok: false, problem: `container removal failed for ${containerId} (status ${removed.status}${removed.timedOut ? ", timed out" : ""})` };
  if (removed.cleanupUncertain === true) return { ok: false, problem: `docker rm process group did not settle (original group not confirmed gone) for ${containerId}` };
  const absence = await runner.run(absenceArgv({ docker, containerId, runId }), { timeoutMs: DEADLINES.absenceVerify });
  if (absence.timedOut || absence.status !== 0) return { ok: false, problem: `container absence not verified for ${containerId}` };
  if (absence.cleanupUncertain === true) return { ok: false, problem: `docker ps process group did not settle (original group not confirmed gone) for ${containerId}` };
  if (String(absence.stdout).trim() !== "") return { ok: false, problem: `container ${containerId} still present after removal` };
  return { ok: true, containerId };
}

function judge(cellId, outcome) {
  if (outcome.timedOut) return { verdict: "FAIL", harness: true, reason: "docker run timed out (partial output ignored)" };
  if (outcome.capExceeded) return { verdict: "FAIL", harness: true, reason: `${outcome.capExceeded} cap exceeded; client killed` };
  const parsed = parseResultFrame(outcome.stdout);
  if (!parsed.ok) return { verdict: "FAIL", harness: true, reason: parsed.error };
  if (parsed.result.cellId !== cellId) return { verdict: "FAIL", harness: true, reason: `result cell id mismatch (${parsed.result.cellId})` };
  if (outcome.exitCode !== 0) return { verdict: "FAIL", harness: true, reason: `container exit code ${outcome.exitCode}`, result: parsed.result };
  // Frame-2 MA4: an infrastructure failure INSIDE a valid frame (driver.* or cell.* checks:
  // host hash, deadline, frame encode, cleanup, collection/launch errors) is a HARNESS failure,
  // whatever the cell class -- an observational cell never hides it.
  const infrastructure = (Array.isArray(parsed.result.checks) ? parsed.result.checks : []).filter((check) => check?.ok !== true && /^(driver|cell)\./.test(String(check?.id))).map((check) => check.id);
  if (infrastructure.length > 0) return { verdict: "FAIL", harness: true, reason: `infrastructure failure: ${infrastructure.join(", ")}`, result: parsed.result };
  return { verdict: parsed.result.verdict, harness: false, reason: parsed.result.verdict === "PASS" ? null : `verdict ${parsed.result.verdict}`, result: parsed.result };
}

/**
 * runner.runAttached(argv, { timeoutMs, stdoutCap, stderrCap }) -> { exitCode, signal, stdout, stderr, timedOut, capExceeded }
 * runner.run(argv, { timeoutMs }) -> { status, stdout, stderr, timedOut }
 */
const defaultWriteRecord = (path, text) => writeFile(path, text, { flag: "wx", mode: 0o600 });

/**
 * `onCleanupUnconfirmed(cellId, problem)` (round-3 Must 2): called SYNCHRONOUSLY as soon as a
 * cell's cleanup is known to be unconfirmed -- before any fallible await (results dir, record
 * write) -- so the gate's cleanup state is right even if the batch then rejects.
 */
export async function runBatch({ runKind, runId, archiveSha256, images, cells, docker, sessionDir, runner, signal = null, writeRecord = defaultWriteRecord, onCleanupUnconfirmed = null }) {
  const allowlist = allowlistFor(runKind);
  const seen = new Set();
  const receipts = [];
  const results = [];
  const stop = (cellId, reason) => ({ status: "stopped", stoppedAt: { cellId, reason }, receipts, results });

  for (const cellId of cells) {
    if (signal?.aborted) return { status: "cancelled", stoppedAt: { cellId, reason: "cancelled by operator before launch" }, cancelled: { cellId: null, cleanupConfirmed: true, cleanupScope: CELL_CLEANUP_SCOPE, cleanupScopeNote: CLEANUP_SCOPE_NOTE, detail: "no container in flight" }, receipts, results };
    try {
      assertAllowedCell(cellId, allowlist, seen);
    } catch (error) {
      return stop(cellId, error.message);
    }
    const { host, scenario } = parseCellId(cellId);
    const imageId = images[host];
    if (!imageId) return stop(cellId, `no image id for host ${host}`);
    const cidfile = join(sessionDir, `${slug(cellId)}.cid`);
    if (await exists(cidfile)) return stop(cellId, `cidfile already exists: ${cidfile}`);

    const outcome = await runner.runAttached(runArgv({ docker, imageId, runId, cellId, cidfile }), {
      // Per-scenario attached-run deadline (cells.mjs; S4: 270 s).
      timeoutMs: cellDeadlines(scenario).controllerMs,
      stdoutCap: OUTPUT_CAPS.stdoutBytes,
      stderrCap: OUTPUT_CAPS.stderrBytes,
      ...(signal ? { signal } : {}),
    });
    let cancelled = outcome.cancelled === true || signal?.aborted === true;
    // The client was group-SIGKILLed but its pipes stayed held past the bound: the client
    // process (group) is not confirmed gone. Never claimed as clean; the container is still removed.
    const clientUncertain = outcome.cleanupUncertain === true;
    const UNSETTLED = "attached docker run client did not settle after group SIGKILL (pipes still held); client cleanup NOT confirmed";
    // Removal only after the attached run settled (EOF/exit, or kill on cap/timeout/cancel, bounded).
    const judged = cancelled
      ? { verdict: "FAIL", harness: true, reason: "cancelled by operator (attached client killed)" }
      : clientUncertain
        ? { verdict: "FAIL", harness: true, reason: UNSETTLED }
        : judge(cellId, outcome);
    const removal = await removeContainer({ runner, docker, cidfile, runId });
    const cleanup = clientUncertain ? { ...removal, ok: false, problem: removal.ok ? UNSETTLED : `${removal.problem}; ${UNSETTLED}` } : removal;
    if (!cleanup.ok) onCleanupUnconfirmed?.(cellId, cleanup.problem);
    // Re-read: a signal during the removal or the absence check still cancels the batch.
    cancelled = cancelled || signal?.aborted === true;

    const closure = judged.result?.closure ?? null;
    const evidence = judged.result?.summary?.evidence ?? null;
    // `cancelledByOperator`: the batch was already cancelled when this record was written.
    const record = { cellId, runKind, runId, imageId, verdict: judged.verdict, reason: judged.reason, cleanup, cancelledByOperator: cancelled, closure, result: judged.result ?? null, stderrBytes: Buffer.byteLength(String(outcome.stderr ?? "")) };
    await mkdir(join(sessionDir, "results"), { recursive: true });
    await writeRecord(join(sessionDir, "results", `${slug(cellId)}.json`), `${JSON.stringify(record, null, 2)}\n`);
    // Re-read again: a signal during the result write cancels too (even after the last cell).
    cancelled = cancelled || signal?.aborted === true;
    results.push(record);
    receipts.push(makeReceipt({ runKind, runId, archiveSha256, imageId, cellId, cellClass: classOf(runKind, cellId), verdict: judged.verdict, resultSha256: null, closureReceiptId: closure?.receiptId ?? null, cleanupConfirmed: cleanup.ok, cleanupScope: CELL_CLEANUP_SCOPE, evidence }));

    if (cancelled) {
      return { status: "cancelled", stoppedAt: { cellId, reason: judged.verdict === "FAIL" && judged.harness ? judged.reason : "cancelled by operator (after the cell settled)" }, cancelled: { cellId, cleanupConfirmed: cleanup.ok, cleanupScope: CELL_CLEANUP_SCOPE, cleanupScopeNote: CLEANUP_SCOPE_NOTE, detail: cleanup.ok ? `container ${cleanup.containerId} removed and absence verified` : cleanup.problem }, receipts, results };
    }
    if (!cleanup.ok) return stop(cellId, cleanup.problem);
    const observational = classOf(runKind, cellId) === "observational";
    if (judged.harness) return stop(cellId, judged.reason);
    if (judged.verdict !== "PASS" && !observational) return stop(cellId, judged.reason);
  }
  return { status: "completed", receipts, results };
}
