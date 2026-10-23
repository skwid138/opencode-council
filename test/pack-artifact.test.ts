// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/pack-artifact.test.ts
// Local modifications (see test/PROVENANCE.md): council-shaped fixture (no SECURITY.md, nested src/dist module, nested test sources); added recursive-discovery, real-repo, nested stale/missing/symlink and compiled-test-artifact rejection cases; entry/size limits in two bound tests adjusted to the larger fixture.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertPackageArchive, buildPackageArchive, expectedPackageFiles, runTar as realRunTar } from "./pack-artifact.mjs";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pack-artifact-")));
  created.push(dir);
  return dir;
}

const SENTINEL_SCRIPT = (flag: string) => `node -e "require('fs').writeFileSync('${flag}','ran')"`;

/** A miniature repo whose lifecycle scripts would leave flag files if anything ran them. */
async function fixtureRepo(): Promise<string> {
  const root = join(await scratch(), "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist"));
  const manifest = {
    name: "fixture-pkg",
    version: "1.2.3",
    type: "module",
    files: ["dist", "LICENSE", "README.md"],
    scripts: {
      prepare: SENTINEL_SCRIPT("PREPARE_RAN"),
      prepack: SENTINEL_SCRIPT("PREPACK_RAN"),
      postpack: SENTINEL_SCRIPT("POSTPACK_RAN"),
    },
  };
  await writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const name of ["LICENSE", "README.md"]) await writeFile(join(root, name), `${name} body\n`);
  await mkdir(join(root, "src", "core"), { recursive: true });
  await mkdir(join(root, "dist", "core"), { recursive: true });
  for (const name of ["a.ts", "b.ts", "a.test.ts", "b.test-d.ts", "ambient.d.ts", "core/c.ts", "core/c.test.ts", "core/d.test-d.ts"]) {
    await writeFile(join(root, "src", name), "export {};\n");
  }
  for (const name of ["a.js", "a.d.ts", "b.js", "b.d.ts", "core/c.js", "core/c.d.ts"]) await writeFile(join(root, "dist", name), `// ${name}\n`);
  return root;
}

describe("expected package file set", () => {
  it("derives root files plus one .js and one .d.ts per production source module, recursively", async () => {
    const repo = await fixtureRepo();
    expect(await expectedPackageFiles(repo)).toEqual([
      "LICENSE",
      "README.md",
      "dist/a.d.ts",
      "dist/a.js",
      "dist/b.d.ts",
      "dist/b.js",
      "dist/core/c.d.ts",
      "dist/core/c.js",
      "package.json",
    ]);
  });

  it("matches this repository's real source tree and package.json files", async () => {
    const repo = new URL("..", import.meta.url).pathname;
    const expected = await expectedPackageFiles(repo);
    expect(expected).toContain("dist/index.js");
    expect(expected).toContain("dist/v2.d.ts");
    expect(expected.filter((name: string) => /\.test(-d)?\./.test(name))).toEqual([]);
  });

  it("refuses to guess when package.json `files` no longer matches the explicit root file set", async () => {
    const repo = await fixtureRepo();
    const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ ...manifest, files: [...manifest.files, "CHANGELOG.md"] }));
    await expect(expectedPackageFiles(repo)).rejects.toThrow(/files.*CHANGELOG\.md/);
  });
});

/** Lists `tar -tvzf` output with the system tar, isolated from inherited tar env. */
function systemList(archive: string): string[] {
  const result = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim().split("\n");
}

describe("script-free package archive", () => {
  it("archives exactly the expected regular files with exact bytes and never runs lifecycle scripts", async () => {
    const repo = await fixtureRepo();
    const work = await scratch();
    let built = 0;
    const result = await buildPackageArchive({ repoRoot: repo, workDir: work, build: async () => void (built += 1) });

    expect(built).toBe(1);
    const expected = await expectedPackageFiles(repo);
    expect(result.members).toEqual(expected.map((name) => `package/${name}`));
    expect(systemList(result.archivePath)).toEqual(result.members);
    expect(result.sha256).toBe(createHash("sha256").update(await readFile(result.archivePath)).digest("hex"));

    const unpacked = join(work, "unpacked");
    await mkdir(unpacked);
    const extract = spawnSync("tar", ["-xzf", result.archivePath, "-C", unpacked], { env: { PATH: "/usr/bin:/bin" } });
    expect(extract.status).toBe(0);
    for (const name of expected) {
      expect(await readFile(join(unpacked, "package", name))).toEqual(await readFile(join(repo, name)));
    }

    for (const flag of ["PREPARE_RAN", "PREPACK_RAN", "POSTPACK_RAN"]) {
      expect(existsSync(join(repo, flag))).toBe(false);
      expect(existsSync(join(work, flag))).toBe(false);
    }
    expect(existsSync(join(repo, ".git"))).toBe(false);
    expect(existsSync(join(repo, ".husky"))).toBe(false);
  });

  it("rejects a symlinked dist before building", async () => {
    const repo = await fixtureRepo();
    const elsewhere = join(await scratch(), "elsewhere-dist");
    await rename(join(repo, "dist"), elsewhere);
    await symlink(elsewhere, join(repo, "dist"));
    const work = await scratch();
    let built = 0;
    await expect(buildPackageArchive({ repoRoot: repo, workDir: work, build: async () => void (built += 1) })).rejects.toThrow(/dist.*symlink/);
    expect(built).toBe(0);
    expect(await readdir(work)).toEqual([]);
  });

  it("rejects a symlinked dist parent (the repo root) before building", async () => {
    const repo = await fixtureRepo();
    const link = join(await scratch(), "repo-link");
    await symlink(repo, link);
    const work = await scratch();
    let built = 0;
    await expect(buildPackageArchive({ repoRoot: link, workDir: work, build: async () => void (built += 1) })).rejects.toThrow(/repo-link.*symlink/);
    expect(built).toBe(0);
  });

  it("rejects a symlinked src before building", async () => {
    const repo = await fixtureRepo();
    const elsewhere = join(await scratch(), "elsewhere-src");
    await rename(join(repo, "src"), elsewhere);
    await symlink(elsewhere, join(repo, "src"));
    let built = 0;
    await expect(buildPackageArchive({ repoRoot: repo, workDir: await scratch(), build: async () => void (built += 1) })).rejects.toThrow(/src.*symlink/);
    expect(built).toBe(0);
  });

  const unsafeOutputs: Array<[string, (repo: string) => Promise<void>, RegExp]> = [
    ["a stale dist output", (repo) => writeFile(join(repo, "dist", "removed.js"), "// stale\n"), /unexpected build output.*dist\/removed\.js/],
    ["a missing dist output", (repo) => rm(join(repo, "dist", "b.d.ts")), /missing.*dist\/b\.d\.ts/],
    ["an unexpected dist subdirectory", (repo) => mkdir(join(repo, "dist", "nested")), /unexpected build output.*dist\/nested/],
    ["a stale nested dist output", (repo) => writeFile(join(repo, "dist", "core", "removed.js"), "// stale\n"), /unexpected build output.*dist\/core\/removed\.js/],
    ["a missing nested dist output", (repo) => rm(join(repo, "dist", "core", "c.js")), /missing.*dist\/core\/c\.js/],
    ["a compiled test artifact", (repo) => writeFile(join(repo, "dist", "a.test.js"), "// test\n"), /compiled test artifact.*dist\/a\.test\.js/],
    [
      "a nested compiled type-test artifact",
      (repo) => writeFile(join(repo, "dist", "core", "d.test-d.d.ts"), "export {};\n"),
      /compiled test artifact.*dist\/core\/d\.test-d\.d\.ts/,
    ],
    [
      "a stale directory holding only compiled tests",
      async (repo) => {
        await mkdir(join(repo, "dist", "old", "deeper"), { recursive: true });
        await writeFile(join(repo, "dist", "old", "deeper", "x.test.js"), "// stale test\n");
      },
      /compiled test artifact.*dist\/old\/deeper\/x\.test\.js/,
    ],
    [
      "a symlinked nested dist directory",
      async (repo) => {
        const elsewhere = join(repo, "elsewhere-core");
        await rename(join(repo, "dist", "core"), elsewhere);
        await symlink(elsewhere, join(repo, "dist", "core"));
      },
      /dist\/core.*symlink/,
    ],
    [
      "a symlinked dist leaf",
      async (repo) => {
        await rm(join(repo, "dist", "a.js"));
        await symlink(join(repo, "README.md"), join(repo, "dist", "a.js"));
      },
      /dist\/a\.js.*symlink/,
    ],
    [
      "a symlinked root file",
      async (repo) => {
        await rename(join(repo, "LICENSE"), join(repo, "LICENSE.real"));
        await symlink(join(repo, "LICENSE.real"), join(repo, "LICENSE"));
      },
      /LICENSE.*symlink/,
    ],
  ];

  for (const [label, mutate, message] of unsafeOutputs) {
    it(`rejects ${label} after building and stages nothing`, async () => {
      const repo = await fixtureRepo();
      const work = await scratch();
      await expect(buildPackageArchive({ repoRoot: repo, workDir: work, build: () => mutate(repo) })).rejects.toThrow(message);
      expect(await readdir(work)).toEqual([]);
    });
  }

  it("rejects a special file in place of an expected output (simulated through an lstat seam; no FIFO is created)", async () => {
    const repo = await fixtureRepo();
    const work = await scratch();
    const target = join(repo, "dist", "a.js");
    const lstatImpl = async (path: string) => {
      const real = await lstat(path);
      if (path !== target) return real;
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { isFile: () => false, isFIFO: () => true });
    };
    await expect(buildPackageArchive({ repoRoot: repo, workDir: work, build: async () => {}, io: { lstat: lstatImpl } })).rejects.toThrow(/dist\/a\.js.*not a regular file/);
    expect(await readdir(work)).toEqual([]);
  });

  it("validates the archive and throws before any consumer check runs", async () => {
    const repo = await fixtureRepo();
    const retainTo = join(await scratch(), "candidate.tgz");
    let consumerRan = false;
    // The real system tar, but asked to archive one extra member the builder did not stage.
    const runTar = (args: string[]) => {
      const stage = args[args.indexOf("-C") + 1];
      writeFileSync(join(stage, "package", "extra.js"), "// injected\n");
      return realRunTar([...args, "package/extra.js"]);
    };
    await expect(
      buildPackageArchive({
        repoRoot: repo,
        workDir: await scratch(),
        build: async () => {},
        consumerChecks: async () => void (consumerRan = true),
        retainTo,
        io: { runTar },
      }),
    ).rejects.toThrow(/package archive rejected.*\n.*not in allowed member list: package\/extra\.js/);
    expect(consumerRan).toBe(false);
    expect(existsSync(retainTo)).toBe(false);
  });

  it("runs consumer checks on the validated archive and only then retains it at a fresh destination", async () => {
    const repo = await fixtureRepo();
    const retainTo = join(await scratch(), "candidate.tgz");
    const seen: string[] = [];
    const result = await buildPackageArchive({
      repoRoot: repo,
      workDir: await scratch(),
      build: async () => {},
      consumerChecks: async ({ archivePath }: { archivePath: string }) => {
        seen.push(archivePath);
        expect(existsSync(retainTo)).toBe(false);
      },
      retainTo,
    });
    expect(seen).toEqual([result.archivePath]);
    expect(result.retainedPath).toBe(retainTo);
    expect(createHash("sha256").update(await readFile(retainTo)).digest("hex")).toBe(result.sha256);
  });

  it("retains nothing when a consumer check fails", async () => {
    const repo = await fixtureRepo();
    const retainTo = join(await scratch(), "candidate.tgz");
    await expect(
      buildPackageArchive({
        repoRoot: repo,
        workDir: await scratch(),
        build: async () => {},
        consumerChecks: async () => {
          throw new Error("consumer import failed");
        },
        retainTo,
      }),
    ).rejects.toThrow(/consumer import failed/);
    expect(existsSync(retainTo)).toBe(false);
  });

  it("never overwrites an existing retention destination", async () => {
    const repo = await fixtureRepo();
    const retainTo = join(await scratch(), "candidate.tgz");
    await writeFile(retainTo, "previous candidate");
    await expect(buildPackageArchive({ repoRoot: repo, workDir: await scratch(), build: async () => {}, retainTo })).rejects.toThrow(/EEXIST/);
    expect(await readFile(retainTo, "utf8")).toBe("previous candidate");
  });
});

describe("pre-read input bounds", () => {
  /** Records every path the builder opens, so a test can prove no payload was read. */
  function spyIo(overrides: Record<string, unknown> = {}) {
    const opened: string[] = [];
    return {
      opened,
      io: {
        open: async (path: string, flags: number, mode?: number) => {
          opened.push(path);
          return open(path, flags, mode);
        },
        ...overrides,
      },
    };
  }

  it("rejects when the derived file count exceeds maxEntries, before building, reading, or staging", async () => {
    const repo = await fixtureRepo();
    const work = await scratch();
    const { opened, io } = spyIo();
    let built = 0;
    const limits = { maxEntries: 8, maxExpandedBytes: 1_000_000, maxFileBytes: 100_000 };
    await expect(buildPackageArchive({ repoRoot: repo, workDir: work, build: async () => void (built += 1), limits, io })).rejects.toThrow(/9 package files exceed maxEntries 8/);
    expect(built).toBe(0);
    expect(opened).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  /** lstat that reports `size` for regular files under dist/ (the real files stay tiny). */
  const inflatedLstat = (size: number) => async (path: string) => {
    const real = await lstat(path);
    if (!real.isFile() || !path.includes("/dist/")) return real;
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { size });
  };

  it("rejects when the summed file sizes exceed maxExpandedBytes, before reading any payload or staging", async () => {
    const repo = await fixtureRepo();
    const work = await scratch();
    const { opened, io } = spyIo({ lstat: inflatedLstat(90_000) });
    // Each file is under maxFileBytes, but 6 dist files x 90 KB exceed the 500 KB aggregate.
    const limits = { maxEntries: 64, maxExpandedBytes: 500_000, maxFileBytes: 100_000 };
    await expect(buildPackageArchive({ repoRoot: repo, workDir: work, build: async () => {}, limits, io })).rejects.toThrow(/package files total \d+ bytes, exceeding maxExpandedBytes 500000/);
    expect(opened).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  it("rejects one oversized file before reading any file, including those sorted before it", async () => {
    const repo = await fixtureRepo();
    const work = await scratch();
    const lstatOne = async (path: string) => {
      const real = await lstat(path);
      return path.endsWith("/dist/b.js") ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { size: 200_000 }) : real;
    };
    const { opened, io } = spyIo({ lstat: lstatOne });
    const limits = { maxEntries: 64, maxExpandedBytes: 1_000_000, maxFileBytes: 100_000 };
    await expect(buildPackageArchive({ repoRoot: repo, workDir: work, build: async () => {}, limits, io })).rejects.toThrow(/dist\/b\.js exceeds maxFileBytes/);
    expect(opened).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  it("rejects a file whose bytes read differ from its checked size, without staging", async () => {
    const repo = await fixtureRepo();
    const work = await scratch();
    // The opened inode reports one byte less than is actually readable (a file that grew after the checks).
    const target = join(repo, "dist", "a.js");
    const lstatShrunk = async (path: string) => {
      const real = await lstat(path);
      return path === target ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { size: real.size - 1 }) : real;
    };
    const shrunkOpen = async (path: string, flags: number) => {
      const handle = await open(path, flags);
      if (path !== target) return handle;
      const stat = handle.stat.bind(handle);
      return Object.assign(handle, { stat: async () => Object.assign(await stat(), { size: (await stat()).size - 1 }) });
    };
    await expect(buildPackageArchive({ repoRoot: repo, workDir: work, build: async () => {}, io: { lstat: lstatShrunk, open: shrunkOpen } })).rejects.toThrow(
      /dist\/a\.js read more bytes than its checked size/,
    );
    expect(await readdir(work)).toEqual([]);
  });

  it("rejects a file whose opened inode size differs from the metadata pass", async () => {
    const repo = await fixtureRepo();
    const target = join(repo, "dist", "a.js");
    const lstatShrunk = async (path: string) => {
      const real = await lstat(path);
      return path === target ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { size: real.size - 1 }) : real;
    };
    await expect(buildPackageArchive({ repoRoot: repo, workDir: await scratch(), build: async () => {}, io: { lstat: lstatShrunk } })).rejects.toThrow(
      /dist\/a\.js changed size since it was checked/,
    );
  });
});

describe("fault injection", () => {
  it("a tar failure that left partial output runs no consumer, retains nothing, and removes the partial archive", async () => {
    const repo = await fixtureRepo();
    const work = await scratch();
    const retainTo = join(await scratch(), "candidate.tgz");
    let consumerRan = false;
    const runTar = (args: string[]) => {
      writeFileSync(args[args.indexOf("-czf") + 1], Buffer.from([0x1f, 0x8b, 0x08, 0x00])); // truncated gzip header
      throw new Error("tar: simulated write failure");
    };
    await expect(
      buildPackageArchive({ repoRoot: repo, workDir: work, build: async () => {}, consumerChecks: async () => void (consumerRan = true), retainTo, io: { runTar } }),
    ).rejects.toThrow(/simulated write failure/);
    expect(consumerRan).toBe(false);
    expect(existsSync(retainTo)).toBe(false);
    expect((await readdir(work)).filter((name) => name.endsWith(".tgz"))).toEqual([]);
  });

  it("a truncated archive from a tar that reported success is rejected before any consumer", async () => {
    const repo = await fixtureRepo();
    const retainTo = join(await scratch(), "candidate.tgz");
    let consumerRan = false;
    const runTar = (args: string[]) => {
      const result = realRunTar(args);
      const archive = args[args.indexOf("-czf") + 1];
      writeFileSync(archive, readFileSync(archive).subarray(0, 200));
      return result;
    };
    await expect(
      buildPackageArchive({ repoRoot: repo, workDir: await scratch(), build: async () => {}, consumerChecks: async () => void (consumerRan = true), retainTo, io: { runTar } }),
    ).rejects.toThrow();
    expect(consumerRan).toBe(false);
    expect(existsSync(retainTo)).toBe(false);
  });

  it("a retention write failure after exclusive creation removes the partial new file and leaves other files untouched", async () => {
    const repo = await fixtureRepo();
    const work = await scratch();
    const retainDir = await scratch();
    const retainTo = join(retainDir, "candidate.tgz");
    const neighbour = join(retainDir, "previous-candidate.tgz");
    await writeFile(neighbour, "previous candidate");
    let consumerRan = false;
    let partialWritten = 0;
    const failingOpen = async (path: string, flags: number, mode?: number) => {
      const handle = await open(path, flags, mode);
      if (!(flags & constants.O_EXCL)) return handle;
      return Object.assign(handle, {
        writeFile: async (data: Buffer) => {
          partialWritten = (await handle.write(data.subarray(0, 100))).bytesWritten;
          throw new Error("simulated ENOSPC during retention");
        },
      });
    };
    await expect(
      buildPackageArchive({ repoRoot: repo, workDir: work, build: async () => {}, consumerChecks: async () => void (consumerRan = true), retainTo, io: { open: failingOpen } }),
    ).rejects.toThrow(/simulated ENOSPC/);
    expect(consumerRan).toBe(true);
    expect(partialWritten).toBe(100);
    expect(existsSync(retainTo)).toBe(false);
    expect(await readFile(neighbour, "utf8")).toBe("previous candidate");
    expect((await readdir(work)).filter((name) => name.endsWith(".tgz"))).toEqual([]);
  });
});

describe("package archive validation", () => {
  const FILES = new Map([
    ["package.json", Buffer.from('{"name":"x"}\n')],
    ["dist/a.js", Buffer.from("// a\n")],
  ]);

  /** Builds an archive with the system tar from a scratch stage; `extra` lets a case add hostile members. */
  async function archiveOf(files: Map<string, Buffer>, extra?: (stage: string) => Promise<string[]>): Promise<string> {
    const root = await scratch();
    const stage = join(root, "stage");
    for (const [name, data] of files) {
      await mkdir(join(stage, "package", name, ".."), { recursive: true });
      await writeFile(join(stage, "package", name), data);
    }
    const members = [...files.keys()].map((name) => `package/${name}`);
    if (extra) members.push(...(await extra(stage)));
    const archive = join(root, "test.tgz");
    const result = spawnSync("tar", ["--format=ustar", "-czf", archive, "-C", stage, ...members], { env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" } });
    if (result.status !== 0) throw new Error(String(result.stderr));
    return archive;
  }

  it("accepts an archive holding exactly the expected regular files and bytes", async () => {
    const buffer = await assertPackageArchive(await archiveOf(FILES), FILES);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("rejects an unexpected extra member", async () => {
    const archive = await archiveOf(FILES, async (stage) => {
      await writeFile(join(stage, "package", "extra.js"), "x");
      return ["package/extra.js"];
    });
    await expect(assertPackageArchive(archive, FILES)).rejects.toThrow(/not in allowed member list: package\/extra\.js/);
  });

  it("rejects a symlink member", async () => {
    const archive = await archiveOf(new Map([["package.json", FILES.get("package.json")!]]), async (stage) => {
      await mkdir(join(stage, "package", "dist"), { recursive: true });
      await symlink("/etc/passwd", join(stage, "package", "dist", "a.js"));
      return ["package/dist/a.js"];
    });
    await expect(assertPackageArchive(archive, FILES)).rejects.toThrow(/link entry rejected: package\/dist\/a\.js/);
  });

  it("rejects member bytes that differ from the staged file", async () => {
    const archive = await archiveOf(new Map([...FILES, ["dist/a.js", Buffer.from("// tampered\n")]]));
    await expect(assertPackageArchive(archive, FILES)).rejects.toThrow(/bytes differ.*package\/dist\/a\.js/);
  });

  it("rejects an archive file larger than the bounded cap before decompressing it", async () => {
    // Incompressible bytes keep the .tgz itself above the cap derived from these limits (~3 KB).
    const big = new Map([["dist/a.js", randomBytes(16_384)]]);
    const archive = await archiveOf(big);
    const limits = { maxEntries: 1, maxExpandedBytes: 1, maxFileBytes: 1 };
    await expect(assertPackageArchive(archive, big, limits)).rejects.toThrow(/archive file .* exceeds the 3073-byte cap/);
  });
});
