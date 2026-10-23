// Provenance: ADAPTED (rewritten) from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/package-stage.mjs.
// Retained: exact-SemVer check, safe path segments, reading only package/ members of
// our own hashed tarball. Replaced: normalizer package identity and stage-into-fixture
// with a pure preseed PLAN for the council package (V1 + V2 exact-spec caches) and a
// no-overwrite tree writer used by image-context assembly. See test/PROVENANCE.md.
//
// Layouts (research §6, source-read, UNVERIFIED at runtime until the spike):
//   V1 cache:  $XDG_CACHE_HOME/opencode/packages/<spec>/node_modules/<pkg>/...
//   V1 config: $XDG_CONFIG_HOME/opencode/node_modules (exists) + package.json/package-lock.json
//              whose lock root names every dependency incl. the injected @opencode-ai/plugin
//   V2 cache:  $XDG_CACHE_HOME/opencode/npm/<spec>/<generation>/{package.json,package-lock.json,node_modules/<pkg>/...}
// <spec> is the exact "<name>@<version>" declared in the host config.
//
// OPEN QUESTION (reported): the V1 server() lazily imports its peer
// @opencode-ai/plugin. With reify skipped, that peer is not installed next to the
// plugin unless seeded via `extraPackages`; the plan reports it as `unresolvedPeers`.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { listTarGz, tarCapFor, validateEntries } from "./artifacts.mjs";

export const PACKAGE_NAME = "@skwid138/opencode-council";
export const V2_CACHE_GENERATION = 1;
/** Bounds for our own packed archive (~40 files, < 300 KB). */
export const PACKAGE_LIMITS = Object.freeze({ maxEntries: 200, maxExpandedBytes: 5_000_000, maxFileBytes: 2_000_000 });

const NUMERIC = "0|[1-9]\\d*";
const PRERELEASE_ID = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const BUILD_ID = "[0-9a-zA-Z-]+";
const EXACT_VERSION = new RegExp(
  `^(?:${NUMERIC})\\.(?:${NUMERIC})\\.(?:${NUMERIC})(?:-${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*)?(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?$`,
);

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function safeRel(value, label) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`unsafe ${label}: ${JSON.stringify(value)}`);
  }
}

/** Reads our own packed archive after verifying its sha256; only package/ regular files are accepted. */
export async function readPackedArchive({ path, sha256: expected }) {
  const buffer = await readFile(path);
  if (sha256(buffer) !== expected) throw new Error(`packed archive digest mismatch: expected ${expected}, got ${sha256(buffer)}`);
  const entries = listTarGz(buffer, { maxTarBytes: tarCapFor(PACKAGE_LIMITS) });
  const outside = entries.filter((entry) => !entry.name.startsWith("package/")).map((entry) => entry.name);
  if (outside.length > 0) throw new Error(`packed archive has entries outside package/: ${outside.join(", ")}`);
  const allowed = entries.map((entry) => entry.name);
  const validation = validateEntries(entries, { limits: PACKAGE_LIMITS, members: { required: ["package/package.json"], allowed } });
  if (!validation.ok) throw new Error(`packed archive rejected:\n- ${validation.problems.join("\n- ")}`);
  const tar = gunzipSync(buffer, { maxOutputLength: tarCapFor(PACKAGE_LIMITS) });
  const files = new Map();
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const rel = entry.name.slice("package/".length);
    safeRel(rel, "package file");
    files.set(rel, Buffer.from(tar.subarray(entry.dataOffset, entry.dataOffset + entry.size)));
  }
  const manifest = JSON.parse(files.get("package.json").toString("utf8"));
  if (manifest.name !== PACKAGE_NAME) throw new Error(`packed archive package name is ${manifest.name}, expected ${PACKAGE_NAME}`);
  return { manifest, files, sha256: expected };
}

/**
 * The V1 config-dir install skip-marker (research §6): `<dir>/node_modules` exists and
 * `<dir>/package.json` / `<dir>/package-lock.json` name `@opencode-ai/plugin` at the host
 * version, so the V1 host does not try to install that dependency into `<dir>` (no network in
 * the cell). Entries in write order (dir, package.json, package-lock.json), relative paths.
 * Used for the XDG config dir (`opencode`, below) and, for V1 S11 only, the project's
 * `.opencode` (scenarios-p1b.mjs).
 */
export function v1ConfigInstallMarker(dir, hostVersion) {
  safeRel(dir, "config dir");
  if (!EXACT_VERSION.test(String(hostVersion))) throw new Error(`V1 config marker needs an exact host version, got ${hostVersion}`);
  const lockDeps = { "@opencode-ai/plugin": hostVersion };
  return [
    { rel: `${dir}/node_modules`, type: "dir" },
    { rel: `${dir}/package.json`, type: "file", data: json({ dependencies: lockDeps }) },
    { rel: `${dir}/package-lock.json`, type: "file", data: json({ name: "opencode", lockfileVersion: 3, requires: true, packages: { "": { dependencies: lockDeps } } }) },
  ];
}

/**
 * Pure preseed plan. Entries are { rel, type: "file", data } | { rel, type: "dir" },
 * relative to XDG_CACHE_HOME (`cache`) or XDG_CONFIG_HOME (`config`).
 */
export function planPluginCache({ family, hostVersion, manifest, files, extraPackages = [], extraTree = null, generation = V2_CACHE_GENERATION }) {
  if (manifest?.name !== PACKAGE_NAME) throw new Error(`unexpected package name ${manifest?.name}`);
  if (!EXACT_VERSION.test(String(manifest.version))) throw new Error(`plugin spec needs an exact version, got ${manifest.version}`);
  const spec = `${PACKAGE_NAME}@${manifest.version}`;
  const packageEntries = (prefix, name, packageFiles) =>
    [...packageFiles].map(([rel, data]) => {
      safeRel(rel, "package file");
      return { rel: `${prefix}/node_modules/${name}/${rel}`, type: "file", data };
    });
  const extras = (prefix) => extraPackages.flatMap((extra) => packageEntries(prefix, extra.name, extra.files));
  const peers = Object.keys(manifest.peerDependencies ?? {});
  const seeded = new Set(extraPackages.map((extra) => extra.name));
  // Amendment A2: a verified Gate P closure, paths relative to node_modules, nested paths kept.
  const treeEntries = (prefix) => {
    if (!extraTree) return [];
    return [...extraTree].map(([rel, data]) => {
      safeRel(rel, "closure file");
      if (rel === PACKAGE_NAME || rel.startsWith(`${PACKAGE_NAME}/`)) throw new Error(`closure file ${rel} collides with the council package`);
      return { rel: `${prefix}/node_modules/${rel}`, type: "file", data };
    });
  };
  if (extraTree) {
    for (const rel of extraTree.keys()) {
      const top = rel.startsWith("@") ? rel.split("/").slice(0, 2).join("/") : rel.split("/")[0];
      seeded.add(top);
    }
  }

  if (family === "v1") {
    const prefix = `opencode/packages/${spec}`;
    return {
      spec,
      cache: [...packageEntries(prefix, PACKAGE_NAME, files), ...extras(prefix), ...treeEntries(prefix)],
      config: v1ConfigInstallMarker("opencode", hostVersion),
      // V1 server() lazily imports its peer; V2 setup() never does.
      unresolvedPeers: peers.filter((peer) => !seeded.has(peer)),
    };
  }
  if (family === "v2") {
    if (extraTree) throw new Error("the Gate P closure is V1 only (V2 never imports @opencode-ai/plugin)");
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error(`V2 cache generation must be a non-negative integer: ${generation}`);
    const prefix = `opencode/npm/${spec}/${generation}`;
    const dependencies = { [PACKAGE_NAME]: manifest.version };
    return {
      spec,
      cache: [
        { rel: `${prefix}/package.json`, type: "file", data: json({ dependencies }) },
        { rel: `${prefix}/package-lock.json`, type: "file", data: json({ lockfileVersion: 3, requires: true, packages: { "": { dependencies }, [`node_modules/${PACKAGE_NAME}`]: { version: manifest.version } } }) },
        ...packageEntries(prefix, PACKAGE_NAME, files),
        ...extras(prefix),
      ],
      config: [],
      unresolvedPeers: [],
    };
  }
  throw new Error(`unknown host family: ${family}`);
}

/** Writes plan entries under `root`; never overwrites a file. Files are 0644, dirs 0755. */
export async function writeTree(root, entries) {
  for (const entry of entries) {
    safeRel(entry.rel, "tree path");
    const target = join(root, entry.rel);
    if (entry.type === "dir") {
      await mkdir(target, { recursive: true, mode: 0o755 });
      continue;
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, entry.data, { flag: "wx", mode: 0o644 });
  }
}
