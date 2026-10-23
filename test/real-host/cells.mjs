// Council real-host cell model (council-only; not copied). A cell is one
// (host, scenario, repetition) run in one fresh container:
//   cellId = <host>:<scenario>:<rep>
// The expected set is defined here, independently of any results, and the
// same allowlist is enforced by the controller, the in-container driver, and
// the report verifier.

export const HOSTS = Object.freeze([
  Object.freeze({ id: "v1-1.18.29", family: "v1", version: "1.18.29" }),
  Object.freeze({ id: "v1-1.19.3", family: "v1", version: "1.19.3" }),
  Object.freeze({ id: "v2-2.0.28", family: "v2", version: "2.0.28" }),
  Object.freeze({ id: "v2-2.0.32", family: "v2", version: "2.0.32" }),
]);

export const GATING_SCENARIOS = Object.freeze(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13"]);
/** Timing scenarios run three pre-planned repetitions (not retries). */
export const REPEATED_SCENARIOS = Object.freeze(new Set(["s3", "s5", "s6", "s7", "s13"]));
export const OBSERVATIONAL_SCENARIO = "obs-ask";
/** Containment-applied version probe (not part of the 94 qualification cells). */
export const PROBE_SCENARIO = "probe";

/**
 * Per-scenario cell deadlines (ms): `driverMs` = the in-container driver's work deadline,
 * `controllerMs` = the controller's attached `docker run` deadline. The ONE table both read
 * (driver, controller, Gate C/D plans). Only S4 differs -- S4 budget option B, user-approved
 * 2026-10-19: S4's councillor budget covers the hosts' default provider-retry worst case
 * (V2 ~101 s incl. jitter; V1 ~78 s), so its cell needs 240 s / 270 s.
 */
export const DEFAULT_CELL_DEADLINES = Object.freeze({ driverMs: 180_000, controllerMs: 210_000 });
export const CELL_DEADLINES = Object.freeze({ s4: Object.freeze({ driverMs: 240_000, controllerMs: 270_000 }) });
export function cellDeadlines(scenario) {
  if (![...GATING_SCENARIOS, OBSERVATIONAL_SCENARIO, PROBE_SCENARIO].includes(scenario)) throw new Error(`unknown scenario ${scenario}`);
  return CELL_DEADLINES[scenario] ?? DEFAULT_CELL_DEADLINES;
}

/** Scenarios the driver runs (P1b: every gating scenario, the observational cell, and the version probe). Anything else is refused. */
export const IMPLEMENTED_SCENARIOS = Object.freeze(new Set([...GATING_SCENARIOS, OBSERVATIONAL_SCENARIO, PROBE_SCENARIO]));

/** Gate C spike: S1, S2 on V2 2.0.32, then V1 1.19.3. */
export const SPIKE_CELLS = Object.freeze(["v2-2.0.32:s1:1", "v2-2.0.32:s2:1", "v1-1.19.3:s1:1", "v1-1.19.3:s2:1"]);

/**
 * S11 diagnostic amendment (opt-in `--gate DIAG`): exactly the V1 1.18.29 version probe, then
 * this one cell. Diagnostic receipts (runKind "diagnostic") never count toward qualification.
 */
export const DIAGNOSTIC_HOST = "v1-1.18.29";
export const DIAGNOSTIC_CELLS = Object.freeze(["v1-1.18.29:s11:1"]);

const HOST_IDS = new Set(HOSTS.map((host) => host.id));
const SCENARIOS = new Set([...GATING_SCENARIOS, OBSERVATIONAL_SCENARIO, PROBE_SCENARIO]);
const CELL_ID = /^([a-z0-9][a-z0-9.-]*):([a-z0-9-]+):([1-9][0-9]*)$/;

export function hostById(id) {
  const host = HOSTS.find((entry) => entry.id === id);
  if (!host) throw new Error(`unknown host ${id}`);
  return host;
}

export function cellId(host, scenario, rep) {
  return `${host}:${scenario}:${rep}`;
}

/** Strict parse; throws on anything not a well-formed cell id of a known host and scenario. */
export function parseCellId(id) {
  const match = typeof id === "string" ? CELL_ID.exec(id) : null;
  if (!match || !HOST_IDS.has(match[1]) || !SCENARIOS.has(match[2])) throw new Error(`invalid cell id: ${JSON.stringify(id)}`);
  const rep = Number(match[3]);
  const maxRep = REPEATED_SCENARIOS.has(match[2]) ? 3 : 1;
  if (rep > maxRep) throw new Error(`invalid cell id: ${JSON.stringify(id)} (repetition ${rep} > ${maxRep})`);
  return { host: match[1], scenario: match[2], rep };
}

/** The full qualification set: 92 gating + 2 observational cells, in run order. */
export function expectedCells() {
  const cells = [];
  for (const host of HOSTS) {
    for (const scenario of GATING_SCENARIOS) {
      const reps = REPEATED_SCENARIOS.has(scenario) ? 3 : 1;
      for (let rep = 1; rep <= reps; rep += 1) cells.push({ id: cellId(host.id, scenario, rep), host: host.id, scenario, rep, class: "gating" });
    }
    if (host.family === "v1") cells.push({ id: cellId(host.id, OBSERVATIONAL_SCENARIO, 1), host: host.id, scenario: OBSERVATIONAL_SCENARIO, rep: 1, class: "observational" });
  }
  return cells;
}

export function probeCell(hostId) {
  return { id: cellId(hostId, PROBE_SCENARIO, 1), host: hostId, scenario: PROBE_SCENARIO, rep: 1, class: "probe" };
}

/**
 * Allowlist + uniqueness check shared by controller, driver, and verifier.
 * `seen` (optional) accumulates ids already accepted in this run.
 */
export function assertAllowedCell(id, allowlist, seen) {
  parseCellId(id);
  if (!allowlist.has(id)) throw new Error(`cell ${id} is not in the allowlist`);
  if (seen) {
    if (seen.has(id)) throw new Error(`duplicate cell id ${id}`);
    seen.add(id);
  }
}
