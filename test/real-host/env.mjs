// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/env.mjs
// Local modifications (see test/PROVENANCE.md): none.
// Real-host fixture layout and host-process environment allowlist.
//
// Unlike test/isolated-env.mjs (unit-test hygiene: copies the inherited
// environment and clears a few prefixes), the real-host environment is built
// from scratch. Nothing is inherited. Every key must be allowlisted, every
// path must be inside the fixture or a fixed system directory, and no value
// may point into the real user's home. This is still not a security boundary
// on its own; the OS sandbox (sandbox.mjs) is separate and unproven.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export const BASE_KEYS = ["HOME", "PATH", "TMPDIR", "LANG", "SHELL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];

/**
 * Extra keys a run may set explicitly. OPENCODE_CONFIG_CONTENT is deliberately
 * absent: the plan forbids it. Additional host switches must be added here by
 * a reviewed change, never passed through from the caller's environment.
 */
export const EXTRA_ALLOWED_KEYS = ["OPENCODE_CONFIG", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_SERVER_PASSWORD"];

/**
 * The one secret-shaped key the host env may carry: a fixture-only server
 * password the harness generates per host launch (contracts "auth"). Its value
 * must have the harness format, so a real inherited password can never pass.
 */
export const HARNESS_SECRET_KEYS = { OPENCODE_SERVER_PASSWORD: /^rh-[A-Za-z0-9_-]{43}$/ };

export function generateServerPassword() {
  return `rh-${randomBytes(32).toString("base64url")}`;
}

export const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
/** The shell the host env advertises (SHELL); the sandbox profile allows exactly this path. */
export const HOST_SHELL = "/bin/bash";

const FORBIDDEN_KEY = /(PROXY|^SSH_|TOKEN|SECRET|PASSWORD|API_KEY|^AWS_|^GH_|^GITHUB_|^NPM_|^npm_config_|^BUN_|^NODE_|^OPENCODE_CONFIG_CONTENT$|^OPENCODE_CONFIG_DIR$)/i;

export function isInside(path, root) {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) return false;
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Creates a fresh canonical (realpath) fixture root and its layout under `parent`. */
export async function createFixture(parent, { label }) {
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error(`invalid fixture label: ${label}`);
  const created = await mkdtemp(join(parent, `rh-${label}-`));
  try {
    const root = await realpath(created);
    const fixture = {
      root,
      home: join(root, "home"),
      xdg: {
        XDG_CONFIG_HOME: join(root, "xdg", "config"),
        XDG_DATA_HOME: join(root, "xdg", "data"),
        XDG_STATE_HOME: join(root, "xdg", "state"),
        XDG_CACHE_HOME: join(root, "xdg", "cache"),
      },
      tmp: join(root, "tmp"),
      logs: join(root, "logs"),
      project: join(root, "project"),
      bin: join(root, "home", "bin"),
      run: join(root, "run"),
      evidence: join(root, "evidence"),
    };
    for (const dir of [fixture.home, ...Object.values(fixture.xdg), fixture.tmp, fixture.logs, fixture.project, fixture.bin, fixture.run, fixture.evidence]) {
      await mkdir(dir, { recursive: true });
    }
    return fixture;
  } catch (error) {
    await rm(created, { recursive: true, force: true });
    throw error;
  }
}

/** Removes the fixture root. Callers must stop owned processes first (supervisor.removeRootIfSafe). */
export async function removeFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

function pathDirProblem(dir, fixture, realHome) {
  if (!isAbsolute(dir)) return `PATH entry is not absolute: ${dir}`;
  if (realHome && isInside(dir, realHome) && !isInside(dir, fixture.root)) return `PATH entry is inside the real home: ${dir}`;
  if (!isInside(dir, fixture.root) && !SYSTEM_PATH_DIRS.includes(dir)) return `PATH entry is outside the fixture and system dirs: ${dir}`;
  return null;
}

/** Builds the host environment from scratch. Throws on any disallowed input. */
export function buildHostEnv(fixture, { pathDirs, extra = {} }, { realHome } = {}) {
  for (const dir of pathDirs) {
    const problem = pathDirProblem(dir, fixture, realHome);
    if (problem) throw new Error(problem);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!EXTRA_ALLOWED_KEYS.includes(key)) throw new Error(`environment key ${key} is not allowlisted`);
    if (HARNESS_SECRET_KEYS[key] && !HARNESS_SECRET_KEYS[key].test(String(value))) throw new Error(`${key} must be a harness-generated fixture password`);
  }
  return {
    HOME: fixture.home,
    PATH: pathDirs.join(":"),
    TMPDIR: fixture.tmp,
    LANG: "C",
    SHELL: HOST_SHELL,
    ...fixture.xdg,
    ...extra,
  };
}

/** Returns human-readable problems; empty when the environment is acceptable. */
export function hostEnvProblems(env, fixture, { realHome }) {
  const problems = [];
  for (const [key, value] of Object.entries(env)) {
    if (HARNESS_SECRET_KEYS[key]) {
      if (!HARNESS_SECRET_KEYS[key].test(String(value))) problems.push(`${key} is not a harness-generated fixture password`);
    } else if (FORBIDDEN_KEY.test(key)) problems.push(`${key} is forbidden in the host environment`);
    else if (!BASE_KEYS.includes(key) && !EXTRA_ALLOWED_KEYS.includes(key)) problems.push(`${key} is not allowlisted`);
    if (typeof value === "string" && realHome && (value === realHome || value.split(":").some((part) => isInside(part, realHome) && !isInside(part, fixture.root)))) {
      problems.push(`${key} points into the real home`);
    }
  }
  if (!isInside(env.HOME, fixture.root)) problems.push("HOME is outside the fixture root");
  for (const key of Object.keys(fixture.xdg)) if (!isInside(env[key], fixture.root)) problems.push(`${key} is outside the fixture root`);
  if (!isInside(env.TMPDIR, fixture.root)) problems.push("TMPDIR is outside the fixture root");
  for (const dir of (env.PATH ?? "").split(":")) {
    const problem = pathDirProblem(dir, fixture, realHome);
    if (problem) problems.push(problem);
  }
  return problems;
}
