#!/usr/bin/env node
// Council real-host qualification CLI (`npm run test:real-host`). NOT run by CI or
// `npm test`. Every gate needs its own explicit user approval; this CLI refuses
// to execute anything without --gate, --run-id, an absolute --session-dir, and an
// --approval <reference>. `--print-plan` prints the exact argv (JSON) and executes
// nothing (no approval needed for that).
//
//   --gate A  acquisition: one `env -i curl` per host (acquire.mjs) into --staging-dir
//   --gate P  frozen V1 peer closure: one pinned `npm install` of @opencode-ai/plugin@1.19.3
//             into $S/closure (closure.mjs, Amendment A2); writes $S/gate-p-<run>.json
//   --gate B  Gate P receipt check (before any docker call) + base-image inspection +
//             definitive tag-absence check + COPY-only build per host (V1 contexts get the
//             closure); writes $S/gate-b-<run>.json (accepted, or failed with stage/problem)
//   --gate C  Gate B receipt check + image id/label verification (docker image inspect),
//             then version probes, then S1/S2 on V2 2.0.32 then V1 1.19.3
//   --gate D  full qualification batch (P1b): Gate B (B') receipt check for all four hosts +
//             image verification, version probes for all four hosts, then the 94 expected
//             cells (cells.mjs) as runKind "qualification", then the report verifier
//             (report.mjs verifyQualification); writes $S/gate-d-{probes,qualification,report}-<run>.json
//   --gate DIAG  opt-in S11 diagnostic (plan Amendment A3): Gate B receipt check + verification of
//             the V1 1.18.29 image only, its version probe, then exactly v1-1.18.29:s11:1 as
//             runKind "diagnostic" (cells.mjs DIAGNOSTIC_CELLS); writes
//             $S/gate-diag-{probes,diagnostic}-<run>.json and the TERMINAL outcome receipt
//             $S/gate-diag-<run>.json (diagnostic.mjs). Never a Gate D report, never removes images,
//             never counts toward qualification. Exit 0 only for s11-pass-cleanup-confirmed.
//
// Docker gates use fresh per-gate CLI dirs ($S/docker-config-<g>, $S/docker-home-<g>):
// refused if present, created 0700, verified empty right before the first docker call.
//
// Operator termination (signals.mjs, installed for every executed gate): the first
// SIGINT/SIGTERM aborts the run signal and kills the attached client; Gate C then removes
// the owned container by exact id and verifies absence (bounded), launches nothing new,
// writes $S/gate-<g>-cancelled-<run>.json recording whether cleanup was confirmed, and
// exits 130. A second signal exits 130 immediately and records cleanup as unconfirmed.
//
// Real runners (proc-runner.mjs) are constructed only after every check passed.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { acquireHost, ARTIFACTS, curlArgv } from "./acquire.mjs";
import { cellDeadlines, DIAGNOSTIC_CELLS, DIAGNOSTIC_HOST, expectedCells, HOSTS, parseCellId, probeCell, SPIKE_CELLS } from "./cells.mjs";
import { allowlistFor, CELL_CLEANUP_SCOPE, runBatch } from "./controller.mjs";
import { ARCHIVE_LABEL, BASE_IMAGE_ID, buildArgv, classifyTagAbsence, DEADLINES, dockerEnv, HOST_LABEL, IMAGE_MANIFEST_LABEL, imageTag, inspectArgv, OWNER_LABEL, removeImageArgv, runArgv, validateBaseImageInspect, verifyBuiltImage } from "./gates.mjs";
import { assembleImageContext } from "./image-context.mjs";
import { checkGatePReceipt, closureArgv, closureConfigFiles, closureEnv, closurePackageJson, GATE_P_TIMEOUT_MS, NPM_CLI, PACOTE_RETRY_AUTHORIZATION, readNpmVersion, runGateP } from "./closure.mjs";
import { classifyDiagnostic, DIAGNOSTIC_INTERPRETATION, DIAGNOSTIC_PASS, DIAGNOSTIC_SCHEMA } from "./diagnostic.mjs";
import { dockerDirs, prepareDockerDirs, verifyDockerDirsEmpty } from "./docker-session.mjs";
import { CLEANUP_SCOPE, CLEANUP_SCOPE_NOTE, createProcRunner } from "./proc-runner.mjs";
import { createReceiptGuard, markReceiptCancelledSync } from "./receipts.mjs";
import { PLAN_RESIDUALS, verifyQualification } from "./report.mjs";
import { exitCodeFor, installSignalHandlers } from "./signals.mjs";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const GATES = new Set(["A", "P", "B", "C", "D", "DIAG"]);
const APPROVAL = /^[A-Za-z0-9._:#/-]{3,128}$/;
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};

export function parseRunArgs(argv) {
  let values;
  try {
    values = parseArgs({
      args: argv,
      options: {
        gate: { type: "string" },
        "run-id": { type: "string" },
        "session-dir": { type: "string" },
        approval: { type: "string" },
        "print-plan": { type: "boolean", default: false },
        "staging-dir": { type: "string" },
        hosts: { type: "string" },
        docker: { type: "string" },
        "docker-socket": { type: "string" },
        "packed-archive": { type: "string" },
        "packed-sha256": { type: "string" },
        "gate-a-receipts": { type: "string" },
        "archive-sha256": { type: "string" },
        "gate-p-receipt": { type: "string" },
        "gate-p-approval": { type: "string" },
        "gate-b-receipt": { type: "string" },
        "gate-b-approval": { type: "string" },
        images: { type: "string" },
        "retain-images": { type: "boolean", default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    refuse(error.message);
  }
  if (!values.gate) refuse("--gate is required (A | P | B | C | D | DIAG); each gate needs its own user approval");
  if (!GATES.has(values.gate)) refuse(`unknown gate ${values.gate}`);
  if (!RUN_ID.test(values["run-id"] ?? "")) refuse("--run-id <[a-z0-9-]{1,32}> is required");
  if (!isAbsolute(values["session-dir"] ?? "")) refuse("--session-dir must be an absolute path");
  if (!values["print-plan"]) {
    if (values.approval === undefined) refuse("--approval <reference> is required to execute a gate (use --print-plan to only print the commands)");
    if (!APPROVAL.test(values.approval)) refuse("--approval must be a recorded approval reference ([A-Za-z0-9._:#/-]{3,128})");
  }
  const hosts = (values.hosts ?? HOSTS.map((host) => host.id).join(",")).split(",");
  for (const host of hosts) if (!HOSTS.some((entry) => entry.id === host)) refuse(`unknown host ${host}`);
  const options = { gate: values.gate, runId: values["run-id"], sessionDir: values["session-dir"], approval: values.approval ?? null, printPlan: values["print-plan"], hosts };
  if (values.gate === "A") {
    if (!isAbsolute(values["staging-dir"] ?? "")) refuse("--staging-dir must be an absolute path");
    options.stagingDir = values["staging-dir"];
  } else if (values.gate === "P") {
    // Gate P needs no docker; its command, env, and cwd are fixed by closure.mjs.
  } else {
    if (!isAbsolute(values.docker ?? "")) refuse("--docker must be the absolute path of the docker CLI");
    if (!isAbsolute(values["docker-socket"] ?? "")) refuse("--docker-socket must be the absolute path of the docker unix socket");
    options.docker = values.docker;
    options.dockerSocket = values["docker-socket"];
    options.dockerDirs = dockerDirs(values["session-dir"], values.gate);
    options.dockerEnv = dockerEnv({ socket: values["docker-socket"], configDir: options.dockerDirs.configDir, home: options.dockerDirs.home });
  }
  if (values.gate === "B") {
    if (!isAbsolute(values["gate-p-receipt"] ?? "")) refuse("--gate-p-receipt must be an absolute path (Gate B requires an accepted Gate P receipt)");
    options.gatePReceipt = values["gate-p-receipt"];
    if (!values["print-plan"]) {
      if (!APPROVAL.test(values["gate-p-approval"] ?? "")) refuse("--gate-p-approval <reference> (the approval recorded in the Gate P receipt) is required");
      options.gatePApproval = values["gate-p-approval"];
    }
  }
  if (values.gate === "B" && !values["print-plan"]) {
    for (const key of ["packed-archive", "gate-a-receipts"]) if (!isAbsolute(values[key] ?? "")) refuse(`--${key} must be an absolute path`);
    if (!/^[0-9a-f]{64}$/.test(values["packed-sha256"] ?? "")) refuse("--packed-sha256 must be a sha256 hex digest");
    Object.assign(options, { packedArchive: { path: values["packed-archive"], sha256: values["packed-sha256"] }, gateAReceipts: values["gate-a-receipts"] });
  }
  if (values.gate === "C" || values.gate === "D" || values.gate === "DIAG") {
    if (!isAbsolute(values["gate-b-receipt"] ?? "")) refuse(`--gate-b-receipt must be an absolute path (Gate ${values.gate} requires an accepted Gate B receipt)`);
    options.gateBReceipt = values["gate-b-receipt"];
    if (!values["print-plan"]) {
      if (!APPROVAL.test(values["gate-b-approval"] ?? "")) refuse("--gate-b-approval <reference> (the approval recorded in the Gate B receipt) is required");
      options.gateBApproval = values["gate-b-approval"];
    }
    let images;
    try {
      images = JSON.parse(values.images ?? "");
    } catch {
      refuse("--images must be a JSON object of host id -> image id");
    }
    for (const host of imageHosts(values.gate)) if (!/^sha256:[0-9a-f]{64}$/.test(images?.[host] ?? "")) refuse(`--images needs an exact image id for ${host}`);
    if (!values["print-plan"] && !/^[0-9a-f]{64}$/.test(values["archive-sha256"] ?? "")) refuse("--archive-sha256 (the packed archive under test) is required for receipts");
    options.images = images;
    options.archiveSha256 = values["archive-sha256"] ?? null;
    // Gate D: owned images are removed by exact id at batch end unless --retain-images (plan "Docker authority").
    if (values.gate === "D") options.retainImages = values["retain-images"] === true;
  }
  return options;
}

const GATE_C_HOSTS = Object.freeze(["v2-2.0.32", "v1-1.19.3"]);
/** Hosts whose images a docker-run gate verifies and uses: C = the spike pair; D = all four; DIAG = V1 1.18.29 only. */
function imageHosts(gate) {
  if (gate === "DIAG") return [DIAGNOSTIC_HOST];
  return gate === "D" ? HOSTS.map((host) => host.id) : GATE_C_HOSTS;
}
/** Cells a docker-run gate launches, in order: probes, then the spike (C), the 94 qualification cells (D), or the diagnostic cell (DIAG). */
function gateCells(gate) {
  const probes = imageHosts(gate).map((host) => probeCell(host).id);
  return { probes, cells: gate === "D" ? expectedCells().map((cell) => cell.id) : gate === "DIAG" ? [...DIAGNOSTIC_CELLS] : [...SPIKE_CELLS] };
}
const GATE_B_SCHEMA = "council-rh-gate-b/1";
const TAG_ABSENT_RULE = (ref) => `exit 1, stdout "" or "[]", stderr exactly "Error response from daemon: No such image: ${ref}" (or "Error: No such image: ..."); anything else -> STOP with a failure receipt`;
const DOCKER_DIRS_STEP = (options) => ({
  label: "create fresh Docker CLI dirs (no spawn)",
  paths: [options.dockerDirs.configDir, options.dockerDirs.home],
  checks: "refuse if either exists (any type, incl. symlink); mkdir 0700 exclusively; verified empty real dirs right before the first docker call",
});

/** Exact argv (with env) each gate would run. Pure; prints placeholders for per-run random names. */
export function planGate(options) {
  if (options.gate === "P") {
    return [
      { label: "assert npm 11.12.1 (read only)", read: join(dirname(dirname(NPM_CLI)), "package.json") },
      { label: "refuse existing closure dir or any .npmrc up to $S", paths: [join(options.sessionDir, "closure"), join(options.sessionDir, "closure", ".npmrc"), join(options.sessionDir, ".npmrc")] },
      { label: "write closure package.json", path: join(options.sessionDir, "closure", "package.json"), content: closurePackageJson() },
      {
        label: "create fresh empty npmrc files (no spawn)",
        dir: join(options.sessionDir, "closure-config"),
        paths: [closureConfigFiles(options.sessionDir).user, closureConfigFiles(options.sessionDir).global],
        checks: "refuse if closure-config exists (any type, incl. symlink); dir 0700; each file exclusive create 0600, empty; verified empty regular files (no symlink) just before the spawn",
      },
      {
        label: "npm install (Gate P; host-side registry acquisition)",
        cwd: join(options.sessionDir, "closure"),
        env: closureEnv(options.sessionDir),
        timeoutMs: GATE_P_TIMEOUT_MS,
        authorization: PACOTE_RETRY_AUTHORIZATION,
        argv: closureArgv(),
      },
      { label: "inspect closure and write receipt", receipt: join(options.sessionDir, `gate-p-${options.runId}.json`) },
    ];
  }
  if (options.gate === "A") {
    return options.hosts.map((host) => ({ label: `download ${host}`, env: {}, timeoutMs: DEADLINES.download, argv: curlArgv({ artifact: ARTIFACTS[host], partPath: join(options.sessionDir, "acquire", `${host}-<random>.part`) }) }));
  }
  if (options.gate === "B") {
    const steps = [
      { label: "verify Gate P receipt (no spawn)", receipt: options.gatePReceipt, checks: `accepted; run id ${options.runId}; approval == --gate-p-approval; closure re-hashed at context assembly` },
      { label: "verify Gate A receipt run id (no spawn)", receipt: options.gateAReceipts ?? null, checks: `run id == ${options.runId} (missing / other -> refused before any docker call); accepted status checked before the first build` },
      DOCKER_DIRS_STEP(options),
      { label: "inspect base image", env: options.dockerEnv, timeoutMs: DEADLINES.imageInspect, argv: inspectArgv({ docker: options.docker, ref: BASE_IMAGE_ID }) },
    ];
    for (const host of options.hosts) {
      const tag = imageTag(host, options.runId);
      steps.push({ label: `require tag absent ${host}`, env: options.dockerEnv, timeoutMs: DEADLINES.imageInspect, absentOnlyIf: TAG_ABSENT_RULE(tag), argv: inspectArgv({ docker: options.docker, ref: tag }) });
      const contextDir = join(options.sessionDir, `context-${host}`);
      steps.push({ label: `build ${host}`, env: options.dockerEnv, timeoutMs: DEADLINES.imageBuild, argv: buildArgv({ docker: options.docker, contextDir, tag, runId: options.runId, iidfile: join(options.sessionDir, `${host}.iid`) }) });
    }
    return steps;
  }
  return [
    { label: "verify Gate B receipt (no spawn)", receipt: options.gateBReceipt, checks: "accepted; run id " + options.runId + "; approval == --gate-b-approval; image ids == --images; archive sha256 == --archive-sha256" },
    DOCKER_DIRS_STEP(options),
    ...imageHosts(options.gate).map((host) => ({
      label: `verify image ${host}`,
      env: options.dockerEnv,
      timeoutMs: DEADLINES.imageInspect,
      checks: `Id == image id; labels ${OWNER_LABEL} == ${options.runId}, ${HOST_LABEL} == ${host}, ${ARCHIVE_LABEL} and ${IMAGE_MANIFEST_LABEL} == Gate B receipt`,
      argv: inspectArgv({ docker: options.docker, ref: options.images[host] }),
    })),
    ...[...gateCells(options.gate).probes, ...gateCells(options.gate).cells].map((cellId) => ({
      label: `cell ${cellId}`,
      env: options.dockerEnv,
      timeoutMs: cellDeadlines(parseCellId(cellId).scenario).controllerMs,
      argv: runArgv({ docker: options.docker, imageId: options.images[cellId.split(":")[0]], runId: options.runId, cellId, cidfile: join(options.sessionDir, `${cellId.replaceAll(":", "_")}.cid`) }),
    })),
    ...(options.gate !== "D"
      ? []
      : options.retainImages
        ? [{ label: "retain images (--retain-images): no removal", images: options.images }]
        : imageHosts("D").flatMap((host) => [
            { label: `remove image ${host}`, env: options.dockerEnv, timeoutMs: DEADLINES.imageRemove, argv: removeImageArgv({ docker: options.docker, imageId: options.images[host] }) },
            { label: `verify image absent ${host}`, env: options.dockerEnv, timeoutMs: DEADLINES.imageInspect, absentOnlyIf: TAG_ABSENT_RULE(options.images[host]), argv: inspectArgv({ docker: options.docker, ref: options.images[host] }) },
          ])),
  ];
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
};

/** Problems with a Gate B receipt for Gate C (missing / not accepted / run id / approval / images / archive / digests). */
export function checkGateBReceipt(receipt, { runId, approval, images, archiveSha256, hosts = GATE_C_HOSTS }) {
  if (!isRecord(receipt)) return ["Gate B receipt is missing"];
  const problems = [];
  if (receipt.schema !== GATE_B_SCHEMA) problems.push("Gate B receipt has an unknown schema");
  if (receipt.status !== "accepted") problems.push(`Gate B receipt is ${receipt.status ?? "not accepted"} (only accepted builds run)`);
  if (receipt.runId !== runId) problems.push(`Gate B receipt run id ${receipt.runId} != ${runId}`);
  if (receipt.approval !== approval) problems.push(`Gate B receipt approval ${receipt.approval} != ${approval}`);
  if (receipt.archiveSha256 !== archiveSha256) problems.push(`Gate B receipt archive sha256 ${receipt.archiveSha256} != --archive-sha256 ${archiveSha256}`);
  for (const host of hosts) {
    if (receipt.images?.[host] !== images[host]) problems.push(`Gate B receipt image for ${host} ${receipt.images?.[host]} != --images ${images[host]}`);
    if (!/^[0-9a-f]{64}$/.test(String(receipt.contexts?.[host]?.imageManifestSha256))) problems.push(`Gate B receipt has no image-manifest sha256 for ${host}`);
  }
  return problems;
}

/** Loads and checks the Gate P receipt. Pure file work: runs before any docker call. */
async function loadGatePClosure(options) {
  const receipt = await readJson(options.gatePReceipt);
  const problems = checkGatePReceipt(receipt, { runId: options.runId, approval: options.gatePApproval });
  if (problems.length > 0) refuse(`Gate B refused: ${problems.join("; ")}`);
  return { dir: receipt.closureDir, receipt, approval: options.gatePApproval };
}

/**
 * A3 (4): the Gate A receipt must name THIS run id (an earlier run's receipt, or one without a run
 * id, is refused). Pure file work: runs before any docker call. The loaded object is the one used
 * for the contexts (never re-read).
 */
async function loadGateAReceipt(options) {
  const receipt = await readJson(options.gateAReceipts);
  if (!isRecord(receipt) || receipt.runId !== options.runId) refuse(`Gate B refused: Gate A receipt run id ${isRecord(receipt) ? receipt.runId : undefined} != ${options.runId} (${options.gateAReceipts})`);
  return receipt;
}

/** Loads and checks the Gate B receipt. Pure file work: runs before any docker call. */
async function loadGateBReceipt(options) {
  const receipt = await readJson(options.gateBReceipt);
  const problems = checkGateBReceipt(receipt, { runId: options.runId, approval: options.gateBApproval, images: options.images, archiveSha256: options.archiveSha256, hosts: imageHosts(options.gate) });
  if (problems.length > 0) refuse(`Gate ${options.gate} refused: ${problems.join("; ")}`);
  return receipt;
}

/**
 * deps (tests inject all of them; defaults are the real ones):
 *   createRunner(env) -> runner   (proc-runner.mjs)
 *   readNpmVersion(cliPath)       (closure.mjs; reads npm's package.json, never runs npm)
 *   proc                          (signal source + exit; default `process`)
 *   receiptHooks                  (receipts.mjs guard hooks: beforeWrite / beforeRename / afterPublish)
 *   markReceiptSync(path, fields) (receipts.mjs markReceiptCancelledSync; injectable to test the delete fallback)
 *   acquireHost(args)             (acquire.mjs; Gate A)
 *   writeCellRecord(path, text)   (controller result records)
 */
/** Thrown at a cancellation checkpoint (operator signal seen between steps / before a spawn). */
class Cancelled extends Error {}
/** Thrown when a tracked (non-attached) command's ORIGINAL process group did not settle: STOP. */
class CleanupUncertain extends Error {}

export async function executeGate(options, deps = {}) {
  const {
    createRunner = (env) => createProcRunner({ env }),
    readNpmVersion: readVersion = readNpmVersion,
    proc = process,
    writeCellRecord,
    receiptHooks = {},
    markReceiptSync = markReceiptCancelledSync,
    acquireHost: acquire = acquireHost,
  } = deps;
  const gate = options.gate.toLowerCase();
  const at = (name) => join(options.sessionDir, name);
  const cancelledPath = at(`gate-${gate}-cancelled-${options.runId}.json`);
  // Every cleanup claim is scoped: the original process group(s) (+ the owned container for
  // Gate C cells). Escaped descendants are not covered; nothing claims all processes stopped.
  const cleanupScope = options.gate === "C" || options.gate === "D" || options.gate === "DIAG" ? CELL_CLEANUP_SCOPE : CLEANUP_SCOPE;
  // A3 (5): a cancelled diagnostic is its own outcome (never a PASS; cleanup recorded as usual).
  // `outcome` is authoritative (after `fields`), the same field the terminal receipt carries.
  const cancelledRecord = (fields) => ({ status: "cancelled", gate: options.gate, runId: options.runId, approval: options.approval, cleanupScope, cleanupScopeNote: CLEANUP_SCOPE_NOTE, ...fields, ...(options.gate === "DIAG" ? { outcome: "cancelled" } : {}) });
  // The gate's own receipts (+ its cancellation record). This invocation may only ever touch
  // receipts IT published (the guard's ownership set); a rerun that would overwrite or
  // invalidate earlier evidence for the same run id is refused before any work.
  const receiptPaths = { a: [`gate-a-${options.runId}.json`], p: [`gate-p-${options.runId}.json`], b: [`gate-b-${options.runId}.json`], c: [`gate-c-${options.runId}.json`, `gate-c-probes-${options.runId}.json`, `gate-c-spike-${options.runId}.json`], d: [`gate-d-${options.runId}.json`, `gate-d-probes-${options.runId}.json`, `gate-d-qualification-${options.runId}.json`, `gate-d-report-${options.runId}.json`, `gate-d-images-${options.runId}.json`], diag: [`gate-diag-${options.runId}.json`, `gate-diag-probes-${options.runId}.json`, `gate-diag-diagnostic-${options.runId}.json`] }[gate].map(at);
  // Per-invocation receipt guard: cancelSync() (from the signal handler) makes any later
  // accepted / completed publish impossible and marks (or deletes) what this invocation wrote.
  const guard = createReceiptGuard({ hooks: receiptHooks, markSync: markReceiptSync });
  const mayWrite = (path) => guard.owned.has(path) || !existsSync(path);

  // Operator termination, installed FIRST -- synchronously, before any await, receipt load, or
  // directory creation. signals.mjs aborts `controller` and calls stopAll() on EVERY signal,
  // then exits 130 itself on the second one. stopAll synchronously kills the attached client
  // group and marks any already-written receipt cancelled, so even a second signal right after
  // an accepted write cannot leave it usable.
  const controller = new AbortController();
  let runner = null;
  let signalCount = 0;
  const supervisor = {
    stopAll: async () => {
      signalCount += 1;
      runner?.killAttached?.();
      // Synchronous: no accepted / completed receipt can be published from here on; pending
      // temp files are unlinked; this invocation's receipts are marked cancelled (or deleted).
      for (const problem of guard.cancelSync({ cancelledBy: "operator signal" })) process.stderr.write(`test:real-host: receipt cancel problem: ${problem}\n`);
      if (signalCount > 1) {
        const detail = "second signal: exited immediately; owned container / process cleanup NOT confirmed";
        process.stderr.write(`test:real-host: ${detail}\n`);
        try {
          if (mayWrite(cancelledPath)) guard.writeSync(cancelledPath, `${JSON.stringify(cancelledRecord({ signals: signalCount, cleanupConfirmed: false, detail }), null, 2)}\n`);
        } catch (error) {
          process.stderr.write(`test:real-host: could not write ${cancelledPath}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      return [];
    },
  };
  const handlers = installSignalHandlers({ controller, supervisor, proc });
  const { signal } = controller;
  /** Cancellation checkpoint: between preparation steps and before / after every spawn. */
  const checkpoint = () => {
    if (signal.aborted) throw new Cancelled("cancelled by operator");
  };
  // Per-gate cancellation facts (updated as the gate progresses).
  const state = { cleanupConfirmed: true, detail: "no process or container in flight", extra: {}, launched: false, processUncertain: false };
  /** Every non-attached command: the signal passed down; launch and settlement recorded honestly. */
  const tracked = async (argv, opts) => {
    state.launched = true;
    const result = await runner.run(argv, { ...opts, signal });
    if (result?.cleanupUncertain === true) {
      state.processUncertain = true;
      // Frame-2 MA3: any gate (Gate P records it as a receipt rejection in closure.mjs instead)
      // STOPS on an unsettled process group -- recorded as a failure, never continued past.
      if (options.gate !== "P" && !signal.aborted) throw new CleanupUncertain(`${basename(String(argv[0]))} ${String(argv[1] ?? "")} ${String(argv[2] ?? "")}`.trim());
    }
    return result;
  };
  const processDetail = (what) =>
    !state.launched
      ? `${what} never launched`
      : state.processUncertain
        ? `${what} process group signalled (SIGTERM, then SIGKILL after grace) but did NOT settle within the bound (pipes still held); termination NOT confirmed`
        : `${what} process group signalled (SIGTERM, then SIGKILL after grace) and settled`;
  const writeJson = (path, value) => guard.write(path, `${JSON.stringify(value, null, 2)}\n`);
  const record = async (name, value) => writeFile(at(name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  /** Final receipt write, then re-check: a signal during / after the write marks it cancelled. */
  const finalReceipt = async (name, value) => {
    await writeJson(at(name), value);
    checkpoint();
  };
  const cancelledExit = async (fields) => {
    const merged = { signals: signalCount, ...fields, cleanupConfirmed: fields.cleanupConfirmed === true && !state.processUncertain };
    await mkdir(options.sessionDir, { recursive: true, mode: 0o700 }).catch(() => {});
    // Never leave a receipt usable: mark every receipt THIS invocation published cancelled
    // (deleting any that cannot be marked) ...
    const errors = await guard.markOwnedCancelled({ cancelledBy: "operator signal" });
    // ... write the gate's main receipt as cancelled when there is none of ours ...
    if (mayWrite(receiptPaths[0]) && !existsSync(receiptPaths[0])) await writeJson(receiptPaths[0], cancelledRecord(merged)).catch((error) => errors.push(`${receiptPaths[0]}: ${error.message}`));
    // ... and the cancellation record (atomic; errors reported, never swallowed).
    if (mayWrite(cancelledPath)) await writeJson(cancelledPath, cancelledRecord({ ...merged, ...(errors.length ? { writeErrors: errors } : {}) })).catch((error) => errors.push(`${cancelledPath}: ${error.message}`));
    for (const error of errors) process.stderr.write(`test:real-host: cancellation write problem: ${error}\n`);
    process.stderr.write(`test:real-host: Gate ${options.gate} cancelled by operator (cleanup ${merged.cleanupConfirmed ? "confirmed" : "NOT confirmed"})\n`);
    return exitCodeFor({ aborted: true, report: { status: "cancelled" } });
  };

  try {
    // Refuse a rerun that would overwrite / invalidate earlier evidence -- synchronously, before
    // any await, so even an immediate signal cannot reach (or record over) a prior receipt.
    for (const path of [...receiptPaths, cancelledPath]) {
      if (existsSync(path)) refuse(`${basename(path)} already exists for run id ${options.runId}; rerun refused (earlier evidence is never overwritten): ${path}`);
    }
    checkpoint();
    // Gates B and C check their predecessor's receipt before creating anything or calling docker.
    const gatePClosure = options.gate === "B" ? await loadGatePClosure(options) : null;
    checkpoint();
    const gateAReceipt = options.gate === "B" ? await loadGateAReceipt(options) : null;
    checkpoint();
    const gateB = options.gate === "C" || options.gate === "D" || options.gate === "DIAG" ? await loadGateBReceipt(options) : null;
    checkpoint();
    await mkdir(options.sessionDir, { recursive: true, mode: 0o700 });
    checkpoint();
    if (options.dockerDirs) await prepareDockerDirs(options.dockerDirs);
    checkpoint();
    runner = createRunner(options.gate === "A" ? {} : options.gate === "P" ? closureEnv(options.sessionDir) : options.dockerEnv);
    checkpoint();

    if (options.gate === "P") {
      const receipt = await runGateP({ sessionDir: options.sessionDir, runId: options.runId, approval: options.approval, readNpmVersion: readVersion, signal, writeReceipt: (path, text) => guard.write(path, text), run: tracked });
      if (receipt.status === "cancelled" || signal.aborted) return await cancelledExit({ cleanupConfirmed: true, detail: `${processDetail("npm")}; no containers`, stage: receipt.stage ?? null });
      if (receipt.status !== "accepted") {
        process.stderr.write(`Gate P receipt REJECTED${receipt.stop ? " (STOP)" : ""}:\n- ${receipt.problems.join("\n- ")}\n`);
        return 1;
      }
      return 0;
    }
    if (options.gate === "A") {
      const workDir = at("acquire");
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      await mkdir(options.stagingDir, { recursive: true, mode: 0o700 });
      const receipts = [];
      state.extra = { receipts };
      for (const hostId of options.hosts) {
        checkpoint();
        receipts.push(await acquire({ hostId, workDir, stagingDir: options.stagingDir, run: tracked }));
        checkpoint();
      }
      await finalReceipt(`gate-a-${options.runId}.json`, { status: "accepted", runId: options.runId, approval: options.approval, receipts });
      return 0;
    }

    // Docker gates: the fresh CLI dirs must still be empty right before the first docker call.
    await verifyDockerDirsEmpty(options.dockerDirs);
    /** Every docker spawn: checkpoint before, the signal passed down, checkpoint after. */
    const docker = async (argv, timeoutMs) => {
      checkpoint();
      const result = await tracked(argv, { timeoutMs });
      checkpoint();
      return result;
    };

    if (options.gate === "B") {
      const images = {};
      const contexts = {};
      state.extra = { images };
      const fail = async (stage, problem) => {
        await writeJson(at(`gate-b-${options.runId}.json`), { schema: GATE_B_SCHEMA, status: "failed", runId: options.runId, approval: options.approval, stage, problem, images });
        process.stderr.write(`Gate B STOP at ${stage}: ${problem}\n`);
        return 1;
      };
      state.detail = "no build started, nothing to remove";

      const inspected = await docker(inspectArgv({ docker: options.docker, ref: BASE_IMAGE_ID }), DEADLINES.imageInspect);
      if (inspected.status !== 0) return await fail("base image", `base image inspect exited ${inspected.status}${inspected.timedOut ? " (timed out)" : ""}; STOP (never pull or substitute)`);
      let parsed = null;
      try {
        parsed = JSON.parse(inspected.stdout);
      } catch {
        parsed = null;
      }
      const verdict = validateBaseImageInspect(parsed, { expectedId: BASE_IMAGE_ID });
      await record(`gate-b-base-${options.runId}.json`, verdict);
      if (!verdict.ok) return await fail("base image", `base image rejected: ${verdict.problems.join("; ")}`);
      const gateA = gateAReceipt;
      if (!isRecord(gateA) || gateA.status !== "accepted" || !Array.isArray(gateA.receipts)) return await fail("gate A receipts", `Gate A receipts are not an accepted receipt: ${options.gateAReceipts}`);
      for (const hostId of options.hosts) {
        checkpoint();
        const tag = imageTag(hostId, options.runId);
        const tagCheck = classifyTagAbsence(await docker(inspectArgv({ docker: options.docker, ref: tag }), DEADLINES.imageInspect), tag);
        if (!tagCheck.absent) return await fail(`tag-absence ${hostId}`, tagCheck.problem);
        const receipt = gateA.receipts.find((entry) => entry.hostId === hostId);
        if (!receipt) return await fail(`context ${hostId}`, `no Gate A receipt for ${hostId}`);
        const contextDir = at(`context-${hostId}`);
        const context = await assembleImageContext({ contextDir, hostId, runId: options.runId, harnessDir: HARNESS_DIR, hostExecutable: { path: receipt.executable.path, sha256: receipt.executable.sha256, provenance: { archive: receipt.archive, member: receipt.member, url: receipt.url } }, packedArchive: options.packedArchive, closure: gatePClosure });
        await record(`context-${hostId}.manifest.json`, { manifest: context.manifest, sha256: context.manifestSha256 });
        checkpoint();
        const iidfile = at(`${hostId}.iid`);
        // From here an owned image may exist if the build is interrupted (never removed automatically).
        state.cleanupConfirmed = false;
        state.detail = `docker build interrupted; an owned image (label ${OWNER_LABEL}=${options.runId}) may exist and is NOT removed automatically`;
        const built = await docker(buildArgv({ docker: options.docker, contextDir, tag, runId: options.runId, iidfile }), DEADLINES.imageBuild);
        if (/resolve image config|docker\.io\/|pulling from/i.test(`${built.stdout}\n${built.stderr}`)) return await fail(`build ${hostId}`, "build attempted remote resolution; STOP");
        if (built.status !== 0) return await fail(`build ${hostId}`, `build failed (status ${built.status}${built.timedOut ? ", timed out" : ""})`);
        const imageId = (await readFile(iidfile, "utf8")).trim();
        if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) return await fail(`build ${hostId}`, `invalid image id in ${iidfile}`);
        images[hostId] = imageId;
        contexts[hostId] = { manifestSha256: context.manifestSha256, imageManifestSha256: context.imageManifestSha256 };
        state.detail = `cancelled between builds; built images are listed (label ${OWNER_LABEL}=${options.runId})`;
      }
      checkpoint();
      await finalReceipt(`gate-b-${options.runId}.json`, { schema: GATE_B_SCHEMA, status: "accepted", runId: options.runId, approval: options.approval, gatePReceiptId: gatePClosure.receipt.receiptId, archiveSha256: options.packedArchive.sha256, images, contexts });
      return 0;
    }

    // Gates C / D / DIAG: verify every gate image by inspection against the Gate B receipt, then the
    // version probes, then the spike (C), the full qualification batch (D), or the one diagnostic
    // cell (DIAG); stop on the first failure.
    const g = gate;
    const failGate = async (stage, problem) => {
      await writeJson(at(`gate-${g}-${options.runId}.json`), { status: "failed", runId: options.runId, approval: options.approval, stage, problem });
      process.stderr.write(`Gate ${options.gate} STOP at ${stage}: ${problem}\n`);
      return 1;
    };
    state.detail = "no container started";
    for (const host of imageHosts(options.gate)) {
      const inspected = await docker(inspectArgv({ docker: options.docker, ref: options.images[host] }), DEADLINES.imageInspect);
      let json = null;
      try {
        json = inspected.status === 0 ? JSON.parse(inspected.stdout) : null;
      } catch {
        json = null;
      }
      const problems = json ? verifyBuiltImage(json, { imageId: options.images[host], runId: options.runId, hostId: host, archiveSha256: gateB.archiveSha256, imageManifestSha256: gateB.contexts[host].imageManifestSha256 }) : [`image inspect exited ${inspected.status}${inspected.timedOut ? " (timed out)" : ""}`];
      if (problems.length > 0) return await failGate(`verify image ${host}`, problems.join("; "));
    }
    checkpoint();
    const { probes: probeCells, cells } = gateCells(options.gate);
    /** Round-3 Must 2: unconfirmed cell cleanup becomes gate state the moment the controller knows it. */
    const markCellCleanupUnconfirmed = (cellId) => {
      state.processUncertain = true;
      state.cleanupConfirmed = false;
      state.detail = `cell cleanup not confirmed (${cellId}); an owned container / client may remain (label ${OWNER_LABEL}=${options.runId})`;
    };
    const common = { runId: options.runId, archiveSha256: options.archiveSha256, images: options.images, docker: options.docker, sessionDir: options.sessionDir, runner, signal, onCleanupUnconfirmed: markCellCleanupUnconfirmed, ...(writeCellRecord ? { writeRecord: writeCellRecord } : {}) };
    /**
     * Re-audit round 2 (Must 3): a cell whose container removal / client settlement was not
     * confirmed is GATE state -- the gate's cleanup is unconfirmed from here on (every later
     * cancellation record says so) and no further docker command is issued.
     */
    const absorbCleanup = (result) => {
      const unconfirmed = (result.receipts ?? []).filter((receipt) => receipt.cleanupConfirmed !== true).map((receipt) => receipt.cellId);
      if (unconfirmed.length === 0) return true;
      state.processUncertain = true;
      state.cleanupConfirmed = false;
      state.detail = `cell cleanup not confirmed (${unconfirmed.join(", ")}); an owned container / client may remain (label ${OWNER_LABEL}=${options.runId})`;
      return false;
    };
    const probes = await runBatch({ ...common, runKind: "probe", cells: probeCells.filter((id) => allowlistFor("probe").has(id)) });
    const probesClean = absorbCleanup(probes);
    if (probes.status === "cancelled" || signal.aborted) return await cancelledExit({ ...(probes.cancelled ?? { cleanupConfirmed: true, detail: "between batches" }), stoppedAt: probes.stoppedAt ?? null, receipts: probes.receipts });
    await finalReceipt(`gate-${g}-probes-${options.runId}.json`, probes);
    /**
     * A3 (3)/(5): the diagnostic's TERMINAL outcome receipt. Written once (probe failure, or after
     * the one S11 cell); never a Gate D report, never image removal, never a qualification claim.
     */
    const diagnosticTerminal = async (batch) => {
      const verdict = classifyDiagnostic({ probes, batch });
      const record = (batch?.results ?? []).find((entry) => entry.cellId === DIAGNOSTIC_CELLS[0]);
      await finalReceipt(`gate-diag-${options.runId}.json`, {
        schema: DIAGNOSTIC_SCHEMA,
        status: "terminal",
        runKind: "diagnostic",
        runId: options.runId,
        approval: options.approval,
        ...verdict,
        probeCellId: probeCell(DIAGNOSTIC_HOST).id,
        archiveSha256: options.archiveSha256,
        imageId: options.images[DIAGNOSTIC_HOST],
        closureReceiptId: gateB.gatePReceiptId ?? null,
        resultClosure: record?.result?.closure ?? null,
        qualification: false,
        imagesRemoved: false,
        interpretation: DIAGNOSTIC_INTERPRETATION,
      });
      return verdict.outcome === DIAGNOSTIC_PASS ? 0 : 1;
    };
    if (probes.status !== "completed" || !probesClean) return options.gate === "DIAG" ? await diagnosticTerminal(null) : 1;
    checkpoint();
    const runKind = options.gate === "D" ? "qualification" : options.gate === "DIAG" ? "diagnostic" : "spike";
    const batch = await runBatch({ ...common, runKind, cells });
    const batchClean = absorbCleanup(batch);
    if (batch.status === "cancelled" || signal.aborted) return await cancelledExit({ ...(batch.cancelled ?? { cleanupConfirmed: true, detail: `after the ${runKind} batch` }), stoppedAt: batch.stoppedAt ?? null, receipts: batch.receipts });
    await finalReceipt(`gate-${g}-${runKind}-${options.runId}.json`, { approval: options.approval, ...batch });
    if (options.gate === "C") return batch.status === "completed" && batchClean ? 0 : 1;
    if (options.gate === "DIAG") return await diagnosticTerminal(batch);
    // Gate D: completeness is decided by the report verifier (expected set specified
    // independently; every gating cell PASS exactly once, current run / archive / images / closure).
    const report = verifyQualification({ receipts: batch.receipts, runId: options.runId, archiveSha256: options.archiveSha256, imageIds: options.images, closureReceiptId: gateB.gatePReceiptId ?? null });
    // Frame-1 Should2: the plan §8 residuals and the UNVERIFIED host shapes the cells relied on travel with the report.
    const hostShapeCandidates = {};
    for (const record of batch.results) {
      const host = String(record.cellId).split(":")[0];
      for (const candidate of Array.isArray(record.result?.summary?.candidates) ? record.result.summary.candidates : []) {
        hostShapeCandidates[host] ??= [];
        if (!hostShapeCandidates[host].includes(candidate)) hostShapeCandidates[host].push(String(candidate).slice(0, 96));
      }
    }
    const reportValue = { ...report, runId: options.runId, approval: options.approval, archiveSha256: options.archiveSha256, imageIds: options.images, closureReceiptId: gateB.gatePReceiptId ?? null, batchStatus: batch.status, stoppedAt: batch.stoppedAt ?? null, residuals: PLAN_RESIDUALS, hostShapeCandidates };
    await finalReceipt(`gate-d-report-${options.runId}.json`, reportValue);
    // Round-3 Should: if the batch-end image removal later hits uncertain process cleanup, the
    // published report is rewritten (never left reading "complete").
    state.publishedReport = { name: `gate-d-report-${options.runId}.json`, value: reportValue };
    // Frame-2 Should1: batch end -- remove the OWNED images (verified by id + labels above) by
    // exact id and verify absence; never prune. --retain-images keeps them (recorded).
    const imagesPath = `gate-d-images-${options.runId}.json`;
    // Must 3: after an unconfirmed cell cleanup no further docker command runs (images stay; recorded).
    if (!batchClean) {
      await finalReceipt(imagesPath, { status: "not-attempted", reason: "cell container / client cleanup not confirmed", runId: options.runId, images: Object.entries(options.images).map(([host, imageId]) => ({ host, imageId })) });
      return 1;
    }
    if (options.retainImages) {
      await finalReceipt(imagesPath, { status: "retained", runId: options.runId, images: Object.entries(options.images).map(([host, imageId]) => ({ host, imageId })) });
      return batch.status === "completed" && report.status === "complete" ? 0 : 1;
    }
    // Should c: the per-image ledger is gate state (carried by a cancellation record) and is
    // persisted after every image ("in-progress"), so a cancellation mid-loop keeps each outcome.
    const removals = [];
    state.extra = { imageRemovals: removals };
    state.detail = "batch-end image removal in progress";
    for (const host of imageHosts("D")) {
      const imageId = options.images[host];
      const removed = await docker(removeImageArgv({ docker: options.docker, imageId }), DEADLINES.imageRemove);
      if (removed.status !== 0 || removed.timedOut) {
        removals.push({ host, imageId, removed: false, absent: false, problem: `image rm exited ${removed.status}${removed.timedOut ? " (timed out)" : ""}` });
      } else {
        const absence = classifyTagAbsence(await docker(inspectArgv({ docker: options.docker, ref: imageId }), DEADLINES.imageInspect), imageId);
        removals.push({ host, imageId, removed: true, absent: absence.absent, problem: absence.absent ? null : absence.problem });
      }
      await writeJson(at(imagesPath), { status: "in-progress", runId: options.runId, images: removals });
      checkpoint();
    }
    const imagesOk = removals.every((entry) => entry.removed && entry.absent);
    await finalReceipt(imagesPath, { status: imagesOk ? "removed" : "failed", runId: options.runId, images: removals });
    return batch.status === "completed" && report.status === "complete" && imagesOk ? 0 : 1;
  } catch (error) {
    if (error instanceof CleanupUncertain && !signal.aborted) {
      const problem = `${error.message}: process group did not settle (cleanup uncertain; original process group not confirmed gone); STOP`;
      if (mayWrite(receiptPaths[0]) && !existsSync(receiptPaths[0])) await writeJson(receiptPaths[0], { status: "failed", gate: options.gate, runId: options.runId, approval: options.approval, stage: "process cleanup", problem, cleanupConfirmed: false, cleanupScope, cleanupScopeNote: CLEANUP_SCOPE_NOTE });
      if (state.publishedReport) {
        const { name, value } = state.publishedReport;
        await writeJson(at(name), { ...value, status: value.status === "complete" ? "incomplete" : value.status, cleanupUncertain: true, problems: [...value.problems, `batch-end image removal: ${problem}`] });
      }
      process.stderr.write(`Gate ${options.gate} STOP at process cleanup: ${problem}\n`);
      return 1;
    }
    // Any interruption seen at a checkpoint (or an error caused by the kill) is a cancellation.
    if (error instanceof Cancelled || signal.aborted) {
      const detail = options.gate === "A" ? `${processDetail("curl")}; partial download removed; no containers` : options.gate === "P" ? `${processDetail("npm")}; no containers` : state.detail;
      return await cancelledExit({ cleanupConfirmed: state.cleanupConfirmed, detail, ...state.extra, ...(error instanceof Cancelled ? {} : { error: error instanceof Error ? error.message.slice(0, 300) : String(error) }) });
    }
    throw error;
  } finally {
    handlers.uninstall();
  }
}

async function main() {
  let options;
  try {
    options = parseRunArgs(process.argv.slice(2));
    if (options.printPlan) {
      process.stdout.write(`${JSON.stringify(planGate(options), null, 2)}\n`);
      return 0;
    }
    return await executeGate(options);
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`test:real-host refused: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`test:real-host failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
