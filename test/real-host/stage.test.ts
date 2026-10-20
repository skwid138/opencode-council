// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/stage.test.ts
// Local modifications (see test/PROVENANCE.md): none.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = join(repoRoot, "test", "real-host", "stage.mjs");
const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

function zipWith(name: string, text: string): Buffer {
  const raw = Buffer.from(text);
  const body = deflateRawSync(raw);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(30 + n.length + body.length, 16);
  return Buffer.concat([local, n, body, central, n, end]);
}

function tgzOf(files: Array<[string, number]>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, size] of files) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write("0000644\0", 100);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, Buffer.alloc(size, 120), Buffer.alloc((512 - (size % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8", timeout: 15_000 });
}

describe("Gate 2 staging helper (local files only; no network)", () => {
  it("inspects a local archive: prints hash, size, and every entry without writing anything", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-stage-")));
    created.push(dir);
    const bytes = zipWith("opencode", "BIN");
    await writeFile(join(dir, "a.zip"), bytes);

    const result = run(["inspect", "--kind", "zip", "--archive", join(dir, "a.zip"), "--limits", JSON.stringify({ maxEntries: 1, maxExpandedBytes: 3, maxFileBytes: 3 })]);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), entries: [{ name: "opencode", type: "file", size: 3 }] });
    expect(report.sha512Integrity).toMatch(/^sha512-/);
    expect(await readdir(dir)).toEqual(["a.zip"]);
  });

  it("refuses to extract while members and limits are unresolved, and extracts one validated member when they are given", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-stage-")));
    created.push(dir);
    await writeFile(join(dir, "a.zip"), zipWith("opencode", "BIN"));
    const dest = join(dir, "staged-opencode");

    const closed = run(["extract", "--kind", "zip", "--archive", join(dir, "a.zip"), "--member", "opencode", "--dest", dest]);
    expect(closed.status).toBe(2);
    expect(closed.stderr).toMatch(/requires reviewed --limits/);
    expect(await readdir(dir)).toEqual(["a.zip"]);

    const limits = JSON.stringify({ maxEntries: 1, maxExpandedBytes: 10, maxFileBytes: 10 });
    const members = JSON.stringify({ required: ["opencode"], allowed: ["opencode"] });
    const badLimits = run(["extract", "--kind", "zip", "--archive", join(dir, "a.zip"), "--member", "opencode", "--dest", dest, "--limits", "{}", "--members", members]);
    expect(badLimits.status).toBe(2);
    expect(badLimits.stderr).toMatch(/maxEntries/);
    const open = run(["extract", "--kind", "zip", "--archive", join(dir, "a.zip"), "--member", "opencode", "--dest", dest, "--limits", limits, "--members", members]);
    expect(open.status).toBe(0);
    const zipBytes = zipWith("opencode", "BIN");
    expect(JSON.parse(open.stdout)).toEqual({
      dest,
      sha256: createHash("sha256").update("BIN").digest("hex"),
      provenance: {
        archive: { sha256: createHash("sha256").update(zipBytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(zipBytes).digest("base64")}` },
        member: "opencode",
        memberSha256: createHash("sha256").update("BIN").digest("hex"),
      },
    });
  });

  it("refuses to inspect a tgz without reviewed limits, because listing decompresses", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-stage-")));
    created.push(dir);
    await writeFile(join(dir, "a.tgz"), gzipSync(Buffer.alloc(1024)));
    const result = run(["inspect", "--kind", "tgz", "--archive", join(dir, "a.tgz")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/requires reviewed --limits/);
  });

  it("refuses to inspect any archive kind without reviewed limits", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-stage-")));
    created.push(dir);
    await writeFile(join(dir, "a.zip"), zipWith("opencode", "BIN"));
    const result = run(["inspect", "--kind", "zip", "--archive", join(dir, "a.zip")]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/requires reviewed --limits/);
  });

  describe("numeric caps on the actual listing, enforced before any success output (members deferred)", () => {
    const limits = { maxEntries: 3, maxFileBytes: 100, maxExpandedBytes: 150 };
    async function inspectTgz(files: Array<[string, number]>) {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-stage-")));
      created.push(dir);
      await writeFile(join(dir, "a.tgz"), tgzOf(files));
      return run(["inspect", "--kind", "tgz", "--archive", join(dir, "a.tgz"), "--limits", JSON.stringify(limits)]);
    }

    it("accepts a listing within every cap (valid control, no member list needed)", async () => {
      const result = await inspectTgz([["package/a", 100], ["package/b", 50], ["package/c", 0]]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).entries).toHaveLength(3);
    });

    it.each([
      ["too many entries", [["a", 1], ["b", 1], ["c", 1], ["d", 1]] as Array<[string, number]>, /too many entries: 4 > 3/],
      ["an individual file over maxFileBytes", [["a", 101]] as Array<[string, number]>, /exceeds maxFileBytes: a \(101\)/],
      ["a total over maxExpandedBytes", [["a", 100], ["b", 51]] as Array<[string, number]>, /expanded size 151 exceeds 150/],
    ])("refuses %s with no success output", async (_label, files, message) => {
      const result = await inspectTgz(files);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(message);
    });

    it("applies the same caps to a zip listing", async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-stage-")));
      created.push(dir);
      await writeFile(join(dir, "a.zip"), zipWith("opencode", "TOO-LONG"));
      const result = run(["inspect", "--kind", "zip", "--archive", join(dir, "a.zip"), "--limits", JSON.stringify({ maxEntries: 1, maxFileBytes: 3, maxExpandedBytes: 3 })]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/exceeds maxFileBytes: opencode \(8\)/);
    });
  });

  it("refuses an archive whose bytes differ from an expected hash", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-stage-")));
    created.push(dir);
    await writeFile(join(dir, "a.zip"), zipWith("opencode", "BIN"));
    const result = run(["inspect", "--kind", "zip", "--archive", join(dir, "a.zip"), "--expect-sha256", "0".repeat(64), "--limits", JSON.stringify({ maxEntries: 1, maxExpandedBytes: 3, maxFileBytes: 3 })]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/hash mismatch/);
  });
});
