// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/provider-evidence.mjs
// Local modifications (see test/PROVENANCE.md): sandbox-profile capture is optional (council's fake provider runs in-process in the driver; no sandbox profile exists on Linux).
// Bounded, provider-only launch evidence (Amendment A3).
//
// Explicit fields only: nothing here spreads a provider, config, spawn-option,
// or host-env object, and nothing relies on key-based JSON redaction. The
// intended launch (label, argv, cwd, the nine-key minimal env, and the actual
// generated profile bytes) is captured BEFORE spawn, so a failed spawn is still
// represented and no pid is fabricated. Later facts (acquisition, startup
// outcome, the launcher's exit event, the raw stop result) are recorded in
// memory by calls that never throw, so evidence can never take cleanup
// authority away from the caller.
//
// Excluded by construction: provider config contents, identity tokens and
// identity response bodies, ledger contents, host auth headers and passwords,
// and arbitrary error messages (errors are a bounded name/code only).
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { BASE_KEYS } from "./env.mjs";

/** Approved capture limits. Profile text is governed by its own 64 KiB cap, not the per-string limit. */
export const PROVIDER_EVIDENCE_LIMITS = Object.freeze({ maxArgv: 16, maxStringBytes: 4096, maxProfileBytes: 65536, maxRecordsPerFixture: 32, maxCaptureFailures: 32 });
/** The provider's minimal env: exactly these nine keys (env.mjs BASE_KEYS). */
export const PROVIDER_ENV_KEYS = Object.freeze([...BASE_KEYS]);

class ProviderEvidenceError extends Error {
  constructor(reason) {
    super(`provider launch evidence capture failed: ${reason}`);
    this.name = "ProviderEvidenceError";
    this.reason = reason;
  }
}

/** Reads at most maxBytes + 1 bytes; a larger file is refused before it is captured. */
export async function readBoundedFile(path, maxBytes = PROVIDER_EVIDENCE_LIMITS.maxProfileBytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
      if (filled > maxBytes) throw Object.assign(new Error(`profile exceeds ${maxBytes} bytes`), { code: "E2BIG" });
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

const utf8Bytes = (value) => Buffer.byteLength(value, "utf8");
const BOUNDED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function stringProblem(name, value) {
  if (typeof value !== "string") return `${name} is not a string`;
  const bytes = utf8Bytes(value);
  if (bytes > PROVIDER_EVIDENCE_LIMITS.maxStringBytes) return `${name} is ${bytes} UTF-8 bytes (limit ${PROVIDER_EVIDENCE_LIMITS.maxStringBytes})`;
  return null;
}

function launchProblem({ label, argv, cwd, env }) {
  const labelProblem = stringProblem("label", label);
  if (labelProblem) return labelProblem;
  if (!Array.isArray(argv)) return "argv is not an array";
  if (argv.length > PROVIDER_EVIDENCE_LIMITS.maxArgv) return `argv has ${argv.length} elements (limit ${PROVIDER_EVIDENCE_LIMITS.maxArgv})`;
  for (const [index, element] of argv.entries()) {
    const problem = stringProblem(`argv[${index}]`, element);
    if (problem) return problem;
  }
  const cwdProblem = stringProblem("cwd", cwd);
  if (cwdProblem) return cwdProblem;
  if (!env || typeof env !== "object" || Array.isArray(env)) return "env is not an object";
  for (const key of Object.keys(env)) if (!PROVIDER_ENV_KEYS.includes(key)) return `env key ${/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ? key : "(invalid)"} is not a provider env key`;
  for (const key of PROVIDER_ENV_KEYS) {
    if (!Object.hasOwn(env, key)) return `env key ${key} is missing`;
    const problem = stringProblem(`env.${key}`, env[key]);
    if (problem) return problem;
  }
  return null;
}

export function createProviderEvidence({ readProfile = readBoundedFile } = {}) {
  /** root -> { launches, captureFailures, captureFailuresDropped } */
  const byRoot = new Map();
  const entryFor = (root) => {
    if (!byRoot.has(root)) byRoot.set(root, { launches: [], captureFailures: [], captureFailuresDropped: 0 });
    return byRoot.get(root);
  };
  const fail = (entry, label, reason) => {
    if (entry.captureFailures.length < PROVIDER_EVIDENCE_LIMITS.maxCaptureFailures) {
      entry.captureFailures.push({ label: stringProblem("label", label) ? "(invalid label)" : label, reason });
    } else entry.captureFailuresDropped += 1;
    throw new ProviderEvidenceError(reason);
  };

  return {
    /**
     * Captures the intended launch before spawn and returns its record. Invalid or oversized
     * evidence is an explicit capture failure (thrown before any launch), never a truncation.
     */
    async begin(root, { label, argv, cwd, env, profilePath, redactProfileText }) {
      const entry = entryFor(root);
      if (entry.launches.length >= PROVIDER_EVIDENCE_LIMITS.maxRecordsPerFixture) fail(entry, label, `provider launch record limit ${PROVIDER_EVIDENCE_LIMITS.maxRecordsPerFixture} reached`);
      const problem = launchProblem({ label, argv, cwd, env });
      if (problem) fail(entry, label, problem);
      // Council adaptation: with no sandbox profile (in-process provider), nothing is read.
      if (profilePath === undefined) {
        const record = {
          role: "provider",
          label,
          intended: { argv: [...argv], cwd, env: Object.fromEntries(PROVIDER_ENV_KEYS.map((key) => [key, env[key]])) },
          profile: null,
          acquisition: { outcome: "not-started" },
          startup: null,
          exit: null,
          stop: null,
        };
        entry.launches.push(record);
        return record;
      }
      let raw;
      try {
        raw = await readProfile(profilePath, PROVIDER_EVIDENCE_LIMITS.maxProfileBytes);
      } catch (error) {
        fail(entry, label, error?.code === "E2BIG" ? `profile exceeds ${PROVIDER_EVIDENCE_LIMITS.maxProfileBytes} bytes` : `profile unreadable (${BOUNDED_CODE.test(error?.code ?? "") ? error.code : "unknown"})`);
      }
      if (!Buffer.isBuffer(raw) || raw.length > PROVIDER_EVIDENCE_LIMITS.maxProfileBytes) fail(entry, label, `profile exceeds ${PROVIDER_EVIDENCE_LIMITS.maxProfileBytes} bytes`);
      const text = redactProfileText(raw.toString("utf8"));
      if (typeof text !== "string" || utf8Bytes(text) > PROVIDER_EVIDENCE_LIMITS.maxProfileBytes) fail(entry, label, `redacted profile text exceeds ${PROVIDER_EVIDENCE_LIMITS.maxProfileBytes} bytes`);
      const record = {
        role: "provider",
        label,
        intended: { argv: [...argv], cwd, env: Object.fromEntries(PROVIDER_ENV_KEYS.map((key) => [key, env[key]])) },
        profile: {
          sha256: createHash("sha256").update(raw).digest("hex"),
          bytes: raw.length,
          digestOf: "raw profile bytes used for this launch",
          text,
          textNote: "path-redacted diagnostic text; not replayable; sha256 is of the raw bytes, not of this text",
        },
        acquisition: { outcome: "not-started" },
        startup: null,
        exit: null,
        stop: null,
      };
      entry.launches.push(record);
      return record;
    },

    /** Plain, structured copy of the fixture's provider evidence. */
    report(root) {
      return structuredClone(byRoot.get(root) ?? { launches: [], captureFailures: [], captureFailuresDropped: 0 });
    },

    /** The direct owned launcher exists: pid/pgid, plus its exit event whenever it arrives. Never throws. */
    acquired(record, owned) {
      try {
        record.acquisition = { outcome: "acquired", pid: integer(owned.pid), pgid: integer(owned.pgid) };
      } catch {
        record.acquisition = { outcome: "acquired", evidence: "unavailable" };
      }
      try {
        const exited = owned.exited;
        if (exited && typeof exited.then === "function") {
          exited.then(
            (value) => {
              try {
                record.exit = { event: "exit", code: integer(value?.code), signal: signalName(value?.signal) };
              } catch {
                record.exit = { event: "exit", evidence: "unavailable" };
              }
            },
            () => undefined,
          );
        }
      } catch {
        record.exit = { event: "exit", evidence: "unavailable" };
      }
    },

    /** Spawn never produced an owned launcher (no pid is fabricated). Never throws; never erases an acquisition. */
    spawnFailed(record, error) {
      if (record.acquisition?.outcome === "acquired") return;
      record.acquisition = { outcome: "spawn-failed", error: errorSummary(error) };
    },

    /** The shared startup wait's outcome. Never throws. */
    startup(record, result) {
      record.startup = { outcome: STARTUP_OUTCOMES.includes(result?.outcome) ? result.outcome : "unknown" };
    },

    /** The raw stop result, recorded before any termination check. Never throws. */
    stopReturned(record, result) {
      try {
        record.stop = {
          outcome: "returned",
          pgid: integer(result?.pgid),
          termSent: boolean(result?.termSent),
          killSent: boolean(result?.killSent),
          aliveAfter: boolean(result?.aliveAfter),
          unsafe: boolean(result?.unsafe),
          alreadyGone: boolean(result?.alreadyGone),
        };
      } catch {
        record.stop = { outcome: "returned", evidence: "unavailable" };
      }
    },

    /** A stop that rejected: a bounded name/code only, never the message. Never throws. */
    stopRejected(record, error) {
      record.stop = { outcome: "rejected", error: errorSummary(error) };
    },
  };
}

const STARTUP_OUTCOMES = ["ready", "exited-before-ready", "startup-timeout", "work-aborted", "wait-failed"];
const integer = (value) => (Number.isSafeInteger(value) ? value : null);
const boolean = (value) => (typeof value === "boolean" ? value : null);
const signalName = (value) => (typeof value === "string" && /^SIG[A-Z0-9]{1,16}$/.test(value) ? value : null);

/** A bounded error description: name and code only, never the message. */
export function errorSummary(error) {
  try {
    const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "unknown";
    const code = typeof error?.code === "string" && BOUNDED_CODE.test(error.code) ? error.code : null;
    return { name, code };
  } catch {
    return { name: "unknown", code: null };
  }
}
