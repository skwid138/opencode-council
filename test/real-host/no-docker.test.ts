// Council-only (not copied). npm test must never reach Docker, npm, or curl: every
// real-host module takes an injected runner, and the worker guard
// (test/no-docker-guard.mjs) makes any docker / npm / npx / node npm-cli.js / curl spawn
// throw before a process is created.
//
// Spawn-level tests below can NEVER reach a real binary, even with a broken guard:
// every target is a stub in a temp dir (or a fake npm-cli.js there) that only
// writes a marker file, every call runs with PATH = that stub dir only, and a
// precondition aborts before spawning if any target would resolve elsewhere.
// A broken guard therefore shows up as a marker file (and a missing throw).
import type { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { classifyInvocation, invokesDocker, invokesForbidden } from "../no-docker-guard.mjs";

if ((globalThis as Record<symbol, unknown>)[Symbol.for("council.noDockerGuard")] !== true) {
  throw new Error("no-docker guard is not installed; refusing to run spawn-level assertions");
}

let stubDir = "";
let fakeNpmCli = "";
let ENV: Record<string, string> = {};
const STUBS = ["npm", "npx", "docker", "curl"];

beforeAll(async () => {
  stubDir = await realpath(await mkdtemp(join(tmpdir(), "rh-stubs-")));
  for (const name of STUBS) {
    const stub = join(stubDir, name);
    await writeFile(stub, `#!/bin/sh\n: > '${join(stubDir, `ran-${name}`)}'\nexit 0\n`);
    await chmod(stub, 0o755);
  }
  fakeNpmCli = join(stubDir, "npm-pkg", "bin", "npm-cli.js");
  await mkdir(join(stubDir, "npm-pkg", "bin"), { recursive: true });
  await writeFile(fakeNpmCli, `require("node:fs").writeFileSync(${JSON.stringify(join(stubDir, "ran-npm-cli"))}, "x");\n`);
  ENV = { PATH: stubDir };
});
afterEach(() => {
  for (const name of readdirSync(stubDir).filter((entry) => entry.startsWith("ran-"))) rmSync(join(stubDir, name));
});
afterAll(async () => {
  await rm(stubDir, { recursive: true, force: true });
});

const markers = () => readdirSync(stubDir).filter((entry) => entry.startsWith("ran-")).sort();

/** Aborts BEFORE the call if PATH is not exactly the stub dir or any target resolves outside it. */
function assertStubOnly(targets: string[], options: { env?: Record<string, string> } | undefined) {
  if (options?.env?.PATH !== stubDir || Object.keys(options.env).length !== 1) throw new Error("PRECONDITION: env must be exactly { PATH: <stub dir> }");
  for (const target of targets) {
    const path = target.startsWith("/") ? target : join(stubDir, target);
    if (!path.startsWith(`${stubDir}/`) || !existsSync(path)) throw new Error(`PRECONDITION: ${target} would resolve outside the stub dir`);
  }
}

/**
 * Expects the guard to refuse `call`. Checks the precondition first; if the guard
 * is broken and a stub ran, waits for it and reports the marker before the throw.
 */
async function expectRefused(kind: "docker" | "npm" | "curl", targets: string[], options: { env?: Record<string, string> }, call: () => unknown) {
  assertStubOnly(targets, options);
  let error: unknown = null;
  let returned: unknown = null;
  try {
    returned = call();
  } catch (caught) {
    error = caught;
  }
  if (returned && typeof (returned as ChildProcess).once === "function") {
    await new Promise((resolve) => (returned as ChildProcess).once("close", resolve));
  }
  expect(markers(), "a stub ran: the guard let the spawn through").toEqual([]);
  expect(error, "the guard did not throw").toBeInstanceOf(Error);
  expect((error as Error).message).toMatch({ docker: /docker is forbidden during npm test/, npm: /npm is forbidden during npm test/, curl: /curl is forbidden during npm test/ }[kind]);
}

describe("spawn-level guard (stub binaries only; never a real docker/npm/curl)", () => {
  it("the precondition aborts before any call whose target is outside the stub dir", async () => {
    let called = false;
    const call = () => (called = true);
    await expect(expectRefused("npm", ["npm"], { env: { PATH: "/usr/local/bin" } }, call)).rejects.toThrow(/PRECONDITION/);
    await expect(expectRefused("npm", ["/usr/local/bin/npm"], { env: ENV }, call)).rejects.toThrow(/PRECONDITION/);
    await expect(expectRefused("npm", ["missing-tool"], { env: ENV }, call)).rejects.toThrow(/PRECONDITION/);
    await expect(expectRefused("npm", ["npm"], { env: { ...ENV, HOME: "/x" } }, call)).rejects.toThrow(/PRECONDITION/);
    expect(called).toBe(false);
  });

  it("the stubs really write markers (so a broken guard would be visible)", () => {
    expect(spawnSync("/bin/sh", ["-c", `: > '${join(stubDir, "ran-self-check")}'`], { env: ENV }).status).toBe(0);
    expect(markers()).toEqual(["ran-self-check"]);
  });

  it.each([
    ["spawn", () => spawn("docker", ["version"], { env: ENV }), ["docker"]],
    ["spawnSync", () => spawnSync("docker", ["version"], { env: ENV }), ["docker"]],
    ["execFile", () => execFile("docker", ["version"], { env: ENV }), ["docker"]],
    ["execFileSync", () => execFileSync("docker", ["version"], { env: ENV }), ["docker"]],
    ["exec", () => exec("docker version", { env: ENV }), ["docker"]],
    ["execSync", () => execSync("docker version", { env: ENV }), ["docker"]],
    ["namespace spawnSync, absolute stub path", () => childProcess.spawnSync(join(stubDir, "docker"), ["ps"], { env: ENV }), ["__abs_docker__"]],
    ["sh -c", () => childProcess.spawn("/bin/sh", ["-c", "docker ps"], { env: ENV }), ["docker"]],
    ["bash -c", () => spawnSync("/bin/bash", ["-c", "true && docker ps"], { env: ENV }), ["docker"]],
    ["env", () => spawnSync("/usr/bin/env", ["FOO=1", "docker", "ps"], { env: ENV }), ["docker"]],
    ["shell: true", () => spawnSync("docker run x", { shell: true, env: ENV }), ["docker"]],
    ["shell line with absolute stub path", () => execSync(`  ${join(stubDir, "docker")} image ls`, { env: ENV }), ["__abs_docker__"]],
  ])("refuses docker via %s", async (_label, call, targets) => {
    await expectRefused("docker", (targets as string[]).map((t) => (t === "__abs_docker__" ? join(stubDir, "docker") : t)), { env: ENV }, call as () => unknown);
  });

  it.each([
    ["spawnSync npm", () => spawnSync("npm", ["--version"], { env: ENV }), ["npm"]],
    ["spawn npx", () => spawn("npx", ["--version"], { env: ENV }), ["npx"]],
    ["node + npm-cli.js (fake)", () => spawnSync(process.execPath, ["__fake_npm_cli__", "--version"], { env: ENV }), ["__fake_npm_cli__"]],
    ["execSync npm", () => execSync("npm --version", { env: ENV }), ["npm"]],
    ["sh -c npm", () => spawnSync("/bin/sh", ["-c", "npm --version"], { env: ENV }), ["npm"]],
    ["env npx", () => spawnSync("/usr/bin/env", ["A=1", "npx", "y"], { env: ENV }), ["npx"]],
  ])("refuses npm via %s", async (_label, call, targets) => {
    const resolved = (targets as string[]).map((t) => (t === "__fake_npm_cli__" ? fakeNpmCli : t));
    const actual = () => {
      if (_label === "node + npm-cli.js (fake)") return spawnSync(process.execPath, [fakeNpmCli, "--version"], { env: ENV });
      return (call as () => unknown)();
    };
    await expectRefused("npm", resolved, { env: ENV }, actual);
  });

  it.each([
    ["spawnSync curl", () => spawnSync("curl", ["-q", "https://example.invalid/"], { env: ENV }), ["curl"]],
    ["spawn curl, absolute stub path", () => spawn(join(stubDir, "curl"), ["--version"], { env: ENV }), ["__abs_curl__"]],
    ["execFileSync curl", () => execFileSync("curl", ["--version"], { env: ENV }), ["curl"]],
    ["execSync curl", () => execSync("curl --version", { env: ENV }), ["curl"]],
    ["sh -c curl", () => spawnSync("/bin/sh", ["-c", "true; curl --version"], { env: ENV }), ["curl"]],
    // `env -i` clears PATH, so a bare name could fall back to the system default path: always the absolute stub here.
    ["env -i <abs stub curl> (Gate A shape)", () => spawnSync("/usr/bin/env", ["-i", join(stubDir, "curl"), "--version"], { env: ENV }), ["__abs_curl__"]],
  ])("refuses curl via %s", async (_label, call, targets) => {
    await expectRefused("curl", (targets as string[]).map((t) => (t === "__abs_curl__" ? join(stubDir, "curl") : t)), { env: ENV }, call as () => unknown);
  });

  it("still allows ordinary processes (no docker/npm in argv)", () => {
    expect(spawnSync(process.execPath, ["-e", "0"], { env: ENV }).status).toBe(0);
    expect(spawnSync("/bin/sh", ["-c", "exit 0"], { env: ENV }).status).toBe(0);
    expect(markers()).toEqual([]);
  });
});

describe("docker invocation classifier (pure; spawns nothing)", () => {
  it.each([
    ["docker", [], {}, true],
    ["/usr/local/bin/docker", ["ps"], {}, true],
    ["docker run x", [], { shell: true }, true],
    ["true && docker ps", [], { shell: "/bin/sh" }, true],
    ["sh", ["-c", "docker ps"], {}, true],
    ["/bin/bash", ["-lc", "x; docker ps"], {}, true],
    ["/usr/bin/env", ["A=1", "docker", "ps"], {}, true],
    ["node", ["-e", "0"], {}, false],
    ["/bin/sh", ["-c", "echo docker-free"], {}, false],
    ["/usr/bin/curl", ["https://example.com"], {}, false],
    ["dockerd-like-name", [], {}, false],
  ])("%s %j -> %s", (command, args, options, expected) => {
    expect(invokesDocker(command, args, options)).toBe(expected);
  });
});

describe("curl invocation classifier (pure; spawns nothing)", () => {
  it.each([
    ["curl", [], {}, "curl"],
    ["/usr/bin/curl", ["-q", "https://example.com"], {}, "curl"],
    ["/usr/bin/env", ["-i", "/usr/bin/curl", "-q"], {}, "curl"],
    ["curl -q https://x", [], { shell: true }, "curl"],
    ["sh", ["-c", "cd x && curl -O y"], {}, "curl"],
    ["curl-config", [], {}, null],
    ["/bin/sh", ["-c", "echo curl-free"], {}, null],
  ])("%s %j -> %s", (command, args, options, expected) => {
    expect(classifyInvocation(command, args, options)).toBe(expected);
  });
});

describe("npm invocation classifier (pure; spawns nothing)", () => {
  const NODE = "/Users/hunter/.nvm/versions/node/v24.15.0/bin/node";
  const NPM_CLI = "/Users/hunter/.nvm/versions/node/v24.15.0/lib/node_modules/npm/bin/npm-cli.js";
  it.each([
    ["npm", ["install"], {}, true],
    ["/usr/local/bin/npm", ["ci"], {}, true],
    ["npx", ["x"], {}, true],
    [NODE, [NPM_CLI, "install"], {}, true],
    ["node", ["/x/npm-cli.js"], {}, true],
    ["npm install x", [], { shell: true }, true],
    ["sh", ["-c", "cd x && npm ci"], {}, true],
    ["/usr/bin/env", ["A=1", "npx", "y"], {}, true],
    [NODE, ["-e", "0"], {}, false],
    ["/bin/sh", ["-c", "echo npm-free"], {}, false],
    ["npmrc-tool", [], {}, false],
  ])("%s %j -> %s", (command, args, options, expected) => {
    expect(invokesForbidden(command, args, options)).toBe(expected);
  });
});
