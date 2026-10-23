// Council-only. Check helpers shared by the S1/S2 evaluators (scenarios.mjs) and the P1b
// evaluators (scenarios-p1b.mjs). Pure; strict cardinality (no .find() for claims).
import { boundDetail } from "./frame.mjs";

export const REVIEWER_AGENT = "council-plugin-reviewer";
export const AGGREGATOR_AGENT = "council-plugin-aggregator";
export const PROVIDER = "fake";
export const BAD_LEDGER_KINDS = new Set(["unattributed", "unidentified", "unknown-model", "budget-exceeded", "script-exhausted", "rejected-route"]);

// Every failing detail is bounded (2 KiB incl. a sha256 marker) so no single check can blow the frame.
// `precondition: true` marks a target-phase fixture precondition: failing it is INVALID-FIXTURE (= FAIL).
export const check = (id, ok, detail = "", { precondition = false } = {}) => ({ id, ok: Boolean(ok), detail: ok ? "" : boundDetail(detail), ...(precondition ? { precondition: true } : {}) });
export const modelEntries = (evidence) => evidence.ledger.filter((entry) => entry.kind === "model");
export const requestsOf = (evidence, sessionID) => modelEntries(evidence).filter((entry) => entry.sessionID === sessionID);
export const count = (list, value) => list.filter((item) => item === value).length;

/**
 * Every provider request belongs to a known session: the parent, a harness-created role session
 * (P1b), or a listed child. With `joinChildren` (P1b), every request of a listed child is also
 * JOINED to the child's host metadata: its parent header equals the child's listed / created
 * parentID and its model equals the child's metadata model (as S2's request attribution);
 * a missing or conflicting value FAILS.
 */
export function attribution(evidence, { joinChildren = false } = {}) {
  const known = new Set([evidence.parentSessionID, ...Object.values(evidence.roles ?? {}), ...evidence.children.map((child) => child.id)]);
  const children = new Map(evidence.children.map((child) => [child.id, child]));
  const problems = [];
  for (const entry of evidence.ledger) {
    if (BAD_LEDGER_KINDS.has(entry.kind)) problems.push(`provider request #${entry.seq} ${entry.kind}`);
    else if ((entry.kind === "model" || entry.kind === "auxiliary") && !known.has(entry.sessionID)) problems.push(`provider ${entry.kind} request #${entry.seq} from unknown session ${entry.sessionID}`);
    else if (joinChildren && entry.kind === "model" && children.has(entry.sessionID)) {
      const child = children.get(entry.sessionID);
      if (entry.parentSessionID !== child.parentID) problems.push(`request #${entry.seq} parent header ${entry.parentSessionID} != child ${child.id} parent ${child.parentID}`);
      if (entry.model !== child.model?.modelID) problems.push(`request #${entry.seq} model ${entry.model} != child ${child.id} metadata model ${child.model?.modelID}`);
    }
  }
  return check("attribution", problems.length === 0, problems.join("; "));
}

/**
 * Suppression proof: the fixtures disable title generation and auto-compaction (and V2
 * warming), so ANY auxiliary request (title / compaction signature) means suppression failed.
 */
export function auxiliarySuppressed(evidence) {
  const auxiliary = evidence.ledger.filter((entry) => entry.kind === "auxiliary");
  return check("aux-suppressed", auxiliary.length === 0, `unexpected auxiliary requests: ${auxiliary.map((entry) => `#${entry.seq} ${entry.auxiliary ?? entry.classification} (session ${entry.sessionID})`).join("; ")}`);
}
