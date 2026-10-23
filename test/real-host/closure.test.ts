import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkGatePReceipt,
  closureArgv,
  closureEnv,
  closureTreeFiles,
  INSTALL_SCRIPT_ALLOWLIST,
  inspectClosure,
  NODE_PATH,
  NPM_CLI,
  prepareClosureConfig,
  prepareClosureDir,
  readNpmVersion,
  runGateP,
  verifyClosureFiles,
} from "./closure.mjs";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-closure-")));
  created.push(dir);
  return dir;
}
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const R = "https://registry.npmjs.org";

type Entry = Record<string, unknown>;
const pkg = (name: string, version: string, extra: Entry = {}) => ({ version, resolved: `${R}/${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity: `sha512-${sha256(name + version)}`, ...extra });

/** Lockfile packages + which of them are physically installed. */
function goodLock(): Record<string, Entry> {
  return {
    "": { dependencies: { "@opencode-ai/plugin": "1.19.3" } },
    "node_modules/@opencode-ai/plugin": pkg("@opencode-ai/plugin", "1.19.3"),
    "node_modules/zod": pkg("zod", "4.1.8"),
    "node_modules/@opencode-ai/plugin/node_modules/effect": pkg("effect", "4.0.0"),
    "node_modules/@x/addon-linux-arm64-gnu": pkg("@x/addon-linux-arm64-gnu", "1.0.0", { optional: true, os: ["linux"], cpu: ["arm64"], libc: ["glibc"] }),
    "node_modules/@x/addon-darwin-arm64": pkg("@x/addon-darwin-arm64", "1.0.0", { optional: true, os: ["darwin"], cpu: ["arm64"] }),
  };
}
const INSTALLED = ["node_modules/@opencode-ai/plugin", "node_modules/zod", "node_modules/@opencode-ai/plugin/node_modules/effect", "node_modules/@x/addon-linux-arm64-gnu"];

async function closureFixture({ lock = goodLock(), installed = INSTALLED, versions = {} as Record<string, string> } = {}) {
  const session = await scratch();
  const dir = join(session, "closure");
  await mkdir(dir);
  await writeFile(join(dir, "package.json"), '{"private":true,"dependencies":{"@opencode-ai/plugin":"1.19.3"}}\n');
  await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name: "closure", lockfileVersion: 3, requires: true, packages: lock }, null, 2));
  for (const key of installed) {
    const name = key.split("node_modules/").pop() as string;
    await mkdir(join(dir, key, "dist"), { recursive: true });
    await writeFile(join(dir, key, "package.json"), JSON.stringify({ name, version: versions[key] ?? (lock[key]?.version as string) ?? "0.0.0" }));
    await writeFile(join(dir, key, "dist", "index.js"), `// ${name}\n`);
  }
  await writeFile(join(dir, "node_modules", ".package-lock.json"), "{}");
  return { session, dir };
}

const problemsOf = async (dir: string) => (await inspectClosure({ closureDir: dir })).problems.join("\n");

describe("Gate P command (pinned literally)", () => {
  it("runs the exact npm-cli under the exact node with the exact flags", () => {
    expect(NODE_PATH).toBe("/Users/hunter/.nvm/versions/node/v24.15.0/bin/node");
    expect(NPM_CLI).toBe("/Users/hunter/.nvm/versions/node/v24.15.0/lib/node_modules/npm/bin/npm-cli.js");
    expect(closureArgv()).toEqual([
      "/Users/hunter/.nvm/versions/node/v24.15.0/bin/node",
      "/Users/hunter/.nvm/versions/node/v24.15.0/lib/node_modules/npm/bin/npm-cli.js",
      "install", "--ignore-scripts", "--no-bin-links", "--fetch-retries=0", "--no-audit", "--no-fund",
      "--os=linux", "--cpu=arm64", "--libc=glibc", "--registry=https://registry.npmjs.org/",
    ]);
  });

  it("builds the environment from scratch (nothing inherited)", () => {
    expect(closureEnv("/s")).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/s/closure-home",
      npm_config_cache: "/s/closure-cache",
      npm_config_userconfig: "/s/closure-config/npmrc-user",
      npm_config_globalconfig: "/s/closure-config/npmrc-global",
    });
    expect(() => closureEnv("relative")).toThrow(/absolute/);
  });

  it("uses two distinct npmrc paths, so npm's @npmcli/config duplicate-source rule is never hit (read from source, npm never run)", async () => {
    const env = closureEnv("/s");
    expect(env.npm_config_userconfig).not.toBe(env.npm_config_globalconfig);
    expect([env.npm_config_userconfig, env.npm_config_globalconfig]).not.toContain("/dev/null");
    // The repo's dev dependency @npmcli/config@10.8.1 is byte-identical (sha256 below) to the copy
    // bundled in the pinned npm 11.12.1; its #loadObject throws when one file is loaded as two
    // config types ("double-loading config ... as ...") -- the /dev/null + /dev/null defect.
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("@npmcli/config/package.json", { paths: [process.cwd()] });
    expect(JSON.parse(await readFile(manifest, "utf8")).version).toBe("10.8.1");
    const source = await readFile(join(dirname(manifest), "lib", "index.js"));
    expect(sha256(source)).toBe("938b85a17fde9f2355497fd4befc9bac45d406fb4afacd8af63322796697ff06");
    const text = source.toString("utf8");
    expect(text).toContain("if (this.sources.has(source)) {");
    expect(text).toContain("const m = `double-loading config \"${source}\" as \"${where}\", ` +");
    expect(text).toContain("return this.#loadFile(this.#get('userconfig'), 'user')");
    expect(text).toContain("return this.#loadFile(this.#get('globalconfig'), 'global')");
  });

  it("asserts npm 11.12.1 by reading npm's package.json, never by running it", async () => {
    const root = await scratch();
    const cli = join(root, "npm", "bin", "npm-cli.js");
    await mkdir(dirname(cli), { recursive: true });
    await writeFile(join(root, "npm", "package.json"), JSON.stringify({ name: "npm", version: "11.12.1" }));
    expect(await readNpmVersion(cli)).toBe("11.12.1");
    await writeFile(join(root, "npm", "package.json"), JSON.stringify({ name: "npm", version: "10.9.2" }));
    await expect(readNpmVersion(cli)).rejects.toThrow(/npm 11.12.1/);
  });
});

describe("prepareClosureDir", () => {
  it("creates a fresh closure dir holding only the generated package.json", async () => {
    const session = await scratch();
    const dir = await prepareClosureDir(session);
    expect(dir).toBe(join(session, "closure"));
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe('{"private":true,"dependencies":{"@opencode-ai/plugin":"1.19.3"}}\n');
  });

  it("refuses an existing closure dir and any .npmrc up to $S", async () => {
    const session = await scratch();
    await mkdir(join(session, "closure"));
    await expect(prepareClosureDir(session)).rejects.toThrow(/already exists/);
    const other = await scratch();
    await writeFile(join(other, ".npmrc"), "registry=https://evil.example/\n");
    await expect(prepareClosureDir(other)).rejects.toThrow(/\.npmrc/);
    expect(existsSync(join(other, "closure"))).toBe(false);
  });
});

describe("prepareClosureConfig (fresh empty npmrc files)", () => {
  it("creates closure-config (0700) holding two distinct empty regular files (0600) by exclusive create", async () => {
    const session = await scratch();
    const files = await prepareClosureConfig(session);
    expect(files).toEqual({ user: join(session, "closure-config", "npmrc-user"), global: join(session, "closure-config", "npmrc-global") });
    expect((await lstat(join(session, "closure-config"))).mode & 0o777).toBe(0o700);
    expect((await readdir(join(session, "closure-config"))).sort()).toEqual(["npmrc-global", "npmrc-user"]);
    for (const path of [files.user, files.global]) {
      const info = await lstat(path);
      expect(info.isFile()).toBe(true);
      expect(info.size).toBe(0);
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["a directory", async (path: string) => mkdir(path)],
    ["a file", async (path: string) => writeFile(path, "")],
    ["a symlink", async (path: string) => symlink("/tmp", path)],
    ["a dangling symlink", async (path: string) => symlink("/nonexistent-rh-target", path)],
  ])("refuses when closure-config already exists as %s", async (_label, make) => {
    const session = await scratch();
    await make(join(session, "closure-config"));
    await expect(prepareClosureConfig(session)).rejects.toThrow(/closure-config already exists/);
  });
});

describe("inspectClosure", () => {
  it("accepts a clean linux/arm64 closure and records lock, installed, omitted, platform-selected, and per-file hashes", async () => {
    const { dir } = await closureFixture();
    const inspection = await inspectClosure({ closureDir: dir });
    expect(inspection.problems).toEqual([]);
    expect(inspection.stop).toBe(false);
    expect(inspection.lockfileSha256).toBe(sha256(await readFile(join(dir, "package-lock.json"))));
    expect(inspection.packages.map((entry: { path: string }) => entry.path)).toEqual(Object.keys(goodLock()).filter((key) => key !== ""));
    expect(inspection.packages[0]).toEqual({ path: "node_modules/@opencode-ai/plugin", name: "@opencode-ai/plugin", version: "1.19.3", resolved: `${R}/@opencode-ai/plugin/-/plugin-1.19.3.tgz`, integrity: expect.stringMatching(/^sha512-/), optional: false, hasInstallScript: false, os: null, cpu: null, libc: null });
    expect(inspection.installed.map((entry: { path: string }) => entry.path).sort()).toEqual([...INSTALLED].sort());
    expect(inspection.omittedOptional).toEqual(["node_modules/@x/addon-darwin-arm64"]);
    expect(inspection.platformSelected).toEqual(["node_modules/@x/addon-linux-arm64-gnu"]);
    expect(inspection.files.map((file: { path: string }) => file.path)).toContain("@opencode-ai/plugin/node_modules/effect/dist/index.js");
    for (const file of inspection.files) expect(sha256(await readFile(join(dir, "node_modules", file.path)))).toBe(file.sha256);
  });

  it.each([
    ["a resolved URL outside the registry", (lock: Record<string, Entry>) => (lock["node_modules/zod"].resolved = "https://evil.example/zod.tgz"), /not under https:\/\/registry\.npmjs\.org\//],
    ["missing integrity", (lock: Record<string, Entry>) => delete lock["node_modules/zod"].integrity, /missing integrity/],
    ["a git spec", (lock: Record<string, Entry>) => (lock["node_modules/zod"].resolved = "git+ssh://git@github.com/x/zod.git#abc"), /not under/],
    ["a file spec", (lock: Record<string, Entry>) => (lock["node_modules/zod"].resolved = "file:../zod"), /not under/],
    ["a link entry", (lock: Record<string, Entry>) => (lock["node_modules/zod"] = { resolved: "../zod", link: true }), /link/],
  ])("rejects %s", async (_label, mutate, message) => {
    const lock = goodLock();
    mutate(lock);
    const { dir } = await closureFixture({ lock });
    expect(await problemsOf(dir)).toMatch(message);
  });

  it("rejects a plugin version other than 1.19.3, and that is the ONLY problem (fixture otherwise clean)", async () => {
    // Lockfile and installed tree agree on 1.19.2 (resolved URL too), so every other
    // check passes; only the exact-peer-version check can reject this closure.
    const lock = goodLock();
    lock["node_modules/@opencode-ai/plugin"] = pkg("@opencode-ai/plugin", "1.19.2");
    const { dir } = await closureFixture({ lock });
    expect((await inspectClosure({ closureDir: dir })).problems).toEqual(["@opencode-ai/plugin must be exactly 1.19.3 at node_modules/@opencode-ai/plugin"]);
  });

  it("rejects an installed darwin or x64 platform package", async () => {
    const darwin = goodLock();
    const { dir } = await closureFixture({ lock: darwin, installed: [...INSTALLED, "node_modules/@x/addon-darwin-arm64"] });
    expect(await problemsOf(dir)).toMatch(/platform package .*addon-darwin-arm64.* is not linux\/arm64/);
    const x64 = goodLock();
    x64["node_modules/@x/addon-linux-x64-gnu"] = pkg("@x/addon-linux-x64-gnu", "1.0.0", { optional: true, os: ["linux"], cpu: ["x64"] });
    const second = await closureFixture({ lock: x64, installed: [...INSTALLED, "node_modules/@x/addon-linux-x64-gnu"] });
    expect(await problemsOf(second.dir)).toMatch(/addon-linux-x64-gnu.* is not linux\/arm64/);
  });

  it("rejects an installed package that does not match the lockfile (version, unknown path, missing required)", async () => {
    const version = await closureFixture({ versions: { "node_modules/zod": "4.1.9" } });
    expect(await problemsOf(version.dir)).toMatch(/node_modules\/zod installed 4\.1\.9 != lockfile 4\.1\.8/);
    const unknown = await closureFixture({ installed: [...INSTALLED, "node_modules/stowaway"] });
    expect(await problemsOf(unknown.dir)).toMatch(/node_modules\/stowaway is installed but not in the lockfile/);
    const missing = await closureFixture({ installed: INSTALLED.filter((key) => key !== "node_modules/zod") });
    expect(await problemsOf(missing.dir)).toMatch(/node_modules\/zod is in the lockfile but not installed/);
  });

  it("rejects an installed package whose package.json name differs from the lockfile", async () => {
    const { dir } = await closureFixture();
    await writeFile(join(dir, "node_modules", "zod", "package.json"), JSON.stringify({ name: "evil-zod", version: "4.1.8" }));
    expect((await inspectClosure({ closureDir: dir })).problems).toEqual(["node_modules/zod installed name evil-zod != lockfile zod"]);
  });

  it("rejects symlinks, hardlinks (nlink > 1), and unsafe file names", async () => {
    const sym = await closureFixture();
    await symlink("/etc/passwd", join(sym.dir, "node_modules", "zod", "dist", "evil.js"));
    expect(await problemsOf(sym.dir)).toMatch(/symlink/);
    const hard = await closureFixture();
    await link(join(hard.dir, "node_modules", "zod", "dist", "index.js"), join(hard.dir, "node_modules", "zod", "dist", "copy.js"));
    expect(await problemsOf(hard.dir)).toMatch(/hardlink \(nlink 2\)/);
    const unsafe = await closureFixture();
    await writeFile(join(unsafe.dir, "node_modules", "zod", "dist", "a\\b.js"), "x");
    expect(await problemsOf(unsafe.dir)).toMatch(/unsafe path/);
  });

  it("rejects a tree over the acceptance limits", async () => {
    const { dir } = await closureFixture();
    expect((await inspectClosure({ closureDir: dir, limits: { maxBytes: 10, maxPackages: 400 } })).problems.join("\n")).toMatch(/exceeds 10 bytes/);
    expect((await inspectClosure({ closureDir: dir, limits: { maxBytes: 1e9, maxPackages: 2 } })).problems.join("\n")).toMatch(/4 packages exceed 2/);
  });

  it("STOPs on an installed package with an install script that is not allowlisted, and allows an exact allowlisted one", async () => {
    const lock = goodLock();
    lock["node_modules/zod"].hasInstallScript = true;
    const { dir } = await closureFixture({ lock });
    const stopped = await inspectClosure({ closureDir: dir });
    expect(stopped.stop).toBe(true);
    expect(stopped.problems.join("\n")).toMatch(/STOP: install script not allowlisted: zod@4\.1\.8/);
    const allowed = await inspectClosure({ closureDir: dir, allowlist: { "zod@4.1.8": "test justification" } });
    expect(allowed.stop).toBe(false);
    expect(allowed.problems).toEqual([]);
  });

  const JUSTIFICATION =
    "optional native addon; install script only runs node-gyp-build-optional-packages, which loads a prebuilt platform package (@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4 selected for linux/arm64/glibc) or falls back; msgpackr catches native-load failure and uses pure JS; scripts are never executed (--ignore-scripts)";

  it("pins the default install-script allowlist to exactly msgpackr-extract@3.0.4", () => {
    expect(INSTALL_SCRIPT_ALLOWLIST).toEqual({ "msgpackr-extract@3.0.4": JUSTIFICATION });
  });

  /** goodLock + msgpackr-extract (with an install script) at `version`, installed, plus its linux-arm64 prebuild. */
  async function withMsgpackrExtract(version: string, { prebuild = true } = {}) {
    const lock = goodLock();
    lock["node_modules/msgpackr-extract"] = pkg("msgpackr-extract", version, { optional: true, hasInstallScript: true });
    const installed = [...INSTALLED, "node_modules/msgpackr-extract"];
    lock["node_modules/@msgpackr-extract/msgpackr-extract-linux-arm64"] = pkg("@msgpackr-extract/msgpackr-extract-linux-arm64", "3.0.4", { optional: true, os: ["linux"], cpu: ["arm64"] });
    lock["node_modules/@msgpackr-extract/msgpackr-extract-darwin-arm64"] = pkg("@msgpackr-extract/msgpackr-extract-darwin-arm64", "3.0.4", { optional: true, os: ["darwin"], cpu: ["arm64"] });
    if (prebuild) installed.push("node_modules/@msgpackr-extract/msgpackr-extract-linux-arm64");
    return (await closureFixture({ lock, installed })).dir;
  }

  it("passes the allowlisted msgpackr-extract@3.0.4 under the default allowlist and records the expected linux-arm64 prebuild", async () => {
    const inspection = await inspectClosure({ closureDir: await withMsgpackrExtract("3.0.4") });
    expect(inspection.problems).toEqual([]);
    expect(inspection.stop).toBe(false);
    expect(inspection.platformSelected).toContain("node_modules/@msgpackr-extract/msgpackr-extract-linux-arm64");
    expect(inspection.expectedPlatformPackages).toEqual([{ spec: "@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4", selected: true }]);
    expect(inspection.omittedOptional).toContain("node_modules/@msgpackr-extract/msgpackr-extract-darwin-arm64");
  });

  it("does not require the expected prebuild (native acceleration is not claimed)", async () => {
    const inspection = await inspectClosure({ closureDir: await withMsgpackrExtract("3.0.4", { prebuild: false }) });
    expect(inspection.problems).toEqual([]);
    expect(inspection.expectedPlatformPackages).toEqual([{ spec: "@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4", selected: false }]);
  });

  it("STOPs on msgpackr-extract at any other version under the default allowlist", async () => {
    const inspection = await inspectClosure({ closureDir: await withMsgpackrExtract("3.0.5") });
    expect(inspection.stop).toBe(true);
    expect(inspection.problems).toEqual(["STOP: install script not allowlisted: msgpackr-extract@3.0.5"]);
  });

  it("STOPs on any other package with an install script under the default allowlist", async () => {
    const lock = goodLock();
    lock["node_modules/zod"].hasInstallScript = true;
    const inspection = await inspectClosure({ closureDir: (await closureFixture({ lock })).dir });
    expect(inspection.stop).toBe(true);
    expect(inspection.problems).toEqual(["STOP: install script not allowlisted: zod@4.1.8"]);
  });
});

describe("runGateP (injected runner; never spawns npm)", () => {
  async function fakeInstall(installDir: string, { lock = goodLock(), installed = INSTALLED } = {}) {
    await writeFile(join(installDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: lock }));
    for (const key of installed) {
      await mkdir(join(installDir, key), { recursive: true });
      await writeFile(join(installDir, key, "package.json"), JSON.stringify({ name: key.split("node_modules/").pop(), version: lock[key].version }));
    }
  }

  it("post-P1b audit (frame-2 MA3): an npm run whose process group did not settle is REJECTED (never accepted), even on exit 0", async () => {
    const session = await scratch();
    const receipt = await runGateP({
      sessionDir: session,
      runId: "p1a01",
      approval: "user-msg-42",
      readNpmVersion: async () => "11.12.1",
      run: async (_argv: string[], options: { cwd: string }) => {
        await fakeInstall(options.cwd);
        return { status: 0, stdout: "", stderr: "", timedOut: false, cleanupUncertain: true };
      },
    });
    expect(receipt.status).toBe("rejected");
    expect(receipt.problems).toContain("npm install process group did not settle (cleanup uncertain; original process group not confirmed gone)");
  });

  it("runs exactly the pinned command once in the closure dir with the scratch env and writes an accepted receipt", async () => {
    const session = await scratch();
    const calls: unknown[] = [];
    const receipt = await runGateP({
      sessionDir: session,
      runId: "p1a01",
      approval: "user-msg-42",
      readNpmVersion: async () => "11.12.1",
      run: async (argv: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => {
        calls.push([argv, options]);
        await fakeInstall(options.cwd);
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    expect(calls).toEqual([[closureArgv(), { cwd: join(session, "closure"), env: closureEnv(session), timeoutMs: 300_000 }]]);
    expect(receipt).toMatchObject({ schema: "council-rh-closure/1", status: "accepted", runId: "p1a01", approval: "user-msg-42", npm: { version: "11.12.1", cliPath: NPM_CLI }, node: { path: NODE_PATH }, plugin: "@opencode-ai/plugin@1.19.3" });
    expect(receipt.receiptId).toBe(`closure-p1a01-${receipt.lockfileSha256.slice(0, 12)}`);
    expect(JSON.parse(await readFile(join(session, "gate-p-p1a01.json"), "utf8"))).toEqual(receipt);
  });

  it("hands npm two freshly created, empty npmrc files that exist at spawn time", async () => {
    const session = await scratch();
    const seen: unknown[] = [];
    await runGateP({
      sessionDir: session,
      runId: "p1a01",
      approval: "user-msg-42",
      readNpmVersion: async () => "11.12.1",
      run: async (_argv: string[], options: { cwd: string; env: Record<string, string> }) => {
        for (const key of ["npm_config_userconfig", "npm_config_globalconfig"]) {
          const info = await lstat(options.env[key]);
          seen.push([key, info.isFile(), info.size]);
        }
        await fakeInstall(options.cwd);
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    expect(seen).toEqual([["npm_config_userconfig", true, 0], ["npm_config_globalconfig", true, 0]]);
  });

  it.each([
    ["a non-empty npmrc", async (path: string) => writeFile(path, "registry=https://evil.example/\n"), /npmrc-user must be an empty regular file/],
    ["an npmrc replaced by a symlink", async (path: string) => (await rm(path), await symlink("/dev/null", path)), /npmrc-user must be an empty regular file/],
    ["an npmrc replaced by a directory", async (path: string) => (await rm(path), await mkdir(path)), /npmrc-user must be an empty regular file/],
  ])("refuses before spawning npm on %s (checked just before the spawn)", async (_label, tamper, message) => {
    const session = await scratch();
    let ran = false;
    await expect(
      runGateP({
        sessionDir: session,
        runId: "p1a01",
        approval: "user-msg-42",
        readNpmVersion: async () => "11.12.1",
        afterPrepare: async () => tamper(join(session, "closure-config", "npmrc-user")),
        run: async () => ((ran = true), { status: 0, stdout: "", stderr: "", timedOut: false }),
      }),
    ).rejects.toThrow(message);
    expect(ran).toBe(false);
  });

  describe("cancellation (operator signal): never an accepted receipt", () => {
    const base = (session: string) => ({ sessionDir: session, runId: "p1a01", approval: "user-msg-42", readNpmVersion: async () => "11.12.1" });

    it("aborted while npm runs -> cancelled receipt (status cancelled, stage npm install)", async () => {
      const session = await scratch();
      const controller = new AbortController();
      const receipt = await runGateP({ ...base(session), signal: controller.signal, run: async (_argv: string[], options: { signal?: AbortSignal }) => (controller.abort(), expect(options.signal).toBe(controller.signal), { status: null, stdout: "", stderr: "", timedOut: false, cancelled: true }) });
      expect(receipt).toMatchObject({ schema: "council-rh-closure/1", status: "cancelled", stage: "npm install", runId: "p1a01" });
      // The cleanup claim is explicitly scoped (never "all started processes stopped").
      expect(receipt).toMatchObject({ cleanupConfirmed: true, cleanupScope: "original-process-group", cleanupScopeNote: expect.stringMatching(/escaped descendants .* not tracked/) });
      expect(receipt).not.toHaveProperty("processSettled");
      expect(JSON.parse(await readFile(join(session, "gate-p-p1a01.json"), "utf8")).status).toBe("cancelled");
    });

    it("aborted after npm exited 0 -> still cancelled (never accepted)", async () => {
      const session = await scratch();
      const controller = new AbortController();
      const receipt = await runGateP({ ...base(session), signal: controller.signal, run: async (_argv: string[], { cwd }: { cwd: string }) => (await fakeInstall(cwd), controller.abort(), { status: 0, stdout: "", stderr: "", timedOut: false, cancelled: false }) });
      // Detected right after npm returned (stage npm install), before any inspection.
      expect(receipt).toMatchObject({ status: "cancelled", stage: "npm install" });
      expect(JSON.parse(await readFile(join(session, "gate-p-p1a01.json"), "utf8")).status).toBe("cancelled");
    });

    it("aborted during the FINAL accepted write -> runGateP itself re-checks and marks the receipt cancelled (stage receipt write)", async () => {
      const session = await scratch();
      const controller = new AbortController();
      const writeReceipt = async (path: string, text: string) => {
        if (JSON.parse(text).status === "accepted") controller.abort();
        await writeFile(path, text);
      };
      const receipt = await runGateP({ ...base(session), signal: controller.signal, writeReceipt, run: async (_argv: string[], { cwd }: { cwd: string }) => (await fakeInstall(cwd), { status: 0, stdout: "", stderr: "", timedOut: false, cancelled: false }) });
      expect(receipt).toMatchObject({ status: "cancelled", previousStatus: "accepted", stage: "receipt write" });
      expect(JSON.parse(await readFile(join(session, "gate-p-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", previousStatus: "accepted", stage: "receipt write" });
    });

    it.each([
      ["while reading the npm version", "version"],
      ["after the closure dir was prepared", "prepare"],
    ])("aborted %s -> npm is never spawned; cancelled receipt", async (_label, when) => {
      const session = await scratch();
      const controller = new AbortController();
      let ran = false;
      const receipt = await runGateP({
        ...base(session),
        signal: controller.signal,
        readNpmVersion: async () => (when === "version" && controller.abort(), "11.12.1"),
        afterPrepare: async () => void (when === "prepare" && controller.abort()),
        run: async () => ((ran = true), { status: 0, stdout: "", stderr: "", timedOut: false }),
      });
      expect(ran).toBe(false);
      expect(receipt.status).toBe("cancelled");
      expect(JSON.parse(await readFile(join(session, "gate-p-p1a01.json"), "utf8")).status).toBe("cancelled");
      // Aborted during the version read: not even the closure dir is created.
      if (when === "version") {
        expect(receipt.stage).toBe("after npm version check");
        expect(existsSync(join(session, "closure"))).toBe(false);
      }
    });
  });

  it("writes a receipt marked rejected (and never retries) on a bad closure or a failed install", async () => {
    const session = await scratch();
    let calls = 0;
    const lock = goodLock();
    lock["node_modules/zod"].resolved = "https://evil.example/zod.tgz";
    const rejected = await runGateP({ sessionDir: session, runId: "r1", approval: "user-msg-1", readNpmVersion: async () => "11.12.1", run: async (_argv: string[], { cwd }: { cwd: string }) => (calls += 1, await fakeInstall(cwd, { lock }), { status: 0, stdout: "", stderr: "", timedOut: false }) });
    expect(rejected.status).toBe("rejected");
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(join(session, "gate-p-r1.json"), "utf8")).status).toBe("rejected");

    const failed = await scratch();
    const timedOut = await runGateP({ sessionDir: failed, runId: "r2", approval: "user-msg-1", readNpmVersion: async () => "11.12.1", run: async () => ({ status: null, stdout: "", stderr: "", timedOut: true }) });
    expect(timedOut).toMatchObject({ status: "rejected", problems: [expect.stringContaining("timed out")] });
  });

  it("refuses before running npm when the npm version is wrong", async () => {
    const session = await scratch();
    let ran = false;
    await expect(runGateP({ sessionDir: session, runId: "r1", approval: "user-msg-1", readNpmVersion: async () => { throw new Error("npm 11.12.1 required, found 10.0.0"); }, run: async () => (ran = true, { status: 0 }) })).rejects.toThrow(/11\.12\.1/);
    expect(ran).toBe(false);
  });
});

describe("Gate P receipt checks used by Gate B", () => {
  const receipt = { schema: "council-rh-closure/1", status: "accepted", runId: "p1a01", approval: "user-msg-42", receiptId: "closure-p1a01-abc", lockfileSha256: "a".repeat(64), files: [], problems: [] };

  it("accepts a matching accepted receipt and refuses rejected / run-id / approval mismatches", () => {
    expect(checkGatePReceipt(receipt, { runId: "p1a01", approval: "user-msg-42" })).toEqual([]);
    expect(checkGatePReceipt({ ...receipt, status: "rejected" }, { runId: "p1a01", approval: "user-msg-42" }).join()).toMatch(/rejected/);
    expect(checkGatePReceipt(receipt, { runId: "other", approval: "user-msg-42" }).join()).toMatch(/run id/);
    expect(checkGatePReceipt(receipt, { runId: "p1a01", approval: "user-msg-99" }).join()).toMatch(/approval/);
    expect(checkGatePReceipt(null, { runId: "p1a01", approval: "user-msg-42" }).join()).toMatch(/missing/);
  });

  it("copies exactly the bytes it hashed: each file is read once, so a change after hashing cannot reach the context", async () => {
    const { dir } = await closureFixture();
    const inspection = await inspectClosure({ closureDir: dir });
    const accepted = { ...receipt, files: inspection.files, lockfileSha256: inspection.lockfileSha256 };
    const target = join(dir, "node_modules", "zod", "dist", "index.js");
    const original = await readFile(target);
    const reads = new Map<string, number>();
    const read = async (path: string) => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      const data = await readFile(path);
      // Swap the file on disk right after it was read (i.e. between hashing and any later load).
      if (path === target) await writeFile(target, "// swapped after hashing\n");
      return data;
    };
    const tree = await closureTreeFiles({ closureDir: dir, receipt: accepted, readFile: read });
    expect(Buffer.compare(tree.get("zod/dist/index.js") as Buffer, original)).toBe(0);
    expect(reads.get(target)).toBe(1);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
  });

  it("re-hashes the closure and refuses changed, extra, or missing files; returns nested tree files without the hidden lock", async () => {
    const { dir } = await closureFixture();
    const inspection = await inspectClosure({ closureDir: dir });
    const accepted = { ...receipt, files: inspection.files, lockfileSha256: inspection.lockfileSha256 };
    expect(await verifyClosureFiles({ closureDir: dir, receipt: accepted })).toEqual([]);
    const tree = await closureTreeFiles({ closureDir: dir, receipt: accepted });
    expect([...tree.keys()]).toContain("@opencode-ai/plugin/node_modules/effect/dist/index.js");
    expect([...tree.keys()]).not.toContain(".package-lock.json");

    await writeFile(join(dir, "node_modules", "zod", "dist", "index.js"), "// tampered\n");
    await writeFile(join(dir, "node_modules", "zod", "extra.js"), "x");
    await rm(join(dir, "node_modules", "@opencode-ai", "plugin", "dist", "index.js"));
    const problems = (await verifyClosureFiles({ closureDir: dir, receipt: accepted })).join("\n");
    expect(problems).toMatch(/changed: zod\/dist\/index\.js/);
    expect(problems).toMatch(/extra: zod\/extra\.js/);
    expect(problems).toMatch(/missing: @opencode-ai\/plugin\/dist\/index\.js/);
    await writeFile(join(dir, "package-lock.json"), "{}");
    expect((await verifyClosureFiles({ closureDir: dir, receipt: accepted })).join("\n")).toMatch(/changed: package-lock\.json/);
    await expect(closureTreeFiles({ closureDir: dir, receipt: accepted })).rejects.toThrow(/closure changed since Gate P/);
  });
});
