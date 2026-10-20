import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dockerDirs, prepareDockerDirs, verifyDockerDirsEmpty } from "./docker-session.mjs";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-dsess-")));
  created.push(dir);
  return dir;
}

describe("fresh Docker CLI config/home per gate", () => {
  it("names one config dir and one home dir per docker gate", () => {
    expect(dockerDirs("/s", "B")).toEqual({ configDir: "/s/docker-config-b", home: "/s/docker-home-b" });
    expect(dockerDirs("/s", "C")).toEqual({ configDir: "/s/docker-config-c", home: "/s/docker-home-c" });
    expect(() => dockerDirs("relative", "B")).toThrow(/absolute/);
  });

  it("creates both exclusively with mode 0700, empty", async () => {
    const session = await scratch();
    const dirs = dockerDirs(session, "B");
    await prepareDockerDirs(dirs);
    for (const dir of [dirs.configDir, dirs.home]) {
      const info = await lstat(dir);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
      expect(await readdir(dir)).toEqual([]);
    }
    await expect(verifyDockerDirsEmpty(dirs)).resolves.toBeUndefined();
  });

  it.each([
    ["config dir already exists", (d: { configDir: string }) => mkdir(d.configDir), /docker-config-b already exists/],
    ["home dir already exists", (d: { home: string }) => mkdir(d.home), /docker-home-b already exists/],
    ["config path is a file", (d: { configDir: string }) => writeFile(d.configDir, ""), /already exists/],
    ["config path is a symlink", (d: { configDir: string }) => symlink("/tmp", d.configDir), /already exists/],
    ["home path is a dangling symlink", (d: { home: string }) => symlink("/nonexistent-rh", d.home), /already exists/],
  ])("refuses when the %s", async (_label, make, message) => {
    const session = await scratch();
    const dirs = dockerDirs(session, "B");
    await make(dirs as never);
    await expect(prepareDockerDirs(dirs)).rejects.toThrow(message);
  });

  it.each([
    ["a file appeared in the config dir", async (d: { configDir: string }) => writeFile(join(d.configDir, "config.json"), "{}"), /docker-config-b must be empty/],
    ["the home dir was replaced by a symlink", async (d: { home: string }) => (await rm(d.home, { recursive: true }), await symlink("/tmp", d.home)), /docker-home-b must be a real directory/],
    ["the config dir disappeared", async (d: { configDir: string }) => rm(d.configDir, { recursive: true }), /docker-config-b must be a real directory/],
  ])("the pre-first-call check refuses when %s", async (_label, tamper, message) => {
    const session = await scratch();
    const dirs = dockerDirs(session, "B");
    await prepareDockerDirs(dirs);
    await tamper(dirs as never);
    await expect(verifyDockerDirsEmpty(dirs)).rejects.toThrow(message);
  });
});
