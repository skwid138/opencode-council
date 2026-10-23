// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/artifacts.test.ts
// Local modifications: the "version matrix" suite is replaced by a check that the
//   normalizer host MATRIX is not carried (see test/PROVENANCE.md).
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  diffInventory,
  limitsProblems,
  memberDigest,
  tarCapFor,
  membersProblems,
  extractMember,
  inventoryTree,
  listTarGz,
  listZip,
  sha256File,
  sriSha512File,
  validateEntries,
  verifyStagedFile,
} from "./artifacts.mjs";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-art-")));
  created.push(dir);
  return dir;
}

// ---- in-memory archive builders (test fixtures only) ----
function tarHeader(name: string, { size = 0, type = "0", linkname = "", mode = 0o644, prefix = "" } = {}): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}
type TarItem = { name: string; data?: string; type?: string; linkname?: string; mode?: number; prefix?: string };
function tgz(items: TarItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    const data = Buffer.from(item.data ?? "");
    parts.push(tarHeader(item.name, { size: data.length, type: item.type ?? "0", linkname: item.linkname, mode: item.mode, prefix: item.prefix }));
    if (data.length > 0) parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

type ZipItem = { name: string; data?: string; mode?: number; deflate?: boolean; zip64?: boolean };
function zip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const raw = Buffer.from(item.data ?? "");
    const body = item.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(item.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(item.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(item.deflate ? 8 : 0, 10);
    central.writeUInt32LE(item.zip64 ? 0xffffffff : body.length, 20);
    central.writeUInt32LE(item.zip64 ? 0xffffffff : raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const LIMITS = { maxEntries: 10, maxExpandedBytes: 1000, maxFileBytes: 500 };

describe("host matrix ownership", () => {
  it("does not carry the normalizer's host matrix (council's real-host plan defines its own)", async () => {
    expect("MATRIX" in (await import("./artifacts.mjs"))).toBe(false);
  });
});

describe("archive entry validation", () => {
  const ok = { name: "package/bin/opencode", type: "file", size: 10 };

  it("fails closed when limits or members are unresolved", () => {
    expect(validateEntries([ok], { limits: null, members: { required: ["package/bin/opencode"], allowed: ["package/bin/opencode"] } }).problems.join()).toMatch(/limits unresolved/);
    expect(validateEntries([ok], { limits: LIMITS, members: null }).problems.join()).toMatch(/members unresolved/);
  });

  it("accepts a clean listing that contains every required member", () => {
    expect(validateEntries([{ name: "package/", type: "directory", size: 0 }, ok], { limits: LIMITS, members: { required: [ok.name], allowed: ["package/", ok.name] } })).toEqual({
      ok: true,
      problems: [],
    });
  });

  it.each([
    ["absolute path", { name: "/etc/passwd", type: "file", size: 1 }],
    ["parent escape", { name: "package/../../x", type: "file", size: 1 }],
    ["symlink", { name: "package/link", type: "symlink", size: 0, linkname: "/etc" }],
    ["hardlink", { name: "package/hard", type: "hardlink", size: 0, linkname: "package/bin/opencode" }],
    ["unsupported entry", { name: "package/pax", type: "unsupported:x", size: 0 }],
    ["oversized file", { name: "package/big", type: "file", size: 501 }],
  ])("rejects %s", (_label, entry) => {
    const result = validateEntries([ok, entry], { limits: LIMITS, members: { required: [ok.name], allowed: [ok.name, entry.name] } });
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("rejects duplicates, too many entries, excess expanded size, and a missing required member", () => {
    const names = [ok.name, "other", "a", "b", "c", ...Array.from({ length: 11 }, (_, i) => `package/f${i}`)];
    const opts = { limits: LIMITS, members: { required: [ok.name], allowed: names } };
    expect(validateEntries([ok, ok], opts).problems.join()).toMatch(/duplicate/);
    expect(validateEntries(Array.from({ length: 11 }, (_, i) => ({ name: `package/f${i}`, type: "file", size: 1 })).concat(ok), opts).problems.join()).toMatch(
      /entries/,
    );
    expect(validateEntries([ok, { name: "a", type: "file", size: 400 }, { name: "b", type: "file", size: 400 }, { name: "c", type: "file", size: 400 }], opts).problems.join()).toMatch(
      /expanded/,
    );
    expect(validateEntries([{ name: "other", type: "file", size: 1 }], opts).problems.join()).toMatch(/missing required member/);
  });
});

describe("strict limit and member schemas", () => {
  it.each([
    ["an empty object", {}],
    ["a missing key", { maxEntries: 1, maxExpandedBytes: 1 }],
    ["an unknown key", { ...LIMITS, maxDepth: 3 }],
    ["NaN", { ...LIMITS, maxEntries: Number.NaN }],
    ["a negative value", { ...LIMITS, maxFileBytes: -1 }],
    ["zero", { ...LIMITS, maxExpandedBytes: 0 }],
    ["Infinity", { ...LIMITS, maxExpandedBytes: Number.POSITIVE_INFINITY }],
    ["a fraction", { ...LIMITS, maxEntries: 1.5 }],
    ["a string", { ...LIMITS, maxEntries: "10" }],
    ["null", null],
  ])("rejects limits with %s", (_label, limits) => {
    expect(limitsProblems(limits).length).toBeGreaterThan(0);
    expect(validateEntries([{ name: "a", type: "file", size: 1 }], { limits, members: { required: ["a"], allowed: ["a"] } }).ok).toBe(false);
  });

  it.each([
    ["an empty object", {}],
    ["an empty required list", { required: [], allowed: [] }],
    ["a non-string member", { required: [1], allowed: [1] }],
    ["a required member missing from allowed", { required: ["a"], allowed: ["b"] }],
    ["an unknown key", { required: ["a"], allowed: ["a"], optional: [] }],
    ["a missing allowed list", { required: ["a"] }],
  ])("rejects members with %s", (_label, members) => {
    expect(membersProblems(members).length).toBeGreaterThan(0);
  });

  it("derives the documented raw tar cap for the proposed future V2 caps (16 / 201326592 / 201326592)", () => {
    const future = { maxEntries: 16, maxFileBytes: 201326592, maxExpandedBytes: 201326592 };
    expect(limitsProblems(future)).toEqual([]);
    expect(tarCapFor(future)).toBe(201345024);
  });

  it("accepts finite positive safe-integer limits and a consistent member list", () => {
    expect(limitsProblems(LIMITS)).toEqual([]);
    expect(membersProblems({ required: ["a"], allowed: ["a", "dir/"] })).toEqual([]);
  });
});

describe("bounded decompression", () => {
  it("refuses a tar.gz whose actual expansion exceeds the cap, without buffering it", () => {
    const bomb = gzipSync(Buffer.alloc(2_000_000));
    expect(() => listTarGz(bomb, { maxTarBytes: 100_000 })).toThrow(/exceeds the 100000-byte cap/);
    expect(() => listTarGz(tgz([{ name: "a", data: "x" }]))).toThrow(/maxTarBytes/);
  });

  it("refuses a zip member whose real expansion exceeds its declared size, before writing anything", async () => {
    const dir = await scratch();
    const real = Buffer.alloc(50_000, 120);
    const body = deflateRawSync(real);
    const honest = zip([{ name: "opencode", data: "x" }]);
    // Build a zip whose central and local headers understate the size as 3 bytes.
    const lying = zip([{ name: "opencode", data: "abc", deflate: true }]);
    const patched = Buffer.concat([lying.subarray(0, 30 + 8), body, lying.subarray(30 + 8 + deflateRawSync(Buffer.from("abc")).length)]);
    patched.writeUInt32LE(body.length, 18);
    const cdStart = 30 + 8 + body.length;
    patched.writeUInt32LE(body.length, cdStart + 20);
    patched.writeUInt32LE(cdStart, patched.length - 22 + 16);
    const entries = listZip(patched);
    expect(entries[0]).toMatchObject({ name: "opencode", size: 3 });
    const dest = join(dir, "opencode");
    await expect(extractMember({ kind: "zip", buffer: patched, entries, name: "opencode", dest, limits: LIMITS })).rejects.toThrow(/exceeds its declared size/);
    expect(existsSync(dest)).toBe(false);
    expect(listZip(honest)).toHaveLength(1);
  });

  it("refuses to extract with unvalidated limits", async () => {
    const dir = await scratch();
    const buffer = zip([{ name: "opencode", data: "BINARY" }]);
    await expect(extractMember({ kind: "zip", buffer, entries: listZip(buffer), name: "opencode", dest: join(dir, "x"), limits: {} })).rejects.toThrow(/limits/);
    expect(existsSync(join(dir, "x"))).toBe(false);
  });

  it("computes a member digest in memory under the same bounds", () => {
    const buffer = zip([{ name: "opencode", data: "BINARY", deflate: true }]);
    expect(memberDigest({ kind: "zip", buffer, entries: listZip(buffer), name: "opencode", limits: LIMITS })).toBe(createHash("sha256").update("BINARY").digest("hex"));
  });
});

describe("archive listing", () => {
  it("lists tar.gz entries, including ustar prefixes, links, and unsupported types", () => {
    const buffer = tgz([
      { name: "package/", type: "5" },
      { name: "opencode", prefix: "package/bin", data: "BIN", mode: 0o755 },
      { name: "package/link", type: "2", linkname: "/etc/passwd" },
      { name: "PaxHeader", type: "x" },
    ]);
    expect(listTarGz(buffer, { maxTarBytes: 100_000 }).map(({ name, type, size, linkname }: Record<string, unknown>) => ({ name, type, size, linkname }))).toEqual([
      { name: "package/", type: "directory", size: 0, linkname: "" },
      { name: "package/bin/opencode", type: "file", size: 3, linkname: "" },
      { name: "package/link", type: "symlink", size: 0, linkname: "/etc/passwd" },
      { name: "PaxHeader", type: "unsupported:x", size: 0, linkname: "" },
    ]);
  });

  it("lists zip entries from the central directory and detects symlinks and zip64", () => {
    const buffer = zip([
      { name: "opencode", data: "BINARY", mode: 0o100755, deflate: true },
      { name: "dir/", mode: 0o040755 },
      { name: "evil", data: "/etc", mode: 0o120777 },
    ]);
    expect(listZip(buffer).map(({ name, type, size }: Record<string, unknown>) => ({ name, type, size }))).toEqual([
      { name: "opencode", type: "file", size: 6 },
      { name: "dir/", type: "directory", size: 0 },
      { name: "evil", type: "symlink", size: 4 },
    ]);
    expect(() => listZip(zip([{ name: "big", data: "x", zip64: true }]))).toThrow(/zip64/);
  });
});

describe("member extraction", () => {
  it("writes exactly one validated regular member with an executable mode and never overwrites", async () => {
    const dir = await scratch();
    const buffer = zip([{ name: "opencode", data: "BINARY", mode: 0o100755, deflate: true }]);
    const entries = listZip(buffer);
    const dest = join(dir, "opencode");

    await extractMember({ kind: "zip", buffer, entries, name: "opencode", dest, limits: LIMITS });

    expect(await readFile(dest, "utf8")).toBe("BINARY");
    expect((await stat(dest)).mode & 0o777).toBe(0o755);
    await expect(extractMember({ kind: "zip", buffer, entries, name: "opencode", dest, limits: LIMITS })).rejects.toThrow(/EEXIST/);
  });

  it("extracts a tar.gz member and refuses non-file members", async () => {
    const dir = await scratch();
    const buffer = tgz([{ name: "package/bin/opencode", data: "TARBIN" }, { name: "package/link", type: "2", linkname: "x" }]);
    const entries = listTarGz(buffer, { maxTarBytes: 100_000 });
    await extractMember({ kind: "tgz", buffer, entries, name: "package/bin/opencode", dest: join(dir, "a"), limits: LIMITS });
    expect(await readFile(join(dir, "a"), "utf8")).toBe("TARBIN");
    await expect(extractMember({ kind: "tgz", buffer, entries, name: "package/link", dest: join(dir, "b"), limits: LIMITS })).rejects.toThrow(/not a regular file/);
  });
});

describe("staged artifact identity", () => {
  it("verifies by content hash inside the staging root and rejects symlinks, outsiders, and mismatches", async () => {
    const root = await scratch();
    const outside = await scratch();
    const file = join(root, "opencode");
    await writeFile(file, "artifact");
    await chmod(file, 0o755);
    const sha256 = createHash("sha256").update("artifact").digest("hex");

    await expect(sha256File(file)).resolves.toBe(sha256);
    await expect(verifyStagedFile({ path: file, sha256, root })).resolves.toMatchObject({ sha256, size: 8 });
    await expect(verifyStagedFile({ path: file, sha256: "0".repeat(64), root })).rejects.toThrow(/hash mismatch/);
    await symlink(file, join(root, "link"));
    await expect(verifyStagedFile({ path: join(root, "link"), sha256, root })).rejects.toThrow(/symlink/);
    await writeFile(join(outside, "x"), "artifact");
    await expect(verifyStagedFile({ path: join(outside, "x"), sha256, root })).rejects.toThrow(/outside/);
    await expect(verifyStagedFile({ path: file, sha256: null, root })).rejects.toThrow(/no recorded hash/);
  });

  it("computes npm-style sha512 integrity", async () => {
    const root = await scratch();
    await writeFile(join(root, "t.tgz"), "tarball");
    expect(await sriSha512File(join(root, "t.tgz"))).toBe(`sha512-${createHash("sha512").update("tarball").digest("base64")}`);
  });
});

describe("runtime write tripwire", () => {
  it("reports dependency growth outside the allowed runtime write prefixes", async () => {
    const root = await scratch();
    await mkdir(join(root, "cache", "packages", "spec", "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "cache", "packages", "spec", "node_modules", "pkg", "index.js"), "x");
    const before = await inventoryTree(root);

    await mkdir(join(root, "cache", "packages", "spec", "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(root, "cache", "packages", "spec", "node_modules", "left-pad", "index.js"), "y");
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(join(root, "logs", "host.log"), "log");
    await writeFile(join(root, "cache", "packages", "spec", "node_modules", "pkg", "index.js"), "changed");
    const after = await inventoryTree(root);

    const diff = diffInventory(before, after, { allowedWritePrefixes: ["logs/"] });
    expect(diff.forbidden.sort()).toEqual(
      [
        "added cache/packages/spec/node_modules/left-pad",
        "added cache/packages/spec/node_modules/left-pad/index.js",
        "changed cache/packages/spec/node_modules/pkg/index.js",
      ].sort(),
    );
  });
});
