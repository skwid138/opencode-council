// Static inspection of shipped package files for test/verify-pack.mjs.
// Written for @skwid138/opencode-council (not copied); the specifier scan is
// adapted from the inline scan in skwid138/opencode-command-normalizer
// test/verify-pack.mjs @ 7ddab8d6d0d23a67b7dcc753248e4673885e2120.
//
// Pure functions over a Map<package-relative path, text>; no file-system access,
// so tests can feed doctored inputs directly.
import { posix } from "node:path";

export const LABELS = Object.freeze({
  V2_SDK: "no shipped file references the V2 SDK (@opencode/*): static, dynamic, or type import",
  EFFECT: "no shipped file imports effect",
  EAGER_V1: "entry graph has no static (eager) @opencode-ai/plugin import",
  GRAPH_BUILTINS: "entry graph statically imports only node: builtins and existing relative modules",
  DEFERRED_V1: "@opencode-ai/plugin is loaded exactly once, by a deferred dynamic import in dist/v1.js",
  EXPORTS: "package exports `.` and `./server` both map to dist/index.js (types on `.`)",
  MANIFEST_DEPS: "shipped manifest has no runtime dependencies and only the @opencode-ai/plugin peer",
});

export const ENTRY = "dist/index.js";
export const V1_HOST = "@opencode-ai/plugin";
export const DEFERRED_V1_FILE = "dist/v1.js";

// Statement-anchored static forms: `import x from "y"`, `import "y"`,
// `import type {..} from "y"`, `export * from "y"`, `export {..} from "y"`.
const STATIC = /(?:^|[;\n}])\s*(?:import|export)\b(?:[^"'`;()]*?\bfrom)?\s*["']([^"']+)["']/g;
// `import("y")` — a deferred runtime import in JS, a type reference in .d.ts.
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Module specifiers in source order, tagged static or dynamic. */
export function moduleSpecifiers(text) {
  const found = [];
  for (const match of text.matchAll(STATIC)) found.push({ index: match.index + match[0].lastIndexOf(match[1]), specifier: match[1], kind: "static" });
  for (const match of text.matchAll(DYNAMIC)) found.push({ index: match.index, specifier: match[1], kind: "dynamic" });
  return found.sort((a, b) => a.index - b.index).map(({ specifier, kind }) => ({ specifier, kind }));
}

const isRelative = (specifier) => specifier.startsWith("./") || specifier.startsWith("../");
const isEffect = (specifier) => specifier === "effect" || specifier.startsWith("effect/");

/** Static relative closure from the entry module. */
export function entryGraph(files, entry = ENTRY) {
  const visited = [];
  const staticBare = [];
  const missing = [];
  const queue = [entry];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const file = queue.shift();
    const text = files.get(file);
    if (text === undefined) continue;
    visited.push(file);
    for (const { specifier, kind } of moduleSpecifiers(text)) {
      if (kind !== "static") continue;
      if (!isRelative(specifier)) {
        staticBare.push({ file, specifier });
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!files.has(target)) missing.push({ file, specifier });
      else if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return { visited, staticBare, missing };
}

/** Every static/manifest problem as { label, detail }, one entry per violated label. */
export function staticProblems(files) {
  const problems = new Map();
  const add = (label, detail) => problems.set(label, [...(problems.get(label) ?? []), detail]);
  const shipped = [...files.keys()].filter((name) => name.startsWith("dist/") && (name.endsWith(".js") || name.endsWith(".d.ts")));

  const dynamicV1 = [];
  for (const file of shipped) {
    for (const { specifier, kind } of moduleSpecifiers(files.get(file))) {
      if (specifier.startsWith("@opencode/")) add(LABELS.V2_SDK, `${file}: ${kind} ${specifier}`);
      if (isEffect(specifier)) add(LABELS.EFFECT, `${file}: ${kind} ${specifier}`);
      if (file.endsWith(".js") && kind === "dynamic" && specifier === V1_HOST) dynamicV1.push(file);
    }
  }
  if (dynamicV1.length !== 1 || dynamicV1[0] !== DEFERRED_V1_FILE) {
    add(LABELS.DEFERRED_V1, `dynamic ${V1_HOST} imports found in: ${dynamicV1.join(", ") || "none"}`);
  }

  if (!files.has(ENTRY)) add(LABELS.GRAPH_BUILTINS, `missing entry ${ENTRY}`);
  const graph = entryGraph(files);
  for (const { file, specifier } of graph.staticBare) {
    if (specifier.startsWith("@opencode-ai/")) add(LABELS.EAGER_V1, `${file}: static ${specifier}`);
    if (!specifier.startsWith("node:")) add(LABELS.GRAPH_BUILTINS, `${file}: static ${specifier}`);
  }
  for (const { file, specifier } of graph.missing) add(LABELS.GRAPH_BUILTINS, `${file}: unresolved ${specifier}`);

  let manifest;
  try {
    manifest = JSON.parse(files.get("package.json") ?? "");
  } catch {
    add(LABELS.EXPORTS, "package.json is missing or not JSON");
    add(LABELS.MANIFEST_DEPS, "package.json is missing or not JSON");
  }
  if (manifest) {
    const root = manifest.exports?.["."] ?? {};
    const server = manifest.exports?.["./server"] ?? {};
    if (root.import !== "./dist/index.js" || root.types !== "./dist/index.d.ts" || server.import !== "./dist/index.js") {
      add(LABELS.EXPORTS, JSON.stringify(manifest.exports ?? null));
    }
    const deps = Object.keys(manifest.dependencies ?? {});
    const optional = Object.keys(manifest.optionalDependencies ?? {});
    const peers = Object.keys(manifest.peerDependencies ?? {});
    if (deps.length > 0 || optional.length > 0 || JSON.stringify(peers) !== JSON.stringify([V1_HOST])) {
      add(LABELS.MANIFEST_DEPS, `dependencies=${JSON.stringify(deps)} optional=${JSON.stringify(optional)} peers=${JSON.stringify(peers)}`);
    }
  }

  return [...problems].map(([label, details]) => ({ label, detail: details.join("; ") }));
}

/**
 * Consumer-compile SDK-tree check, per consumer family. V1 consumers must NOT
 * receive the V2 SDK tree (`node_modules/@opencode`); V2 consumers must have
 * `@opencode/plugin` installed. `present` is the respective existence probe.
 */
export function consumerSdkTreeCheck(family, present) {
  return family === "v1"
    ? { label: "V1-only consumer has no V2 SDK tree (@opencode/*)", ok: !present }
    : { label: "V2 consumer has the V2 SDK (@opencode/plugin) installed", ok: present };
}
