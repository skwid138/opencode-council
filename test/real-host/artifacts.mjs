// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/artifacts.mjs
// Local modifications (see test/PROVENANCE.md): removed the normalizer host MATRIX export (council's separate real-host plan defines its own host matrix); everything else unchanged.
// Artifact manifest, archive inspection, staged-file identity, and the runtime
// write tripwire. Nothing here downloads anything: URLs are recorded for the
// separately approved Gate 2 acquisition step only.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

function hashFile(path, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest(encoding)));
  });
}

export const sha256File = (path) => hashFile(path, "sha256", "hex");
export const sriSha512File = async (path) => `sha512-${await hashFile(path, "sha512", "base64")}`;

// ---- tar.gz ----
function cstr(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(buffer, start, length, label) {
  if (buffer[start] & 0x80) throw new Error(`unsupported base-256 ${label} in tar header`);
  const text = cstr(buffer, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error(`invalid octal ${label} in tar header: ${text}`);
  return text === "" ? 0 : Number.parseInt(text, 8);
}

const TAR_TYPES = { "0": "file", "": "file", "5": "directory", "2": "symlink", "1": "hardlink" };

const LIMIT_KEYS = ["maxEntries", "maxExpandedBytes", "maxFileBytes"];
const isPositiveSafeInteger = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Strict schema: exactly maxEntries, maxExpandedBytes, maxFileBytes, each a finite positive safe integer. */
export function limitsProblems(limits) {
  if (!isRecord(limits)) return ["limits must be an object"];
  const problems = [];
  for (const key of LIMIT_KEYS) if (!isPositiveSafeInteger(limits[key])) problems.push(`limits.${key} must be a finite positive safe integer`);
  for (const key of Object.keys(limits)) if (!LIMIT_KEYS.includes(key)) problems.push(`unknown limits key ${key}`);
  return problems;
}

/** Strict schema: { required: non-empty string[], allowed: string[] } with required ⊆ allowed. */
export function membersProblems(members) {
  if (!isRecord(members)) return ["members must be an object"];
  const problems = [];
  const strings = (list) => Array.isArray(list) && list.every((item) => typeof item === "string" && item !== "");
  if (!strings(members.required) || members.required.length === 0) problems.push("members.required must be a non-empty string array");
  if (!strings(members.allowed)) problems.push("members.allowed must be a string array");
  for (const key of Object.keys(members)) if (key !== "required" && key !== "allowed") problems.push(`unknown members key ${key}`);
  if (strings(members.required) && strings(members.allowed)) {
    for (const name of members.required) if (!members.allowed.includes(name)) problems.push(`required member ${name} is not in members.allowed`);
  }
  return problems;
}

/** Upper bound on raw tar bytes for validated limits: data plus at most one header and one padding block per entry, plus the end blocks. */
export function tarCapFor(limits) {
  return limits.maxExpandedBytes + 1024 * (limits.maxEntries + 2);
}

function boundedGunzip(gzipped, maxTarBytes) {
  if (!isPositiveSafeInteger(maxTarBytes)) throw new Error("listTarGz requires a positive maxTarBytes cap");
  try {
    return gunzipSync(gzipped, { maxOutputLength: maxTarBytes });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) throw new Error(`decompressed tar exceeds the ${maxTarBytes}-byte cap`);
    throw error;
  }
}

/** Lists entries of a gzipped tar, decompressing at most `maxTarBytes`. Unknown type flags are reported, not interpreted. */
export function listTarGz(gzipped, { maxTarBytes } = {}) {
  const tar = boundedGunzip(gzipped, maxTarBytes);
  const entries = [];
  let position = 0;
  while (position + 512 <= tar.length) {
    const header = tar.subarray(position, position + 512);
    if (header.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== octal(header, 148, 8, "checksum")) throw new Error(`tar header checksum mismatch at offset ${position}`);
    const name = cstr(header, 0, 100);
    const prefix = cstr(header, 257, 6) === "ustar" ? cstr(header, 345, 155) : "";
    const flag = String.fromCharCode(header[156]).replace("\0", "");
    const size = octal(header, 124, 12, "size");
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      type: TAR_TYPES[flag] ?? `unsupported:${flag}`,
      size,
      linkname: cstr(header, 157, 100),
      mode: octal(header, 100, 8, "mode"),
      dataOffset: position + 512,
    });
    position += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// ---- zip ----
/** Lists zip entries from the central directory. zip64 and encrypted entries are rejected. */
export function listZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip end of central directory not found");
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are unsupported");
  const entries = [];
  let position = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(position) !== 0x02014b50) throw new Error(`bad zip central directory signature at ${position}`);
    const madeBy = buffer.readUInt16LE(position + 4);
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const external = buffer.readUInt32LE(position + 38);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString("utf8");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error(`zip64 entry is unsupported: ${name}`);
    const fileType = (external >>> 16) & 0o170000;
    let type;
    if (flags & 1) type = "unsupported:encrypted";
    else if (madeBy >> 8 === 3 && fileType !== 0) {
      type = fileType === 0o120000 ? "symlink" : fileType === 0o040000 ? "directory" : fileType === 0o100000 ? "file" : `unsupported:mode-${fileType.toString(8)}`;
    } else type = name.endsWith("/") ? "directory" : "file";
    entries.push({ name, type, size, compressedSize, method, localOffset, linkname: "" });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---- validation ----
/** Actual-listing numeric caps (entry count, per-file size, summed size); independent of any member list. */
export function numericCapProblems(entries, limits) {
  const problems = [];
  let total = 0;
  for (const entry of entries) {
    total += entry.size;
    if (entry.type === "file" && entry.size > limits.maxFileBytes) problems.push(`entry exceeds maxFileBytes: ${entry.name} (${entry.size})`);
  }
  if (entries.length > limits.maxEntries) problems.push(`too many entries: ${entries.length} > ${limits.maxEntries}`);
  if (total > limits.maxExpandedBytes) problems.push(`expanded size ${total} exceeds ${limits.maxExpandedBytes}`);
  return problems;
}

export function validateEntries(entries, { limits, members }) {
  if (!limits) return { ok: false, problems: ["archive limits unresolved: recipe inspection gate (do not invent)", ...(members ? [] : ["archive members unresolved: recipe inspection gate (do not invent)"])] };
  if (!members) return { ok: false, problems: ["archive members unresolved: recipe inspection gate (do not invent)"] };
  const schema = [...limitsProblems(limits), ...membersProblems(members)];
  if (schema.length > 0) return { ok: false, problems: schema };
  const problems = [];
  const seen = new Set();
  for (const entry of entries) {
    const name = entry.name;
    const key = name.replace(/\/+$/, "");
    if (!name || name.includes("\0") || name.includes("\\")) problems.push(`invalid entry name: ${JSON.stringify(name)}`);
    else if (isAbsolute(name)) problems.push(`absolute entry path: ${name}`);
    else if (key.split("/").includes("..")) problems.push(`entry escapes the target: ${name}`);
    if (seen.has(key)) problems.push(`duplicate entry: ${name}`);
    seen.add(key);
    if (entry.type === "symlink" || entry.type === "hardlink") problems.push(`link entry rejected: ${name} -> ${entry.linkname}`);
    else if (entry.type !== "file" && entry.type !== "directory") problems.push(`unsupported entry ${entry.type}: ${name}`);
    if (!members.allowed.includes(name)) problems.push(`entry not in allowed member list: ${name}`);
  }
  problems.push(...numericCapProblems(entries, limits));
  for (const required of members.required) {
    if (!entries.some((entry) => entry.name === required && entry.type === "file")) problems.push(`missing required member: ${required}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Reads one regular-file member into memory, bounded by the validated limits and the declared size. */
function readMember({ kind, buffer, entries, name, limits }) {
  const schema = limitsProblems(limits);
  if (schema.length > 0) throw new Error(`invalid limits: ${schema.join("; ")}`);
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`member not found: ${name}`);
  if (entry.type !== "file") throw new Error(`member is not a regular file: ${name}`);
  if (entry.size > limits.maxFileBytes) throw new Error(`member ${name} exceeds maxFileBytes`);
  let data;
  if (kind === "tgz") {
    data = boundedGunzip(buffer, tarCapFor(limits)).subarray(entry.dataOffset, entry.dataOffset + entry.size);
  } else if (kind === "zip") {
    if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error(`bad zip local header for ${name}`);
    const start = entry.localOffset + 30 + buffer.readUInt16LE(entry.localOffset + 26) + buffer.readUInt16LE(entry.localOffset + 28);
    const body = buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) data = body;
    else if (entry.method === 8) {
      try {
        // Inflate is capped at the declared size; real data larger than declared aborts here.
        data = inflateRawSync(body, { maxOutputLength: Math.max(1, entry.size) });
      } catch (error) {
        if (error?.code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) throw new Error(`member ${name} inflates beyond and so exceeds its declared size ${entry.size}`);
        throw error;
      }
    } else throw new Error(`unsupported zip compression method ${entry.method} for ${name}`);
  } else throw new Error(`unknown archive kind: ${kind}`);
  if (data.length !== entry.size) throw new Error(`size mismatch reading ${name}: ${data.length} != ${entry.size} (exceeds its declared size or truncated)`);
  return data;
}

/** sha256 of one member, computed in memory under the same bounds as extraction. */
export function memberDigest(options) {
  return createHash("sha256").update(readMember(options)).digest("hex");
}

/** Writes one regular-file member to `dest` (never overwrites), mode 0755. */
export async function extractMember({ kind, buffer, entries, name, dest, limits }) {
  const data = readMember({ kind, buffer, entries, name, limits });
  await writeFile(dest, data, { flag: "wx", mode: 0o700 });
  await chmod(dest, 0o755);
  return { dest, size: data.length };
}

/** Verifies a staged file by content hash; never by version alone. */
export async function verifyStagedFile({ path, sha256, root }) {
  if (!sha256) throw new Error(`no recorded hash for ${path}`);
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`staged artifact is a symlink: ${path}`);
  if (!info.isFile()) throw new Error(`staged artifact is not a regular file: ${path}`);
  const real = await realpath(path);
  const realRoot = await realpath(root);
  const rel = relative(realRoot, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`staged artifact is outside the staging root: ${path}`);
  const actual = await sha256File(real);
  if (actual !== sha256) throw new Error(`hash mismatch for ${path}: expected ${sha256}, got ${actual}`);
  return { path: real, sha256: actual, size: info.size };
}

// ---- tripwire ----
/** Map of relative path -> { type, digest } for every entry under `root`. */
export async function inventoryTree(root) {
  const result = new Map();
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      const rel = relative(root, full);
      if (item.isSymbolicLink()) result.set(rel, { type: "symlink", digest: await readlink(full) });
      else if (item.isDirectory()) {
        result.set(rel, { type: "directory", digest: "" });
        await walk(full);
      } else if (item.isFile()) result.set(rel, { type: "file", digest: createHash("sha256").update(await readFile(full)).digest("hex") });
      else result.set(rel, { type: "other", digest: "" });
    }
  }
  await walk(root);
  return result;
}

export function diffInventory(before, after, { allowedWritePrefixes }) {
  const allowed = (path) => allowedWritePrefixes.some((prefix) => path.startsWith(prefix) || `${path}/` === prefix);
  const changes = [];
  for (const [path, entry] of after) {
    const old = before.get(path);
    if (!old) changes.push(["added", path]);
    else if (old.type !== entry.type || old.digest !== entry.digest) changes.push(["changed", path]);
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push(["removed", path]);
  return {
    changes: changes.map(([kind, path]) => `${kind} ${path}`),
    forbidden: changes.filter(([, path]) => !allowed(path)).map(([kind, path]) => `${kind} ${path}`),
  };
}
