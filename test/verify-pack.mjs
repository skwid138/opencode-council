#!/usr/bin/env node
// Constructed-archive verification for @skwid138/opencode-council. Must run
// through test/run-isolated.mjs (npm run verify:pack / verify:consumer).
//
// Adapted from skwid138/opencode-command-normalizer test/verify-pack.mjs @
// 7ddab8d6d0d23a67b7dcc753248e4673885e2120 (see test/PROVENANCE.md). Local
// modifications: council package shape/exports/named API; static checks moved to
// test/pack-checks.mjs (V2 SDK, effect, eager vs deferred @opencode-ai/plugin,
// entry graph); runtime probes for deferred server() loading and setup() without
// any SDK; doctored-archive negative controls run on every invocation; a
// four-host consumer-compile matrix (V1 1.18.29 / 1.19.3, V2 2.0.28 / 2.0.32).
//
// Modes:
//   (default)               build with tsc via this Node, construct the archive with
//                           the system tar (test/pack-artifact.mjs, NO npm pack, NO
//                           lifecycle scripts), validate it, verify it in a clean
//                           consumer with NO host packages, then run the
//                           doctored-archive negative controls. No network, no npm.
//   --print-consumer-plan   additionally print the exact consumer-compile install
//                           commands without running them.
//   --consumer-types        (separately approved; USES THE NETWORK) additionally
//                           install the archive plus pinned host type packages into
//                           four throwaway consumers with --ignore-scripts and the
//                           launcher's disposable npm cache, then type-check root +
//                           ./server with skipLibCheck: false under NodeNext and
//                           Bundler. Any diagnostic, non-zero exit, signal, or
//                           timeout fails (test/consumer-compile.mjs).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateCompile } from "./consumer-compile.mjs";
import { assertIsolated, isInside, ROOT_VAR } from "./isolated-env.mjs";
import { buildPackageArchive, expectedPackageFiles, isCompiledTestArtifact, PACK_LIMITS, runTar } from "./pack-artifact.mjs";
import { consumerSdkTreeCheck, LABELS as STATIC_LABELS, staticProblems } from "./pack-checks.mjs";
import { listTarGz, tarCapFor, validateEntries } from "./real-host/artifacts.mjs";

assertIsolated();

const consumerTypes = process.argv.includes("--consumer-types");
const printPlan = process.argv.includes("--print-consumer-plan");
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const PLUGIN_ID = "skwid138.opencode-council";
const NAMED_EXPORTS = [
  "CouncilToolPlugin",
  "composeCouncilConfig",
  "default",
  "parseCouncilConfig",
  "raceWithTimeout",
  "resolveDebug",
  "validateCouncilConfig",
];

export const LABELS = Object.freeze({
  ...STATIC_LABELS,
  MEMBERS: "archive members are exactly the expected package files",
  TESTS: "archive contains no compiled test or type-test artifacts",
  SOURCES: "archive excludes sources, tests, and plans",
  IMPORT: "`.` and `./server` import with no host package installed",
  SAME_DEFAULT: "`.` and `./server` share one default object",
  SHAPE: `default export is the dual-host object { id: "${PLUGIN_ID}", server, setup }`,
  NAMED: "named exports are exactly the public API and default.server is CouncilToolPlugin",
  SERVER_DEFERS: "server() defers loading @opencode-ai/plugin until it is called",
  STUB_DEFERS: "with a stub @opencode-ai/plugin installed, importing `.` and `./server` neither requests nor evaluates it; calling server() does",
  SETUP: "setup() runs against a structural V2 context with no SDK installed",
});

// ---------------------------------------------------------------------------
// Consumer-compile matrix (pinned; installed only with --consumer-types).
// V2 consumers also pin the V1 types package: council's declarations reference
// @opencode-ai/plugin (its only peer), and an unpinned peer would otherwise be
// auto-installed from the registry at whatever version is latest.
const TOOLCHAIN = ["typescript@6.0.3", "@types/node@22.20.5"];
export const CONSUMER_MATRIX = Object.freeze([
  { label: "v1-1.18.29", family: "v1", packages: ["@opencode-ai/plugin@1.18.29", ...TOOLCHAIN] },
  { label: "v1-1.19.3", family: "v1", packages: ["@opencode-ai/plugin@1.19.3", ...TOOLCHAIN] },
  {
    label: "v2-2.0.28",
    family: "v2",
    packages: ["@opencode-ai/plugin@1.19.3", "@opencode/plugin@2.0.28", "@types/json-schema@7.0.15", ...TOOLCHAIN],
  },
  {
    label: "v2-2.0.32",
    family: "v2",
    packages: ["@opencode-ai/plugin@1.19.3", "@opencode/plugin@2.0.32", "@types/json-schema@7.0.15", ...TOOLCHAIN],
  },
]);
const INSTALL_FLAGS = ["--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"];
const INSTALL_ENV_OVERRIDES = { npm_config_userconfig: "/dev/null", npm_config_offline: "false" };

function sizeOf(path) {
  const result = spawnSync("du", ["-sk", path], { encoding: "utf8" });
  return result.status === 0 ? `${Math.round(Number(result.stdout.split(/\s/)[0]) / 1024)} MB` : "unknown";
}

/** Reporting only: resolved versions of the consumer's direct packages (read from node_modules). */
async function resolvedVersions(cwd, packages) {
  const names = [pkg.name, "@opencode-ai/sdk", ...packages.map((spec) => spec.slice(0, spec.lastIndexOf("@")))];
  const versions = [];
  for (const name of names) {
    const manifest = join(cwd, "node_modules", ...name.split("/"), "package.json");
    versions.push(`${name}@${existsSync(manifest) ? JSON.parse(await readFile(manifest, "utf8")).version : "MISSING"}`);
  }
  return versions;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Archive verification (shared by the real archive and every doctored archive).

/** Runs every check against `archivePath`; returns failures as { label, detail }. Never throws for check failures. */
async function verifyArchive(archivePath, expected, work, { log = () => {} } = {}) {
  const failures = [];
  const check = (label, ok, detail = "") => {
    log(`${ok ? "PASS" : "FAIL"} ${label}${detail && !ok ? ` — ${detail}` : ""}\n`);
    if (!ok) failures.push({ label, detail });
  };

  const buffer = await readFile(archivePath);
  const entries = listTarGz(buffer, { maxTarBytes: tarCapFor(PACK_LIMITS) });
  const expectedMembers = expected.map((name) => `package/${name}`);
  const validation = validateEntries(entries, { limits: PACK_LIMITS, members: { required: expectedMembers, allowed: expectedMembers } });
  check(LABELS.MEMBERS, validation.ok, validation.problems.join("; "));
  const names = entries.map((entry) => entry.name.replace(/^package\//, ""));
  const testArtifacts = names.filter(isCompiledTestArtifact);
  check(LABELS.TESTS, testArtifacts.length === 0, testArtifacts.join(", "));
  const sources = names.filter((name) => /^(src|test|\.project-plans)\//.test(name));
  check(LABELS.SOURCES, sources.length === 0, sources.join(", "));

  // Never extract an archive with link, escaping, or non-regular entries.
  const unsafe = entries.filter((entry) => entry.type !== "file" || entry.name.includes("..") || entry.name.startsWith("/"));
  if (unsafe.length > 0) {
    check("archive is safe to extract (regular files only)", false, unsafe.map((entry) => `${entry.name} (${entry.type})`).join(", "));
    return failures;
  }

  const consumer = await mkdtemp(join(work, "consumer-"));
  const installed = join(consumer, "node_modules", ...pkg.name.split("/"));
  await mkdir(installed, { recursive: true });
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }), "utf8");
  runTar(["-xzf", archivePath, "-C", installed, "--strip-components=1"]);
  const hostPackages = ["@opencode-ai/plugin", "@opencode-ai/sdk", "@opencode/plugin", "effect"];
  check(
    "clean consumer has no host SDK packages",
    hostPackages.every((name) => !existsSync(join(consumer, "node_modules", ...name.split("/")))),
  );

  const files = new Map();
  for (const name of names) files.set(name, await readFile(join(installed, name), "utf8"));
  const statics = staticProblems(files);
  for (const label of Object.values(STATIC_LABELS)) {
    const problem = statics.find((entry) => entry.label === label);
    check(label, !problem, problem?.detail ?? "");
  }

  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", RUNTIME_PROBE], { cwd: consumer, encoding: "utf8", timeout: 60_000 });
  let seen;
  try {
    seen = JSON.parse(probe.stdout);
  } catch {
    seen = { importError: `probe failed (${probe.status ?? probe.signal}): ${probe.stderr.trim().split("\n").slice(-3).join(" | ")}` };
  }
  check(LABELS.IMPORT, !seen.importError, seen.importError ?? "");
  if (seen.importError) {
    for (const label of [LABELS.SAME_DEFAULT, LABELS.SHAPE, LABELS.NAMED, LABELS.SERVER_DEFERS, LABELS.SETUP, LABELS.STUB_DEFERS]) check(label, false, "not reached: import failed");
    return failures;
  }
  check(LABELS.SAME_DEFAULT, seen.sameDefault === true);
  check(
    LABELS.SHAPE,
    JSON.stringify(seen.defaultKeys) === JSON.stringify(["id", "server", "setup"]) && seen.id === PLUGIN_ID && seen.serverIsFunction && seen.setupIsFunction,
    `${seen.defaultKeys.join(",")} id=${seen.id}`,
  );
  check(
    LABELS.NAMED,
    JSON.stringify(seen.rootNamed) === JSON.stringify(NAMED_EXPORTS) &&
      JSON.stringify(seen.serverNamed) === JSON.stringify(NAMED_EXPORTS) &&
      seen.serverIsNamedPlugin === true,
    `${seen.rootNamed.join(",")} serverIsNamedPlugin=${seen.serverIsNamedPlugin}`,
  );
  check(LABELS.SERVER_DEFERS, seen.serverDeferred === true, seen.serverOutcome ?? "");
  check(LABELS.SETUP, seen.setupOk === true, seen.setupOutcome ?? "");

  // Second probe, same consumer: install a stub @opencode-ai/plugin that records
  // when it is evaluated. Importing the package must not evaluate it; server() must.
  const stubDir = join(consumer, "node_modules", "@opencode-ai", "plugin");
  await mkdir(stubDir, { recursive: true });
  await writeFile(join(stubDir, "package.json"), JSON.stringify({ name: "@opencode-ai/plugin", version: "0.0.0-stub", type: "module", exports: { ".": "./index.js" } }), "utf8");
  await writeFile(join(stubDir, "index.js"), STUB_V1_PLUGIN, "utf8");
  const stubProbe = spawnSync(process.execPath, ["--input-type=module", "-e", STUB_PROBE], { cwd: consumer, encoding: "utf8", timeout: 60_000 });
  let stub;
  try {
    stub = JSON.parse(stubProbe.stdout);
  } catch {
    stub = { error: `stub probe failed (${stubProbe.status ?? stubProbe.signal}): ${stubProbe.stderr.trim().split("\n").slice(-3).join(" | ")}` };
  }
  check(
    LABELS.STUB_DEFERS,
    stub.loadedAfterImport === false && stub.loadedAfterServer === true && stub.registered === true,
    stub.error ?? `requestedAfterImport=${stub.requestedAfterImport} afterImport=${stub.loadedAfterImport} afterServer=${stub.loadedAfterServer} registered=${stub.registered}`,
  );
  return failures;
}

// Minimal stand-in for @opencode-ai/plugin: flags its own evaluation and provides
// just enough of \`tool\` / \`tool.schema\` for server() to register council_review.
const STUB_V1_PLUGIN = `globalThis.__councilV1Loaded = true;
export function tool(input) { return input; }
const stringSchema = { describe: () => stringSchema };
tool.schema = { string: () => stringSchema };
`;

// Deterministic barrier: a synchronous module resolve hook (node:module
// registerHooks, Node >= 22.15) records every request for @opencode-ai/plugin.
// The hook runs inside the import() call itself, so once \`await import(root)\`
// returns, every module-level import() — static or dynamic — has already been
// recorded, without waiting on timers and without the probe loading the stub.
// The stub's own evaluation flag is checked too (belt and braces), and after
// server() both must be set.
const STUB_PROBE = `
import { registerHooks } from "node:module";
globalThis.__councilV1Loaded = false;
let requested = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin" || specifier.startsWith("@opencode-ai/plugin/")) requested += 1;
    return nextResolve(specifier, context);
  },
});
const out = {};
try {
  const root = await import(${JSON.stringify(pkg.name)});
  await import(${JSON.stringify(`${pkg.name}/server`)});
  out.requestedAfterImport = requested;
  out.loadedAfterImport = globalThis.__councilV1Loaded === true || requested > 0;
  const v1ctx = { client: { app: { log: async () => ({}) }, session: {} }, directory: "/consumer" };
  const hooks = await root.default.server(v1ctx, { council: { models: [{ providerID: "p", modelID: "a" }, { providerID: "p", modelID: "b" }] } });
  out.loadedAfterServer = globalThis.__councilV1Loaded === true && requested > 0;
  out.registered = typeof hooks?.tool?.council_review?.execute === "function";
} catch (error) {
  out.error = String(error?.code ?? "") + " " + String(error?.message ?? error).split("\\n")[0];
}
process.stdout.write(JSON.stringify(out));
`;

// Runs inside the clean consumer (no host packages installed).
const RUNTIME_PROBE = `
const out = {};
let root, server;
try {
  root = await import(${JSON.stringify(pkg.name)});
  server = await import(${JSON.stringify(`${pkg.name}/server`)});
} catch (error) {
  out.importError = String(error?.code ?? "") + " " + String(error?.message ?? error).split("\\n")[0];
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
out.rootNamed = Object.keys(root).sort();
out.serverNamed = Object.keys(server).sort();
out.sameDefault = root.default === server.default;
out.defaultKeys = Object.keys(root.default ?? {}).sort();
out.id = root.default?.id;
out.serverIsFunction = typeof root.default?.server === "function";
out.setupIsFunction = typeof root.default?.setup === "function";
out.serverIsNamedPlugin = root.default?.server === root.CouncilToolPlugin;

// server(): importing the package must not need @opencode-ai/plugin; calling
// server() must be what tries to load it (absent here -> ERR_MODULE_NOT_FOUND).
const models = [{ providerID: "p", modelID: "a" }, { providerID: "p", modelID: "b" }];
try {
  const v1ctx = { client: { app: { log: async () => ({}) }, session: {} }, directory: "/consumer" };
  await root.default.server(v1ctx, { council: { models } });
  out.serverOutcome = "server() resolved without @opencode-ai/plugin installed";
} catch (error) {
  out.serverOutcome = String(error?.code) + " " + String(error?.message).split("\\n")[0];
  out.serverDeferred = error?.code === "ERR_MODULE_NOT_FOUND" && String(error?.message).includes("@opencode-ai/plugin");
}

// setup(): runs against a structural V2 context with no SDK installed.
try {
  const tools = [];
  const registration = { dispose: async () => {} };
  const v2ctx = {
    options: { council: { models } },
    agent: { transform: async (cb) => { cb({ update: (_id, fn) => fn({ request: { settings: {}, headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }) }); return registration; }, get: async () => ({ data: {} }) },
    tool: { transform: async (cb) => { cb({ add: (tool) => tools.push(tool) }); return registration; } },
    session: {},
    permission: { hook: async () => registration },
  };
  const cleanup = await root.default.setup(v2ctx);
  const tool = tools.find((entry) => entry.name === "council_review");
  await cleanup();
  out.setupOk = typeof cleanup === "function" && tool?.options?.codemode === false && typeof tool?.execute === "function";
  out.setupOutcome = "tools=" + tools.map((entry) => entry.name).join(",");
} catch (error) {
  out.setupOk = false;
  out.setupOutcome = String(error?.code ?? "") + " " + String(error?.message).split("\\n")[0];
}
process.stdout.write(JSON.stringify(out));
`;

// ---------------------------------------------------------------------------
// Doctored-archive negative controls: each mutates a copy of the verified
// archive and must be caught by the named check(s) through verifyArchive.

const DOCTORINGS = [
  {
    name: "extra compiled type-test artifact",
    expect: [LABELS.MEMBERS, LABELS.TESTS],
    mutate: async (pkgDir) => void (await writeFile(join(pkgDir, "dist", "v2.test-d.js"), "export {};\n")),
  },
  {
    name: "nested stale compiled test",
    expect: [LABELS.MEMBERS, LABELS.TESTS],
    mutate: async (pkgDir) => {
      await mkdir(join(pkgDir, "dist", "old"), { recursive: true });
      await writeFile(join(pkgDir, "dist", "old", "orchestrator.test.js"), "export {};\n");
    },
  },
  {
    name: "missing production module",
    expect: [LABELS.MEMBERS, LABELS.GRAPH_BUILTINS, LABELS.IMPORT],
    mutate: (pkgDir) => rm(join(pkgDir, "dist", "v2-permissions.js")),
  },
  {
    name: "eager static @opencode-ai/plugin import in the entry",
    expect: [LABELS.EAGER_V1, LABELS.GRAPH_BUILTINS, LABELS.IMPORT],
    mutate: (pkgDir) => prepend(join(pkgDir, "dist", "index.js"), 'import "@opencode-ai/plugin";\n'),
  },
  {
    name: "top-level await of @opencode-ai/plugin in v1.js (eager despite dynamic syntax)",
    expect: [LABELS.DEFERRED_V1, LABELS.IMPORT],
    mutate: (pkgDir) => append(join(pkgDir, "dist", "v1.js"), 'await import("@opencode-ai/plugin");\n'),
  },
  {
    name: "static effect import",
    expect: [LABELS.EFFECT, LABELS.GRAPH_BUILTINS, LABELS.IMPORT],
    mutate: (pkgDir) => prepend(join(pkgDir, "dist", "v2.js"), 'import { Effect } from "effect";\n'),
  },
  {
    name: "deferred V2 SDK runtime import",
    expect: [LABELS.V2_SDK],
    mutate: (pkgDir) => append(join(pkgDir, "dist", "v2.js"), 'export const loadSdk = () => import("@opencode/plugin");\n'),
  },
  {
    name: "V2 SDK type import in a declaration",
    expect: [LABELS.V2_SDK],
    mutate: (pkgDir) => prepend(join(pkgDir, "dist", "v2-contract.d.ts"), 'import type { Plugin } from "@opencode/plugin";\n'),
  },
  {
    name: "default export without setup",
    expect: [LABELS.SHAPE],
    mutate: (pkgDir) => replaceIn(join(pkgDir, "dist", "index.js"), "server: CouncilToolPlugin, setup }", "server: CouncilToolPlugin }"),
  },
  {
    name: "wrong plugin id",
    expect: [LABELS.SHAPE],
    mutate: (pkgDir) => replaceIn(join(pkgDir, "dist", "index.js"), `id: "${PLUGIN_ID}"`, 'id: "other.plugin"'),
  },
  {
    name: "./server resolves to a different default object",
    expect: [LABELS.MEMBERS, LABELS.EXPORTS, LABELS.SAME_DEFAULT],
    mutate: async (pkgDir) => {
      await writeFile(join(pkgDir, "dist", "server.js"), 'import plugin from "./index.js";\nexport * from "./index.js";\nexport default { ...plugin };\n');
      const manifestPath = join(pkgDir, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.exports["./server"] = { import: "./dist/server.js" };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    },
  },
  {
    // Evades the count-based static check (still one dynamic import in v1.js)
    // and the missing-package probe (server() still rejects with the original
    // ERR_MODULE_NOT_FOUND); only the stub-evaluation probe catches it.
    name: "module-level eager import(\"@opencode-ai/plugin\") awaited later by server()",
    expect: [LABELS.STUB_DEFERS],
    mutate: async (pkgDir) => {
      const file = join(pkgDir, "dist", "v1.js");
      await replaceIn(file, 'const { tool } = await import("@opencode-ai/plugin");', "const __v1 = await __eagerV1; if (__v1 instanceof Error) throw __v1; const { tool } = __v1;");
      await prepend(file, 'const __eagerV1 = import("@opencode-ai/plugin").catch((e) => e);\n');
    },
  },
  {
    name: "server() no longer defers the V1 host import",
    expect: [LABELS.SERVER_DEFERS],
    mutate: (pkgDir) => replaceIn(join(pkgDir, "dist", "v1.js"), 'const { tool } = await import("@opencode-ai/plugin");', 'const tool = Object.assign((d) => d, { schema: { string: () => ({ describe: () => ({}) }) } }); void (() => import("@opencode-ai/plugin"));'),
  },
  {
    name: "setup() broken",
    expect: [LABELS.SETUP],
    mutate: (pkgDir) => replaceIn(join(pkgDir, "dist", "v2.js"), "export const setup = createV2Setup();", 'export const setup = async () => { throw new Error("doctored"); };'),
  },
  {
    name: "runtime dependency added to the manifest",
    expect: [LABELS.MANIFEST_DEPS],
    mutate: async (pkgDir) => {
      const manifestPath = join(pkgDir, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.dependencies = { effect: "^3.0.0" };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    },
  },
  {
    name: "symlink member",
    expect: [LABELS.MEMBERS],
    mutate: async (pkgDir) => {
      await rm(join(pkgDir, "dist", "prompts.js"));
      await symlink("/etc/passwd", join(pkgDir, "dist", "prompts.js"));
    },
  },
];

async function replaceIn(path, from, to) {
  const text = await readFile(path, "utf8");
  if (!text.includes(from)) throw new Error(`doctoring anchor not found in ${path}: ${from}`);
  await writeFile(path, text.replace(from, to));
}
const prepend = async (path, text) => writeFile(path, text + (await readFile(path, "utf8")));
const append = async (path, text) => writeFile(path, (await readFile(path, "utf8")) + text);

async function listMembers(dir, prefix = "package") {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${item.name}`;
    if (item.isDirectory()) found.push(...(await listMembers(join(dir, item.name), rel)));
    else found.push(rel);
  }
  return found.sort();
}

async function doctoredArchive(work, archivePath, doctoring, index) {
  const root = join(work, `doctored-${index}`);
  await mkdir(root);
  runTar(["-xzf", archivePath, "-C", root]);
  await doctoring.mutate(join(root, "package"));
  const out = join(work, `doctored-${index}.tgz`);
  runTar(["--format=ustar", "--numeric-owner", "-czf", out, "-C", root, ...(await listMembers(join(root, "package")))]);
  return out;
}

async function runNegativeControls(work, archivePath, expected) {
  const problems = [];
  for (const [index, doctoring] of DOCTORINGS.entries()) {
    const failures = await verifyArchive(await doctoredArchive(work, archivePath, doctoring, index), expected, work);
    const caught = failures.map((failure) => failure.label);
    const missed = doctoring.expect.filter((label) => !caught.includes(label));
    const ok = failures.length > 0 && missed.length === 0;
    process.stdout.write(`${ok ? "PASS" : "FAIL"} negative control "${doctoring.name}" → caught: ${caught.join(" | ") || "nothing"}\n`);
    if (!ok) problems.push(`negative control "${doctoring.name}" missed: ${missed.join(" | ") || "(no failure at all)"}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Consumer compile (network; only with --consumer-types).

const consumerSource = (family) => {
  const v1 = `
import plugin, {
  composeCouncilConfig,
  CouncilToolPlugin,
  parseCouncilConfig,
  raceWithTimeout,
  resolveDebug,
  validateCouncilConfig,
} from "${pkg.name}";
import serverEntry from "${pkg.name}/server";
import type { Plugin as V1Plugin, PluginModule } from "@opencode-ai/plugin";

const v1Module: PluginModule = plugin;
const v1Server: V1Plugin = plugin.server;
const v1Named: V1Plugin = CouncilToolPlugin;
const sameShape: typeof plugin = serverEntry;
const id: string = plugin.id;
const parsed = parseCouncilConfig({ council: { models: [] } });
const reviewer: string = parsed.reviewer;
const composed: boolean = composeCouncilConfig({}).debug;
const sameParser: typeof parseCouncilConfig = validateCouncilConfig;
const debug: boolean = resolveDebug({});
const raced: Promise<number> = raceWithTimeout(Promise.resolve(1), 10, "x");

// Negative controls: declarations resolved to real types, not \`any\`.
// @ts-expect-error id is a string
const notANumber: number = plugin.id;
// @ts-expect-error the V1 host Plugin type is a real function type
const notAV1Plugin: V1Plugin = "not a plugin";
// @ts-expect-error a V1 plugin module needs a server function
const badModule: PluginModule = { id: "x" };

export { v1Module, v1Server, v1Named, sameShape, id, reviewer, composed, sameParser, debug, raced, notANumber, notAV1Plugin, badModule };
`;
  if (family === "v1") return v1;
  return `${v1}
import type { Plugin as V2 } from "@opencode/plugin";

const v2Root: V2.Plugin = plugin;
const v2Server: V2.Plugin = serverEntry;
const v2Defined: Parameters<typeof V2.define>[0] = plugin;
declare const hostContext: V2.Context;
const cleanup: Promise<unknown> = plugin.setup(hostContext);

// Negative controls: the V2 host types are real, and a malformed plugin is rejected.
// @ts-expect-error the V2 host Plugin type is not any
const notAV2Plugin: V2.Plugin = "not a plugin";
// @ts-expect-error setup must be a function
const malformedV2Plugin: V2.Plugin = { id: "malformed", setup: 42 };
// @ts-expect-error a V2 plugin needs an id
const missingId: V2.Plugin = { setup: plugin.setup };

export { v2Root, v2Server, v2Defined, cleanup, notAV2Plugin, malformedV2Plugin, missingId };
`;
};

const baselineSource = (family) =>
  `import type { Plugin } from "@opencode-ai/plugin";\ndeclare const p: Plugin;\nexport { p };\n` +
  (family === "v2" ? `import type { Plugin as V2 } from "@opencode/plugin";\ndeclare const q: V2.Plugin;\nexport { q };\n` : "");

const tsconfigFor = (moduleResolution, file) =>
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: moduleResolution === "NodeNext" ? "NodeNext" : "ESNext",
        moduleResolution,
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: ["node"],
      },
      files: [file],
    },
    null,
    2,
  );

function consumerPlan(work, archiveName) {
  return CONSUMER_MATRIX.map((row) => ({
    ...row,
    cwd: join(work, `consumer-${row.label}`),
    args: ["install", ...INSTALL_FLAGS, `./${archiveName}`, ...row.packages],
  }));
}

function printConsumerPlan(work, archiveName) {
  const cache = process.env.npm_config_cache ?? "(unset)";
  process.stdout.write(`\nconsumer-compile plan (NOT RUN; requires --consumer-types and approval):\n`);
  process.stdout.write(`  npm cache: ${cache} (disposable, inside ${ROOT_VAR}=${process.env[ROOT_VAR]})\n`);
  process.stdout.write(`  npm globalconfig: ${process.env.npm_config_globalconfig} (empty file); userconfig override: /dev/null\n`);
  for (const step of consumerPlan(work, archiveName)) {
    process.stdout.write(`  [${step.label}] cwd=${step.cwd}\n`);
    process.stdout.write(`  [${step.label}] $ ${Object.entries(INSTALL_ENV_OVERRIDES).map(([k, v]) => `${k}=${v}`).join(" ")} npm ${step.args.join(" ")}\n`);
    process.stdout.write(`  [${step.label}] then: node node_modules/typescript/bin/tsc -p tsconfig.consumer.ts.{NodeNext,Bundler}.json\n`);
  }
}

async function typedConsumers(work, archivePath, check) {
  const cache = process.env.npm_config_cache ?? "";
  const realCache = join(userInfo().homedir, ".npm");
  if (!isInside(cache, process.env[ROOT_VAR]) || isInside(cache, realCache)) {
    throw new Error(`refusing to install: npm cache ${cache || "(unset)"} is not inside the disposable test root`);
  }
  for (const step of consumerPlan(work, basename(archivePath))) {
    await mkdir(step.cwd, { recursive: true });
    await writeFile(join(step.cwd, "package.json"), JSON.stringify({ name: `consumer-${step.label}`, private: true, type: "module" }), "utf8");
    await copyFile(archivePath, join(step.cwd, basename(archivePath)));
    process.stdout.write(`[${step.label}] $ npm ${step.args.join(" ")}\n`);
    const started = Date.now();
    run("npm", step.args, { cwd: step.cwd, env: { ...process.env, ...INSTALL_ENV_OVERRIDES }, timeout: 300_000 });
    process.stdout.write(`[${step.label}] install finished in ${((Date.now() - started) / 1000).toFixed(1)}s; node_modules ${sizeOf(join(step.cwd, "node_modules"))}\n`);
    process.stdout.write(`[${step.label}] resolved: ${(await resolvedVersions(step.cwd, step.packages)).join(" ")}\n`);

    const manifest = JSON.parse(await readFile(join(step.cwd, "node_modules", ...pkg.name.split("/"), "package.json"), "utf8"));
    check(`${step.label}: installed manifest is the packed version`, manifest.version === pkg.version, manifest.version);
    const tree = consumerSdkTreeCheck(
      step.family,
      existsSync(join(step.cwd, "node_modules", ...(step.family === "v1" ? ["@opencode"] : ["@opencode", "plugin"]))),
    );
    check(`${step.label}: ${tree.label}`, tree.ok);

    await writeFile(join(step.cwd, "consumer.ts"), consumerSource(step.family), "utf8");
    await writeFile(join(step.cwd, "baseline.ts"), baselineSource(step.family), "utf8");
    const tsc = join(step.cwd, "node_modules", "typescript", "bin", "tsc");
    for (const resolution of ["NodeNext", "Bundler"]) {
      const compile = async (file) => {
        const tsconfig = `tsconfig.${file}.${resolution}.json`;
        await writeFile(join(step.cwd, tsconfig), tsconfigFor(resolution, file), "utf8");
        return spawnSync(process.execPath, [tsc, "-p", tsconfig], { cwd: step.cwd, encoding: "utf8", timeout: 120_000 });
      };
      const compileStarted = Date.now();
      const verdict = evaluateCompile(await compile("consumer.ts"));
      process.stdout.write(`[${step.label}] tsc ${resolution}: ${verdict.ok ? "clean" : "DIAGNOSTICS"} in ${((Date.now() - compileStarted) / 1000).toFixed(1)}s\n`);
      check(`${step.label}: tsc (${resolution}, strict, skipLibCheck: false) root + ./server + negative controls`, verdict.ok, [...verdict.reasons, ...verdict.errors].join("\n"));
      if (!verdict.ok) {
        const baseline = evaluateCompile(await compile("baseline.ts"));
        process.stdout.write(`  DIAGNOSTIC ONLY: host-types-only baseline ${baseline.ok ? "compiles cleanly" : `reports: ${[...baseline.reasons, ...baseline.errors].join(" | ")}`}\n`);
      }
    }
  }
}

// ---------------------------------------------------------------------------

const failures = [];
const check = (label, ok, detail = "") => {
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${label}${detail && !ok ? ` — ${detail}` : ""}\n`);
  if (!ok) failures.push(label);
};

const work = await mkdtemp(join(tmpdir(), "pack-verify-"));
try {
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const expected = await expectedPackageFiles(repoRoot);
  const archive = await buildPackageArchive({
    repoRoot,
    workDir: work,
    // The only build step: the TypeScript compiler run with this Node. No package-manager lifecycle.
    build: async () => void run(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: repoRoot }),
    // Runs only after the archive passed bounded validation (exact members, regular files, caps, bytes).
    consumerChecks: async ({ archivePath, members }) => {
      process.stdout.write(`constructed ${basename(archivePath)} (${members.length} regular files, validated before extraction)\n`);
      const own = await verifyArchive(archivePath, expected, work, { log: (line) => process.stdout.write(line) });
      for (const failure of own) failures.push(failure.label);
      if (own.length > 0) throw new Error(`archive checks failed: ${own.map((f) => f.label).join("; ")}`);

      process.stdout.write("\nnegative controls (doctored copies of this archive):\n");
      for (const problem of await runNegativeControls(work, archivePath, expected)) {
        failures.push(problem);
        process.stdout.write(`FAIL ${problem}\n`);
      }

      if (printPlan) printConsumerPlan(work, basename(archivePath));
      if (consumerTypes) {
        await typedConsumers(work, archivePath, check);
        process.stdout.write(`disposable npm cache size: ${sizeOf(process.env.npm_config_cache ?? "")}\n`);
      }
      else process.stdout.write("\nNOT VERIFIED consumer type-check (separately approved: --consumer-types)\n");
      if (failures.length > 0) throw new Error(`verification failed: ${failures.join("; ")}`);
    },
  });
  process.stdout.write(`constructed archive sha256 ${archive.sha256} (${archive.size} bytes; temporary, not retained)\n`);
} catch (error) {
  if (failures.length === 0) failures.push(error instanceof Error ? error.message : String(error));
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`pack verification failed: ${failures.length} failure(s)\n`);
  process.exit(1);
}
process.stdout.write("pack verification passed\n");
