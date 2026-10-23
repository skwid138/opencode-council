// Council-only (Amendment A2). Gate P: the frozen V1 peer closure.
//
// The V1 server() lazily imports its peer @opencode-ai/plugin. Gate P installs
// exactly @opencode-ai/plugin@1.19.3 (+ its dependency closure) on the HOST with
// the pinned npm, never running install scripts, and records a receipt. Gate B
// re-hashes that closure and COPYs it next to the plugin in V1 image contexts.
//
// Nothing here spawns: runGateP takes an injected `run`. run.mjs injects the real
// runner only for an approved `--gate P`.
//
// AUTHORIZATION (approval text and plan state this exactly): pacote's single
// built-in re-download per tarball, from the same resolved registry URL, ONLY after
// EINTEGRITY / Z_DATA_ERROR / ENOENT / EISDIR. Everything else is single-attempt.
// Gate A's no-retry rule is unchanged.
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile as fsReadFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { CLEANUP_SCOPE, CLEANUP_SCOPE_NOTE } from "./proc-runner.mjs";
import { markReceiptCancelled, writeAtomic } from "./receipts.mjs";

export const NODE_PATH = "/Users/hunter/.nvm/versions/node/v24.15.0/bin/node";
export const NPM_CLI = "/Users/hunter/.nvm/versions/node/v24.15.0/lib/node_modules/npm/bin/npm-cli.js";
export const NPM_VERSION = "11.12.1";
export const PEER_NAME = "@opencode-ai/plugin";
export const PEER_VERSION = "1.19.3";
export const REGISTRY = "https://registry.npmjs.org/";
export const GATE_P_TIMEOUT_MS = 300_000;
export const RECEIPT_SCHEMA = "council-rh-closure/1";
/** Post-install acceptance limits (not containment). */
export const CLOSURE_LIMITS = Object.freeze({ maxBytes: 160 * 1024 * 1024, maxPackages: 400 });
export const PACOTE_RETRY_AUTHORIZATION =
  "pacote's single built-in re-download per tarball, from the same resolved registry URL, ONLY after EINTEGRITY/Z_DATA_ERROR/ENOENT/EISDIR; everything else single-attempt; Gate A no-retry unchanged";

/**
 * Exact install-script allowlist: { "name@version": "source justification" }.
 * Registry facts (read-only metadata, 2026-10-18): @opencode-ai/plugin@1.19.3 ->
 * effect@4.0.0-beta.83 -> msgpackr ^2.0.1 (latest 2.1.1) -> optional msgpackr-extract
 * ^3.0.4; 3.0.4 is the only 3.x >= 3.0.4. Its `install` script is
 * node-gyp-build-optional-packages (gypfile: true) with optional platform prebuilds
 * @msgpackr-extract/msgpackr-extract-{linux-arm,linux-x64,win32-x64,darwin-x64,linux-arm64,darwin-arm64}@3.0.4.
 * Any other install-script package (or version) STOPs. Scripts are never run.
 */
export const INSTALL_SCRIPT_ALLOWLIST = Object.freeze({
  "msgpackr-extract@3.0.4":
    "optional native addon; install script only runs node-gyp-build-optional-packages, which loads a prebuilt platform package (@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4 selected for linux/arm64/glibc) or falls back; msgpackr catches native-load failure and uses pure JS; scripts are never executed (--ignore-scripts)",
});

/** Recorded in the receipt when present; NOT required (native acceleration is not claimed). */
export const EXPECTED_PLATFORM_PACKAGES = Object.freeze(["@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4"]);

const readFile = fsReadFile;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const SAFE_NAME = /^[^\u0000-\u001f\u007f\\/]+$/;
const list = (value) => (Array.isArray(value) ? value.map(String) : null);

export const closurePackageJson = () => `${JSON.stringify({ private: true, dependencies: { [PEER_NAME]: PEER_VERSION } })}\n`;

export function closureArgv() {
  return [NODE_PATH, NPM_CLI, "install", "--ignore-scripts", "--no-bin-links", "--fetch-retries=0", "--no-audit", "--no-fund", "--os=linux", "--cpu=arm64", "--libc=glibc", `--registry=${REGISTRY}`];
}

/**
 * Fresh, empty npmrc files for userconfig / globalconfig. Two DISTINCT paths: npm 11.12.1's
 * @npmcli/config throws when one file is loaded as two config types (the original
 * `/dev/null` + `/dev/null` plan defect; mechanical correction recorded in Amendment A2).
 */
export const closureConfigFiles = (sessionDir) => ({ user: join(sessionDir, "closure-config", "npmrc-user"), global: join(sessionDir, "closure-config", "npmrc-global") });

/** Built from scratch: no inherited npm_config_*, NODE_*, or token variables. */
export function closureEnv(sessionDir) {
  if (!isAbsolute(sessionDir)) throw new Error("session dir must be absolute");
  const files = closureConfigFiles(sessionDir);
  return {
    PATH: "/usr/bin:/bin",
    HOME: join(sessionDir, "closure-home"),
    npm_config_cache: join(sessionDir, "closure-cache"),
    npm_config_userconfig: files.user,
    npm_config_globalconfig: files.global,
  };
}

/** Creates $S/closure-config (0700; refused if it exists in any form) with both npmrc files by exclusive create (0600, empty). */
export async function prepareClosureConfig(sessionDir) {
  const dir = join(sessionDir, "closure-config");
  if (await exists(dir)) throw new Error(`refusing: closure-config already exists: ${dir}`);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  const files = closureConfigFiles(sessionDir);
  for (const path of [files.user, files.global]) await writeFile(path, "", { flag: "wx", mode: 0o600 });
  return files;
}

/** Just before the spawn: each npmrc must still be an empty regular file (no symlink) inside a real closure-config dir. */
export async function verifyClosureConfig(sessionDir) {
  const dir = join(sessionDir, "closure-config");
  const dirInfo = await lstat(dir).catch(() => null);
  if (!dirInfo || dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Error(`refusing: ${dir} must be a real directory`);
  const files = closureConfigFiles(sessionDir);
  for (const path of [files.user, files.global]) {
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isFile() || info.size !== 0) throw new Error(`refusing: ${path} must be an empty regular file (no symlink) at spawn time`);
  }
}

/** Reads npm's own package.json next to npm-cli.js (never runs npm). */
export async function readNpmVersion(cliPath = NPM_CLI) {
  const manifestPath = join(dirname(dirname(cliPath)), "package.json");
  const version = JSON.parse(await readFile(manifestPath, "utf8")).version;
  if (version !== NPM_VERSION) throw new Error(`npm ${NPM_VERSION} required at ${manifestPath}, found ${version}`);
  return version;
}

const exists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

/** Fresh $S/closure with only the generated package.json; refuses an existing dir or any .npmrc up to $S. */
export async function prepareClosureDir(sessionDir) {
  const dir = join(sessionDir, "closure");
  if (await exists(dir)) throw new Error(`closure dir already exists: ${dir}`);
  for (const candidate of [join(dir, ".npmrc"), join(sessionDir, ".npmrc")]) {
    if (await exists(candidate)) throw new Error(`refusing: ${candidate} exists (.npmrc could redirect npm)`);
  }
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, "package.json"), closurePackageJson(), { flag: "wx", mode: 0o644 });
  return dir;
}

/**
 * Walks every entry under `root`; reports links / hardlinks / special files / unsafe names.
 * Each file is read exactly once; with `keep`, the hashed bytes are retained in `out.data`.
 */
async function walkFiles(root, { read = readFile, keep = false } = {}, prefix = "", out = { files: [], problems: [], bytes: 0, data: new Map() }) {
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (!SAFE_NAME.test(name) || name === "." || name === "..") {
      out.problems.push(`unsafe path: ${JSON.stringify(rel)}`);
      continue;
    }
    const info = await lstat(join(root, rel));
    if (info.isSymbolicLink()) out.problems.push(`symlink: ${rel}`);
    else if (info.isDirectory()) await walkFiles(root, { read, keep }, rel, out);
    else if (!info.isFile()) out.problems.push(`special file: ${rel}`);
    else {
      if (info.nlink > 1) out.problems.push(`hardlink (nlink ${info.nlink}): ${rel}`);
      const data = await read(join(root, rel));
      out.bytes += data.length;
      out.files.push({ path: rel, size: data.length, sha256: sha256(data) });
      if (keep) out.data.set(rel, data);
    }
  }
  return out;
}

/** Installed package dirs (node_modules walk, nested), keyed like the lockfile ("node_modules/a/node_modules/b"). */
async function walkPackages(closureDir, base = "", out = []) {
  const modules = base ? `${base}/node_modules` : "node_modules";
  let names;
  try {
    names = (await readdir(join(closureDir, modules))).sort();
  } catch {
    return out;
  }
  const dirs = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      const scope = join(closureDir, modules, name);
      if (!(await lstat(scope)).isDirectory()) continue;
      for (const child of (await readdir(scope)).sort()) dirs.push(`${modules}/${name}/${child}`);
    } else dirs.push(`${modules}/${name}`);
  }
  for (const path of dirs) {
    const info = await lstat(join(closureDir, path));
    if (!info.isDirectory()) continue;
    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(join(closureDir, path, "package.json"), "utf8"));
    } catch {
      manifest = null;
    }
    out.push({ path, name: manifest?.name ?? null, version: manifest?.version ?? null });
    await walkPackages(closureDir, path, out);
  }
  return out;
}

function platformOk(entry) {
  const os = entry.os;
  const cpu = entry.cpu;
  const libc = entry.libc;
  if (os && (!os.includes("linux") || os.includes("!linux"))) return false;
  if (cpu && (!cpu.includes("arm64") || cpu.includes("!arm64"))) return false;
  if (libc && !libc.includes("glibc")) return false;
  return true;
}

export async function inspectClosure({ closureDir, allowlist = INSTALL_SCRIPT_ALLOWLIST, limits = CLOSURE_LIMITS }) {
  const problems = [];
  let stop = false;
  const lockBytes = await readFile(join(closureDir, "package-lock.json"));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const entries = isRecord(lock.packages) ? lock.packages : {};
  const packages = [];
  for (const [path, entry] of Object.entries(entries)) {
    if (path === "") continue;
    const record = {
      path,
      name: typeof entry.name === "string" ? entry.name : path.split("node_modules/").pop(),
      version: entry.version ?? null,
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null,
      optional: entry.optional === true,
      hasInstallScript: entry.hasInstallScript === true,
      os: list(entry.os),
      cpu: list(entry.cpu),
      libc: list(entry.libc),
    };
    packages.push(record);
    if (entry.link === true) problems.push(`${path}: link entry (link spec) is not allowed`);
    if (typeof record.resolved !== "string" || !record.resolved.startsWith(REGISTRY)) problems.push(`${path}: resolved ${JSON.stringify(record.resolved)} is not under ${REGISTRY}`);
    if (typeof record.integrity !== "string" || record.integrity === "") problems.push(`${path}: missing integrity`);
  }

  const walked = await walkFiles(join(closureDir, "node_modules"));
  problems.push(...walked.problems);
  const installed = await walkPackages(closureDir);
  const byPath = new Map(packages.map((record) => [record.path, record]));
  const installedPaths = new Set(installed.map((entry) => entry.path));
  for (const entry of installed) {
    const record = byPath.get(entry.path);
    if (!record) problems.push(`${entry.path} is installed but not in the lockfile`);
    else {
      if (entry.name !== record.name) problems.push(`${entry.path} installed name ${entry.name} != lockfile ${record.name}`);
      if (entry.version !== record.version) problems.push(`${entry.path} installed ${entry.version} != lockfile ${record.version}`);
    }
  }
  const omittedOptional = [];
  for (const record of packages) {
    if (installedPaths.has(record.path)) continue;
    if (record.optional) omittedOptional.push(record.path);
    else problems.push(`${record.path} is in the lockfile but not installed`);
  }

  const platformSelected = [];
  for (const record of packages.filter((entry) => installedPaths.has(entry.path))) {
    if (record.os || record.cpu || record.libc) {
      if (platformOk(record)) platformSelected.push(record.path);
      else problems.push(`platform package ${record.path} (${record.os ?? "*"}/${record.cpu ?? "*"}) is not linux/arm64`);
    }
    if (record.hasInstallScript && !Object.hasOwn(allowlist, `${record.name}@${record.version}`)) {
      problems.push(`STOP: install script not allowlisted: ${record.name}@${record.version}`);
      stop = true;
    }
  }

  const installedSpecs = new Set(packages.filter((entry) => installedPaths.has(entry.path) && platformSelected.includes(entry.path)).map((entry) => `${entry.name}@${entry.version}`));
  const expectedPlatformPackages = EXPECTED_PLATFORM_PACKAGES.map((spec) => ({ spec, selected: installedSpecs.has(spec) }));

  const peerKey = `node_modules/${PEER_NAME}`;
  const peerInstalled = installed.filter((entry) => entry.path === peerKey);
  if (byPath.get(peerKey)?.version !== PEER_VERSION || peerInstalled.length !== 1 || peerInstalled[0].version !== PEER_VERSION) {
    problems.push(`${PEER_NAME} must be exactly ${PEER_VERSION} at ${peerKey}`);
  }
  if (installed.length > limits.maxPackages) problems.push(`${installed.length} packages exceed ${limits.maxPackages}`);
  if (walked.bytes > limits.maxBytes) problems.push(`installed tree (${walked.bytes} bytes) exceeds ${limits.maxBytes} bytes`);

  return {
    problems,
    stop,
    lockfileSha256: sha256(lockBytes),
    packages,
    installed,
    omittedOptional,
    platformSelected,
    expectedPlatformPackages,
    files: walked.files,
    totals: { bytes: walked.bytes, packages: installed.length, files: walked.files.length },
  };
}

/** Runs Gate P once through the injected `run` and writes `$S/gate-p-<run>.json` (rejected receipts too). */
/**
 * `signal` (operator termination): checked before every preparation step and before the
 * spawn, passed to `run`, and re-checked after npm and after inspection. A cancelled Gate P
 * never writes an accepted receipt: it writes `status: "cancelled"` with the stage reached.
 */
export async function runGateP({ sessionDir, runId, approval, run, readNpmVersion: readVersion = readNpmVersion, afterPrepare = null, signal = null, writeReceipt = writeAtomic }) {
  const receiptPath = join(sessionDir, `gate-p-${runId}.json`);
  // Receipts are written atomically (temp + rename) and may be overwritten by a cancellation.
  const cancelledReceipt = async (stage, extra = {}) => {
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    // cleanupConfirmed: true unless npm was launched and its ORIGINAL process group did not
    // settle. Scoped explicitly: escaped descendants are not covered (CLEANUP_SCOPE_NOTE).
    const receipt = { schema: RECEIPT_SCHEMA, status: "cancelled", stage, receiptId: `closure-${runId}-cancelled`, runId, approval, plugin: `${PEER_NAME}@${PEER_VERSION}`, problems: [`cancelled by operator (${stage})`], cleanupConfirmed: true, cleanupScope: CLEANUP_SCOPE, cleanupScopeNote: CLEANUP_SCOPE_NOTE, ...extra };
    await writeReceipt(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  };
  const aborted = () => signal?.aborted === true;
  if (aborted()) return cancelledReceipt("before preparation");
  const npmVersion = await readVersion(NPM_CLI);
  if (aborted()) return cancelledReceipt("after npm version check");
  const closureDir = await prepareClosureDir(sessionDir);
  if (aborted()) return cancelledReceipt("after closure dir");
  await prepareClosureConfig(sessionDir);
  const env = closureEnv(sessionDir);
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.npm_config_cache, { recursive: true, mode: 0o700 });
  // Test seam only (tamper between creation and the spawn-time check).
  if (afterPrepare) await afterPrepare();
  if (aborted()) return cancelledReceipt("before npm install");
  await verifyClosureConfig(sessionDir);
  const result = await run(closureArgv(), { cwd: closureDir, env, timeoutMs: GATE_P_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  if (result.cancelled === true || aborted()) return cancelledReceipt("npm install", { cleanupConfirmed: result.cleanupUncertain !== true });

  let inspection = null;
  const problems = [];
  // Post-P1b audit (frame-2 MA3): an npm whose ORIGINAL process group did not settle is never accepted.
  if (result.cleanupUncertain === true) problems.push("npm install process group did not settle (cleanup uncertain; original process group not confirmed gone)");
  if (result.timedOut) problems.push(`npm install timed out after ${GATE_P_TIMEOUT_MS} ms (killed; no retry)`);
  else if (result.status !== 0) problems.push(`npm install exited with status ${result.status} (no retry)`);
  else {
    try {
      inspection = await inspectClosure({ closureDir });
      problems.push(...inspection.problems);
    } catch (error) {
      problems.push(`closure inspection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (aborted()) return cancelledReceipt("closure inspection");
  const lockfileSha256 = inspection?.lockfileSha256 ?? null;
  const receipt = {
    schema: RECEIPT_SCHEMA,
    status: problems.length === 0 ? "accepted" : "rejected",
    receiptId: `closure-${runId}-${lockfileSha256 ? lockfileSha256.slice(0, 12) : "none"}`,
    runId,
    approval,
    plugin: `${PEER_NAME}@${PEER_VERSION}`,
    closureDir,
    npm: { version: npmVersion, cliPath: NPM_CLI },
    node: { path: NODE_PATH, version: process.execPath === NODE_PATH ? process.version : null },
    command: { argv: closureArgv(), env, cwd: closureDir, timeoutMs: GATE_P_TIMEOUT_MS },
    authorization: PACOTE_RETRY_AUTHORIZATION,
    lockfileSha256,
    packages: inspection?.packages ?? [],
    installed: inspection?.installed ?? [],
    omittedOptional: inspection?.omittedOptional ?? [],
    platformSelected: inspection?.platformSelected ?? [],
    expectedPlatformPackages: inspection?.expectedPlatformPackages ?? EXPECTED_PLATFORM_PACKAGES.map((spec) => ({ spec, selected: false })),
    files: inspection?.files ?? [],
    totals: inspection?.totals ?? null,
    stop: inspection?.stop ?? false,
    problems,
  };
  await writeReceipt(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  // A signal during / right after the final write: the receipt must not stay accepted.
  if (aborted()) {
    await markReceiptCancelled(receiptPath, { stage: "receipt write", problems: [...receipt.problems, "cancelled by operator (receipt write)"] });
    return { ...receipt, status: "cancelled", previousStatus: receipt.status, stage: "receipt write" };
  }
  return receipt;
}

/** Problems with a Gate P receipt for Gate B (missing, rejected, run-id or approval mismatch). */
export function checkGatePReceipt(receipt, { runId, approval }) {
  if (!isRecord(receipt)) return ["Gate P receipt is missing"];
  const problems = [];
  if (receipt.schema !== RECEIPT_SCHEMA) problems.push("Gate P receipt has an unknown schema");
  if (receipt.status !== "accepted") problems.push(`Gate P receipt is ${receipt.status ?? "not accepted"} (rejected receipts never build)`);
  if (receipt.runId !== runId) problems.push(`Gate P receipt run id ${receipt.runId} != ${runId}`);
  if (receipt.approval !== approval) problems.push(`Gate P receipt approval ${receipt.approval} != ${approval}`);
  if (!/^[0-9a-f]{64}$/.test(String(receipt.lockfileSha256))) problems.push("Gate P receipt has no lockfile sha256");
  if (!Array.isArray(receipt.files)) problems.push("Gate P receipt has no file manifest");
  return problems;
}

/** Re-hashes node_modules against the receipt manifest: changed / extra / missing files and links are problems. */
export async function verifyClosureFiles({ closureDir, receipt, readFile: read = readFile }) {
  return (await hashAgainstReceipt({ closureDir, receipt, read, keep: false })).problems;
}

async function hashAgainstReceipt({ closureDir, receipt, read, keep }) {
  const walked = await walkFiles(join(closureDir, "node_modules"), { read, keep });
  const problems = [...walked.problems];
  const expected = new Map(receipt.files.map((file) => [file.path, file.sha256]));
  const actual = new Map(walked.files.map((file) => [file.path, file.sha256]));
  for (const [path, digest] of actual) {
    if (!expected.has(path)) problems.push(`extra: ${path}`);
    else if (expected.get(path) !== digest) problems.push(`changed: ${path}`);
  }
  for (const path of expected.keys()) if (!actual.has(path)) problems.push(`missing: ${path}`);
  const lock = await read(join(closureDir, "package-lock.json")).catch(() => null);
  if (!lock || sha256(lock) !== receipt.lockfileSha256) problems.push("changed: package-lock.json");
  return { problems, data: walked.data };
}

/**
 * Verified closure files relative to node_modules (nested paths kept), without npm's hidden
 * lockfile. Returns the SAME buffers that were hashed (each file read once), so nothing that
 * changes on disk after verification can reach the image context.
 */
export async function closureTreeFiles({ closureDir, receipt, readFile: read = readFile }) {
  const { problems, data } = await hashAgainstReceipt({ closureDir, receipt, read, keep: true });
  if (problems.length > 0) throw new Error(`closure changed since Gate P:\n- ${problems.join("\n- ")}`);
  const files = new Map();
  for (const file of receipt.files) {
    if (file.path === ".package-lock.json") continue;
    files.set(file.path, data.get(file.path));
  }
  return files;
}
