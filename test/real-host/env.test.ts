// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/env.test.ts
// Local modifications (see test/PROVENANCE.md): none.
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildHostEnv, createFixture, generateServerPassword, hostEnvProblems, removeFixture } from "./env.mjs";

const REAL_HOME = "/Users/someone";
const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function parent(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rh-env-"));
  created.push(dir);
  return realpath(dir);
}

describe("real-host fixture layout", () => {
  it("creates a canonical owned root holding HOME, four XDG dirs, temp, cache, logs, project, bin, and run dirs", async () => {
    const fixture = await createFixture(await parent(), { label: "v1-floor" });

    expect(fixture.root).toBe(await realpath(fixture.root));
    const dirs = [fixture.home, ...Object.values(fixture.xdg), fixture.tmp, fixture.logs, fixture.project, fixture.bin, fixture.run, fixture.evidence];
    for (const dir of dirs) {
      expect(dir.startsWith(`${fixture.root}/`), dir).toBe(true);
      expect((await lstat(dir)).isDirectory(), dir).toBe(true);
    }
    expect(Object.keys(fixture.xdg).sort()).toEqual(["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
  });

  it("removes only the root it created", async () => {
    const dir = await parent();
    const fixture = await createFixture(dir, { label: "x" });
    await removeFixture(fixture);
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});

describe("host environment allowlist", () => {
  it("builds the environment from scratch: inherited credentials, proxies, SSH, OpenCode, npm and Node settings never pass through", async () => {
    const fixture = await createFixture(await parent(), { label: "x" });
    const env = buildHostEnv(fixture, { pathDirs: [fixture.bin, "/usr/bin", "/bin"] });

    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "LANG", "PATH", "SHELL", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].sort(),
    );
    expect(env.HOME).toBe(fixture.home);
    expect(env.PATH).toBe(`${fixture.bin}:/usr/bin:/bin`);
    expect(hostEnvProblems(env, fixture, { realHome: REAL_HOME })).toEqual([]);
  });

  it("accepts only explicitly allowlisted extra variables", async () => {
    const fixture = await createFixture(await parent(), { label: "x" });
    const config = join(fixture.xdg.XDG_CONFIG_HOME, "opencode.json");
    expect(buildHostEnv(fixture, { pathDirs: ["/usr/bin"], extra: { OPENCODE_CONFIG: config } }).OPENCODE_CONFIG).toBe(config);
    expect(() => buildHostEnv(fixture, { pathDirs: ["/usr/bin"], extra: { GITHUB_TOKEN: "x" } })).toThrow(/not allowlisted/);
    expect(() => buildHostEnv(fixture, { pathDirs: ["/usr/bin"], extra: { OPENCODE_CONFIG_CONTENT: "{}" } })).toThrow(/not allowlisted/);
  });

  it("admits only a harness-generated fixture server password, never other credential-shaped keys or values", async () => {
    const fixture = await createFixture(await parent(), { label: "x" });
    const password = generateServerPassword();
    expect(password).toMatch(/^rh-[A-Za-z0-9_-]{43}$/);
    expect(generateServerPassword()).not.toBe(password);
    const env = buildHostEnv(fixture, { pathDirs: ["/usr/bin"], extra: { OPENCODE_SERVER_PASSWORD: password } });
    expect(hostEnvProblems(env, fixture, { realHome: REAL_HOME })).toEqual([]);
    expect(() => buildHostEnv(fixture, { pathDirs: ["/usr/bin"], extra: { OPENCODE_SERVER_PASSWORD: "hunter2" } })).toThrow(/harness-generated/);
    expect(() => buildHostEnv(fixture, { pathDirs: ["/usr/bin"], extra: { OPENCODE_PASSWORD: password } })).toThrow(/not allowlisted/);
    expect(hostEnvProblems({ ...env, OPENCODE_SERVER_PASSWORD: "real-password" }, fixture, { realHome: REAL_HOME }).join()).toMatch(/OPENCODE_SERVER_PASSWORD/);
  });

  it("rejects PATH entries that are relative, inside the real home, or outside the fixture and system dirs", async () => {
    const fixture = await createFixture(await parent(), { label: "x" });
    expect(() => buildHostEnv(fixture, { pathDirs: ["bin"] })).toThrow(/PATH/);
    expect(() => buildHostEnv(fixture, { pathDirs: ["/opt/homebrew/bin"] })).toThrow(/PATH/);
    expect(() => buildHostEnv(fixture, { pathDirs: [`${REAL_HOME}/.bun/bin`] }, { realHome: REAL_HOME })).toThrow(/PATH/);
  });

  it("reports every problem in a tampered environment", async () => {
    const fixture = await createFixture(await parent(), { label: "x" });
    const env = {
      ...buildHostEnv(fixture, { pathDirs: ["/usr/bin"] }),
      HOME: REAL_HOME,
      HTTPS_PROXY: "http://proxy",
      SSH_AUTH_SOCK: "/tmp/agent",
      OPENCODE_CONFIG_CONTENT: "{}",
      NODE_OPTIONS: "--require x",
      XDG_DATA_HOME: `${REAL_HOME}/.local/share`,
      TMPDIR: "/tmp",
    };
    const problems = hostEnvProblems(env, fixture, { realHome: REAL_HOME });
    for (const expected of ["HTTPS_PROXY", "SSH_AUTH_SOCK", "OPENCODE_CONFIG_CONTENT", "NODE_OPTIONS", "HOME", "XDG_DATA_HOME", "TMPDIR"]) {
      expect(problems.join("\n"), expected).toContain(expected);
    }
  });

  it("flags any value that points into the real home", async () => {
    const fixture = await createFixture(await parent(), { label: "x" });
    const env = { ...buildHostEnv(fixture, { pathDirs: ["/usr/bin"] }), OPENCODE_CONFIG: `${REAL_HOME}/.config/opencode/opencode.json` };
    expect(hostEnvProblems(env, fixture, { realHome: REAL_HOME }).join("\n")).toMatch(/OPENCODE_CONFIG.*real home/);
  });
});
