// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/isolated-env.test.ts
// Local modifications: added council naming and isolation-environment assertions;
//   created parent directories are removed in afterEach (see test/PROVENANCE.md).
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Deterministic filesystem failure injection for createIsolationRoot's
// post-mkdtemp initialization. Only the named operation fails, only while armed.
const inject = vi.hoisted(() => ({ fail: null as null | "mkdir" | "writeFile" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const injected = (name: "mkdir" | "writeFile") =>
    (async (...args: unknown[]) => {
      if (inject.fail === name) throw Object.assign(new Error(`EIO: injected ${name} failure`), { code: "EIO" });
      return (actual[name] as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as never;
  const mocked = { ...actual, mkdir: injected("mkdir"), writeFile: injected("writeFile") };
  return { ...mocked, default: mocked };
});

// The worker setup file already imported isolated-env.mjs with the real fs;
// reset the registry so this import binds to the mocked module.
vi.resetModules();
const { createIsolationRoot } = await import("./isolated-env.mjs");

// Every parent directory a test creates is removed after the test (it also holds any root created under it).
const created: string[] = [];
afterEach(async () => {
  inject.fail = null;
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratchParent(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "isolation-root-parent-"));
  created.push(dir);
  return dir;
}

describe("createIsolationRoot", () => {
  for (const operation of ["mkdir", "writeFile"] as const) {
    it(`removes only its own root when ${operation} fails after the root was created`, async () => {
      const parent = await scratchParent();
      await writeFile(join(parent, "sentinel"), "not owned by the helper", "utf8");
      inject.fail = operation;

      await expect(createIsolationRoot(parent)).rejects.toThrow(`injected ${operation} failure`);

      inject.fail = null;
      await expect(readdir(parent)).resolves.toEqual(["sentinel"]);
    });
  }

  it("returns a complete layout under the parent when initialization succeeds", async () => {
    const parent = await scratchParent();

    const layout = await createIsolationRoot(parent);

    expect(await readdir(parent)).toHaveLength(1);
    expect((await readdir(layout.root)).sort()).toEqual(["home", "npm", "tmp", "xdg"]);
  });
});

describe("council isolation environment", () => {
  it("uses a council-owned root variable that is not itself an OPENCODE* variable", async () => {
    const { ROOT_VAR } = await import("./isolated-env.mjs");
    expect(ROOT_VAR).toBe("COUNCIL_TEST_ROOT");
    expect(/^OPENCODE/i.test(ROOT_VAR)).toBe(false);
  });

  it("creates roots with a council prefix under the given parent", async () => {
    const parent = await scratchParent();
    const layout = await createIsolationRoot(parent);
    expect(layout.root.startsWith(await realpath(parent))).toBe(true);
    expect(layout.root).toMatch(/\/opencode-council-test-[^/]+$/);
  });

  it("pins HOME, every XDG dir, TMPDIR/TMP/TEMP and the npm cache/config inside the root, and strips OPENCODE_* and npm overrides", async () => {
    const { buildIsolatedEnv, isolationProblems, ROOT_VAR } = await import("./isolated-env.mjs");
    const parent = await scratchParent();
    const layout = await createIsolationRoot(parent);
    const env = buildIsolatedEnv(
      {
        PATH: "/usr/bin",
        HOME: "/real/home",
        OPENCODE_CONFIG: "/real/opencode.json",
        opencode_server_url: "http://x",
        npm_config_registry: "https://evil.example",
        NPM_TOKEN: "secret",
        NODE_AUTH_TOKEN: "secret",
      },
      layout,
    );

    expect(env[ROOT_VAR]).toBe(layout.root);
    expect(env.HOME).toBe(layout.home);
    for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
      expect(env[name].startsWith(layout.root)).toBe(true);
    }
    for (const name of ["TMPDIR", "TMP", "TEMP"]) expect(env[name]).toBe(layout.tmp);
    expect(env.npm_config_cache).toBe(layout.npmCache);
    expect(env.npm_config_userconfig).toBe(layout.npmUserConfig);
    expect(env.npm_config_globalconfig).toBe(layout.npmGlobalConfig);
    expect(env.npm_config_offline).toBe("true");
    expect(Object.keys(env).filter((name) => /^opencode/i.test(name) || name === "NPM_TOKEN" || name === "NODE_AUTH_TOKEN")).toEqual([]);
    expect(env.npm_config_registry).toBeUndefined();
    expect(isolationProblems(env, env.HOME, env.TMPDIR)).toEqual([]);
    expect(isolationProblems({ ...env, OPENCODE_X: "1" }, env.HOME, env.TMPDIR)).toEqual([
      "inherited OpenCode variables present: OPENCODE_X",
    ]);
    expect(isolationProblems(env, "/real/home", env.TMPDIR)).toContain("os.homedir() is outside the isolation root");
    expect(isolationProblems(env, env.HOME, "/tmp")).toContain("os.tmpdir() is outside the isolation root");
  });
});
