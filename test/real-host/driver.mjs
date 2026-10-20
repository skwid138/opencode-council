#!/usr/bin/env node
// Council-only in-container driver (ENTRYPOINT ["/usr/local/bin/node","/opt/council-rh/driver.mjs"], argv = cellId).
//
// Contract with the controller:
//   - stdout carries exactly one line, the final result frame (frame.mjs); every
//     diagnostic goes to stderr;
//   - the cell id must be in the baked allowlist (cells.json) for this image's host;
//   - the host executable's sha256 is verified against the image manifest before
//     any launch (mismatch -> FAIL, nothing launched);
//   - the driver owns a 180 s work deadline: on expiry the cell's signal aborts,
//     the cell gets a short cleanup grace, and the result is FAIL either way.
// The frame is written in a single write call, once.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { cellDeadlines, IMPLEMENTED_SCENARIOS, parseCellId } from "./cells.mjs";
import { boundDetail, encodeFrame, RESULT_SCHEMA } from "./frame.mjs";

/** Default work deadline; the per-cell value is cells.mjs cellDeadlines(scenario).driverMs (S4: 240 s). */
export const DRIVER_DEADLINE_MS = 180_000;
export const CLEANUP_GRACE_MS = 10_000;
/**
 * The cell's own waits end this long before the driver deadline (runCell gets the absolute
 * `deadlineAt`), so a slow cell fails ITSELF and cleans up (stop host, close provider and
 * listeners) before the driver's deadline abort is needed.
 */
export const WORK_MARGIN_MS = 20_000;
const IMAGE_ROOT = "/opt/council-rh";

const fail = (id, detail) => ({ verdict: "FAIL", checks: [{ id, ok: false, detail }] });
const errorClass = (error) => {
  const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? ` ${error.code}` : "";
  return `${name}${code}`;
};

async function withDeadline(run, { deadlineMs, cleanupGraceMs, timers = globalThis }) {
  const controller = new AbortController();
  const work = Promise.resolve().then(() => run(controller.signal));
  work.catch(() => {});
  let timer;
  const deadline = new Promise((resolve) => {
    timer = timers.setTimeout(() => resolve("deadline"), deadlineMs);
  });
  const first = await Promise.race([work.then(() => "done", () => "done"), deadline]);
  timers.clearTimeout(timer);
  if (first === "done") return { timedOut: false, work };
  controller.abort();
  let graceTimer;
  const grace = new Promise((resolve) => {
    graceTimer = timers.setTimeout(() => resolve("grace-expired"), cleanupGraceMs);
  });
  const settled = await Promise.race([work.then(() => "settled", () => "settled"), grace]);
  timers.clearTimeout(graceTimer);
  return { timedOut: true, cleanupConfirmed: settled === "settled" };
}

/** Returns the process exit code. Writes exactly one frame to `stdout`. */
export async function runDriver({ argv, loadManifest, loadCells, hashFile, runCell, stdout, stderr = () => {}, deadlineMs, cleanupGraceMs = CLEANUP_GRACE_MS, now = Date.now }) {
  const started = now();
  let written = false;
  const cellId = typeof argv?.[0] === "string" ? argv[0] : "";
  let host = { id: null, executableSha256: null };
  // Amendment A2: the image's Gate P closure identity rides in every result (null for V2).
  let closure = null;
  const emit = (outcome) => {
    if (written) return;
    const checks = (Array.isArray(outcome.checks) ? outcome.checks : []).map((entry) => (entry && typeof entry === "object" ? { ...entry, detail: boundDetail(entry.detail) } : entry));
    const verdict = outcome.verdict === "PASS" && checks.length > 0 && checks.every((entry) => entry.ok === true) ? "PASS" : outcome.verdict === "INVALID-FIXTURE" ? "INVALID-FIXTURE" : "FAIL";
    let frame;
    try {
      frame = encodeFrame({ schema: RESULT_SCHEMA, cellId, verdict, checks, host, closure, durationMs: now() - started, ...(outcome.summary ? { summary: outcome.summary } : {}) });
    } catch (error) {
      // Too large (or unencodable): a bounded fallback FAIL frame that states why.
      frame = encodeFrame({ schema: RESULT_SCHEMA, cellId, verdict: "FAIL", checks: [{ id: "driver.frame-encode", ok: false, detail: boundDetail(`result could not be encoded: ${error instanceof Error ? error.message : String(error)}`) }], host, closure, durationMs: now() - started });
    }
    // Only after a successful encode: a failed encode never leaves the driver "written" without a frame.
    stdout(frame);
    written = true;
  };

  try {
    if (!Array.isArray(argv) || argv.length !== 1) {
      emit(fail("driver.argv", `expected exactly one argument (the cell id), got ${Array.isArray(argv) ? argv.length : 0}`));
      return 0;
    }
    const manifest = await loadManifest();
    host = { id: manifest.host.id, executableSha256: manifest.host.executableSha256 };
    closure = manifest.closure ?? null;
    let cell;
    try {
      cell = parseCellId(cellId);
      const allowed = new Set(await loadCells());
      if (!allowed.has(cellId)) throw new Error(`cell ${cellId} is not in this image's allowlist`);
      if (cell.host !== manifest.host.id) throw new Error(`cell ${cellId} is not for this image's host ${manifest.host.id}`);
    } catch (error) {
      emit(fail("driver.allowlist", error instanceof Error ? error.message.slice(0, 256) : "refused"));
      return 0;
    }
    if (!IMPLEMENTED_SCENARIOS.has(cell.scenario)) {
      emit(fail("driver.implemented", `scenario ${cell.scenario} is not implemented`));
      return 0;
    }
    const actual = await hashFile(manifest.host.executablePath);
    if (actual !== manifest.host.executableSha256) {
      emit(fail("driver.host-hash", `host executable sha256 ${actual} != manifest ${manifest.host.executableSha256}; not launched`));
      return 0;
    }
    // Per-scenario work deadline (tests may inject `deadlineMs`).
    const workMs = deadlineMs ?? cellDeadlines(cell.scenario).driverMs;
    const deadlineAt = started + workMs - WORK_MARGIN_MS;
    const outcome = await withDeadline((signal) => runCell({ cell: { ...cell, id: cellId }, manifest, signal, stderr, deadlineAt }), { deadlineMs: workMs, cleanupGraceMs });
    if (outcome.timedOut) {
      emit({
        verdict: "FAIL",
        checks: [
          { id: "driver.deadline", ok: false, detail: `cell exceeded the ${workMs} ms work deadline` },
          ...(outcome.cleanupConfirmed ? [] : [{ id: "driver.cleanup-unconfirmed", ok: false, detail: `cell did not settle within ${cleanupGraceMs} ms after abort` }]),
        ],
      });
      return 0;
    }
    try {
      emit(await outcome.work);
    } catch (error) {
      emit(fail("driver.cell-error", errorClass(error)));
    }
    return 0;
  } catch (error) {
    stderr(`driver error: ${errorClass(error)}\n`);
    emit(fail("driver.error", errorClass(error)));
    return 0;
  }
}

/**
 * Frame-2 MA1: after the frame, flush stdout and EXIT -- a cell that did not settle within the
 * cleanup grace may still hold handles (host process, sockets, timers); exiting ends the
 * container (tini as PID 1), so nothing outlives the driver.
 */
export async function exitAfterFlush(code, { flush, exit }) {
  await flush();
  exit(code);
}

async function main() {
  const { runCell } = await import("./runner.mjs");
  const code = await runDriver({
    argv: process.argv.slice(2),
    loadManifest: async () => JSON.parse(await readFile(`${IMAGE_ROOT}/image-manifest.json`, "utf8")),
    loadCells: async () => JSON.parse(await readFile(`${IMAGE_ROOT}/cells.json`, "utf8")),
    hashFile: async (path) => createHash("sha256").update(await readFile(path)).digest("hex"),
    runCell,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  await exitAfterFlush(code, { flush: () => new Promise((resolve) => process.stdout.write("", () => resolve())), exit: (value) => process.exit(value) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
