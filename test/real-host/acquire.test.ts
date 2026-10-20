import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireHost, ARTIFACTS, curlArgv } from "./acquire.mjs";
import { tgz } from "./tar-fixture";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-acq-")));
  created.push(dir);
  return dir;
}

const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const sri = (buffer: Buffer) => `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
const EXE = Buffer.from("#!/bin/sh\necho opencode\n");

/** A fake `run` that "downloads" by writing `bytes` to the curl --output path. Records argv. */
function fakeCurl(bytes: Buffer | null, { status = 0 } = {}) {
  const calls: string[][] = [];
  const run = async (argv: string[], options: { timeoutMs: number; env: Record<string, string> }) => {
    calls.push(argv);
    expect(options).toEqual({ timeoutMs: 300_000, env: {} });
    if (bytes) await writeFile(argv[argv.indexOf("--output") + 1], bytes);
    return { status, signal: null, stdout: "", stderr: status === 0 ? "" : "curl: (22) 404" };
  };
  return { run, calls };
}

function v1Artifact(archive: Buffer) {
  return { ...ARTIFACTS["v1-1.19.3"], size: archive.length, digest: { algorithm: "sha256", value: sha256(archive) } };
}
function v2Artifact(archive: Buffer) {
  return { ...ARTIFACTS["v2-2.0.32"], digest: { algorithm: "sha512", value: sri(archive) } };
}

describe("pinned acquisition table", () => {
  it("pins the four approved artifacts, digests, caps, limits, and member allowlists", () => {
    expect(ARTIFACTS["v1-1.18.29"]).toMatchObject({
      url: "https://github.com/anomalyco/opencode/releases/download/v1.18.29/opencode-linux-arm64.tar.gz",
      size: 60_343_887,
      cap: 60_343_887,
      digest: { algorithm: "sha256", value: "70baf769395ca4e7a68924026530c390eace194f3b7e4919d4efcb2aa2eed3c0" },
      members: { required: ["opencode"], allowed: ["opencode"] },
      executableMember: "opencode",
      limits: { maxEntries: 16, maxExpandedBytes: 268_435_456, maxFileBytes: 268_435_456 },
    });
    expect(ARTIFACTS["v1-1.19.3"]).toMatchObject({ size: 60_519_745, digest: { value: "7900818a6a98881edbbadab4b7525940eff3b9750040c200481f9f56cacee405" } });
    expect(ARTIFACTS["v2-2.0.32"]).toMatchObject({
      url: "https://registry.npmjs.org/@opencode/cli-linux-arm64/-/cli-linux-arm64-2.0.32.tgz",
      size: null,
      cap: 134_217_728,
      digest: { algorithm: "sha512", value: "sha512-YR5O03irvmot/G0f8W49ehvhn5uqCFN3vf9JTsChvf47W6ldjKCNvsaCSXS2SP26dPOUMQBn7WqbKnyHzrNR5w==" },
      members: { required: ["package/bin/opencode"], allowed: ["package/bin/opencode", "package/package.json"] },
      executableMember: "package/bin/opencode",
      limits: { maxEntries: 64, maxExpandedBytes: 314_572_800, maxFileBytes: 314_572_800 },
    });
    expect(ARTIFACTS["v2-2.0.28"].digest.value).toBe("sha512-BOjXZMtvYiQ9xowfHXJseARn7wHN8RTvRvYvMMIsjIOEJOYtv4aPvB4l0BmmnhUEhZQgrprPFamkUDy0lDiYiw==");
  });

  it("builds the exact single-attempt curl argv under env -i", () => {
    expect(curlArgv({ artifact: ARTIFACTS["v1-1.18.29"], partPath: "/tmp/s/a.part" })).toEqual([
      "/usr/bin/env", "-i", "/usr/bin/curl", "-q",
      "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "5",
      "--connect-timeout", "20", "--max-time", "300", "--max-filesize", "60343887",
      "--fail", "--location", "--silent", "--show-error", "--output", "/tmp/s/a.part",
      "https://github.com/anomalyco/opencode/releases/download/v1.18.29/opencode-linux-arm64.tar.gz",
    ]);
    expect(curlArgv({ artifact: ARTIFACTS["v2-2.0.28"], partPath: "/tmp/s/b.part" })).toContain("134217728");
  });
});

describe("acquireHost (injected runner; never downloads)", () => {
  it("downloads once, verifies the digest before listing, extracts only the allowlisted executable, and links provenance", async () => {
    const work = await scratch();
    const staging = await scratch();
    const archive = tgz([{ name: "opencode", data: EXE, mode: 0o755 }]);
    const { run, calls } = fakeCurl(archive);
    const receipt = await acquireHost({ hostId: "v1-1.19.3", artifact: v1Artifact(archive), workDir: work, stagingDir: staging, run });

    expect(calls).toHaveLength(1);
    expect(receipt).toMatchObject({
      hostId: "v1-1.19.3",
      archive: { size: archive.length, sha256: sha256(archive), sha512Integrity: sri(archive) },
      member: "opencode",
      executable: { path: join(staging, "opencode-1.19.3"), sha256: sha256(EXE), size: EXE.length },
    });
    expect(await readFile(join(staging, "opencode-1.19.3"))).toEqual(EXE);
    expect((await stat(join(staging, "opencode-1.19.3"))).mode & 0o777).toBe(0o755);
    expect((await readdir(work)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("extracts package/bin/opencode from a V2 npm tarball and ignores package.json", async () => {
    const archive = tgz([{ name: "package/package.json", data: "{}" }, { name: "package/bin/opencode", data: EXE, mode: 0o755 }]);
    const staging = await scratch();
    const receipt = await acquireHost({ hostId: "v2-2.0.32", artifact: v2Artifact(archive), workDir: await scratch(), stagingDir: staging, run: fakeCurl(archive).run });
    expect(receipt.member).toBe("package/bin/opencode");
    expect(await readdir(staging)).toEqual(["opencode-2.0.32"]);
  });

  it("refuses a digest mismatch before listing and removes the partial file", async () => {
    const work = await scratch();
    const staging = await scratch();
    const archive = tgz([{ name: "opencode", data: EXE }]);
    const artifact = { ...v1Artifact(archive), digest: { algorithm: "sha256", value: "0".repeat(64) } };
    await expect(acquireHost({ hostId: "v1-1.19.3", artifact, workDir: work, stagingDir: staging, run: fakeCurl(archive).run })).rejects.toThrow(/digest mismatch/);
    expect(await readdir(work)).toEqual([]);
    expect(await readdir(staging)).toEqual([]);
  });

  it("refuses a V1 size mismatch (exact size)", async () => {
    const archive = tgz([{ name: "opencode", data: EXE }]);
    const artifact = { ...v1Artifact(archive), size: archive.length + 1 };
    await expect(acquireHost({ hostId: "v1-1.19.3", artifact, workDir: await scratch(), stagingDir: await scratch(), run: fakeCurl(archive).run })).rejects.toThrow(/size/);
  });

  it("fails on a curl error without retrying and leaves nothing behind", async () => {
    const work = await scratch();
    const fake = fakeCurl(Buffer.from("partial"), { status: 22 });
    await expect(acquireHost({ hostId: "v1-1.19.3", artifact: ARTIFACTS["v1-1.19.3"], workDir: work, stagingDir: await scratch(), run: fake.run })).rejects.toThrow(/download failed/);
    expect(fake.calls).toHaveLength(1);
    expect(await readdir(work)).toEqual([]);
  });

  it.each([
    ["a symlink member", [{ name: "opencode", type: "2", linkname: "/etc/passwd" }], /link entry rejected/],
    ["an extra member", [{ name: "opencode", data: "x" }, { name: "README", data: "x" }], /not in allowed member list/],
    ["a duplicate member", [{ name: "opencode", data: "x" }, { name: "opencode", data: "y" }], /duplicate entry/],
    ["a missing executable", [{ name: "other", data: "x" }], /not in allowed member list|missing required member/],
    ["an escaping member", [{ name: "../opencode", data: "x" }], /escapes|not in allowed/],
  ])("refuses %s after the digest check and stages nothing", async (_label, items, message) => {
    const archive = tgz(items as never);
    const staging = await scratch();
    await expect(acquireHost({ hostId: "v1-1.19.3", artifact: v1Artifact(archive), workDir: await scratch(), stagingDir: staging, run: fakeCurl(archive).run })).rejects.toThrow(message);
    expect(await readdir(staging)).toEqual([]);
  });

  it("never overwrites an existing staged executable", async () => {
    const staging = await scratch();
    await writeFile(join(staging, "opencode-1.19.3"), "previous");
    const archive = tgz([{ name: "opencode", data: EXE }]);
    await expect(acquireHost({ hostId: "v1-1.19.3", artifact: v1Artifact(archive), workDir: await scratch(), stagingDir: staging, run: fakeCurl(archive).run })).rejects.toThrow(/EEXIST|exists/);
    expect(await readFile(join(staging, "opencode-1.19.3"), "utf8")).toBe("previous");
    expect(existsSync(join(staging, "opencode-1.19.3"))).toBe(true);
  });
});
