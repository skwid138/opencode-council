import { describe, expect, it } from "vitest";

import { consumerSdkTreeCheck, LABELS, moduleSpecifiers, staticProblems } from "./pack-checks.mjs";

const MANIFEST = JSON.stringify({
  name: "@skwid138/opencode-council",
  exports: {
    ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
    "./server": { import: "./dist/index.js" },
  },
  peerDependencies: { "@opencode-ai/plugin": "^1.15.0" },
  devDependencies: { "@opencode/plugin": "2.0.32" },
});

/** A miniature shipped dist mirroring council's real import shape. */
function shipped(overrides: Record<string, string | null> = {}) {
  const files = new Map<string, string>([
    ["package.json", MANIFEST],
    ["dist/index.js", 'import { CouncilToolPlugin } from "./v1.js";\nimport { setup } from "./v2.js";\nexport default { id: "skwid138.opencode-council", server: CouncilToolPlugin, setup };\n'],
    ["dist/index.d.ts", 'import { CouncilToolPlugin } from "./v1.js";\ndeclare const _default: { server: import("@opencode-ai/plugin").Plugin };\nexport default _default;\n'],
    [
      "dist/v1.js",
      '// `@opencode-ai/plugin` is only imported dynamically inside server()\nimport { createLogger } from "./logging.js";\nexport const CouncilToolPlugin = async () => {\n    const { tool } = await import("@opencode-ai/plugin");\n    return { tool };\n};\n',
    ],
    ["dist/v1.d.ts", 'import type { Plugin } from "@opencode-ai/plugin";\nexport declare const CouncilToolPlugin: Plugin;\n'],
    ["dist/v2.js", '/* never imports `@opencode/plugin` */\nimport { homedir } from "node:os";\nimport { createLogger } from "./logging.js";\nexport const setup = async () => homedir;\n'],
    ["dist/v2.d.ts", 'import type { V2SetupContext } from "./v2-contract.js";\nexport declare const setup: (ctx: V2SetupContext) => Promise<void>;\n'],
    ["dist/v2-contract.d.ts", "/** TYPE-ONLY: nothing here imports `@opencode/plugin` or `effect`. */\nexport type V2SetupContext = {};\n"],
    ["dist/logging.js", "export const createLogger = () => () => {};\n"],
  ]);
  for (const [name, text] of Object.entries(overrides)) {
    if (text === null) files.delete(name);
    else files.set(name, text);
  }
  return files;
}

const labelsOf = (files: Map<string, string>) => staticProblems(files).map((problem: { label: string }) => problem.label);

describe("module specifier scan", () => {
  it("separates static imports/re-exports from dynamic imports and ignores comments and object literals", () => {
    expect(
      moduleSpecifiers(
        [
          '// imports `@opencode/plugin` never',
          'import a from "./a.js";',
          'import "side-effect";',
          "import {\n  b,\n  c,\n} from 'multi-line';",
          'export * from "./re.js";',
          'export { d } from "./d.js";',
          'export default { id: "x", server };',
          'const m = await import("lazy");',
        ].join("\n"),
      ),
    ).toEqual([
      { specifier: "./a.js", kind: "static" },
      { specifier: "side-effect", kind: "static" },
      { specifier: "multi-line", kind: "static" },
      { specifier: "./re.js", kind: "static" },
      { specifier: "./d.js", kind: "static" },
      { specifier: "lazy", kind: "dynamic" },
    ]);
  });
});

describe("shipped-file static checks", () => {
  it("accepts council's real shape: V1 types in declarations and one deferred dynamic V1 import in v1.js", () => {
    expect(staticProblems(shipped())).toEqual([]);
  });

  it("rejects a static @opencode-ai/plugin import reachable from the entry graph", () => {
    expect(labelsOf(shipped({ "dist/index.js": `import "@opencode-ai/plugin";\n${shipped().get("dist/index.js")}` }))).toEqual(
      expect.arrayContaining([LABELS.EAGER_V1, LABELS.GRAPH_BUILTINS]),
    );
  });

  it("rejects a static @opencode-ai/plugin import in a transitively imported module", () => {
    expect(labelsOf(shipped({ "dist/logging.js": 'import { tool } from "@opencode-ai/plugin";\nexport const createLogger = tool;\n' }))).toEqual(
      expect.arrayContaining([LABELS.EAGER_V1]),
    );
  });

  it("rejects a second (or misplaced) dynamic @opencode-ai/plugin import", () => {
    expect(labelsOf(shipped({ "dist/v2.js": `${shipped().get("dist/v2.js")}export const x = () => import("@opencode-ai/plugin");\n` }))).toEqual([
      LABELS.DEFERRED_V1,
    ]);
    expect(labelsOf(shipped({ "dist/v1.js": "export const CouncilToolPlugin = async () => ({});\n" }))).toEqual([LABELS.DEFERRED_V1]);
  });

  it("rejects any V2 SDK reference: static JS, deferred dynamic JS, or declaration type import", () => {
    expect(labelsOf(shipped({ "dist/v2.js": 'import { Plugin } from "@opencode/plugin";\nexport const setup = Plugin;\n' }))).toEqual(
      expect.arrayContaining([LABELS.V2_SDK, LABELS.GRAPH_BUILTINS]),
    );
    expect(labelsOf(shipped({ "dist/v2.js": 'export const setup = async () => import("@opencode/plugin");\n' }))).toEqual([LABELS.V2_SDK]);
    expect(labelsOf(shipped({ "dist/v2-contract.d.ts": 'export type { Plugin } from "@opencode/plugin";\n' }))).toEqual([LABELS.V2_SDK]);
    expect(labelsOf(shipped({ "dist/v2.d.ts": 'export declare const setup: import("@opencode/plugin").Plugin["setup"];\n' }))).toEqual([LABELS.V2_SDK]);
  });

  it("rejects an effect import, static or dynamic", () => {
    expect(labelsOf(shipped({ "dist/v2.js": 'import { Effect } from "effect";\nexport const setup = Effect;\n' }))).toEqual(
      expect.arrayContaining([LABELS.EFFECT, LABELS.GRAPH_BUILTINS]),
    );
    expect(labelsOf(shipped({ "dist/v2.js": 'export const setup = () => import("effect/Schema");\n' }))).toEqual([LABELS.EFFECT]);
  });

  it("rejects a non-builtin bare static import in the entry graph", () => {
    expect(labelsOf(shipped({ "dist/logging.js": 'import chalk from "chalk";\nexport const createLogger = chalk;\n' }))).toEqual([
      LABELS.GRAPH_BUILTINS,
    ]);
  });

  it("rejects a broken relative import in the entry graph", () => {
    expect(labelsOf(shipped({ "dist/logging.js": null }))).toEqual([LABELS.GRAPH_BUILTINS]);
  });

  it("rejects exports that no longer map `.` and `./server` to dist/index.js", () => {
    const manifest = JSON.parse(MANIFEST);
    manifest.exports["./server"] = { import: "./dist/server.js" };
    expect(labelsOf(shipped({ "package.json": JSON.stringify(manifest) }))).toEqual([LABELS.EXPORTS]);
  });

  it("rejects runtime dependencies or extra peers in the shipped manifest", () => {
    const withDeps = { ...JSON.parse(MANIFEST), dependencies: { effect: "^3.0.0" } };
    expect(labelsOf(shipped({ "package.json": JSON.stringify(withDeps) }))).toEqual([LABELS.MANIFEST_DEPS]);
    const withPeer = { ...JSON.parse(MANIFEST), peerDependencies: { "@opencode-ai/plugin": "^1.15.0", "@opencode/plugin": "^2" } };
    expect(labelsOf(shipped({ "package.json": JSON.stringify(withPeer) }))).toEqual([LABELS.MANIFEST_DEPS]);
  });
});

describe("consumer SDK-tree check (consumer-compile)", () => {
  it("asserts absence of the V2 SDK tree for V1 consumers", () => {
    expect(consumerSdkTreeCheck("v1", false)).toEqual({ label: "V1-only consumer has no V2 SDK tree (@opencode/*)", ok: true });
    expect(consumerSdkTreeCheck("v1", true)).toEqual({ label: "V1-only consumer has no V2 SDK tree (@opencode/*)", ok: false });
  });

  it("asserts presence of @opencode/plugin for V2 consumers, under an accurate label", () => {
    expect(consumerSdkTreeCheck("v2", true)).toEqual({ label: "V2 consumer has the V2 SDK (@opencode/plugin) installed", ok: true });
    expect(consumerSdkTreeCheck("v2", false)).toEqual({ label: "V2 consumer has the V2 SDK (@opencode/plugin) installed", ok: false });
  });
});
