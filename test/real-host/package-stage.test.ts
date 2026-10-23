import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { planPluginCache, PACKAGE_NAME, readPackedArchive, writeTree } from "./package-stage.mjs";
import { tgz } from "./tar-fixture";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-pkg-")));
  created.push(dir);
  return dir;
}
const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const MANIFEST = JSON.stringify({ name: PACKAGE_NAME, version: "0.3.0", type: "module", peerDependencies: { "@opencode-ai/plugin": "^1.15.0" } });

async function archiveFile(items: { name: string; data?: string; type?: string; linkname?: string }[]) {
  const dir = await scratch();
  const buffer = tgz(items);
  const path = join(dir, "council.tgz");
  await writeFile(path, buffer);
  return { path, sha256: sha256(buffer) };
}

const packageFiles = () => new Map([["package.json", Buffer.from(MANIFEST)], ["dist/index.js", Buffer.from("export default {};\n")]]);

describe("packed council archive", () => {
  it("reads the package files after verifying the archive digest", async () => {
    const archive = await archiveFile([{ name: "package/package.json", data: MANIFEST }, { name: "package/dist/index.js", data: "export default {};\n" }]);
    const { manifest, files } = await readPackedArchive(archive);
    expect(manifest).toMatchObject({ name: PACKAGE_NAME, version: "0.3.0" });
    expect([...files.keys()]).toEqual(["package.json", "dist/index.js"]);
  });

  it("rejects a digest mismatch, entries outside package/, links, and a foreign package name", async () => {
    const good = await archiveFile([{ name: "package/package.json", data: MANIFEST }]);
    await expect(readPackedArchive({ ...good, sha256: "0".repeat(64) })).rejects.toThrow(/digest mismatch/);
    await expect(readPackedArchive(await archiveFile([{ name: "package/package.json", data: MANIFEST }, { name: "evil.js", data: "x" }]))).rejects.toThrow(/outside package\//);
    await expect(readPackedArchive(await archiveFile([{ name: "package/package.json", data: MANIFEST }, { name: "package/x", type: "2", linkname: "/etc" }]))).rejects.toThrow(/link entry/);
    await expect(readPackedArchive(await archiveFile([{ name: "package/package.json", data: JSON.stringify({ name: "other", version: "1.0.0" }) }]))).rejects.toThrow(/package name/);
  });
});

describe("plugin cache preseed plan (exact spec)", () => {
  it("lays out the V1 npm plugin cache plus the config-dir node_modules and package-lock root naming @opencode-ai/plugin", () => {
    const plan = planPluginCache({ family: "v1", hostVersion: "1.19.3", manifest: JSON.parse(MANIFEST), files: packageFiles() });
    expect(plan.spec).toBe("@skwid138/opencode-council@0.3.0");
    expect(plan.cache.map((entry: { rel: string }) => entry.rel)).toEqual([
      "opencode/packages/@skwid138/opencode-council@0.3.0/node_modules/@skwid138/opencode-council/package.json",
      "opencode/packages/@skwid138/opencode-council@0.3.0/node_modules/@skwid138/opencode-council/dist/index.js",
    ]);
    expect(plan.config).toEqual([
      { rel: "opencode/node_modules", type: "dir" },
      { rel: "opencode/package.json", type: "file", data: Buffer.from(`${JSON.stringify({ dependencies: { "@opencode-ai/plugin": "1.19.3" } }, null, 2)}\n`) },
      {
        rel: "opencode/package-lock.json",
        type: "file",
        data: Buffer.from(`${JSON.stringify({ name: "opencode", lockfileVersion: 3, requires: true, packages: { "": { dependencies: { "@opencode-ai/plugin": "1.19.3" } } } }, null, 2)}\n`),
      },
    ]);
    // The V1 server() lazily imports this peer; with reify skipped it must be seeded separately.
    expect(plan.unresolvedPeers).toEqual(["@opencode-ai/plugin"]);
  });

  it("lays out the V2 npm cache generation 1 with package.json, package-lock.json, and node_modules", () => {
    const plan = planPluginCache({ family: "v2", hostVersion: "2.0.32", manifest: JSON.parse(MANIFEST), files: packageFiles() });
    const base = "opencode/npm/@skwid138/opencode-council@0.3.0/1";
    expect(plan.cache.map((entry: { rel: string }) => entry.rel)).toEqual([
      `${base}/package.json`,
      `${base}/package-lock.json`,
      `${base}/node_modules/@skwid138/opencode-council/package.json`,
      `${base}/node_modules/@skwid138/opencode-council/dist/index.js`,
    ]);
    expect(JSON.parse(plan.cache[0].data.toString())).toEqual({ dependencies: { [PACKAGE_NAME]: "0.3.0" } });
    expect(JSON.parse(plan.cache[1].data.toString())).toEqual({
      lockfileVersion: 3,
      requires: true,
      packages: { "": { dependencies: { [PACKAGE_NAME]: "0.3.0" } }, [`node_modules/${PACKAGE_NAME}`]: { version: "0.3.0" } },
    });
    expect(plan.config).toEqual([]);
    expect(plan.unresolvedPeers).toEqual([]);
  });

  it("seeds extra packages next to the plugin so a peer closure can be supplied", () => {
    const plan = planPluginCache({
      family: "v1",
      hostVersion: "1.19.3",
      manifest: JSON.parse(MANIFEST),
      files: packageFiles(),
      extraPackages: [{ name: "@opencode-ai/plugin", version: "1.19.3", files: new Map([["package.json", Buffer.from("{}")]]) }],
    });
    expect(plan.cache.at(-1).rel).toBe("opencode/packages/@skwid138/opencode-council@0.3.0/node_modules/@opencode-ai/plugin/package.json");
    expect(plan.unresolvedPeers).toEqual([]);
  });

  it("seeds a verified V1 closure tree as council siblings, nested paths preserved, without synthesizing a spec-root package.json or lock", () => {
    const extraTree = new Map([
      ["@opencode-ai/plugin/package.json", Buffer.from("{}")],
      ["@opencode-ai/plugin/node_modules/effect/dist/index.js", Buffer.from("x")],
      ["zod/package.json", Buffer.from("{}")],
    ]);
    const plan = planPluginCache({ family: "v1", hostVersion: "1.19.3", manifest: JSON.parse(MANIFEST), files: packageFiles(), extraTree });
    const prefix = "opencode/packages/@skwid138/opencode-council@0.3.0";
    expect(plan.cache.map((entry: { rel: string }) => entry.rel).slice(2)).toEqual([
      `${prefix}/node_modules/@opencode-ai/plugin/package.json`,
      `${prefix}/node_modules/@opencode-ai/plugin/node_modules/effect/dist/index.js`,
      `${prefix}/node_modules/zod/package.json`,
    ]);
    expect(plan.cache.some((entry: { rel: string }) => entry.rel === `${prefix}/package.json` || entry.rel === `${prefix}/package-lock.json`)).toBe(false);
    expect(plan.unresolvedPeers).toEqual([]);
  });

  it("refuses a closure tree that would overwrite the council package or is offered to V2", () => {
    const clash = new Map([["@skwid138/opencode-council/package.json", Buffer.from("{}")]]);
    expect(() => planPluginCache({ family: "v1", hostVersion: "1.19.3", manifest: JSON.parse(MANIFEST), files: packageFiles(), extraTree: clash })).toThrow(/collides with the council package/);
    expect(() => planPluginCache({ family: "v2", hostVersion: "2.0.32", manifest: JSON.parse(MANIFEST), files: packageFiles(), extraTree: new Map([["zod/package.json", Buffer.from("{}")]]) })).toThrow(/V1 only/);
  });

  it("refuses a non-exact version and unsafe file paths", () => {
    expect(() => planPluginCache({ family: "v2", hostVersion: "2.0.32", manifest: { name: PACKAGE_NAME, version: "^0.3.0" }, files: packageFiles() })).toThrow(/exact version/);
    expect(() => planPluginCache({ family: "v2", hostVersion: "2.0.32", manifest: JSON.parse(MANIFEST), files: new Map([["../x", Buffer.from("")]]) })).toThrow(/unsafe/);
  });

  it("writes a plan under a root without overwriting, creating dirs and 0644 files", async () => {
    const root = await scratch();
    const plan = planPluginCache({ family: "v1", hostVersion: "1.19.3", manifest: JSON.parse(MANIFEST), files: packageFiles() });
    await writeTree(root, [...plan.cache, ...plan.config]);
    expect(await readFile(join(root, plan.cache[1].rel), "utf8")).toBe("export default {};\n");
    expect((await stat(join(root, "opencode/node_modules"))).isDirectory()).toBe(true);
    expect((await stat(join(root, plan.cache[0].rel))).mode & 0o777).toBe(0o644);
    await expect(writeTree(root, plan.cache)).rejects.toThrow(/EEXIST/);
  });
});
