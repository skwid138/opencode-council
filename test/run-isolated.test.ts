import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

const launcher = new URL("./run-isolated.mjs", import.meta.url).pathname;
const probe = `
const os = require("node:os");
process.stdout.write(JSON.stringify({
  root: process.env.COUNCIL_TEST_ROOT, home: os.homedir(), tmp: os.tmpdir(),
  xdg: ["XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_STATE_HOME","XDG_CACHE_HOME"].map((n) => process.env[n]),
  cache: process.env.npm_config_cache,
  opencode: Object.keys(process.env).filter((n) => /^opencode/i.test(n)),
}));`;

describe("run-isolated launcher", () => {
  it("runs the command inside a disposable root under COUNCIL_ISOLATION_PARENT and removes only that root", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "run-isolated-parent-")));
    created.push(parent);
    const result = spawnSync(process.execPath, [launcher, process.execPath, "-e", probe], {
      encoding: "utf8",
      env: { ...process.env, COUNCIL_ISOLATION_PARENT: parent, OPENCODE_CONFIG: "/real/opencode.json" },
    });

    expect(result.status).toBe(0);
    const seen = JSON.parse(result.stdout);
    expect(seen.root.startsWith(`${parent}/opencode-council-test-`)).toBe(true);
    for (const path of [seen.home, seen.tmp, ...seen.xdg, seen.cache]) expect(path.startsWith(seen.root)).toBe(true);
    expect(seen.opencode).toEqual([]);
    expect(await readdir(parent)).toEqual([]);
  });

  it("refuses a relative COUNCIL_ISOLATION_PARENT", () => {
    const result = spawnSync(process.execPath, [launcher, process.execPath, "-e", "0"], {
      encoding: "utf8",
      env: { ...process.env, COUNCIL_ISOLATION_PARENT: "relative/dir" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("COUNCIL_ISOLATION_PARENT must be an absolute path");
  });
});
