// Council-only (not copied; acquisition contract from the normalizer V1 plan,
// research §4). Gate A host acquisition. Nothing here runs unless Gate A is
// approved: the network command is executed only through the injected `run`,
// and unit tests inject a fake that never touches the network.
//
// One attempt per artifact, no retry, `env -i curl` with HTTPS-only redirects
// (<= 5), bounded connect/total time and file size, into a unique .part file in
// the session temp dir. The digest (and, for V1, the exact size) is verified
// BEFORE the archive is listed; the bounded listing must contain exactly the
// allowlisted members (no links, no escapes, no duplicates); then only the
// allowlisted executable is extracted (never overwriting) and a provenance
// receipt links its sha256 to the archive digest and member name.
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { extractMember, listTarGz, tarCapFor, validateEntries } from "./artifacts.mjs";
import { hostById } from "./cells.mjs";

const MiB = 1024 * 1024;
const V1_LIMITS = Object.freeze({ maxEntries: 16, maxExpandedBytes: 256 * MiB, maxFileBytes: 256 * MiB });
const V2_LIMITS = Object.freeze({ maxEntries: 64, maxExpandedBytes: 300 * MiB, maxFileBytes: 300 * MiB });
const V1_MEMBERS = Object.freeze({ required: ["opencode"], allowed: ["opencode"] });
const V2_MEMBERS = Object.freeze({ required: ["package/bin/opencode"], allowed: ["package/bin/opencode", "package/package.json"] });

const v1 = (version, size, sha256) =>
  Object.freeze({
    url: `https://github.com/anomalyco/opencode/releases/download/v${version}/opencode-linux-arm64.tar.gz`,
    size,
    cap: size,
    digest: Object.freeze({ algorithm: "sha256", value: sha256 }),
    limits: V1_LIMITS,
    members: V1_MEMBERS,
    executableMember: "opencode",
  });
const v2 = (version, integrity) =>
  Object.freeze({
    url: `https://registry.npmjs.org/@opencode/cli-linux-arm64/-/cli-linux-arm64-${version}.tgz`,
    size: null,
    cap: 128 * MiB,
    digest: Object.freeze({ algorithm: "sha512", value: integrity }),
    limits: V2_LIMITS,
    members: V2_MEMBERS,
    executableMember: "package/bin/opencode",
  });

/** The four approved Linux ARM64 (glibc) host artifacts, pinned to upstream digests. */
export const ARTIFACTS = Object.freeze({
  "v1-1.18.29": v1("1.18.29", 60_343_887, "70baf769395ca4e7a68924026530c390eace194f3b7e4919d4efcb2aa2eed3c0"),
  "v1-1.19.3": v1("1.19.3", 60_519_745, "7900818a6a98881edbbadab4b7525940eff3b9750040c200481f9f56cacee405"),
  "v2-2.0.28": v2("2.0.28", "sha512-BOjXZMtvYiQ9xowfHXJseARn7wHN8RTvRvYvMMIsjIOEJOYtv4aPvB4l0BmmnhUEhZQgrprPFamkUDy0lDiYiw=="),
  "v2-2.0.32": v2("2.0.32", "sha512-YR5O03irvmot/G0f8W49ehvhn5uqCFN3vf9JTsChvf47W6ldjKCNvsaCSXS2SP26dPOUMQBn7WqbKnyHzrNR5w=="),
});

export const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Exact single-attempt curl argv (no shell). `env -i` starts curl with an empty environment. */
export function curlArgv({ artifact, partPath }) {
  return [
    "/usr/bin/env", "-i", "/usr/bin/curl", "-q",
    "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "5",
    "--connect-timeout", "20", "--max-time", "300", "--max-filesize", String(artifact.cap),
    "--fail", "--location", "--silent", "--show-error", "--output", partPath,
    artifact.url,
  ];
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

/**
 * Acquires one host executable. `run(argv, { timeoutMs, env })` must execute argv
 * without a shell and resolve { status, signal, stdout, stderr }.
 */
export async function acquireHost({ hostId, artifact = ARTIFACTS[hostId], workDir, stagingDir, run }) {
  const host = hostById(hostId);
  if (!artifact) throw new Error(`no approved artifact for ${hostId}`);
  const dest = join(stagingDir, `opencode-${host.version}`);
  if (await exists(dest)) throw new Error(`staged executable already exists (EEXIST): ${dest}`);
  const partPath = join(workDir, `${hostId}-${randomBytes(8).toString("hex")}.part`);
  if (await exists(partPath)) throw new Error(`refusing to reuse ${partPath}`);
  const archivePath = join(workDir, `${hostId}.archive`);
  if (await exists(archivePath)) throw new Error(`archive already exists (EEXIST): ${archivePath}`);

  let buffer;
  try {
    const result = await run(curlArgv({ artifact, partPath }), { timeoutMs: DOWNLOAD_TIMEOUT_MS, env: {} });
    if (result.status !== 0) throw new Error(`download failed for ${hostId} (status ${result.status ?? result.signal}): ${String(result.stderr).slice(0, 512)}`);
    buffer = await readFile(partPath);
    if (artifact.size !== null && buffer.length !== artifact.size) throw new Error(`size mismatch for ${hostId}: expected ${artifact.size}, got ${buffer.length}`);
    if (buffer.length > artifact.cap) throw new Error(`size ${buffer.length} exceeds the ${artifact.cap}-byte cap for ${hostId}`);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const sha512Integrity = `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
    const actual = artifact.digest.algorithm === "sha256" ? sha256 : sha512Integrity;
    if (actual !== artifact.digest.value) throw new Error(`digest mismatch for ${hostId}: expected ${artifact.digest.value}, got ${actual}`);
    // Only now, after the digest matched, is the archive listed and validated.
    const entries = listTarGz(buffer, { maxTarBytes: tarCapFor(artifact.limits) });
    const validation = validateEntries(entries, { limits: artifact.limits, members: artifact.members });
    if (!validation.ok) throw new Error(`archive rejected for ${hostId}:\n- ${validation.problems.join("\n- ")}`);
    await extractMember({ kind: "tgz", buffer, entries, name: artifact.executableMember, dest, limits: artifact.limits });
    const executable = await readFile(dest);
    await rename(partPath, archivePath);
    return {
      hostId,
      url: artifact.url,
      archive: { path: archivePath, size: buffer.length, sha256, sha512Integrity },
      member: artifact.executableMember,
      executable: { path: dest, sha256: createHash("sha256").update(executable).digest("hex"), size: executable.length },
    };
  } catch (error) {
    await rm(partPath, { force: true });
    throw error;
  }
}
