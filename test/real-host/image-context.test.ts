import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { inspectClosure } from "./closure.mjs";
import { BASE_IMAGE_ID, dockerfileProblems } from "./gates.mjs";
import { assembleImageContext, harnessClosure } from "./image-context.mjs";
import { tgz } from "./tar-fixture";

const HARNESS = dirname(fileURLToPath(import.meta.url));
const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-ctx-")));
  created.push(dir);
  return dir;
}
const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const MANIFEST = JSON.stringify({ name: "@skwid138/opencode-council", version: "0.3.0", peerDependencies: { "@opencode-ai/plugin": "^1.15.0" } });

async function inputs() {
  const dir = await scratch();
  const exe = Buffer.from("#!/bin/sh\necho 2.0.32\n");
  await writeFile(join(dir, "opencode-2.0.32"), exe, { mode: 0o755 });
  const archive = tgz([{ name: "package/package.json", data: MANIFEST }, { name: "package/dist/index.js", data: "export default {};\n" }]);
  await writeFile(join(dir, "council.tgz"), archive);
  return {
    hostExecutable: { path: join(dir, "opencode-2.0.32"), sha256: sha256(exe), provenance: { archive: { sha256: "c".repeat(64) }, member: "package/bin/opencode" } },
    packedArchive: { path: join(dir, "council.tgz"), sha256: sha256(archive) },
  };
}

describe("harness closure", () => {
  it("collects driver.mjs and everything it imports (static and dynamic), node: builtins only, no tests", async () => {
    const closure = await harnessClosure(HARNESS, "driver.mjs");
    expect(closure).toContain("driver.mjs");
    expect(closure).toContain("runner.mjs");
    expect(closure).toContain("fake-provider.mjs");
    expect(closure).toContain("artifacts.mjs");
    expect(closure.some((file: string) => file.endsWith(".test.ts") || file.endsWith(".ts"))).toBe(false);
    expect(closure).not.toContain("controller.mjs");
    expect(closure).not.toContain("acquire.mjs");
  });

  it.each([
    ["a bare package import", 'import chalk from "chalk";\n', /bare specifier chalk/],
    ["a dynamic bare import", 'export const x = () => import("@opencode-ai/plugin");\n', /bare specifier @opencode-ai\/plugin/],
    ["an escaping relative import", 'import "../outside.mjs";\n', /escapes the harness/],
    ["a missing relative import", 'import "./missing.mjs";\n', /missing/],
  ])("rejects %s", async (_label, source, message) => {
    const dir = await scratch();
    await writeFile(join(dir, "driver.mjs"), source);
    await expect(harnessClosure(dir, "driver.mjs")).rejects.toThrow(message);
  });
});

describe("assembleImageContext", () => {
  it("writes only allowlisted files, a valid COPY-only Dockerfile, and a hashed manifest", async () => {
    const parent = await scratch();
    const contextDir = join(parent, "ctx");
    const result = await assembleImageContext({ contextDir, hostId: "v2-2.0.32", runId: "r1", harnessDir: HARNESS, ...(await inputs()) });

    const dockerfile = await readFile(join(contextDir, "Dockerfile"), "utf8");
    expect(dockerfileProblems(dockerfile, { baseImageId: BASE_IMAGE_ID })).toEqual([]);
    expect(dockerfile.split("\n")[0]).toBe(`FROM ${BASE_IMAGE_ID}`);
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/node","/opt/council-rh/driver.mjs"]');
    expect((await readdir(contextDir)).sort()).toEqual(["Dockerfile", "bin", "harness", "meta", "plugin-cache"]);
    expect(await readdir(join(contextDir, "bin"))).toEqual(["opencode-2.0.32"]);
    expect((await stat(join(contextDir, "bin", "opencode-2.0.32"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(contextDir, "harness", "driver.mjs"))).mode & 0o777).toBe(0o644);

    // Gate C verifies these labels on the built image (docker image inspect) against the Gate B receipt.
    const imageManifestBytes = await readFile(join(contextDir, "meta", "image-manifest.json"));
    expect(result.imageManifestSha256).toBe(sha256(imageManifestBytes));
    expect(dockerfile).toContain(`LABEL council-rh.image-manifest-sha256=${sha256(imageManifestBytes)}\n`);
    expect(dockerfile).toContain(`LABEL council-rh.archive-sha256=${result.imageManifest.archiveSha256}\n`);
    expect(dockerfile).toContain("LABEL council-rh.owner=r1\n");
    expect(dockerfile).toContain("LABEL council-rh.host=v2-2.0.32\n");

    const imageManifest = JSON.parse(await readFile(join(contextDir, "meta", "image-manifest.json"), "utf8"));
    expect(imageManifest).toMatchObject({ runId: "r1", baseImageId: BASE_IMAGE_ID, archiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/), host: { id: "v2-2.0.32", executablePath: "/opt/council-rh/bin/opencode-2.0.32" } });
    const cells = JSON.parse(await readFile(join(contextDir, "meta", "cells.json"), "utf8"));
    expect(cells).toContain("v2-2.0.32:s1:1");
    expect(cells).toContain("v2-2.0.32:probe:1");
    expect(cells.every((id: string) => id.startsWith("v2-2.0.32:"))).toBe(true);
    expect(await readFile(join(contextDir, "plugin-cache", "cache", "opencode", "npm", "@skwid138", "opencode-council@0.3.0", "1", "node_modules", "@skwid138", "opencode-council", "dist", "index.js"), "utf8")).toBe("export default {};\n");

    // The manifest lists every context file with its digest, and its own digest is reported.
    const listed = result.manifest.files.map((file: { path: string }) => file.path);
    expect(listed).toContain("Dockerfile");
    expect(listed).toContain("bin/opencode-2.0.32");
    for (const file of result.manifest.files) expect(sha256(await readFile(join(contextDir, file.path)))).toBe(file.sha256);
    expect(result.manifestSha256).toBe(sha256(Buffer.from(JSON.stringify(result.manifest))));
  });

  it("refuses a non-empty context dir and a host executable hash mismatch", async () => {
    const parent = await scratch();
    const busy = join(parent, "busy");
    await mkdir(busy);
    await writeFile(join(busy, "x"), "x");
    await expect(assembleImageContext({ contextDir: busy, hostId: "v2-2.0.32", runId: "r1", harnessDir: HARNESS, ...(await inputs()) })).rejects.toThrow(/must not exist/);
    const bad = await inputs();
    bad.hostExecutable.sha256 = "0".repeat(64);
    await expect(assembleImageContext({ contextDir: join(parent, "ctx2"), hostId: "v2-2.0.32", runId: "r1", harnessDir: HARNESS, ...bad })).rejects.toThrow(/sha256 mismatch/);
  });

  it("fails closed for V1 while @opencode-ai/plugin (lazily imported by server()) is not seeded", async () => {
    const parent = await scratch();
    const v1 = await inputs();
    await expect(assembleImageContext({ contextDir: join(parent, "v1"), hostId: "v1-1.19.3", runId: "r1", harnessDir: HARNESS, ...v1 })).rejects.toThrow(/unresolved peer.*@opencode-ai\/plugin/);
  });
});

/** Minimal accepted Gate P closure on disk + its receipt. */
async function closure({ runId = "r1", approval = "user-msg-p" } = {}) {
  const session = await scratch();
  const dir = join(session, "closure");
  const lockPackages: Record<string, unknown> = { "": { dependencies: { "@opencode-ai/plugin": "1.19.3" } } };
  for (const [key, version] of [["node_modules/@opencode-ai/plugin", "1.19.3"], ["node_modules/@opencode-ai/plugin/node_modules/effect", "4.0.0"], ["node_modules/zod", "4.1.8"]]) {
    lockPackages[key] = { version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity: "sha512-x" };
    await mkdir(join(dir, key, "dist"), { recursive: true });
    await writeFile(join(dir, key, "package.json"), JSON.stringify({ name: key.split("node_modules/").pop(), version }));
    await writeFile(join(dir, key, "dist", "index.js"), `// ${key}\n`);
  }
  await writeFile(join(dir, "package.json"), "{}");
  await writeFile(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: lockPackages }));
  await writeFile(join(dir, "node_modules", ".package-lock.json"), "{}");
  const inspection = await inspectClosure({ closureDir: dir });
  expect(inspection.problems).toEqual([]);
  const receipt = { schema: "council-rh-closure/1", status: "accepted", receiptId: `closure-${runId}-${inspection.lockfileSha256.slice(0, 12)}`, runId, approval, lockfileSha256: inspection.lockfileSha256, files: inspection.files, problems: [] };
  return { dir, receipt, approval };
}

describe("V1 contexts with a Gate P closure (Amendment A2)", () => {
  const SPEC_ROOT = ["plugin-cache", "cache", "opencode", "packages", "@skwid138", "opencode-council@0.3.0"];

  it("copies the verified closure next to the plugin with nested paths preserved and records the receipt in the image manifest", async () => {
    const parent = await scratch();
    const contextDir = join(parent, "v1");
    const gateP = await closure();
    const result = await assembleImageContext({ contextDir, hostId: "v1-1.19.3", runId: "r1", harnessDir: HARNESS, ...(await inputs()), closure: gateP });
    const modules = join(contextDir, ...SPEC_ROOT, "node_modules");
    expect(await readFile(join(modules, "@opencode-ai", "plugin", "node_modules", "effect", "dist", "index.js"), "utf8")).toBe("// node_modules/@opencode-ai/plugin/node_modules/effect\n");
    expect(await readFile(join(modules, "zod", "package.json"), "utf8")).toContain('"4.1.8"');
    expect((await readdir(join(contextDir, ...SPEC_ROOT))).sort()).toEqual(["node_modules"]);
    expect((await readdir(modules)).sort()).toEqual(["@opencode-ai", "@skwid138", "zod"]);
    expect(result.imageManifest.closure).toEqual({ receiptId: gateP.receipt.receiptId, lockfileSha256: gateP.receipt.lockfileSha256, plugin: "@opencode-ai/plugin@1.19.3" });
    expect(result.imageManifest.unresolvedPeers).toEqual([]);
  });

  it.each([
    ["a rejected receipt", (g: Awaited<ReturnType<typeof closure>>) => (g.receipt.status = "rejected"), /rejected/],
    ["a run-id mismatch", (g: Awaited<ReturnType<typeof closure>>) => (g.receipt.runId = "other"), /run id/],
    ["an approval mismatch", (g: Awaited<ReturnType<typeof closure>>) => (g.approval = "user-msg-other"), /approval/],
  ])("refuses %s (no context written)", async (_label, mutate, message) => {
    const parent = await scratch();
    const gateP = await closure();
    mutate(gateP);
    await expect(assembleImageContext({ contextDir: join(parent, "v1"), hostId: "v1-1.19.3", runId: "r1", harnessDir: HARNESS, ...(await inputs()), closure: gateP })).rejects.toThrow(message);
    expect(await readdir(parent)).toEqual([]);
  });

  it.each([
    ["a changed file", async (dir: string) => writeFile(join(dir, "node_modules", "zod", "dist", "index.js"), "// tampered\n"), /changed: zod\/dist\/index\.js/],
    ["an extra file", async (dir: string) => writeFile(join(dir, "node_modules", "zod", "extra.js"), "x"), /extra: zod\/extra\.js/],
    ["a missing file", async (dir: string) => rm(join(dir, "node_modules", "zod", "dist", "index.js")), /missing: zod\/dist\/index\.js/],
  ])("refuses a closure with %s since Gate P", async (_label, mutate, message) => {
    const parent = await scratch();
    const gateP = await closure();
    await mutate(gateP.dir);
    await expect(assembleImageContext({ contextDir: join(parent, "v1"), hostId: "v1-1.19.3", runId: "r1", harnessDir: HARNESS, ...(await inputs()), closure: gateP })).rejects.toThrow(message);
    expect(await readdir(parent)).toEqual([]);
  });

  it("leaves V2 unchanged: no closure files and no closure in the image manifest", async () => {
    const parent = await scratch();
    const result = await assembleImageContext({ contextDir: join(parent, "v2"), hostId: "v2-2.0.32", runId: "r1", harnessDir: HARNESS, ...(await inputs()), closure: await closure() });
    expect(result.imageManifest.closure).toBeNull();
    expect(result.manifest.files.some((file: { path: string }) => file.path.includes("node_modules/zod"))).toBe(false);
  });
});
