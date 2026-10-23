// Council-only. Gate B / B' build-context assembly (pure file work; no Docker).
//
// The context dir contains only allowlisted files:
//   Dockerfile                COPY-only, FROM the base image by id (gates.dockerfileProblems)
//   harness/<closure>.mjs     driver.mjs + everything it imports (node: builtins + relative only)
//   meta/cells.json           baked per-host cell allowlist (qualification cells + probe)
//   meta/image-manifest.json  host id, executable path + sha256 + provenance, archive sha256, run id
//   bin/opencode-<ver>        the hashed host executable (mode 0755)
//   plugin-cache/{cache,config}/...  exact-spec plugin preseed (package-stage.mjs)
// A context manifest (path, size, mode, sha256 of every file) is returned with its own sha256.
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import { expectedCells, hostById, probeCell } from "./cells.mjs";
import { ARCHIVE_LABEL, BASE_IMAGE_ID, dockerfileProblems, HOST_LABEL, IMAGE_MANIFEST_LABEL, OWNER_LABEL } from "./gates.mjs";
import { checkGatePReceipt, closureTreeFiles, PEER_NAME, PEER_VERSION } from "./closure.mjs";
import { planPluginCache, readPackedArchive, writeTree } from "./package-stage.mjs";
import { moduleSpecifiers } from "../pack-checks.mjs";

const IMAGE_ROOT = "/opt/council-rh";
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** driver.mjs plus every module it reaches (static or dynamic); only node: builtins and in-harness relative imports. */
export async function harnessClosure(harnessDir, entry = "driver.mjs") {
  const found = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (found.has(file)) continue;
    let text;
    try {
      text = await readFile(join(harnessDir, file), "utf8");
    } catch {
      throw new Error(`harness module missing: ${file}`);
    }
    found.add(file);
    for (const { specifier } of moduleSpecifiers(text)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) throw new Error(`${file}: bare specifier ${specifier} is not allowed in the image harness`);
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (target.startsWith("../") || target === "..") throw new Error(`${file}: import ${specifier} escapes the harness directory`);
      queue.push(target);
    }
  }
  return [...found].sort();
}

async function listFiles(root, prefix = "") {
  const files = [];
  for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...(await listFiles(root, rel)));
    else if (item.isFile()) files.push(rel);
    else throw new Error(`unexpected non-regular entry in context: ${rel}`);
  }
  return files;
}

/**
 * The ENTRYPOINT below is documentation only: every `docker run` overrides it explicitly
 * (gates.runArgv `--entrypoint`). Labels let Gate C verify the built image by inspection:
 * owner (run id), host, packed archive sha256, and the sha256 of meta/image-manifest.json.
 */
export function renderDockerfile({ hostId, runId, baseImageId = BASE_IMAGE_ID, archiveSha256, imageManifestSha256 }) {
  return [
    `FROM ${baseImageId}`,
    `COPY harness/ ${IMAGE_ROOT}/`,
    `COPY meta/ ${IMAGE_ROOT}/`,
    `COPY bin/ ${IMAGE_ROOT}/bin/`,
    `COPY plugin-cache/ ${IMAGE_ROOT}/plugin-cache/`,
    "USER 1000:1000",
    "WORKDIR /scratch",
    `ENTRYPOINT ["/usr/local/bin/node","${IMAGE_ROOT}/driver.mjs"]`,
    "CMD []",
    `LABEL ${OWNER_LABEL}=${runId}`,
    `LABEL ${HOST_LABEL}=${hostId}`,
    `LABEL ${ARCHIVE_LABEL}=${archiveSha256}`,
    `LABEL ${IMAGE_MANIFEST_LABEL}=${imageManifestSha256}`,
    "",
  ].join("\n");
}

/**
 * `closure` (Amendment A2, V1 only): { dir, receipt, approval } from Gate P. The receipt
 * must be accepted, for this run id and the expected Gate P approval, and the closure
 * is re-hashed (changed / extra / missing files refuse) before anything is written.
 */
export async function assembleImageContext({ contextDir, hostId, runId, harnessDir, hostExecutable, packedArchive, baseImageId = BASE_IMAGE_ID, extraPackages = [], allowUnresolvedPeers = false, closure = null }) {
  const host = hostById(hostId);
  try {
    await lstat(contextDir);
    throw Object.assign(new Error(`context dir must not exist: ${contextDir}`), { code: "EEXIST" });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const executable = await readFile(hostExecutable.path);
  if (sha256(executable) !== hostExecutable.sha256) throw new Error(`host executable sha256 mismatch: ${sha256(executable)} != ${hostExecutable.sha256}`);
  const packed = await readPackedArchive(packedArchive);
  let extraTree = null;
  let closureRecord = null;
  if (host.family === "v1" && closure) {
    const receiptProblems = checkGatePReceipt(closure.receipt, { runId, approval: closure.approval });
    if (receiptProblems.length > 0) throw new Error(`Gate P receipt refused: ${receiptProblems.join("; ")}`);
    extraTree = await closureTreeFiles({ closureDir: closure.dir, receipt: closure.receipt });
    closureRecord = { receiptId: closure.receipt.receiptId, lockfileSha256: closure.receipt.lockfileSha256, plugin: `${PEER_NAME}@${PEER_VERSION}` };
  }
  const plan = planPluginCache({ family: host.family, hostVersion: host.version, manifest: packed.manifest, files: packed.files, extraPackages, extraTree });
  if (plan.unresolvedPeers.length > 0 && !allowUnresolvedPeers) {
    throw new Error(`unresolved peer dependency for ${hostId}: ${plan.unresolvedPeers.join(", ")} (V1 server() imports it lazily; supply an accepted Gate P closure receipt)`);
  }
  const harnessFiles = await harnessClosure(harnessDir);

  const executableName = `opencode-${host.version}`;
  const cells = [...expectedCells().filter((cell) => cell.host === hostId).map((cell) => cell.id), probeCell(hostId).id];
  const imageManifest = {
    schema: "council-rh-image/1",
    runId,
    baseImageId,
    archiveSha256: packed.sha256,
    pluginSpec: plan.spec,
    unresolvedPeers: plan.unresolvedPeers,
    closure: closureRecord,
    host: { id: hostId, family: host.family, version: host.version, executablePath: `${IMAGE_ROOT}/bin/${executableName}`, executableSha256: hostExecutable.sha256, provenance: hostExecutable.provenance ?? null },
  };
  const imageManifestBytes = Buffer.from(`${JSON.stringify(imageManifest, null, 2)}\n`);
  const imageManifestSha256 = sha256(imageManifestBytes);
  const dockerfile = renderDockerfile({ hostId, runId, baseImageId, archiveSha256: packed.sha256, imageManifestSha256 });
  const problems = dockerfileProblems(dockerfile, { baseImageId });
  if (problems.length > 0) throw new Error(`generated Dockerfile rejected: ${problems.join("; ")}`);

  await mkdir(contextDir, { recursive: true, mode: 0o755 });
  await writeFile(join(contextDir, "Dockerfile"), dockerfile, { flag: "wx", mode: 0o644 });
  for (const file of harnessFiles) {
    await mkdir(dirname(join(contextDir, "harness", file)), { recursive: true, mode: 0o755 });
    await writeFile(join(contextDir, "harness", file), await readFile(join(harnessDir, file)), { flag: "wx", mode: 0o644 });
  }
  await mkdir(join(contextDir, "meta"), { mode: 0o755 });
  await writeFile(join(contextDir, "meta", "cells.json"), `${JSON.stringify(cells, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  await writeFile(join(contextDir, "meta", "image-manifest.json"), imageManifestBytes, { flag: "wx", mode: 0o644 });
  await mkdir(join(contextDir, "bin"), { mode: 0o755 });
  await writeFile(join(contextDir, "bin", executableName), executable, { flag: "wx", mode: 0o755 });
  await mkdir(join(contextDir, "plugin-cache", "cache"), { recursive: true, mode: 0o755 });
  await mkdir(join(contextDir, "plugin-cache", "config"), { recursive: true, mode: 0o755 });
  await writeTree(join(contextDir, "plugin-cache", "cache"), plan.cache);
  await writeTree(join(contextDir, "plugin-cache", "config"), plan.config);

  const files = [];
  for (const path of await listFiles(contextDir)) {
    const data = await readFile(join(contextDir, path));
    files.push({ path, size: data.length, mode: (await lstat(join(contextDir, path))).mode & 0o777, sha256: sha256(data) });
  }
  const manifest = { schema: "council-rh-context/1", hostId, runId, baseImageId, imageManifest, files };
  return { contextDir, dockerfile, manifest, manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))), imageManifest, imageManifestSha256 };
}
