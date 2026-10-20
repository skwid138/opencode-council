// Spawns only `node test/real-host/run.mjs` with refusal / --print-plan arguments:
// nothing here can reach docker or curl (and the no-docker guard is active).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";

import { BASE_IMAGE_ID } from "./gates.mjs";
import { encodeFrame } from "./frame.mjs";
import { createProcRunner } from "./proc-runner.mjs";
import { executeGate, parseRunArgs, planGate } from "./run.mjs";
import { tgz } from "./tar-fixture";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "run.mjs");
// Every CLI child carries the tripwire: if any path wrongly reached a real spawn it
// would fail with TRIPWIRE (asserted absent) instead of running docker/curl/npm.
const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 20_000, env: { ...process.env, COUNCIL_RH_FORBID_SPAWN: "1" } });
const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-run-")));
  created.push(dir);
  return dir;
}
const BASE = ["--run-id", "r1", "--session-dir", "/tmp/council-rh-session"];

describe("test:real-host refuses without explicit gate flags and approval", () => {
  it.each([
    [[], /--gate is required/],
    [["--gate", "A", ...BASE], /--approval <reference> is required/],
    [["--gate", "A", "--run-id", "r1", "--approval", "user-msg-1"], /--session-dir must be an absolute path/],
    [["--gate", "Z", ...BASE, "--approval", "user-msg-1"], /unknown gate Z/],
    [["--gate", "D", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--images", "{}"], /--gate-b-receipt must be an absolute path/],
    [["--gate", "D", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/b.json", "--gate-b-approval", "user-msg-b", "--images", JSON.stringify({ "v2-2.0.32": "sha256:" + "4".repeat(64), "v1-1.19.3": "sha256:" + "2".repeat(64) })], /exact image id for v1-1\.18\.29/],
    [["--gate", "D", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/b.json", "--gate-b-approval", "user-msg-b", "--images", JSON.stringify({ "v2-2.0.32": "sha256:" + "4".repeat(64), "v1-1.19.3": "sha256:" + "2".repeat(64), "v1-1.18.29": "sha256:" + "1".repeat(64), "v2-2.0.28": "sha256:" + "3".repeat(64) })], /--archive-sha256/],
    [["--gate", "A", ...BASE, "--approval", "x"], /approval reference/],
    [["--gate", "B", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock"], /--gate-p-receipt must be an absolute path/],
    [["--gate", "B", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-p-receipt", "/tmp/x.json"], /--gate-p-approval/],
    [["--gate", "B", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-p-receipt", "/tmp/x.json", "--gate-p-approval", "user-msg-p"], /--packed-archive must be an absolute path/],
    [["--gate", "P", ...BASE], /--approval <reference> is required/],
    [["--gate", "p", ...BASE, "--approval", "user-msg-1"], /unknown gate p/],
    [["--gate", "C", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/b.json", "--gate-b-approval", "user-msg-b", "--images", JSON.stringify({ "v2-2.0.32": "sha256:" + "4".repeat(64), "v1-1.19.3": "sha256:" + "2".repeat(64) })], /--archive-sha256/],
    [["--gate", "C", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/b.json", "--gate-b-approval", "user-msg-b", "--images", "{}"], /exact image id for v2-2.0.32/],
    [["--gate", "C", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--images", "{}"], /--gate-b-receipt must be an absolute path/],
    [["--gate", "C", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/b.json", "--images", "{}"], /--gate-b-approval/],
    [["--gate", "B", ...BASE, "--approval", "user-msg-1", "--docker", "docker", "--docker-socket", "/var/run/docker.sock"], /--docker must be the absolute path/],
  ])("%j", (args, message) => {
    const result = cli(args as string[]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).not.toMatch(/TRIPWIRE/);
    expect(result.stdout).toBe("");
  });
});

describe("--print-plan shows exact argv and executes nothing", () => {
  it("Gate A: one env -i curl per host", () => {
    const plan = planGate(parseRunArgs(["--gate", "A", ...BASE, "--staging-dir", "/tmp/council-rh-session/staging", "--print-plan"]));
    expect(plan.map((step: { argv: string[] }) => step.argv[2])).toEqual(["/usr/bin/curl", "/usr/bin/curl", "/usr/bin/curl", "/usr/bin/curl"]);
    expect(plan[0].argv.at(-1)).toBe("https://github.com/anomalyco/opencode/releases/download/v1.18.29/opencode-linux-arm64.tar.gz");
    expect(plan[0].argv[plan[0].argv.indexOf("--output") + 1]).toMatch(/^\/tmp\/council-rh-session\/acquire\/v1-1\.18\.29-<random>\.part$/);
  });

  it("Gate B: base inspect, tag-absence inspect, and a COPY-only build per host", () => {
    const plan = planGate(parseRunArgs(["--gate", "B", ...BASE, "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--hosts", "v2-2.0.32", "--gate-p-receipt", "/tmp/council-rh-session/gate-p-r1.json", "--print-plan"]));
    expect(plan.map((step: { label: string }) => step.label)).toEqual(["verify Gate P receipt (no spawn)", "verify Gate A receipt run id (no spawn)", "create fresh Docker CLI dirs (no spawn)", "inspect base image", "require tag absent v2-2.0.32", "build v2-2.0.32"]);
    expect(plan[0]).toEqual({ label: "verify Gate P receipt (no spawn)", receipt: "/tmp/council-rh-session/gate-p-r1.json", checks: "accepted; run id r1; approval == --gate-p-approval; closure re-hashed at context assembly" });
    expect(plan.splice(1, 1)[0]).toEqual({ label: "verify Gate A receipt run id (no spawn)", receipt: null, checks: "run id == r1 (missing / other -> refused before any docker call); accepted status checked before the first build" });
    expect(plan[1]).toEqual({ label: "create fresh Docker CLI dirs (no spawn)", paths: ["/tmp/council-rh-session/docker-config-b", "/tmp/council-rh-session/docker-home-b"], checks: "refuse if either exists (any type, incl. symlink); mkdir 0700 exclusively; verified empty real dirs right before the first docker call" });
    expect(plan[2].argv).toEqual(["/usr/local/bin/docker", "image", "inspect", "sha256:422aa978464c78bd78bea13d66d189eecbb72954b264b6f89167d39c9715fdcd"]);
    expect(plan[3].argv).toEqual(["/usr/local/bin/docker", "image", "inspect", "local/council-rh:v2-2.0.32-r1"]);
    expect(plan[3].absentOnlyIf).toBe('exit 1, stdout "" or "[]", stderr exactly "Error response from daemon: No such image: local/council-rh:v2-2.0.32-r1" (or "Error: No such image: ..."); anything else -> STOP with a failure receipt');
    expect(plan[4].argv.slice(0, 6)).toEqual(["/usr/local/bin/docker", "build", "--network", "none", "--pull=false", "--no-cache"]);
    expect(plan[4].env).toEqual({ DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONFIG: "/tmp/council-rh-session/docker-config-b", HOME: "/tmp/council-rh-session/docker-home-b", PATH: "/usr/bin:/bin", LANG: "C" });
  });

  it("Gate C: Gate B receipt + image verification, then probes and the four spike cells, attached, under the run contract", () => {
    const images = JSON.stringify({ "v2-2.0.32": "sha256:" + "4".repeat(64), "v1-1.19.3": "sha256:" + "2".repeat(64) });
    const plan = planGate(parseRunArgs(["--gate", "C", ...BASE, "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/council-rh-session/gate-b-r1.json", "--images", images, "--print-plan"]));
    expect(plan.slice(0, 4).map((step: { label: string }) => step.label)).toEqual(["verify Gate B receipt (no spawn)", "create fresh Docker CLI dirs (no spawn)", "verify image v2-2.0.32", "verify image v1-1.19.3"]);
    expect(plan[0]).toEqual({ label: "verify Gate B receipt (no spawn)", receipt: "/tmp/council-rh-session/gate-b-r1.json", checks: "accepted; run id r1; approval == --gate-b-approval; image ids == --images; archive sha256 == --archive-sha256" });
    expect(plan[2].argv).toEqual(["/usr/local/bin/docker", "image", "inspect", "sha256:" + "4".repeat(64)]);
    expect(plan[2].checks).toBe("Id == image id; labels council-rh.owner == r1, council-rh.host == v2-2.0.32, council-rh.archive-sha256 and council-rh.image-manifest-sha256 == Gate B receipt");
    const cells = plan.slice(4);
    expect(cells.map((step: { argv: string[] }) => step.argv.at(-1))).toEqual(["v2-2.0.32:probe:1", "v1-1.19.3:probe:1", "v2-2.0.32:s1:1", "v2-2.0.32:s2:1", "v1-1.19.3:s1:1", "v1-1.19.3:s2:1"]);
    for (const step of cells) {
      expect(step.argv).toContain("--network");
      expect(step.argv[step.argv.indexOf("--entrypoint") + 1]).toBe("/usr/local/bin/node");
      expect(step.argv.at(-2)).toBe("/opt/council-rh/driver.mjs");
      expect(step.env.DOCKER_CONFIG).toBe("/tmp/council-rh-session/docker-config-c");
    }
  });

  it("the CLI prints the plan as JSON on stdout and exits 0 without an approval", () => {
    const result = cli(["--gate", "A", ...BASE, "--staging-dir", "/tmp/council-rh-session/staging", "--print-plan"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(4);
  });
});

describe("Gate P (Amendment A2)", () => {
  it("--print-plan prints the exact npm command, cwd, env, and timeout, and executes nothing", async () => {
    const session = await scratch();
    const result = cli(["--gate", "P", "--run-id", "p1a01", "--session-dir", session, "--print-plan"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/TRIPWIRE/);
    const plan = JSON.parse(result.stdout);
    expect(plan).toEqual([
      { label: "assert npm 11.12.1 (read only)", read: "/Users/hunter/.nvm/versions/node/v24.15.0/lib/node_modules/npm/package.json" },
      { label: "refuse existing closure dir or any .npmrc up to $S", paths: [`${session}/closure`, `${session}/closure/.npmrc`, `${session}/.npmrc`] },
      { label: "write closure package.json", path: `${session}/closure/package.json`, content: '{"private":true,"dependencies":{"@opencode-ai/plugin":"1.19.3"}}\n' },
      {
        label: "create fresh empty npmrc files (no spawn)",
        dir: `${session}/closure-config`,
        paths: [`${session}/closure-config/npmrc-user`, `${session}/closure-config/npmrc-global`],
        checks: "refuse if closure-config exists (any type, incl. symlink); dir 0700; each file exclusive create 0600, empty; verified empty regular files (no symlink) just before the spawn",
      },
      {
        label: "npm install (Gate P; host-side registry acquisition)",
        cwd: `${session}/closure`,
        env: { PATH: "/usr/bin:/bin", HOME: `${session}/closure-home`, npm_config_cache: `${session}/closure-cache`, npm_config_userconfig: `${session}/closure-config/npmrc-user`, npm_config_globalconfig: `${session}/closure-config/npmrc-global` },
        timeoutMs: 300000,
        authorization: "pacote's single built-in re-download per tarball, from the same resolved registry URL, ONLY after EINTEGRITY/Z_DATA_ERROR/ENOENT/EISDIR; everything else single-attempt; Gate A no-retry unchanged",
        argv: ["/Users/hunter/.nvm/versions/node/v24.15.0/bin/node", "/Users/hunter/.nvm/versions/node/v24.15.0/lib/node_modules/npm/bin/npm-cli.js", "install", "--ignore-scripts", "--no-bin-links", "--fetch-retries=0", "--no-audit", "--no-fund", "--os=linux", "--cpu=arm64", "--libc=glibc", "--registry=https://registry.npmjs.org/"],
      },
      { label: "inspect closure and write receipt", receipt: `${session}/gate-p-p1a01.json` },
    ]);
    expect(await readdir(session)).toEqual([]);
  });

  it("an approved Gate P reaches the acquisition spawn only through the runner (tripwire fires; no real npm)", async () => {
    const session = await scratch();
    const previous = process.env.COUNCIL_RH_FORBID_SPAWN;
    process.env.COUNCIL_RH_FORBID_SPAWN = "1";
    const reads: string[] = [];
    try {
      // The npm-version reader is injected: no dependency on a machine-local npm install (CI is Ubuntu).
      const readNpmVersion = async (cliPath: string) => (reads.push(cliPath), "11.12.1");
      await expect(executeGate(parseRunArgs(["--gate", "P", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-p"]), { readNpmVersion, proc: fakeProc() })).rejects.toThrow(/TRIPWIRE: spawn refused/);
      expect(reads).toEqual(["/Users/hunter/.nvm/versions/node/v24.15.0/lib/node_modules/npm/bin/npm-cli.js"]);
    } finally {
      if (previous === undefined) delete process.env.COUNCIL_RH_FORBID_SPAWN;
      else process.env.COUNCIL_RH_FORBID_SPAWN = previous;
    }
    expect((await readdir(session)).sort()).toEqual(["closure", "closure-cache", "closure-config", "closure-home"]);
  });
});

describe("Gate B refuses without an accepted Gate P receipt, before any docker call", () => {
  const gateB = (session: string, receipt: string) =>
    parseRunArgs(["--gate", "B", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-b", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-p-receipt", receipt, "--gate-p-approval", "user-msg-p", "--packed-archive", "/tmp/x.tgz", "--packed-sha256", "a".repeat(64), "--gate-a-receipts", "/tmp/gate-a.json"]);
  const tripwired = async (fn: () => Promise<unknown>) => {
    const previous = process.env.COUNCIL_RH_FORBID_SPAWN;
    process.env.COUNCIL_RH_FORBID_SPAWN = "1";
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.COUNCIL_RH_FORBID_SPAWN;
      else process.env.COUNCIL_RH_FORBID_SPAWN = previous;
    }
  };
  const receipt = { schema: "council-rh-closure/1", status: "accepted", receiptId: "closure-p1a01-abc", runId: "p1a01", approval: "user-msg-p", lockfileSha256: "a".repeat(64), files: [], problems: [] };

  it.each([
    ["a missing receipt", null, /Gate P receipt is missing/],
    ["a rejected receipt", { ...receipt, status: "rejected" }, /rejected/],
    ["a run-id mismatch", { ...receipt, runId: "other" }, /run id other != p1a01/],
    ["an approval mismatch", { ...receipt, approval: "user-msg-x" }, /approval user-msg-x != user-msg-p/],
  ])("%s", async (_label, content, message) => {
    const session = await scratch();
    const path = join(session, "gate-p.json");
    if (content) await writeFile(path, JSON.stringify(content));
    const error = await tripwired(() => executeGate(gateB(session, path), { proc: fakeProc() }).then(() => null, (caught: Error) => caught));
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toMatch(/TRIPWIRE/);
  });
});

// ---------------------------------------------------------------------------
// Executed gates with INJECTED runners only (never a real docker/npm/curl).

/** Fake process for signal handlers: records exit codes; `emit("SIGINT")` simulates the operator. */
function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & { exits: number[]; exit: (code: number) => void };
  proc.exits = [];
  proc.exit = (code: number) => void proc.exits.push(code);
  return proc;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const okRun = (stdout = "") => ({ status: 0, stdout, stderr: "", timedOut: false });
const baseInspect = () => okRun(JSON.stringify([{ Id: BASE_IMAGE_ID, Os: "linux", Architecture: "arm64", Config: { OnBuild: null, Volumes: null } }]));
const noSuchImage = (ref: string) => ({ status: 1, stdout: "[]\n", stderr: `Error response from daemon: No such image: ${ref}\n`, timedOut: false });
const P_RECEIPT = { schema: "council-rh-closure/1", status: "accepted", receiptId: "closure-p1a01-abc", runId: "p1a01", approval: "user-msg-p", lockfileSha256: "a".repeat(64), files: [], problems: [] };

/** A Gate B session: accepted Gate P receipt, Gate A receipt for v2-2.0.32, packed archive. */
async function gateBSession() {
  const session = await scratch();
  const inputs = await scratch();
  await writeFile(join(session, "gate-p-p1a01.json"), JSON.stringify(P_RECEIPT));
  const exe = Buffer.from("#!/bin/sh\necho 2.0.32\n");
  await writeFile(join(inputs, "opencode-2.0.32"), exe, { mode: 0o755 });
  const archive = tgz([{ name: "package/package.json", data: JSON.stringify({ name: "@skwid138/opencode-council", version: "0.3.0" }) }, { name: "package/dist/index.js", data: "export default {};\n" }]);
  await writeFile(join(inputs, "council.tgz"), archive);
  await writeFile(join(inputs, "gate-a.json"), JSON.stringify({ status: "accepted", runId: "p1a01", receipts: [{ hostId: "v2-2.0.32", url: "https://x", archive: { sha256: "c".repeat(64) }, member: "package/bin/opencode", executable: { path: join(inputs, "opencode-2.0.32"), sha256: sha256(exe) } }] }));
  const options = parseRunArgs(["--gate", "B", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-b", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-p-receipt", join(session, "gate-p-p1a01.json"), "--gate-p-approval", "user-msg-p", "--packed-archive", join(inputs, "council.tgz"), "--packed-sha256", sha256(archive), "--gate-a-receipts", join(inputs, "gate-a.json"), "--hosts", "v2-2.0.32"]);
  return { session, options, archiveSha256: sha256(archive) };
}

/** Fake docker runner for Gate B: base inspect ok, tag check answered by `tag`, build writes an iidfile. */
function gateBRunner(tag: (ref: string) => unknown, log: string[]) {
  return {
    killAttached: () => 0,
    async run(argv: string[], options: { timeoutMs: number }) {
      log.push(argv.slice(1, 3).join(" ") + " " + argv.at(argv[1] === "build" ? -1 : 3));
      if (argv[1] === "image" && argv[3] === BASE_IMAGE_ID) return baseInspect();
      if (argv[1] === "image") return tag(argv[3]);
      if (argv[1] === "build") {
        expect(options.timeoutMs).toBe(300_000);
        await writeFile(argv[argv.indexOf("--iidfile") + 1], "sha256:" + "4".repeat(64) + "\n");
        return okRun();
      }
      throw new Error(`unexpected docker call ${argv.join(" ")}`);
    },
  };
}

describe("Gate B executed with an injected runner", () => {
  it("builds after a definitive tag absence and writes an accepted receipt with image ids, archive, and image-manifest digests", async () => {
    const { session, options, archiveSha256 } = await gateBSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateBRunner(noSuchImage, log), proc: fakeProc() });
    expect(code).toBe(0);
    expect(log).toEqual([`image inspect ${BASE_IMAGE_ID}`, "image inspect local/council-rh:v2-2.0.32-p1a01", `build --network ${session}/context-v2-2.0.32`]);
    const receipt = JSON.parse(await readFile(join(session, "gate-b-p1a01.json"), "utf8"));
    const manifest = await readFile(join(session, "context-v2-2.0.32", "meta", "image-manifest.json"));
    expect(receipt).toEqual({
      schema: "council-rh-gate-b/1",
      status: "accepted",
      runId: "p1a01",
      approval: "user-msg-b",
      gatePReceiptId: "closure-p1a01-abc",
      archiveSha256,
      images: { "v2-2.0.32": "sha256:" + "4".repeat(64) },
      contexts: { "v2-2.0.32": { manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/), imageManifestSha256: sha256(manifest) } },
    });
  });

  it.each([
    ["the tag already exists", () => okRun("[{}]"), /already exists/],
    ["the tag check timed out", () => ({ status: null, stdout: "", stderr: "", timedOut: true }), /timed out/],
    ["a null status", () => ({ status: null, stdout: "", stderr: "", timedOut: false }), /status null/],
    ["a daemon error", () => ({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n", timedOut: false }), /not a definitive "No such image"/],
    ["a permission error", () => ({ status: 1, stdout: "", stderr: "permission denied while trying to connect to the Docker daemon socket\n", timedOut: false }), /not a definitive/],
    ["other output", () => ({ status: 1, stdout: "noise\n", stderr: "Error response from daemon: No such image: local/council-rh:v2-2.0.32-p1a01\n", timedOut: false }), /not a definitive/],
  ])("STOPs with a failure receipt (no build) when %s", async (_label, tag, message) => {
    const { session, options } = await gateBSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateBRunner(tag, log), proc: fakeProc() });
    expect(code).toBe(1);
    expect(log.some((entry) => entry.startsWith("build"))).toBe(false);
    const receipt = JSON.parse(await readFile(join(session, "gate-b-p1a01.json"), "utf8"));
    expect(receipt).toMatchObject({ schema: "council-rh-gate-b/1", status: "failed", runId: "p1a01", stage: "tag-absence v2-2.0.32" });
    expect(receipt.problem).toMatch(message);
  });

  it("refuses an existing docker-config-b / docker-home-b before any docker call", async () => {
    for (const name of ["docker-config-b", "docker-home-b"]) {
      const { session, options } = await gateBSession();
      await mkdir(join(session, name));
      const log: string[] = [];
      await expect(executeGate(options, { createRunner: () => gateBRunner(noSuchImage, log), proc: fakeProc() })).rejects.toThrow(new RegExp(`${name} already exists`));
      expect(log).toEqual([]);
    }
  });

  it("verifies the fresh Docker dirs are still empty right before the first docker call", async () => {
    const { session, options } = await gateBSession();
    const log: string[] = [];
    const createRunner = () => {
      // Something writes into DOCKER_CONFIG between creation and the first call.
      writeFileSync(join(session, "docker-config-b", "config.json"), "{}");
      return gateBRunner(noSuchImage, log);
    };
    await expect(executeGate(options, { createRunner, proc: fakeProc() })).rejects.toThrow(/docker-config-b must be empty before the first docker call/);
    expect(log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gate C

const SPIKE_IMAGES = { "v2-2.0.32": "sha256:" + "4".repeat(64), "v1-1.19.3": "sha256:" + "2".repeat(64) };
const ARCHIVE = "e".repeat(64);
const B_RECEIPT = {
  schema: "council-rh-gate-b/1",
  status: "accepted",
  runId: "p1a01",
  approval: "user-msg-b",
  gatePReceiptId: "closure-p1a01-abc",
  archiveSha256: ARCHIVE,
  images: { ...SPIKE_IMAGES },
  contexts: { "v2-2.0.32": { manifestSha256: "1".repeat(64), imageManifestSha256: "7".repeat(64) }, "v1-1.19.3": { manifestSha256: "2".repeat(64), imageManifestSha256: "8".repeat(64) } },
};

async function gateCSession(receipt: unknown = B_RECEIPT, extra: string[] = []) {
  const session = await scratch();
  const path = join(session, "gate-b-p1a01.json");
  if (receipt) await writeFile(path, JSON.stringify(receipt));
  const options = parseRunArgs(["--gate", "C", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-c", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", path, "--gate-b-approval", "user-msg-b", "--images", JSON.stringify(SPIKE_IMAGES), "--archive-sha256", ARCHIVE, ...extra]);
  return { session, options };
}

const builtImage = (host: string, labels: Record<string, string> = {}) =>
  okRun(JSON.stringify([{ Id: SPIKE_IMAGES[host as keyof typeof SPIKE_IMAGES], Config: { Labels: { "council-rh.owner": "p1a01", "council-rh.host": host, "council-rh.archive-sha256": ARCHIVE, "council-rh.image-manifest-sha256": B_RECEIPT.contexts[host as keyof typeof B_RECEIPT.contexts].imageManifestSha256, ...labels } } }]));
const passFrame = (cellId: string) => encodeFrame({ schema: "council-rh-result/1", cellId, verdict: "PASS", checks: [{ id: "x", ok: true, detail: "" }], host: { id: cellId.split(":")[0], executableSha256: "a".repeat(64) }, durationMs: 1 });

/** Fake docker runner for Gate C. `attached(argv, signal)` answers docker run. */
function gateCRunner(log: string[], { inspect = (host: string) => builtImage(host), attached = async (argv: string[]) => ({ exitCode: 0, signal: null, stdout: passFrame(argv.at(-1) as string), stderr: "", timedOut: false, capExceeded: null, cancelled: false }) as unknown, rm = (_cid?: string): unknown => undefined, ps = () => {} } = {}) {
  const hostOf = (id: string) => Object.entries(SPIKE_IMAGES).find(([, image]) => image === id)?.[0] as string;
  let killed = 0;
  return {
    killAttached: () => ((killed += 1), 0),
    killedCount: () => killed,
    async run(argv: string[]) {
      if (argv[1] === "image") {
        log.push(`inspect ${hostOf(argv[3])}`);
        return inspect(hostOf(argv[3]));
      }
      if (argv[1] === "rm") return (log.push(`rm ${argv[3]}`), (rm(argv[3]) as unknown) ?? okRun());
      if (argv[1] === "ps") return (log.push("ps"), ps(), okRun(""));
      throw new Error(`unexpected docker call ${argv.join(" ")}`);
    },
    async runAttached(argv: string[], options: { signal?: AbortSignal }) {
      log.push(`run ${argv.at(-1)}`);
      expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("/usr/local/bin/node");
      expect(argv.at(-2)).toBe("/opt/council-rh/driver.mjs");
      await writeFile(argv[argv.indexOf("--cidfile") + 1], `cid-${argv.at(-1)}`);
      return attached(argv, options.signal);
    },
  };
}

describe("Gate C requires the Gate B receipt and verifies the built images before any docker run", () => {
  it.each([
    ["a missing receipt", null, /Gate B receipt is missing/],
    ["a failed receipt", { ...B_RECEIPT, status: "failed" }, /Gate B receipt is failed/],
    ["a run-id mismatch", { ...B_RECEIPT, runId: "other" }, /run id other != p1a01/],
    ["an approval mismatch", { ...B_RECEIPT, approval: "user-msg-x" }, /approval user-msg-x != user-msg-b/],
    ["an image id mismatch", { ...B_RECEIPT, images: { ...SPIKE_IMAGES, "v1-1.19.3": "sha256:" + "9".repeat(64) } }, /image for v1-1\.19\.3/],
    ["an archive mismatch", { ...B_RECEIPT, archiveSha256: "f".repeat(64) }, /archive sha256/],
    ["a missing image-manifest digest", { ...B_RECEIPT, contexts: {} }, /image-manifest sha256 for v2-2\.0\.32/],
  ])("refuses %s (no docker call)", async (_label, receipt, message) => {
    const { session, options } = await gateCSession(receipt);
    const log: string[] = [];
    await expect(executeGate(options, { createRunner: () => gateCRunner(log), proc: fakeProc() })).rejects.toThrow(message);
    expect(log).toEqual([]);
    expect(existsSync(join(session, "docker-config-c"))).toBe(false);
  });

  it.each([
    ["a foreign owner label", { "council-rh.owner": "someone-else" }, /council-rh\.owner/],
    ["another image-manifest digest", { "council-rh.image-manifest-sha256": "0".repeat(64) }, /council-rh\.image-manifest-sha256/],
    ["another archive digest", { "council-rh.archive-sha256": "0".repeat(64) }, /council-rh\.archive-sha256/],
  ])("STOPs with a failure receipt (no docker run) on %s", async (_label, labels, message) => {
    const { session, options } = await gateCSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateCRunner(log, { inspect: (host: string) => builtImage(host, host === "v1-1.19.3" ? labels : {}) }), proc: fakeProc() });
    expect(code).toBe(1);
    expect(log).toEqual(["inspect v2-2.0.32", "inspect v1-1.19.3"]);
    const receipt = JSON.parse(await readFile(join(session, "gate-c-p1a01.json"), "utf8"));
    expect(receipt).toMatchObject({ status: "failed", stage: "verify image v1-1.19.3" });
    expect(receipt.problem).toMatch(message);
  });

  it("runs probes then spike cells with the explicit entrypoint after both images verified", async () => {
    const { session, options } = await gateCSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateCRunner(log), proc: fakeProc() });
    expect(code).toBe(0);
    expect(log.filter((entry) => !entry.startsWith("rm") && entry !== "ps")).toEqual(["inspect v2-2.0.32", "inspect v1-1.19.3", "run v2-2.0.32:probe:1", "run v1-1.19.3:probe:1", "run v2-2.0.32:s1:1", "run v2-2.0.32:s2:1", "run v1-1.19.3:s1:1", "run v1-1.19.3:s2:1"]);
    expect(JSON.parse(await readFile(join(session, "gate-c-spike-p1a01.json"), "utf8")).status).toBe("completed");
  });
});

describe("operator termination is wired into run.mjs (signals.mjs) and the controller", () => {
  it("first SIGINT: stops launching, kills the attached client, removes the owned container by id, writes a cancelled receipt, exits 130", async () => {
    const { session, options } = await gateCSession();
    const log: string[] = [];
    const proc = fakeProc();
    let runner: ReturnType<typeof gateCRunner> | null = null;
    const attached = (_argv: string[], signal?: AbortSignal) =>
      new Promise((resolve) => {
        setTimeout(() => proc.emit("SIGINT", "SIGINT"), 5);
        signal?.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: false, capExceeded: null, cancelled: true }), { once: true });
      });
    const code = await executeGate(options, { createRunner: () => (runner = gateCRunner(log, { attached })), proc });
    expect(code).toBe(130);
    expect(proc.exits).toEqual([]);
    expect(log.filter((entry) => entry.startsWith("run "))).toEqual(["run v2-2.0.32:probe:1"]);
    expect(log.slice(-2)).toEqual(["rm cid-v2-2.0.32:probe:1", "ps"]);
    expect(runner!.killedCount()).toBe(1);
    const cancelled = JSON.parse(await readFile(join(session, "gate-c-cancelled-p1a01.json"), "utf8"));
    expect(cancelled).toMatchObject({ status: "cancelled", gate: "C", runId: "p1a01", signals: 1, cleanupConfirmed: true, cellId: "v2-2.0.32:probe:1", cleanupScope: "original-process-group+owned-container" });
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  it("a first signal during the spike batch (after probes passed) also writes the cancelled receipt and exits 130", async () => {
    const { session, options } = await gateCSession();
    const log: string[] = [];
    const proc = fakeProc();
    const attached = (argv: string[], signal?: AbortSignal) => {
      const cellId = argv.at(-1) as string;
      if (cellId.includes(":probe:")) return Promise.resolve({ exitCode: 0, signal: null, stdout: passFrame(cellId), stderr: "", timedOut: false, capExceeded: null, cancelled: false });
      return new Promise((resolve) => {
        setTimeout(() => proc.emit("SIGTERM", "SIGTERM"), 5);
        signal?.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: false, capExceeded: null, cancelled: true }), { once: true });
      });
    };
    const code = await executeGate(options, { createRunner: () => gateCRunner(log, { attached }), proc });
    expect(code).toBe(130);
    expect(log.filter((entry) => entry.startsWith("run "))).toEqual(["run v2-2.0.32:probe:1", "run v1-1.19.3:probe:1", "run v2-2.0.32:s1:1"]);
    expect(JSON.parse(await readFile(join(session, "gate-c-cancelled-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", cellId: "v2-2.0.32:s1:1", cleanupConfirmed: true });
    expect(existsSync(join(session, "gate-c-spike-p1a01.json"))).toBe(false);
  });

  it("second signal: exits immediately (130) and records cleanup as unconfirmed", async () => {
    const { session, options } = await gateCSession();
    const log: string[] = [];
    const proc = fakeProc();
    let release: (value: unknown) => void = () => {};
    // The client ignores the kill (worst case): only a second signal gets the operator out.
    const attached = () =>
      new Promise((resolve) => {
        release = resolve;
        setTimeout(() => proc.emit("SIGTERM", "SIGTERM"), 5);
        setTimeout(() => proc.emit("SIGINT", "SIGINT"), 15);
      });
    const pending = executeGate(options, { createRunner: () => gateCRunner(log, { attached }), proc });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(proc.exits).toEqual([130]);
    const record = JSON.parse(await readFile(join(session, "gate-c-cancelled-p1a01.json"), "utf8"));
    expect(record).toMatchObject({ status: "cancelled", gate: "C", signals: 2, cleanupConfirmed: false, cleanupScope: "original-process-group+owned-container" });
    expect(record.detail).toMatch(/second signal/);
    release({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: false, capExceeded: null, cancelled: true });
    await pending.catch(() => null);
  });
});

// ---------------------------------------------------------------------------
// Round 2: cancellation of non-attached commands and re-checks after cleanup.

/** A runner whose run() executes a real NODE sleeper (never npm/curl/docker) under the real proc-runner, honoring the signal. */
function nodeSleeperRunner(seen: unknown[]) {
  return (env: Record<string, string>) => {
    const real = createProcRunner({ env, killGraceMs: 300 });
    return {
      killAttached: () => 0,
      run: async (argv: string[], options: Record<string, unknown>) => {
        seen.push({ argv0: argv[0], hasSignal: options.signal instanceof AbortSignal });
        const result = await real.run([process.execPath, "-e", "process.stdout.write('started');setInterval(() => {}, 1000)"], { ...options, env: { PATH: "/usr/bin:/bin" } } as never);
        seen.push(result);
        return result;
      },
    };
  };
}

describe("Gate P / Gate A: an operator signal kills the running (node) child and never yields an accepted receipt", () => {
  it("Gate P: SIGINT while the install command runs -> SIGTERM'd, cancelled receipt, exit 130", async () => {
    const session = await scratch();
    const proc = fakeProc();
    const seen: unknown[] = [];
    setTimeout(() => proc.emit("SIGINT", "SIGINT"), 150);
    const code = await executeGate(parseRunArgs(["--gate", "P", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-p"]), { createRunner: nodeSleeperRunner(seen), readNpmVersion: async () => "11.12.1", proc });
    expect(code).toBe(130);
    expect(seen[0]).toEqual({ argv0: "/Users/hunter/.nvm/versions/node/v24.15.0/bin/node", hasSignal: true });
    expect(seen[1]).toMatchObject({ status: null, cancelled: true, signal: "SIGTERM", stdout: "started" });
    expect(JSON.parse(await readFile(join(session, "gate-p-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", stage: "npm install" });
    expect(JSON.parse(await readFile(join(session, "gate-p-cancelled-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", gate: "P", cleanupConfirmed: true });
  });

  it("Gate P: SIGINT during preparation -> nothing is spawned, cancelled receipt, exit 130", async () => {
    const session = await scratch();
    const proc = fakeProc();
    const seen: unknown[] = [];
    const code = await executeGate(parseRunArgs(["--gate", "P", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-p"]), { createRunner: nodeSleeperRunner(seen), readNpmVersion: async () => (proc.emit("SIGINT", "SIGINT"), "11.12.1"), proc });
    expect(code).toBe(130);
    expect(seen).toEqual([]);
    expect(JSON.parse(await readFile(join(session, "gate-p-p1a01.json"), "utf8")).status).toBe("cancelled");
  });

  it("Gate A: SIGINT while the download command runs -> killed, .part removed, gate-a receipt is cancelled (not accepted), exit 130", async () => {
    const session = await scratch();
    const staging = join(session, "staging");
    const proc = fakeProc();
    const seen: unknown[] = [];
    setTimeout(() => proc.emit("SIGINT", "SIGINT"), 150);
    const code = await executeGate(parseRunArgs(["--gate", "A", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-a", "--staging-dir", staging, "--hosts", "v2-2.0.32"]), { createRunner: nodeSleeperRunner(seen), proc });
    expect(code).toBe(130);
    expect(seen[0]).toEqual({ argv0: "/usr/bin/env", hasSignal: true });
    expect(seen[1]).toMatchObject({ status: null, cancelled: true, signal: "SIGTERM" });
    expect(JSON.parse(await readFile(join(session, "gate-a-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", receipts: [] });
    expect(await readdir(join(session, "acquire"))).toEqual([]);
    expect(await readdir(staging)).toEqual([]);
  });
});

describe("Gate B / Gate C: the signal is checked before every docker spawn", () => {
  it("Gate B: SIGINT during the base inspect -> no further docker call, cancelled receipts (cleanup confirmed: no build started), exit 130", async () => {
    const { session, options } = await gateBSession();
    const proc = fakeProc();
    const log: string[] = [];
    const runner = gateBRunner(noSuchImage, log);
    const original = runner.run.bind(runner);
    runner.run = async (argv: string[], opts: { timeoutMs: number }) => {
      if (argv[3] === BASE_IMAGE_ID) proc.emit("SIGINT", "SIGINT");
      return original(argv, opts);
    };
    const code = await executeGate(options, { createRunner: () => runner, proc });
    expect(code).toBe(130);
    expect(log).toEqual([`image inspect ${BASE_IMAGE_ID}`]);
    expect(JSON.parse(await readFile(join(session, "gate-b-p1a01.json"), "utf8")).status).toBe("cancelled");
    expect(JSON.parse(await readFile(join(session, "gate-b-cancelled-p1a01.json"), "utf8"))).toMatchObject({ cleanupConfirmed: true });
  });

  it("Gate B: SIGINT during a build -> cleanup NOT confirmed (an owned image may exist), exit 130", async () => {
    const { session, options } = await gateBSession();
    const proc = fakeProc();
    const log: string[] = [];
    const runner = gateBRunner(noSuchImage, log);
    const original = runner.run.bind(runner);
    runner.run = async (argv: string[], opts: { timeoutMs: number }) => {
      if (argv[1] === "build") proc.emit("SIGINT", "SIGINT");
      return original(argv, opts);
    };
    expect(await executeGate(options, { createRunner: () => runner, proc })).toBe(130);
    expect(JSON.parse(await readFile(join(session, "gate-b-cancelled-p1a01.json"), "utf8"))).toMatchObject({ cleanupConfirmed: false });
    expect(JSON.parse(await readFile(join(session, "gate-b-p1a01.json"), "utf8")).status).toBe("cancelled");
  });

  it("Gate B refuses a Gate A receipt that is not accepted", async () => {
    const { session, options } = await gateBSession();
    await writeFile(options.gateAReceipts, JSON.stringify({ status: "cancelled", runId: "p1a01", receipts: [] }));
    expect(await executeGate(options, { createRunner: () => gateBRunner(noSuchImage, []), proc: fakeProc() })).toBe(1);
    expect(JSON.parse(await readFile(join(session, "gate-b-p1a01.json"), "utf8"))).toMatchObject({ status: "failed", stage: "gate A receipts" });
  });

  it("Gate C: SIGINT during image verification -> no docker run, exit 130", async () => {
    const { session, options } = await gateCSession();
    const proc = fakeProc();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateCRunner(log, { inspect: (host: string) => (proc.emit("SIGINT", "SIGINT"), builtImage(host)) }), proc });
    expect(code).toBe(130);
    expect(log).toEqual(["inspect v2-2.0.32"]);
    expect(JSON.parse(await readFile(join(session, "gate-c-cancelled-p1a01.json"), "utf8"))).toMatchObject({ cleanupConfirmed: true });
  });
});

describe("Gate C: a signal during cleanup or the result write still cancels (exit 130), never 'completed'", () => {
  it.each([
    ["the container removal", "rm"],
    ["the absence check", "ps"],
  ])("during %s", async (_label, where) => {
    const { session, options } = await gateCSession();
    const proc = fakeProc();
    const log: string[] = [];
    let fired = false;
    const hook = () => {
      if (!fired) proc.emit("SIGINT", "SIGINT");
      fired = true;
    };
    const code = await executeGate(options, { createRunner: () => gateCRunner(log, where === "rm" ? { rm: hook } : { ps: hook }), proc });
    expect(code).toBe(130);
    expect(log.filter((entry) => entry.startsWith("run "))).toEqual(["run v2-2.0.32:probe:1"]);
    expect(JSON.parse(await readFile(join(session, "gate-c-cancelled-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", cellId: "v2-2.0.32:probe:1", cleanupConfirmed: true });
    expect(existsSync(join(session, "gate-c-probes-p1a01.json"))).toBe(false);
  });

  it("during the final result write of the last spike cell", async () => {
    const { session, options } = await gateCSession();
    const proc = fakeProc();
    const log: string[] = [];
    const writeCellRecord = async (path: string, text: string) => {
      if (path.endsWith("v1-1.19.3_s2_1.json")) proc.emit("SIGINT", "SIGINT");
      await writeFile(path, text, { flag: "wx", mode: 0o600 });
    };
    const code = await executeGate(options, { createRunner: () => gateCRunner(log), proc, writeCellRecord });
    expect(code).toBe(130);
    expect(JSON.parse(await readFile(join(session, "gate-c-cancelled-p1a01.json"), "utf8"))).toMatchObject({ cellId: "v1-1.19.3:s2:1", cleanupConfirmed: true });
    expect(existsSync(join(session, "gate-c-spike-p1a01.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round 3: cancellation during the FINAL receipt write; handlers before any preparation.

/** Receipt hooks: fire the operator signal while `target` is being written (before its temp file exists). */
function signallingHooks(proc: EventEmitter, target: string) {
  return { beforeWrite: (path: string) => void (path.endsWith(target) && proc.emit("SIGINT", "SIGINT")) };
}

async function fakeClosureInstall(cwd: string) {
  const lock = { "": { dependencies: { "@opencode-ai/plugin": "1.19.3" } }, "node_modules/@opencode-ai/plugin": { version: "1.19.3", resolved: "https://registry.npmjs.org/@opencode-ai/plugin/-/plugin-1.19.3.tgz", integrity: "sha512-x" } };
  await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: lock }));
  await mkdir(join(cwd, "node_modules", "@opencode-ai", "plugin"), { recursive: true });
  await writeFile(join(cwd, "node_modules", "@opencode-ai", "plugin", "package.json"), JSON.stringify({ name: "@opencode-ai/plugin", version: "1.19.3" }));
}

describe("a signal during each gate's FINAL receipt write: exit 130, the receipt is never left accepted, the next gate refuses it", () => {
  it("Gate A -> Gate B refuses the cancelled Gate A receipt", async () => {
    const session = await scratch();
    const proc = fakeProc();
    const acquireHost = async ({ hostId }: { hostId: string }) => ({ hostId, url: "https://x", archive: { sha256: "c".repeat(64) }, member: "m", executable: { path: "/x", sha256: "d".repeat(64) } });
    const code = await executeGate(parseRunArgs(["--gate", "A", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-a", "--staging-dir", join(session, "staging"), "--hosts", "v2-2.0.32"]), { createRunner: () => ({ run: async () => okRun(), killAttached: () => 0 }), acquireHost, receiptHooks: signallingHooks(proc, "gate-a-p1a01.json"), proc });
    expect(code).toBe(130);
    const gateA = JSON.parse(await readFile(join(session, "gate-a-p1a01.json"), "utf8"));
    expect(gateA.status).toBe("cancelled");
    const { session: bSession, options } = await gateBSession();
    options.gateAReceipts = join(session, "gate-a-p1a01.json");
    expect(await executeGate(options, { createRunner: () => gateBRunner(noSuchImage, []), proc: fakeProc() })).toBe(1);
    expect(JSON.parse(await readFile(join(bSession, "gate-b-p1a01.json"), "utf8"))).toMatchObject({ status: "failed", stage: "gate A receipts" });
  });

  it("Gate P -> Gate B refuses the cancelled Gate P receipt", async () => {
    const session = await scratch();
    const proc = fakeProc();
    const createRunner = () => ({ killAttached: () => 0, run: async (_argv: string[], opts: { cwd: string }) => (await fakeClosureInstall(opts.cwd), okRun()) });
    const code = await executeGate(parseRunArgs(["--gate", "P", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-p"]), { createRunner, readNpmVersion: async () => "11.12.1", receiptHooks: signallingHooks(proc, "gate-p-p1a01.json"), proc });
    expect(code).toBe(130);
    const receipt = JSON.parse(await readFile(join(session, "gate-p-p1a01.json"), "utf8"));
    expect(receipt.status).toBe("cancelled");
    const gateB = parseRunArgs(["--gate", "B", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-b", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-p-receipt", join(session, "gate-p-p1a01.json"), "--gate-p-approval", "user-msg-p", "--packed-archive", "/tmp/x.tgz", "--packed-sha256", "a".repeat(64), "--gate-a-receipts", "/tmp/gate-a.json"]);
    await expect(executeGate(gateB, { createRunner: () => gateBRunner(noSuchImage, []), proc: fakeProc() })).rejects.toThrow(/Gate P receipt is cancelled/);
  });

  it("Gate B -> Gate C refuses the cancelled Gate B receipt", async () => {
    const { session, options } = await gateBSession();
    const proc = fakeProc();
    const code = await executeGate(options, { createRunner: () => gateBRunner(noSuchImage, []), receiptHooks: signallingHooks(proc, "gate-b-p1a01.json"), proc });
    expect(code).toBe(130);
    const receipt = JSON.parse(await readFile(join(session, "gate-b-p1a01.json"), "utf8"));
    expect(receipt.status).toBe("cancelled");
    const gateC = parseRunArgs(["--gate", "C", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-c", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", join(session, "gate-b-p1a01.json"), "--gate-b-approval", "user-msg-b", "--images", JSON.stringify(SPIKE_IMAGES), "--archive-sha256", "e".repeat(64)]);
    await expect(executeGate(gateC, { createRunner: () => gateCRunner([]), proc: fakeProc() })).rejects.toThrow(/Gate B receipt is cancelled/);
  });

  it("Gate C: the spike record written as completed is marked cancelled; exit 130", async () => {
    const { session, options } = await gateCSession();
    const proc = fakeProc();
    const code = await executeGate(options, { createRunner: () => gateCRunner([]), receiptHooks: signallingHooks(proc, "gate-c-spike-p1a01.json"), proc });
    expect(code).toBe(130);
    // The spike record (status completed) is never published after the signal: absent, or cancelled.
    const spikePath = join(session, "gate-c-spike-p1a01.json");
    expect(existsSync(spikePath) ? JSON.parse(await readFile(spikePath, "utf8")).status : "absent").toMatch(/^(absent|cancelled)$/);
    expect(JSON.parse(await readFile(join(session, "gate-c-probes-p1a01.json"), "utf8")).status).toBe("cancelled");
    expect(JSON.parse(await readFile(join(session, "gate-c-cancelled-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", gate: "C" });
  });

  it("a signal arriving AFTER an accepted receipt landed (before the gate returns) is caught synchronously by the signal handler", async () => {
    const { session, options } = await gateBSession();
    const proc = fakeProc();
    // Write accepted first, THEN signal: the handler itself marks the on-disk receipt cancelled.
    let statusRightAfterSignal = "";
    const afterPublish = (path: string, text: string) => {
      if (path.endsWith("gate-b-p1a01.json") && JSON.parse(text).status === "accepted") {
        proc.emit("SIGINT", "SIGINT");
        // Synchronously, before any later await: the handler already marked it (a second
        // signal could exit the process right now; the receipt must not be usable).
        statusRightAfterSignal = JSON.parse(readFileSync(path, "utf8")).status;
      }
    };
    expect(await executeGate(options, { createRunner: () => gateBRunner(noSuchImage, []), receiptHooks: { afterPublish }, proc })).toBe(130);
    expect(statusRightAfterSignal).toBe("cancelled");
    expect(JSON.parse(await readFile(join(session, "gate-b-p1a01.json"), "utf8")).status).toBe("cancelled");
  });

  it("a stale cancellation record from an earlier invocation makes the rerun refuse; the stale file is unchanged", async () => {
    const { session, options } = await gateBSession();
    const stale = JSON.stringify({ status: "stale" });
    await writeFile(join(session, "gate-b-cancelled-p1a01.json"), stale);
    const log: string[] = [];
    await expect(executeGate(options, { createRunner: () => gateBRunner(noSuchImage, log), proc: fakeProc() })).rejects.toThrow(/already exists/);
    expect(log).toEqual([]);
    expect(await readFile(join(session, "gate-b-cancelled-p1a01.json"), "utf8")).toBe(stale);
  });
});

describe("signal handlers are installed before ANY preparation (receipt loads, dir creation)", () => {
  it("a signal right after the call (before the Gate B receipt is even read) cancels instead of refusing", async () => {
    const session = await scratch();
    const proc = fakeProc();
    const options = parseRunArgs(["--gate", "B", "--run-id", "p1a01", "--session-dir", join(session, "not-yet"), "--approval", "user-msg-b", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-p-receipt", join(session, "missing.json"), "--gate-p-approval", "user-msg-p", "--packed-archive", "/tmp/x.tgz", "--packed-sha256", "a".repeat(64), "--gate-a-receipts", "/tmp/gate-a.json"]);
    const pending = executeGate(options, { createRunner: () => gateBRunner(noSuchImage, []), proc });
    expect(proc.listenerCount("SIGINT")).toBe(1);
    proc.emit("SIGINT", "SIGINT");
    expect(await pending).toBe(130);
    expect(existsSync(join(session, "not-yet", "docker-config-b"))).toBe(false);
  });
});

describe("honest settlement reporting (no 'reaped' claim when the process group did not settle)", () => {
  it("Gate P: an uncertain settlement after the kill -> cleanupConfirmed false and the detail says so", async () => {
    const session = await scratch();
    const proc = fakeProc();
    const createRunner = () => ({ killAttached: () => 0, run: async () => (proc.emit("SIGINT", "SIGINT"), { status: null, stdout: "", stderr: "", timedOut: false, cancelled: true, signal: "SIGKILL", cleanupUncertain: true }) });
    expect(await executeGate(parseRunArgs(["--gate", "P", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-p"]), { createRunner, readNpmVersion: async () => "11.12.1", proc })).toBe(130);
    const record = JSON.parse(await readFile(join(session, "gate-p-cancelled-p1a01.json"), "utf8"));
    expect(record.cleanupConfirmed).toBe(false);
    expect(record.detail).toMatch(/did NOT settle/);
    expect(record.detail).not.toMatch(/reaped/);
    expect(record).toMatchObject({ cleanupScope: "original-process-group", cleanupScopeNote: expect.stringMatching(/escaped descendants .* not tracked/) });
    // The Gate P receipt itself carries it too.
    expect(JSON.parse(await readFile(join(session, "gate-p-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", cleanupConfirmed: false });
  });

  it("Gate A: an uncertain settlement -> the cancelled Gate A receipt and record both say cleanupConfirmed false", async () => {
    const session = await scratch();
    const proc = fakeProc();
    const createRunner = () => ({ killAttached: () => 0, run: async () => (proc.emit("SIGINT", "SIGINT"), { status: null, stdout: "", stderr: "", timedOut: false, cancelled: true, signal: "SIGKILL", cleanupUncertain: true }) });
    const acquireHost = async ({ run }: { run: (argv: string[], opts: Record<string, unknown>) => Promise<{ status: number | null }> }) => {
      const result = await run(["/usr/bin/env", "-i", "/usr/bin/curl"], { timeoutMs: 1000, env: {} });
      throw new Error(`download failed (status ${result.status})`);
    };
    expect(await executeGate(parseRunArgs(["--gate", "A", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-a", "--staging-dir", join(session, "staging"), "--hosts", "v2-2.0.32"]), { createRunner, acquireHost, proc })).toBe(130);
    expect(JSON.parse(await readFile(join(session, "gate-a-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", cleanupConfirmed: false });
    const record = JSON.parse(await readFile(join(session, "gate-a-cancelled-p1a01.json"), "utf8"));
    expect(record).toMatchObject({ cleanupConfirmed: false, detail: expect.stringMatching(/did NOT settle/) });
  });
});

// ---------------------------------------------------------------------------
// Round 4: second signal racing an outstanding rename; ownership; reruns refused.

describe("MUST: a second signal while an accepted write is outstanding can never leave it published", () => {
  it("first + second signal between the temp write and the rename (injected exit): the destination is never accepted", async () => {
    const { session, options } = await gateBSession();
    const proc = fakeProc();
    const target = join(session, "gate-b-p1a01.json");
    const atExit: string[] = [];
    proc.exit = (code: number) => {
      proc.exits.push(code);
      // What a real immediate exit would leave on disk, read synchronously at exit time.
      atExit.push(existsSync(target) ? JSON.parse(readFileSync(target, "utf8")).status : "absent");
    };
    const beforeRename = async (path: string, text: string) => {
      if (path === target && JSON.parse(text).status === "accepted") {
        proc.emit("SIGINT", "SIGINT");
        proc.emit("SIGINT", "SIGINT");
        await new Promise((resolve) => setImmediate(resolve)); // let signals.mjs reach proc.exit
      }
    };
    expect(await executeGate(options, { createRunner: () => gateBRunner(noSuchImage, []), receiptHooks: { beforeRename }, proc })).toBe(130);
    // signals.mjs (copied, unmodified) calls exit from each pending handler; a real exit happens on the first.
    expect(proc.exits[0]).toBe(130);
    expect(atExit[0]).toBe("absent");
    expect(atExit.every((status) => status !== "accepted")).toBe(true);
    expect(existsSync(target) ? JSON.parse(readFileSync(target, "utf8")).status : "absent").not.toBe("accepted");
    expect((await readdir(session)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("if marking the already-published receipt throws in the signal handler, it is deleted synchronously instead", async () => {
    const { session, options } = await gateBSession();
    const proc = fakeProc();
    const target = join(session, "gate-b-p1a01.json");
    let presentRightAfterSignal: boolean | null = null;
    const afterPublish = (path: string, text: string) => {
      if (path !== target || JSON.parse(text).status !== "accepted") return;
      proc.emit("SIGINT", "SIGINT");
      presentRightAfterSignal = existsSync(target);
    };
    const markReceiptSync = () => {
      throw new Error("disk full");
    };
    expect(await executeGate(options, { createRunner: () => gateBRunner(noSuchImage, []), receiptHooks: { afterPublish }, markReceiptSync, proc })).toBe(130);
    expect(presentRightAfterSignal).toBe(false);
    // Afterwards only a CANCELLED record may occupy the path.
    expect(JSON.parse(readFileSync(target, "utf8")).status).toBe("cancelled");
  });
});

describe("SHOULD: reruns that would overwrite or invalidate earlier evidence are refused; signals only touch this invocation's receipts", () => {
  const gateAArgs = (session: string) => parseRunArgs(["--gate", "A", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-a", "--staging-dir", join(session, "staging"), "--hosts", "v2-2.0.32"]);
  const acquireHost = async ({ hostId }: { hostId: string }) => ({ hostId, url: "https://x", archive: { sha256: "c".repeat(64) }, member: "m", executable: { path: "/x", sha256: "d".repeat(64) } });
  const quietRunner = () => ({ run: async () => okRun(), killAttached: () => 0 });

  it("rerunning Gate A with the same run id is refused before any work; the accepted receipt is byte-identical", async () => {
    const session = await scratch();
    expect(await executeGate(gateAArgs(session), { createRunner: quietRunner, acquireHost, proc: fakeProc() })).toBe(0);
    const before = await readFile(join(session, "gate-a-p1a01.json"), "utf8");
    expect(JSON.parse(before).status).toBe("accepted");
    let acquired = 0;
    await expect(executeGate(gateAArgs(session), { createRunner: quietRunner, acquireHost: async (args: { hostId: string }) => ((acquired += 1), acquireHost(args)), proc: fakeProc() })).rejects.toThrow(/gate-a-p1a01\.json already exists/);
    expect(acquired).toBe(0);
    expect(await readFile(join(session, "gate-a-p1a01.json"), "utf8")).toBe(before);
  });

  it("an early signal during a duplicate run does not touch the prior receipt (or create a cancellation record over it)", async () => {
    const session = await scratch();
    expect(await executeGate(gateAArgs(session), { createRunner: quietRunner, acquireHost, proc: fakeProc() })).toBe(0);
    const before = await readFile(join(session, "gate-a-p1a01.json"), "utf8");
    const proc = fakeProc();
    const pending = executeGate(gateAArgs(session), { createRunner: quietRunner, acquireHost, proc });
    proc.emit("SIGINT", "SIGINT");
    await pending.then(() => null, () => null);
    expect(await readFile(join(session, "gate-a-p1a01.json"), "utf8")).toBe(before);
    expect(existsSync(join(session, "gate-a-cancelled-p1a01.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1b: Gate D (full qualification batch).

const ALL_IMAGES = { "v1-1.18.29": "sha256:" + "1".repeat(64), "v1-1.19.3": "sha256:" + "2".repeat(64), "v2-2.0.28": "sha256:" + "3".repeat(64), "v2-2.0.32": "sha256:" + "4".repeat(64) };
const D_RECEIPT = {
  ...B_RECEIPT,
  images: { ...ALL_IMAGES },
  contexts: Object.fromEntries(Object.keys(ALL_IMAGES).map((host, index) => [host, { manifestSha256: String(index + 1).repeat(64), imageManifestSha256: String(index + 5).repeat(64) }])),
};
const dImage = (host: string) => okRun(JSON.stringify([{ Id: ALL_IMAGES[host as keyof typeof ALL_IMAGES], Config: { Labels: { "council-rh.owner": "p1a01", "council-rh.host": host, "council-rh.archive-sha256": ARCHIVE, "council-rh.image-manifest-sha256": D_RECEIPT.contexts[host].imageManifestSha256 } } }]));
/** A PASS frame; V1 frames carry the Gate P closure identity (as the image manifest does). */
const dFrame = (cellId: string, verdict = "PASS") => encodeFrame({ schema: "council-rh-result/1", cellId, verdict, checks: [{ id: "x", ok: verdict === "PASS", detail: verdict === "PASS" ? "" : "boom" }], host: { id: cellId.split(":")[0], executableSha256: "a".repeat(64) }, closure: cellId.startsWith("v1-") ? { receiptId: "closure-p1a01-abc" } : null, durationMs: 1 });
function gateDRunner(log: string[], verdictFor: (cellId: string) => string = () => "PASS", { rmi = (_host: string) => okRun(), inspectExtra = (_host: string): unknown => null, lingers = (_host: string) => false, rmContainer = (_cid: string): unknown => null }: { rmi?: (host: string) => unknown; inspectExtra?: (host: string) => unknown; lingers?: (host: string) => boolean; rmContainer?: (cid: string) => unknown } = {}) {
  const hostOf = (id: string) => Object.entries(ALL_IMAGES).find(([, image]) => image === id)?.[0] as string;
  const removed = new Set<string>();
  return {
    killAttached: () => 0,
    async run(argv: string[]) {
      if (argv[1] === "image" && argv[2] === "rm") {
        log.push(`rmi ${hostOf(argv[3])}`);
        const result = rmi(hostOf(argv[3])) as { status: number };
        if (result.status === 0 && !lingers(hostOf(argv[3]))) removed.add(argv[3]);
        return result;
      }
      if (argv[1] === "image" && removed.has(argv[3])) return (log.push(`absent? ${hostOf(argv[3])}`), noSuchImage(argv[3]));
      if (argv[1] === "image") return (log.push(`inspect ${hostOf(argv[3])}`), inspectExtra(hostOf(argv[3])) ?? dImage(hostOf(argv[3])));
      if (argv[1] === "rm") return (log.push(`rm ${argv[3]}`), rmContainer(argv[3]) ?? okRun());
      if (argv[1] === "ps") return okRun("");
      throw new Error(`unexpected docker call ${argv.join(" ")}`);
    },
    async runAttached(argv: string[]) {
      const cellId = argv.at(-1) as string;
      log.push(`run ${cellId}`);
      await writeFile(argv[argv.indexOf("--cidfile") + 1], `cid-${cellId}`);
      return { exitCode: 0, signal: null, stdout: dFrame(cellId, verdictFor(cellId)), stderr: "", timedOut: false, capExceeded: null, cancelled: false };
    },
  };
}
async function gateDSession(receipt: unknown = D_RECEIPT) {
  const session = await scratch();
  const path = join(session, "gate-b-p1a01.json");
  if (receipt) await writeFile(path, JSON.stringify(receipt));
  const options = parseRunArgs(["--gate", "D", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-d", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", path, "--gate-b-approval", "user-msg-b", "--images", JSON.stringify(ALL_IMAGES), "--archive-sha256", ARCHIVE]);
  return { session, options };
}

describe("Gate D (P1b): full 94-cell qualification batch", () => {
  it("--print-plan: Gate B receipt, fresh Docker dirs, 4 image verifications, 4 version probes, then exactly the 94 expected cells in order", async () => {
    const { expectedCells } = await import("./cells.mjs");
    const plan = planGate(parseRunArgs(["--gate", "D", ...BASE, "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/council-rh-session/gate-b-r1.json", "--images", JSON.stringify(ALL_IMAGES), "--print-plan"]));
    expect(plan.slice(0, 6).map((step: { label: string }) => step.label)).toEqual(["verify Gate B receipt (no spawn)", "create fresh Docker CLI dirs (no spawn)", "verify image v1-1.18.29", "verify image v1-1.19.3", "verify image v2-2.0.28", "verify image v2-2.0.32"]);
    expect(plan[1].paths).toEqual(["/tmp/council-rh-session/docker-config-d", "/tmp/council-rh-session/docker-home-d"]);
    const cellSteps = plan.filter((step: { label: string }) => step.label.startsWith("cell "));
    expect(plan.slice(6, 6 + cellSteps.length)).toEqual(cellSteps);
    const cells = cellSteps.map((step: { argv: string[] }) => step.argv.at(-1));
    expect(cells.slice(0, 4)).toEqual(["v1-1.18.29:probe:1", "v1-1.19.3:probe:1", "v2-2.0.28:probe:1", "v2-2.0.32:probe:1"]);
    expect(cells.slice(4)).toEqual(expectedCells().map((cell: { id: string }) => cell.id));
    expect(cells.slice(4)).toHaveLength(94);
    for (const step of cellSteps) {
      expect(step.argv[step.argv.indexOf("--network") + 1]).toBe("none");
      expect(step.argv.at(-2)).toBe("/opt/council-rh/driver.mjs");
      expect(step.env.DOCKER_CONFIG).toBe("/tmp/council-rh-session/docker-config-d");
      expect(step.argv).toContain(ALL_IMAGES[(step.argv.at(-1) as string).split(":")[0] as keyof typeof ALL_IMAGES]);
    }
  });

  it("the CLI prints the Gate D plan without an approval and executes nothing", async () => {
    const session = await scratch();
    const result = cli(["--gate", "D", "--run-id", "r1", "--session-dir", session, "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", join(session, "gate-b-r1.json"), "--images", JSON.stringify(ALL_IMAGES), "--print-plan"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/TRIPWIRE/);
    // 104 + per-host batch-end image removal and absence verification (8).
    expect(JSON.parse(result.stdout)).toHaveLength(112);
    expect(await readdir(session)).toEqual([]);
  });

  it("refuses a Gate B receipt that does not cover all four hosts (no docker call)", async () => {
    const { options } = await gateDSession({ ...D_RECEIPT, images: { ...SPIKE_IMAGES } });
    const log: string[] = [];
    await expect(executeGate(options, { createRunner: () => gateDRunner(log), proc: fakeProc() })).rejects.toThrow(/Gate D refused: .*image for v1-1\.18\.29/);
    expect(log).toEqual([]);
  });

  it("all cells PASS: probes, then the 94 cells; the report verifier says complete (92 gating + 2 observational); exit 0", async () => {
    const { session, options } = await gateDSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateDRunner(log), proc: fakeProc() });
    expect(code).toBe(0);
    expect(log.slice(0, 4)).toEqual(["inspect v1-1.18.29", "inspect v1-1.19.3", "inspect v2-2.0.28", "inspect v2-2.0.32"]);
    expect(log.filter((entry) => entry.startsWith("run "))).toHaveLength(98);
    expect(JSON.parse(await readFile(join(session, "gate-d-probes-p1a01.json"), "utf8")).status).toBe("completed");
    const batch = JSON.parse(await readFile(join(session, "gate-d-qualification-p1a01.json"), "utf8"));
    expect(batch).toMatchObject({ status: "completed", approval: "user-msg-d" });
    expect(batch.receipts.every((receipt: { runKind: string }) => receipt.runKind === "qualification")).toBe(true);
    const report = JSON.parse(await readFile(join(session, "gate-d-report-p1a01.json"), "utf8"));
    expect(report).toMatchObject({ status: "complete", problems: [], counts: { gating: 92, observational: 2, passed: 94 }, closureReceiptId: "closure-p1a01-abc" });
  });

  it("a FAIL gating cell stops the batch; the report is not complete; exit 1", async () => {
    const { session, options } = await gateDSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateDRunner(log, (cellId) => (cellId === "v1-1.18.29:s3:2" ? "FAIL" : "PASS")), proc: fakeProc() });
    expect(code).toBe(1);
    const runs = log.filter((entry) => entry.startsWith("run "));
    expect(runs.at(-1)).toBe("run v1-1.18.29:s3:2");
    const report = JSON.parse(await readFile(join(session, "gate-d-report-p1a01.json"), "utf8"));
    expect(report.status).toBe("failed");
    expect(report.problems).toEqual(expect.arrayContaining(["gating cell v1-1.18.29:s3:2 verdict FAIL"]));
  });

  it("an observational FAIL does not stop the batch and does not gate the report", async () => {
    const { session, options } = await gateDSession();
    const code = await executeGate(options, { createRunner: () => gateDRunner([], (cellId) => (cellId.includes(":obs-ask:") ? "FAIL" : "PASS")), proc: fakeProc() });
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(join(session, "gate-d-report-p1a01.json"), "utf8"))).toMatchObject({ status: "complete", counts: { passed: 92 } });
  });
});

describe("Gate D exit follows the report verifier, not only the batch", () => {
  it("every cell PASS but V1 results from another closure -> report incomplete, exit 1", async () => {
    const { session, options } = await gateDSession();
    const runner = gateDRunner([]);
    const attached = runner.runAttached.bind(runner);
    runner.runAttached = async (argv: string[]) => {
      const result = await attached(argv);
      const cellId = argv.at(-1) as string;
      if (!cellId.startsWith("v1-")) return result;
      return { ...result, stdout: encodeFrame({ schema: "council-rh-result/1", cellId, verdict: "PASS", checks: [{ id: "x", ok: true, detail: "" }], host: { id: cellId.split(":")[0], executableSha256: "a".repeat(64) }, closure: { receiptId: "closure-OTHER" }, durationMs: 1 }) };
    };
    const code = await executeGate(options, { createRunner: () => runner, proc: fakeProc() });
    expect(code).toBe(1);
    const report = JSON.parse(await readFile(join(session, "gate-d-report-p1a01.json"), "utf8"));
    expect(report.status).toBe("incomplete");
    expect(report.batchStatus).toBe("completed");
    expect(report.problems.some((problem: string) => /closure receipt closure-OTHER != closure-p1a01-abc/.test(problem))).toBe(true);
  });
});

describe("post-P1b audit: Gate D cleanup, image removal, report contents", () => {
  it("frame-2 MA3: a tracked docker command whose process group did not settle STOPS the gate with a failure receipt (no cell runs)", async () => {
    const { session, options } = await gateDSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateDRunner(log, () => "PASS", { inspectExtra: (host) => (host === "v1-1.19.3" ? { ...dImage(host), cleanupUncertain: true } : null) }), proc: fakeProc() });
    expect(code).toBe(1);
    expect(log.filter((entry) => entry.startsWith("run "))).toEqual([]);
    expect(JSON.parse(await readFile(join(session, "gate-d-p1a01.json"), "utf8"))).toMatchObject({ status: "failed", stage: "process cleanup", cleanupConfirmed: false });
  });

  it("frame-2 MA2: a signal right as the 'complete' report is published -> the report is never left usable; exit 130", async () => {
    const { session, options } = await gateDSession();
    const proc = fakeProc();
    const code = await executeGate(options, { createRunner: () => gateDRunner([]), receiptHooks: signallingHooks(proc, "gate-d-report-p1a01.json"), proc });
    expect(code).toBe(130);
    const path = join(session, "gate-d-report-p1a01.json");
    expect(existsSync(path) ? JSON.parse(await readFile(path, "utf8")).status : "absent").toMatch(/^(absent|cancelled)$/);
  });

  it("frame-2 MA2: a signal AFTER the 'complete' report landed marks it cancelled synchronously", async () => {
    const { session, options } = await gateDSession();
    const proc = fakeProc();
    let after = "";
    const afterPublish = (path: string, text: string) => {
      if (path.endsWith("gate-d-report-p1a01.json") && JSON.parse(text).status === "complete") {
        proc.emit("SIGINT", "SIGINT");
        after = JSON.parse(readFileSync(path, "utf8")).status;
      }
    };
    const code = await executeGate(options, { createRunner: () => gateDRunner([]), receiptHooks: { afterPublish }, proc });
    expect(after).toBe("cancelled");
    expect(code).toBe(130);
  });

  it("frame-1 Should2: the report carries the plan §8 residuals and the UNVERIFIED host shapes the cells relied on", async () => {
    const { session, options } = await gateDSession();
    expect(await executeGate(options, { createRunner: () => gateDRunner([]), proc: fakeProc() })).toBe(0);
    const report = JSON.parse(await readFile(join(session, "gate-d-report-p1a01.json"), "utf8"));
    const { PLAN_RESIDUALS } = await import("./report.mjs");
    expect(report.residuals).toEqual(JSON.parse(JSON.stringify(PLAN_RESIDUALS)));
    expect(report.hostShapeCandidates).toEqual({});
  });

  it("frame-2 Should1: batch end removes the OWNED images by exact id and verifies absence (default)", async () => {
    const { session, options } = await gateDSession();
    const log: string[] = [];
    expect(await executeGate(options, { createRunner: () => gateDRunner(log), proc: fakeProc() })).toBe(0);
    expect(log.slice(-8)).toEqual(["rmi v1-1.18.29", "absent? v1-1.18.29", "rmi v1-1.19.3", "absent? v1-1.19.3", "rmi v2-2.0.28", "absent? v2-2.0.28", "rmi v2-2.0.32", "absent? v2-2.0.32"]);
    const images = JSON.parse(await readFile(join(session, "gate-d-images-p1a01.json"), "utf8"));
    expect(images).toMatchObject({ status: "removed", runId: "p1a01" });
    expect(images.images).toEqual(Object.entries(ALL_IMAGES).map(([host, imageId]) => ({ host, imageId, removed: true, absent: true, problem: null })));
  });

  it("frame-2 Should1: --retain-images keeps them (recorded), never removes", async () => {
    const session = await scratch();
    const path = join(session, "gate-b-p1a01.json");
    await writeFile(path, JSON.stringify(D_RECEIPT));
    const options = parseRunArgs(["--gate", "D", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-d", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", path, "--gate-b-approval", "user-msg-b", "--images", JSON.stringify(ALL_IMAGES), "--archive-sha256", ARCHIVE, "--retain-images"]);
    const log: string[] = [];
    expect(await executeGate(options, { createRunner: () => gateDRunner(log), proc: fakeProc() })).toBe(0);
    expect(log.some((entry) => entry.startsWith("rmi"))).toBe(false);
    expect(JSON.parse(await readFile(join(session, "gate-d-images-p1a01.json"), "utf8"))).toMatchObject({ status: "retained" });
    const plan = planGate({ ...options, printPlan: true });
    expect(plan.at(-1)).toEqual({ label: "retain images (--retain-images): no removal", images: ALL_IMAGES });
  });

  it("frame-2 Should1: a failed removal (or an image still present) is recorded and the gate exits 1", async () => {
    const { session, options } = await gateDSession();
    const code = await executeGate(options, { createRunner: () => gateDRunner([], () => "PASS", { rmi: (host) => (host === "v2-2.0.28" ? { status: 1, stdout: "", stderr: "conflict", timedOut: false } : okRun()) }), proc: fakeProc() });
    expect(code).toBe(1);
    const images = JSON.parse(await readFile(join(session, "gate-d-images-p1a01.json"), "utf8"));
    expect(images.status).toBe("failed");
    expect(images.images.find((entry: { host: string }) => entry.host === "v2-2.0.28")).toMatchObject({ removed: false, absent: false, problem: "image rm exited 1" });
  });

  it("print-plan: per-host exact-id removal and absence steps after the cells (no prune)", () => {
    const plan = planGate(parseRunArgs(["--gate", "D", ...BASE, "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/council-rh-session/gate-b-r1.json", "--images", JSON.stringify(ALL_IMAGES), "--print-plan"]));
    const tail = plan.slice(-8);
    expect(tail.map((step: { label: string }) => step.label)).toEqual(Object.keys(ALL_IMAGES).flatMap((host) => [`remove image ${host}`, `verify image absent ${host}`]));
    expect(tail[0].argv).toEqual(["/usr/local/bin/docker", "image", "rm", ALL_IMAGES["v1-1.18.29"]]);
    expect(tail[1].argv).toEqual(["/usr/local/bin/docker", "image", "inspect", ALL_IMAGES["v1-1.18.29"]]);
    expect(JSON.stringify(plan)).not.toMatch(/prune/);
  });
});

it("frame-2 Should1: 'image rm' exiting 0 while the image is STILL present fails the absence check (exit 1, recorded)", async () => {
  const { session, options } = await gateDSession();
  const code = await executeGate(options, { createRunner: () => gateDRunner([], () => "PASS", { lingers: (host) => host === "v1-1.19.3" }), proc: fakeProc() });
  expect(code).toBe(1);
  const images = JSON.parse(await readFile(join(session, "gate-d-images-p1a01.json"), "utf8"));
  expect(images.status).toBe("failed");
  expect(images.images.find((entry: { host: string }) => entry.host === "v1-1.19.3")).toMatchObject({ removed: true, absent: false });
});

it("S4 budget option B: the Gate D plan carries 270 s for the four S4 cells and 210 s for every other cell", () => {
  const plan = planGate(parseRunArgs(["--gate", "D", ...BASE, "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/council-rh-session/gate-b-r1.json", "--images", JSON.stringify(ALL_IMAGES), "--print-plan"]));
  const cells = plan.filter((step: { label: string }) => step.label.startsWith("cell "));
  const s4 = cells.filter((step: { argv: string[] }) => (step.argv.at(-1) as string).split(":")[1] === "s4");
  expect(s4.map((step: { argv: string[] }) => step.argv.at(-1))).toEqual(["v1-1.18.29:s4:1", "v1-1.19.3:s4:1", "v2-2.0.28:s4:1", "v2-2.0.32:s4:1"]);
  for (const step of cells) expect(step.timeoutMs).toBe(s4.includes(step) ? 270_000 : 210_000);
});

describe("P1b re-audit round 2 (Must 3): cell cleanup uncertainty is gate state", () => {
  const uncertain = (cid: string, target: string) => (cid === `cid-${target}` ? { status: 0, stdout: "", stderr: "", timedOut: false, cleanupUncertain: true } : null);

  it("Gate D: no image-removal (or any further docker) command follows a qualification cell whose rm did not settle; exit 1", async () => {
    const { session, options } = await gateDSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateDRunner(log, () => "PASS", { rmContainer: (cid) => uncertain(cid, "v1-1.18.29:s2:1") }), proc: fakeProc() });
    expect(code).toBe(1);
    const last = log.lastIndexOf("rm cid-v1-1.18.29:s2:1");
    expect(log.slice(last + 1).filter((entry) => !entry.startsWith("ps"))).toEqual([]);
    expect(log.some((entry) => entry.startsWith("rmi"))).toBe(false);
    expect(JSON.parse(await readFile(join(session, "gate-d-images-p1a01.json"), "utf8"))).toMatchObject({ status: "not-attempted", reason: "cell container / client cleanup not confirmed" });
  });

  it("Gate D: a signal from afterPublish of the qualification receipt -> the cancellation record reports cleanupConfirmed: false", async () => {
    const { session, options } = await gateDSession();
    const proc = fakeProc();
    const afterPublish = (path: string) => void (path.endsWith("gate-d-qualification-p1a01.json") && proc.emit("SIGINT", "SIGINT"));
    const code = await executeGate(options, { createRunner: () => gateDRunner([], () => "PASS", { rmContainer: (cid) => uncertain(cid, "v1-1.18.29:s2:1") }), receiptHooks: { afterPublish }, proc });
    expect(code).toBe(130);
    expect(JSON.parse(await readFile(join(session, "gate-d-cancelled-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", gate: "D", cleanupConfirmed: false });
  });

  it("Gate C: a signal from afterPublish of the spike receipt after an unsettled rm -> cleanupConfirmed: false", async () => {
    const { session, options } = await gateCSession();
    const proc = fakeProc();
    const afterPublish = (path: string) => void (path.endsWith("gate-c-spike-p1a01.json") && proc.emit("SIGINT", "SIGINT"));
    const code = await executeGate(options, { createRunner: () => gateCRunner([], { rm: (cid?: string) => uncertain(String(cid), "v2-2.0.32:s2:1") }), receiptHooks: { afterPublish }, proc });
    expect(code).toBe(130);
    expect(JSON.parse(await readFile(join(session, "gate-c-cancelled-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", gate: "C", cleanupConfirmed: false });
  });
});

describe("P1b re-audit round 2 (Should c): Gate D image removal keeps its per-image ledger across a cancellation", () => {
  it("a signal during the second image removal: the images receipt and the cancellation record keep the first image's outcome", async () => {
    const { session, options } = await gateDSession();
    const proc = fakeProc();
    const code = await executeGate(options, { createRunner: () => gateDRunner([], () => "PASS", { rmi: (host) => (host === "v1-1.19.3" && proc.emit("SIGINT", "SIGINT"), okRun()) }), proc });
    expect(code).toBe(130);
    const first = { host: "v1-1.18.29", imageId: ALL_IMAGES["v1-1.18.29"], removed: true, absent: true, problem: null };
    const cancelled = JSON.parse(await readFile(join(session, "gate-d-cancelled-p1a01.json"), "utf8"));
    expect(cancelled.imageRemovals[0]).toEqual(first);
    const images = JSON.parse(await readFile(join(session, "gate-d-images-p1a01.json"), "utf8"));
    expect(images.images[0]).toEqual(first);
    expect(images.status).toBe("in-progress");
  });
});

describe("round-3 Must 2: unconfirmed cell cleanup reaches gate state BEFORE the result write can fail", () => {
  const uncertain = (cid: string, target: string) => (cid === `cid-${target}` ? { status: 0, stdout: "", stderr: "", timedOut: false, cleanupUncertain: true } : null);
  /** Signals and REJECTS when the target cell's result record is written (cancellation during the write). */
  function failingWrite(proc: EventEmitter, target: string) {
    return async (path: string, text: string) => {
      if (path.endsWith(`${target.replaceAll(":", "_")}.json`)) {
        proc.emit("SIGINT", "SIGINT");
        throw new Error("result write failed during cancellation");
      }
      await writeFile(path, text, { flag: "wx", mode: 0o600 });
    };
  }

  it.each([
    ["Gate C spike cell", "C", "v2-2.0.32:s1:1"],
    ["Gate C probe cell", "C", "v1-1.19.3:probe:1"],
    ["Gate D qualification cell", "D", "v1-1.18.29:s3:2"],
    ["Gate D probe cell", "D", "v2-2.0.28:probe:1"],
  ] as const)("%s: the cancellation record and the main receipt report cleanupConfirmed: false", async (_label, gate, target) => {
    const { session, options } = gate === "C" ? await gateCSession() : await gateDSession();
    const proc = fakeProc();
    const runner = gate === "C" ? gateCRunner([], { rm: (cid?: string) => uncertain(String(cid), target) }) : gateDRunner([], () => "PASS", { rmContainer: (cid) => uncertain(cid, target) });
    const code = await executeGate(options, { createRunner: () => runner, writeCellRecord: failingWrite(proc, target), proc });
    expect(code).toBe(130);
    const g = gate.toLowerCase();
    expect(JSON.parse(await readFile(join(session, `gate-${g}-cancelled-p1a01.json`), "utf8"))).toMatchObject({ status: "cancelled", cleanupConfirmed: false });
    expect(JSON.parse(await readFile(join(session, `gate-${g}-p1a01.json`), "utf8"))).toMatchObject({ status: "cancelled", cleanupConfirmed: false });
  });
});

describe("round-3 Should: a 'complete' report never stays complete when batch-end image removal cleanup is uncertain", () => {
  it("an image rm whose process group did not settle rewrites the published report (not complete, cleanupUncertain) and exits 1", async () => {
    const { session, options } = await gateDSession();
    const code = await executeGate(options, { createRunner: () => gateDRunner([], () => "PASS", { rmi: (host) => (host === "v2-2.0.28" ? { status: 0, stdout: "", stderr: "", timedOut: false, cleanupUncertain: true } : okRun()) }), proc: fakeProc() });
    expect(code).toBe(1);
    const report = JSON.parse(await readFile(join(session, "gate-d-report-p1a01.json"), "utf8"));
    expect(report.status).toBe("incomplete");
    expect(report.cleanupUncertain).toBe(true);
    expect(report.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^batch-end image removal: .*process group did not settle/)]));
    expect(JSON.parse(await readFile(join(session, "gate-d-p1a01.json"), "utf8"))).toMatchObject({ status: "failed", stage: "process cleanup" });
  });

  it("an image inspect (absence check) whose process group did not settle does the same", async () => {
    const { session, options } = await gateDSession();
    const runner = gateDRunner([]);
    const run = runner.run.bind(runner);
    let removedOnce = false;
    runner.run = async (argv: string[]) => {
      const result = await run(argv);
      if (argv[2] === "rm") removedOnce = true;
      return removedOnce && argv[2] === "inspect" ? { ...(result as object), cleanupUncertain: true } : result;
    };
    expect(await executeGate(options, { createRunner: () => runner, proc: fakeProc() })).toBe(1);
    expect(JSON.parse(await readFile(join(session, "gate-d-report-p1a01.json"), "utf8"))).toMatchObject({ status: "incomplete", cleanupUncertain: true });
  });
});

// ---------------------------------------------------------------------------
// S11 diagnostic amendment (plan Amendment A3).

describe("A3 (4): the Gate A receipt carries its run id; Gate B refuses a missing / mismatched one BEFORE any docker call", () => {
  it("an accepted Gate A receipt records the run id", async () => {
    const session = await scratch();
    const acquireHost = async ({ hostId }: { hostId: string }) => ({ hostId, url: "https://x", archive: { sha256: "c".repeat(64) }, member: "m", executable: { path: "/x", sha256: "d".repeat(64) } });
    const code = await executeGate(parseRunArgs(["--gate", "A", "--run-id", "p1a06", "--session-dir", session, "--approval", "user-msg-a", "--staging-dir", join(session, "staging"), "--hosts", "v1-1.18.29"]), { createRunner: () => ({ run: async () => okRun(), killAttached: () => 0 }), acquireHost, proc: fakeProc() });
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(join(session, "gate-a-p1a06.json"), "utf8"))).toMatchObject({ status: "accepted", runId: "p1a06", approval: "user-msg-a" });
  });

  it.each([
    ["a missing run id", (receipt: Record<string, unknown>) => ({ ...receipt, runId: undefined }), /Gate A receipt run id undefined != p1a01/],
    ["a mismatched run id (an earlier run's receipt)", (receipt: Record<string, unknown>) => ({ ...receipt, runId: "p1a05" }), /Gate A receipt run id p1a05 != p1a01/],
    ["an unreadable receipt", () => null, /Gate A receipt run id undefined != p1a01/],
  ])("%s -> refused, no docker call, no Docker dirs", async (_label, mutate, message) => {
    const { session, options } = await gateBSession();
    const original = JSON.parse(await readFile(options.gateAReceipts, "utf8"));
    const next = mutate(original);
    await writeFile(options.gateAReceipts, next === null ? "{not json" : JSON.stringify(next));
    const log: string[] = [];
    await expect(executeGate(options, { createRunner: () => gateBRunner(noSuchImage, log), proc: fakeProc() })).rejects.toThrow(message);
    expect(log).toEqual([]);
    expect(existsSync(join(session, "docker-config-b"))).toBe(false);
    expect(existsSync(join(session, "gate-b-p1a01.json"))).toBe(false);
  });
});

describe("A3 (3): opt-in S11 diagnostic gate (--gate DIAG): exactly the V1 1.18.29 probe + v1-1.18.29:s11:1", () => {
  const DIAG_IMAGES = { "v1-1.18.29": ALL_IMAGES["v1-1.18.29"] };
  async function diagSession(receipt: unknown = D_RECEIPT, extra: string[] = []) {
    const session = await scratch();
    const path = join(session, "gate-b-p1a01.json");
    if (receipt) await writeFile(path, JSON.stringify(receipt));
    const options = parseRunArgs(["--gate", "DIAG", "--run-id", "p1a01", "--session-dir", session, "--approval", "user-msg-diag", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", path, "--gate-b-approval", "user-msg-b", "--images", JSON.stringify(DIAG_IMAGES), "--archive-sha256", ARCHIVE, ...extra]);
    return { session, options };
  }
  const terminal = async (session: string) => JSON.parse(await readFile(join(session, "gate-diag-p1a01.json"), "utf8"));
  const noGateD = async (session: string) => expect((await readdir(session)).filter((name) => name.startsWith("gate-d-") || name.includes("-d-"))).toEqual([]);

  it("--print-plan: Gate B receipt, fresh DIAG Docker dirs, ONE image verification, the probe, the one S11 cell; no image removal", () => {
    const plan = planGate(parseRunArgs(["--gate", "DIAG", ...BASE, "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/council-rh-session/gate-b-r1.json", "--images", JSON.stringify(DIAG_IMAGES), "--print-plan"]));
    expect(plan.map((step: { label: string }) => step.label)).toEqual(["verify Gate B receipt (no spawn)", "create fresh Docker CLI dirs (no spawn)", "verify image v1-1.18.29", "cell v1-1.18.29:probe:1", "cell v1-1.18.29:s11:1"]);
    expect(plan[1].paths).toEqual(["/tmp/council-rh-session/docker-config-diag", "/tmp/council-rh-session/docker-home-diag"]);
    for (const step of plan.slice(3)) {
      expect(step.argv[step.argv.indexOf("--network") + 1]).toBe("none");
      expect(step.argv).toContain(DIAG_IMAGES["v1-1.18.29"]);
      expect(step.timeoutMs).toBe(210_000);
    }
  });

  it("refuses without the V1 1.18.29 image id, and is never selected implicitly by Gate D", () => {
    const result = cli(["--gate", "DIAG", ...BASE, "--approval", "user-msg-1", "--docker", "/usr/local/bin/docker", "--docker-socket", "/var/run/docker.sock", "--gate-b-receipt", "/tmp/b.json", "--gate-b-approval", "user-msg-b", "--images", JSON.stringify({ "v1-1.19.3": ALL_IMAGES["v1-1.19.3"] }), "--archive-sha256", ARCHIVE]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/exact image id for v1-1\.18\.29/);
    expect(result.stderr).not.toMatch(/TRIPWIRE/);
  });

  it("S11 PASS + confirmed cleanup: exactly probe then S11, diagnostic receipts, a TERMINAL outcome receipt, exit 0; no Gate D report, no image removal", async () => {
    const { session, options } = await diagSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateDRunner(log), proc: fakeProc() });
    expect(code).toBe(0);
    expect(log.filter((entry) => !entry.startsWith("rm "))).toEqual(["inspect v1-1.18.29", "run v1-1.18.29:probe:1", "run v1-1.18.29:s11:1"]);
    expect(log.some((entry) => entry.startsWith("rmi"))).toBe(false);
    const diag = JSON.parse(await readFile(join(session, "gate-diag-diagnostic-p1a01.json"), "utf8"));
    expect(diag.status).toBe("completed");
    expect(diag.receipts).toEqual([expect.objectContaining({ runKind: "diagnostic", cellClass: "diagnostic", cellId: "v1-1.18.29:s11:1", cleanupConfirmed: true })]);
    expect(JSON.parse(await readFile(join(session, "gate-diag-probes-p1a01.json"), "utf8")).receipts.map((receipt: { cellId: string }) => receipt.cellId)).toEqual(["v1-1.18.29:probe:1"]);
    expect(await terminal(session)).toMatchObject({ schema: "council-rh-diagnostic/1", status: "terminal", runId: "p1a01", approval: "user-msg-diag", outcome: "s11-pass-cleanup-confirmed", cellId: "v1-1.18.29:s11:1", archiveSha256: ARCHIVE, imageId: DIAG_IMAGES["v1-1.18.29"], closureReceiptId: "closure-p1a01-abc", qualification: false, imagesRemoved: false, interpretation: expect.stringMatching(/not causal proof/) });
    await noGateD(session);
  });

  it("a mismatched image (labels) -> STOP before any docker run; failure receipt; exit 1", async () => {
    const { session, options } = await diagSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateDRunner(log, () => "PASS", { inspectExtra: () => okRun(JSON.stringify([{ Id: DIAG_IMAGES["v1-1.18.29"], Config: { Labels: { "council-rh.owner": "someone-else" } } }])) }), proc: fakeProc() });
    expect(code).toBe(1);
    expect(log).toEqual(["inspect v1-1.18.29"]);
    expect(await terminal(session)).toMatchObject({ status: "failed", stage: "verify image v1-1.18.29" });
    await noGateD(session);
  });

  it("a probe FAIL is terminal: S11 never runs; outcome probe-failed; exit 1", async () => {
    const { session, options } = await diagSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateDRunner(log, (cellId) => (cellId.endsWith(":probe:1") ? "FAIL" : "PASS")), proc: fakeProc() });
    expect(code).toBe(1);
    expect(log.filter((entry) => entry.startsWith("run "))).toEqual(["run v1-1.18.29:probe:1"]);
    expect(await terminal(session)).toMatchObject({ status: "terminal", outcome: "probe-failed", stage: "probe" });
  });

  it("an S11 container removal that did not settle -> outcome cleanup-uncertain, exit 1, no further docker command", async () => {
    const { session, options } = await diagSession();
    const log: string[] = [];
    const code = await executeGate(options, { createRunner: () => gateDRunner(log, () => "PASS", { rmContainer: (cid) => (cid.includes(":s11:") ? { ...okRun(), cleanupUncertain: true } : null) }), proc: fakeProc() });
    expect(code).toBe(1);
    expect(log.at(-1)).toBe("rm cid-v1-1.18.29:s11:1");
    expect(await terminal(session)).toMatchObject({ status: "terminal", outcome: "cleanup-uncertain", cleanupConfirmed: false });
    await noGateD(session);
  });

  it("an S11 FAIL verdict -> a non-success outcome, exit 1", async () => {
    const { session, options } = await diagSession();
    const code = await executeGate(options, { createRunner: () => gateDRunner([], (cellId) => (cellId.includes(":s11:") ? "FAIL" : "PASS")), proc: fakeProc() });
    expect(code).toBe(1);
    expect((await terminal(session)).outcome).toBe("handshake-ok-later-failure");
  });

  it("an operator signal during the S11 run -> exit 130, cancellation record carries the cancelled outcome; never a PASS outcome", async () => {
    const { session, options } = await diagSession();
    const proc = fakeProc();
    const runner = gateDRunner([]);
    const attached = runner.runAttached.bind(runner);
    runner.runAttached = async (argv: string[]) => {
      if ((argv.at(-1) as string).includes(":s11:")) proc.emit("SIGINT", "SIGINT");
      return attached(argv);
    };
    expect(await executeGate(options, { createRunner: () => runner, proc })).toBe(130);
    // Pre-publication cancellation: the main receipt and the cancellation record both say outcome "cancelled".
    for (const name of ["gate-diag-cancelled-p1a01.json", "gate-diag-p1a01.json"]) {
      const receipt = JSON.parse(await readFile(join(session, name), "utf8"));
      expect(receipt).toMatchObject({ status: "cancelled", outcome: "cancelled" });
      expect(receipt).not.toHaveProperty("diagnosticOutcome");
    }
  });

  it("a signal right AFTER the terminal PASS receipt was published -> exit 130; the receipt becomes cancelled with outcome 'cancelled' (previousOutcome kept)", async () => {
    const { session, options } = await diagSession();
    const proc = fakeProc();
    const receiptHooks = { afterPublish: (path: string) => void (path.endsWith("gate-diag-p1a01.json") && proc.emit("SIGINT", "SIGINT")) };
    expect(await executeGate(options, { createRunner: () => gateDRunner([]), proc, receiptHooks })).toBe(130);
    expect(await terminal(session)).toMatchObject({ status: "cancelled", previousStatus: "terminal", outcome: "cancelled", previousOutcome: "s11-pass-cleanup-confirmed" });
    expect(JSON.parse(await readFile(join(session, "gate-diag-cancelled-p1a01.json"), "utf8"))).toMatchObject({ status: "cancelled", outcome: "cancelled" });
  });
});
