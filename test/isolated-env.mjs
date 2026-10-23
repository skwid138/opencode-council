// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/isolated-env.mjs
// Local modifications (see test/PROVENANCE.md): ROOT_VAR renamed to COUNCIL_TEST_ROOT (must not match /^OPENCODE/i); root prefix "opencode-council-test-".
// Shared test-isolation helpers used by the launcher, the vitest config guard,
// and the worker setup guard. Plain ESM so it loads before any TypeScript
// transform. Environment isolation is a test-hygiene boundary, not a
// filesystem security sandbox.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export const ROOT_VAR = "COUNCIL_TEST_ROOT";
export const XDG_VARS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];
export const TEMP_VARS = ["TMPDIR", "TMP", "TEMP"];

/** Inherited variables that could point tools at live OpenCode or npm config/auth. */
export function isClearedVariable(name) {
  return /^OPENCODE/i.test(name) || /^npm_config_/i.test(name) || /^NPM_TOKEN$/i.test(name) || /^NODE_AUTH_TOKEN$/i.test(name);
}

export function isInside(path, root) {
  if (typeof path !== "string" || path === "") return false;
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Creates an owned disposable root and returns it with its child layout. If
 * any initialization after the root is created fails, removes that root (and
 * nothing else) before rethrowing, so callers never receive a partial layout.
 */
export async function createIsolationRoot(parent = tmpdir()) {
  const created = await mkdtemp(join(parent, "opencode-council-test-"));
  try {
    const root = await realpath(created);
    const layout = {
      root,
      home: join(root, "home"),
      xdg: {
        XDG_CONFIG_HOME: join(root, "xdg", "config"),
        XDG_DATA_HOME: join(root, "xdg", "data"),
        XDG_STATE_HOME: join(root, "xdg", "state"),
        XDG_CACHE_HOME: join(root, "xdg", "cache"),
      },
      tmp: join(root, "tmp"),
      npmUserConfig: join(root, "npm", "userconfig"),
      npmGlobalConfig: join(root, "npm", "globalconfig"),
      npmCache: join(root, "npm", "cache"),
    };
    for (const dir of [layout.home, ...Object.values(layout.xdg), layout.tmp, layout.npmCache]) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(layout.npmUserConfig, "", "utf8");
    await writeFile(layout.npmGlobalConfig, "", "utf8");
    return layout;
  } catch (error) {
    await rm(created, { recursive: true, force: true });
    throw error;
  }
}

/** Builds a child environment pinned to the isolation layout. */
export function buildIsolatedEnv(baseEnv, layout) {
  const env = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined || isClearedVariable(name)) continue;
    env[name] = value;
  }
  env[ROOT_VAR] = layout.root;
  env.HOME = layout.home;
  Object.assign(env, layout.xdg);
  for (const name of TEMP_VARS) env[name] = layout.tmp;
  env.npm_config_userconfig = layout.npmUserConfig;
  env.npm_config_globalconfig = layout.npmGlobalConfig;
  env.npm_config_cache = layout.npmCache;
  env.npm_config_offline = "true";
  env.npm_config_update_notifier = "false";
  env.npm_config_fund = "false";
  env.npm_config_audit = "false";
  return env;
}

/** Returns human-readable isolation violations; empty when isolated. */
export function isolationProblems(env = process.env, home = homedir(), temp = tmpdir()) {
  const root = env[ROOT_VAR];
  if (typeof root !== "string" || root === "") {
    return [`${ROOT_VAR} is not set; run tests through test/run-isolated.mjs (npm test)`];
  }
  const problems = [];
  if (!isInside(env.HOME, root)) problems.push("HOME is outside the isolation root");
  if (!isInside(home, root)) problems.push("os.homedir() is outside the isolation root");
  for (const name of XDG_VARS) if (!isInside(env[name], root)) problems.push(`${name} is outside the isolation root`);
  for (const name of TEMP_VARS) if (!isInside(env[name], root)) problems.push(`${name} is outside the isolation root`);
  if (!isInside(temp, root)) problems.push("os.tmpdir() is outside the isolation root");
  const leaked = Object.keys(env).filter((name) => /^OPENCODE/i.test(name));
  if (leaked.length > 0) problems.push(`inherited OpenCode variables present: ${leaked.join(", ")}`);
  return problems;
}

export function assertIsolated(env = process.env, home = homedir(), temp = tmpdir()) {
  const problems = isolationProblems(env, home, temp);
  if (problems.length > 0) {
    throw new Error(`Refusing to run tests without environment isolation:\n- ${problems.join("\n- ")}`);
  }
}

/** Removes only a root this process created. */
export async function removeIsolationRoot(layout) {
  await rm(layout.root, { recursive: true, force: true });
}
