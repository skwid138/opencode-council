// Council-only (host side; not in the image). S11 diagnostic amendment (plan Amendment A3):
// classifies the opt-in `--gate DIAG` run (V1 1.18.29 version probe, then v1-1.18.29:s11:1)
// into ONE terminal outcome from the controller's batch results. Pure; never spawns.
//
// Outcomes (precedence: cancellation > cleanup uncertainty > frame uncertainty > checks):
//   cancelled                         operator cancellation (either stage)
//   cleanup-uncertain                 container removal / absence / client settlement not confirmed
//   frame-uncertain                   no valid result frame (missing / corrupt / timeout / cap /
//                                     unsettled client / non-zero exit with all checks ok)
//   not-run                           the controller stopped before launching the cell
//   probe-failed                      the version probe did not PASS (S11 never runs)
//   handshake-anonymous-timeout       the anonymous challenge leg timed out (EHTTPTIMEOUT)
//   handshake-authenticated-timeout   the authenticated probe leg timed out (EHTTPTIMEOUT)
//   handshake-failed                  any other handshake failure (leg / code in `detail`)
//   failed-before-handshake           a cell.* failure before collection (fixture .. connect)
//   inconclusive                      a driver.* failure (e.g. deadline): handshake state unknown; or
//                                     an S11 batch that is not exactly the one diagnostic cell (stopped
//                                     at another / duplicate cell, extra records): never a PASS
//   handshake-ok-later-failure        the handshake passed; a later step / predicate failed
//   s11-pass-cleanup-confirmed        S11 PASS, cleanup confirmed, and the batch COMPLETED with exactly
//                                     the one diagnostic cell (only success)
import { DIAGNOSTIC_CELLS, DIAGNOSTIC_HOST, probeCell } from "./cells.mjs";

export const DIAGNOSTIC_SCHEMA = "council-rh-diagnostic/1";
export const DIAGNOSTIC_PASS = "s11-pass-cleanup-confirmed";
export const DIAGNOSTIC_INTERPRETATION =
  "One diagnostic outcome is not causal proof and not qualification evidence (Gate D still requires every one of the 92 gating cells to PASS in a full batch). Before interpreting it, compare the fresh Gate P closure manifest (lockfile sha256 + per-file manifest) with the p1a05 Gate P receipt and report any difference with the outcome.";

const HANDSHAKE_LEG = /^[A-Za-z][A-Za-z0-9_]* (E[A-Z0-9_]+): auth handshake (anonymous|authenticated) leg /;
const HANDSHAKE_RESPONSE = /^[A-Za-z][A-Za-z0-9_]* (EAUTHCHALLENGE|EAUTHREJECTED): /;
const BEFORE_HANDSHAKE = /^cell\.(fixture|seed|provider|config|launch|connect)$/;

const bounded = (value) => String(value ?? "").slice(0, 512);

/** One stage (probe or S11) of the run: null when it passed cleanly (probe only), else the terminal outcome. */
function stageOutcome(run, cellId, stage) {
  const base = { stage, cellId };
  if (!run) return { ...base, outcome: "not-run", detail: "stage not reached", failedChecks: [], cleanupConfirmed: true };
  const record = (run.results ?? []).find((entry) => entry.cellId === cellId) ?? null;
  const cleanupConfirmed = record ? record.cleanup?.ok === true : run.status !== "cancelled" || run.cancelled?.cleanupConfirmed === true;
  if (run.status === "cancelled" || record?.cancelledByOperator === true) return { ...base, outcome: "cancelled", detail: bounded(run.stoppedAt?.reason ?? "cancelled by operator"), failedChecks: [], cleanupConfirmed };
  if (!record) return { ...base, outcome: "not-run", detail: bounded(run.stoppedAt?.reason ?? "no result record"), failedChecks: [], cleanupConfirmed };
  if (!cleanupConfirmed) return { ...base, outcome: "cleanup-uncertain", detail: bounded(record.cleanup?.problem ?? "cleanup not confirmed"), failedChecks: [], cleanupConfirmed };
  // Containment: the S11 batch must be exactly the one diagnostic cell. A batch the controller
  // stopped at another (refused / duplicate) cell is never classified from an earlier record.
  const ids = (run.results ?? []).map((entry) => entry.cellId);
  if (stage === "s11" && (ids.length !== 1 || (run.status !== "completed" && run.stoppedAt?.cellId !== cellId))) {
    return { ...base, outcome: "inconclusive", detail: bounded(`batch ${run.status} at ${run.stoppedAt?.cellId ?? "-"}: ${run.stoppedAt?.reason ?? ""}; records ${ids.join(",")}`), failedChecks: [], cleanupConfirmed };
  }
  const result = record.result;
  if (!result || !Array.isArray(result.checks)) return { ...base, outcome: "frame-uncertain", detail: bounded(record.reason ?? "no valid result frame"), failedChecks: [], cleanupConfirmed };
  const failed = result.checks.filter((check) => check?.ok !== true);
  const failedChecks = failed.map((check) => String(check?.id).slice(0, 64));
  const done = (outcome, detail) => ({ ...base, outcome, detail: bounded(detail), failedChecks, cleanupConfirmed });
  if (record.verdict === "PASS" && failed.length === 0) {
    if (stage === "probe") return null;
    return run.status === "completed" ? done(DIAGNOSTIC_PASS, "") : done("inconclusive", `batch ${run.status} at ${run.stoppedAt?.cellId ?? "-"}: ${run.stoppedAt?.reason ?? ""}`);
  }
  if (failed.length === 0) return done("frame-uncertain", record.reason ?? `verdict ${record.verdict}`);
  if (stage === "probe") return done("probe-failed", `${failed[0].id}: ${failed[0].detail}`);
  for (const check of failed) {
    const detail = String(check.detail ?? "");
    const leg = HANDSHAKE_LEG.exec(detail);
    if (leg) return done(leg[1] === "EHTTPTIMEOUT" ? `handshake-${leg[2]}-timeout` : "handshake-failed", `${check.id}: ${detail}`);
    if (check.id === "cell.collect" && HANDSHAKE_RESPONSE.test(detail)) return done("handshake-failed", `${check.id}: ${detail}`);
  }
  const driver = failed.find((check) => String(check.id).startsWith("driver."));
  if (driver) return done("inconclusive", `${driver.id}: ${driver.detail}`);
  const early = failed.find((check) => BEFORE_HANDSHAKE.test(String(check.id)));
  if (early) return done("failed-before-handshake", `${early.id}: ${early.detail}`);
  return done("handshake-ok-later-failure", `${failed[0].id}: ${failed[0].detail}`);
}

/** `probes` / `batch`: controller runBatch results (`batch` null when S11 never ran). */
export function classifyDiagnostic({ probes, batch = null }) {
  const probe = stageOutcome(probes, probeCell(DIAGNOSTIC_HOST).id, "probe");
  if (probe) return probe;
  return stageOutcome(batch, DIAGNOSTIC_CELLS[0], "s11");
}
