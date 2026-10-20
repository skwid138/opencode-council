// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/pack-artifact.mjs
// Local modifications (see test/PROVENANCE.md):
//   1. PACKAGE_ROOT_FILES / PACK_LIMITS sized for @skwid138/opencode-council
//      (no SECURITY.md; ~40 files).
//   2. Recursive src discovery: nested production modules map to nested
//      dist/<path>.js + dist/<path>.d.ts outputs.
//   3. Recursive dist inspection: rejects compiled test artifacts (`*.test.*`,
//      `*.test-d.*`) anywhere under dist (including stale leftovers), symlinks at
//      any depth, and any stale/foreign file or directory not on the expected path set.
//
// Script-free package archive construction for test/verify-pack.mjs.
//
// This replaces `npm pack`, which (npm 10.9.2 / pacote 19) was observed to run
// the `prepare` lifecycle script despite --ignore-scripts. Nothing here runs a
// package manager or any lifecycle script: the archive is built by the system
// `tar` from an isolated stage holding exactly the expected regular files.
//
// The result is a constructed archive for consumer verification. It is NOT
// proof of npm publish file selection and is NOT byte-reproducible (entries are
// sorted, but mtimes are not normalized).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { listTarGz, tarCapFor, validateEntries } from "./real-host/artifacts.mjs";

/** Root files shipped next to dist/. package.json is shipped byte-for-byte, scripts included. */
export const PACKAGE_ROOT_FILES = Object.freeze(["LICENSE", "README.md", "package.json"]);

/**
 * Caps for this repo's own archive. The current package is ~40 files and well
 * under 300 KB expanded; these leave generous headroom while still bounding a
 * runaway build or a hostile archive before anything is extracted.
 */
export const PACK_LIMITS = Object.freeze({ maxEntries: 128, maxExpandedBytes: 4_000_000, maxFileBytes: 1_000_000 });
const FILE_MODE = 0o644;
const TAR_TIMEOUT_MS = 30_000;

const isProductionModule = (name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && !/\.test(-d)?\.ts$/.test(name);

/** Compiled test or type-test output (`a.test.js`, `b.test-d.d.ts`, `c.test.js.map`, ...). */
export const isCompiledTestArtifact = (path) => /\.test(-d)?\./.test(path.split("/").pop() ?? "");

/** Every regular-file path under `dir`, relative and `/`-separated; symlinks anywhere are refused. */
async function listSourceModules(dir, prefix = "") {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`refusing to build: src/${rel} is a symlink`);
    if (item.isDirectory()) found.push(...(await listSourceModules(join(dir, item.name), rel)));
    else if (item.isFile() && isProductionModule(item.name)) found.push(rel);
  }
  return found;
}

/** Sorted package-relative paths: root files plus dist/<m>.js and dist/<m>.d.ts for every production module under src/ (recursively). */
export async function expectedPackageFiles(repoRoot) {
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const declared = Array.isArray(manifest.files) ? [...manifest.files].sort() : manifest.files;
  const explicit = ["dist", ...PACKAGE_ROOT_FILES.filter((name) => name !== "package.json")].sort();
  if (JSON.stringify(declared) !== JSON.stringify(explicit)) {
    throw new Error(`package.json files ${JSON.stringify(manifest.files)} no longer matches the explicit set ${JSON.stringify(explicit)}; update pack-artifact.mjs deliberately`);
  }
  const modules = (await listSourceModules(join(repoRoot, "src"))).map((name) => name.slice(0, -".ts".length));
  return [...PACKAGE_ROOT_FILES, ...modules.flatMap((name) => [`dist/${name}.js`, `dist/${name}.d.ts`])].sort();
}

/** Filesystem and tar operations used by the builder. Overridable for fault-injection tests only. */
const REAL_IO = Object.freeze({ lstat, open, runTar: (args) => runTar(args) });

export async function buildPackageArchive({ repoRoot, workDir, build, consumerChecks, retainTo, limits = PACK_LIMITS, io: ioOverrides = {} }) {
  const io = { ...REAL_IO, ...ioOverrides };
  await assertBuildBoundary(repoRoot);
  const expected = await expectedPackageFiles(repoRoot);
  // Every expected file becomes one archive entry (no directory entries are archived).
  if (expected.length > limits.maxEntries) throw new Error(`${expected.length} package files exceed maxEntries ${limits.maxEntries}`);
  await build();
  const files = await collectPackageFiles(repoRoot, expected, { io, limits });
  const manifest = JSON.parse(files.get("package.json").toString("utf8"));

  const stageRoot = join(workDir, "stage");
  await stagePackage(files, stageRoot);
  const members = expected.map((name) => `package/${name}`);
  const archivePath = join(workDir, archiveFileName(manifest));
  if (await lstatOrNull(archivePath)) throw new Error(`refusing to overwrite existing archive ${archivePath}`);
  // The archive path was verified absent, so on any failure from here on this
  // call removes only the file it (or tar) created; partial output never lingers.
  try {
    io.runTar(["--format=ustar", "--numeric-owner", "-czf", archivePath, "-C", stageRoot, ...members]);
    const buffer = await assertPackageArchive(archivePath, files, limits);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (consumerChecks) await consumerChecks({ archivePath, buffer, sha256, members });
    const retainedPath = retainTo ? await retainCandidate(io, buffer, retainTo) : null;
    return { archivePath, members, sha256, size: buffer.length, retainedPath };
  } catch (error) {
    await rm(archivePath, { force: true });
    throw error;
  }
}

/**
 * Publication gate: called only after validation and every requested consumer
 * check passed. Exclusive create, so an existing destination is never touched;
 * a failed write removes only the file this call created.
 */
async function retainCandidate(io, buffer, dest) {
  let created = false;
  try {
    const handle = await io.open(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
    created = true;
    try {
      await handle.writeFile(buffer);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (created) await rm(dest, { force: true });
    throw error;
  }
  return dest;
}

/**
 * Source/output boundary, checked before the build writes anything: the build
 * must not follow a symlink out of the repo.
 */
async function assertBuildBoundary(repoRoot) {
  for (const path of [repoRoot, join(repoRoot, "src")]) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`refusing to build: ${path} is a symlink`);
    if (!info.isDirectory()) throw new Error(`refusing to build: ${path} is not a directory`);
  }
  const dist = await lstatOrNull(join(repoRoot, "dist"));
  if (dist?.isSymbolicLink()) throw new Error(`refusing to build: ${join(repoRoot, "dist")} is a symlink`);
}

async function lstatOrNull(path, lstatImpl = lstat) {
  try {
    return await lstatImpl(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** npm-style tarball name: `@scope/name` 1.2.3 -> scope-name-1.2.3.tgz. */
function archiveFileName(manifest) {
  return `${String(manifest.name).replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
}

/**
 * Reads exactly the expected files after the build. Rejects stale or foreign
 * dist entries (including subdirectories), missing outputs, symlinks, and
 * anything that is not a regular file. Never copies dist wholesale.
 */
async function collectPackageFiles(repoRoot, expected, { io, limits }) {
  const lstatImpl = io.lstat;
  const distDir = join(repoRoot, "dist");
  for (const path of [repoRoot, distDir]) {
    const info = await lstatImpl(path);
    if (info.isSymbolicLink()) throw new Error(`refusing to package: ${path} is a symlink`);
    if (!info.isDirectory()) throw new Error(`refusing to package: ${path} is not a directory`);
  }
  const expectedDist = new Set(expected.filter((name) => name.startsWith("dist/")));
  const expectedDirs = new Set();
  for (const name of expectedDist) {
    const parts = name.split("/");
    for (let i = 2; i < parts.length; i += 1) expectedDirs.add(parts.slice(0, i).join("/"));
  }
  const listing = await listDistTree(distDir, "dist", lstatImpl);
  const testArtifacts = listing.filter((entry) => isCompiledTestArtifact(entry.path)).map((entry) => entry.path).sort();
  if (testArtifacts.length > 0) throw new Error(`compiled test artifact(s) in build output: ${testArtifacts.join(", ")}`);
  const links = listing.filter((entry) => entry.type === "symlink").map((entry) => entry.path).sort();
  if (links.length > 0) throw new Error(`refusing to package: ${links.join(", ")} is a symlink`);
  const unexpected = listing
    .filter((entry) => (entry.type === "directory" ? !expectedDirs.has(entry.path) : !expectedDist.has(entry.path)))
    .map((entry) => entry.path)
    .sort();
  if (unexpected.length > 0) throw new Error(`unexpected build output(s) (stale or foreign): ${unexpected.join(", ")}`);

  const files = new Map();
  // Pass 1, metadata only: every expected file must exist as a regular file, and
  // per-file and summed sizes must fit the caps before any payload is read.
  const sizes = new Map();
  let total = 0;
  for (const name of expected) {
    const info = await lstatOrNull(join(repoRoot, name), lstatImpl);
    if (!info) throw new Error(`missing package file: ${name}`);
    if (info.isSymbolicLink()) throw new Error(`package file ${name} is a symlink`);
    if (!info.isFile()) throw new Error(`package file ${name} is not a regular file`);
    if (info.size > limits.maxFileBytes) throw new Error(`package file ${name} exceeds maxFileBytes (${info.size} > ${limits.maxFileBytes})`);
    sizes.set(name, info.size);
    total += info.size;
  }
  if (total > limits.maxExpandedBytes) throw new Error(`package files total ${total} bytes, exceeding maxExpandedBytes ${limits.maxExpandedBytes}`);

  // Pass 2, bounded reads. Metadata can change between passes (no TOCTOU guarantee),
  // so each read re-checks the opened inode and requires exactly the checked byte
  // count; the summed bytes therefore cannot exceed the cap enforced above.
  for (const name of expected) {
    files.set(name, await readRegularFileNoFollow(io, join(repoRoot, name), name, sizes.get(name)));
  }
  return files;
}

/** Recursive lstat listing of dist (never follows symlinks; does not descend into them). */
async function listDistTree(dir, prefix, lstatImpl) {
  const entries = [];
  for (const name of await readdir(dir)) {
    const path = `${prefix}/${name}`;
    const info = await lstatImpl(join(dir, name));
    if (info.isSymbolicLink()) entries.push({ path, type: "symlink" });
    else if (info.isDirectory()) {
      entries.push({ path, type: "directory" });
      entries.push(...(await listDistTree(join(dir, name), path, lstatImpl)));
    } else entries.push({ path, type: info.isFile() ? "file" : "other" });
  }
  return entries;
}

/**
 * Opens without following a final symlink, re-checks the opened inode with
 * fstat, and reads at most `expectedSize + 1` bytes so a file that changed
 * since the metadata pass is rejected instead of read unbounded.
 */
async function readRegularFileNoFollow(io, path, name, expectedSize) {
  const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`package file ${name} is not a regular file`);
    if (info.size !== expectedSize) throw new Error(`package file ${name} changed size since it was checked (${expectedSize} -> ${info.size})`);
    const buffer = Buffer.alloc(expectedSize + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== expectedSize) throw new Error(`package file ${name} read ${length > expectedSize ? "more" : "fewer"} bytes than its checked size ${expectedSize}`);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function stagePackage(files, stageRoot) {
  await mkdir(stageRoot);
  for (const [name, data] of files) {
    const dest = join(stageRoot, "package", name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data, { flag: "wx", mode: FILE_MODE });
    await chmod(dest, FILE_MODE);
  }
}

/** Environment for every system tar invocation: system PATH only, no inherited TAR_OPTIONS or tar reader/writer options, macOS metadata suppressed. */
export function tarEnv() {
  return { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1", LC_ALL: "C" };
}

export function runTar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8", env: tarEnv(), timeout: TAR_TIMEOUT_MS });
  if (result.status !== 0) throw new Error(`tar ${args.join(" ")} failed (${result.status ?? result.signal ?? result.error?.message}): ${result.stderr}`);
  return result;
}

/**
 * Bounded validation before any consumer touches the archive; throws on any
 * unsafe property. `files` maps package-relative names to the exact expected
 * bytes. Checks, in order: archive file size, bounded decompression, exact
 * member set (no extras, no duplicates, all present), regular files only (no
 * links, directories are not expected either), size caps, and exact bytes.
 */
export async function assertPackageArchive(archivePath, files, limits = PACK_LIMITS) {
  const cap = tarCapFor(limits);
  const info = await lstat(archivePath);
  if (!info.isFile()) throw new Error(`archive file ${archivePath} is not a regular file`);
  if (info.size > cap) throw new Error(`archive file ${archivePath} (${info.size} bytes) exceeds the ${cap}-byte cap`);
  const buffer = await readFile(archivePath);
  const expectedNames = [...files.keys()].map((name) => `package/${name}`);
  const entries = listTarGz(buffer, { maxTarBytes: cap });
  const validation = validateEntries(entries, { limits, members: { required: expectedNames, allowed: expectedNames } });
  if (!validation.ok) throw new Error(`package archive rejected:\n- ${validation.problems.join("\n- ")}`);
  const tar = gunzipSync(buffer, { maxOutputLength: cap });
  for (const entry of entries) {
    if (entry.type !== "file") throw new Error(`package archive member is not a regular file: ${entry.name}`);
    const data = tar.subarray(entry.dataOffset, entry.dataOffset + entry.size);
    if (!data.equals(files.get(entry.name.slice("package/".length)))) throw new Error(`package archive member bytes differ from the staged file: ${entry.name}`);
  }
  return buffer;
}
