// Council-only Vitest worker guard (not copied). `npm test` must never reach
// Docker, npm, or curl: real-host runs, Gate A downloads, and Gate P acquisition go
// through `npm run test:real-host` with explicit gate approvals, and every real-host
// module takes an injected runner. This guard makes any docker / npm / npx /
// node npm-cli.js / curl invocation through node:child_process throw synchronously,
// before a process is created, in every test worker.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

export const GUARD = Symbol.for("council.noDockerGuard");
const MESSAGES = {
  docker: "docker is forbidden during npm test (real-host runs use `npm run test:real-host` with gate approvals)",
  npm: "npm is forbidden during npm test (Gate P acquisition runs only via `npm run test:real-host` with approval)",
  curl: "curl is forbidden during npm test (Gate A downloads run only via `npm run test:real-host` with approval)",
};

const isDockerToken = (token) => /(^|\/)docker(\.exe)?$/i.test(token ?? "");
const isNpmToken = (token) => /(^|\/)(npm|npx)(\.cmd|\.exe)?$/i.test(token ?? "");
const isCurlToken = (token) => /(^|\/)curl(\.exe)?$/i.test(token ?? "");
const isNodeToken = (token) => /(^|\/)node(\.exe)?$/i.test(token ?? "");
const isNpmCli = (arg) => /(^|\/)npm-cli\.js$/.test(String(arg));

/** "docker" | "npm" | "curl" | null for one executable + its argv. */
function classifyExec(command, list) {
  if (isDockerToken(command)) return "docker";
  if (isNpmToken(command)) return "npm";
  if (isCurlToken(command)) return "curl";
  if (isNodeToken(command) && list.some(isNpmCli)) return "npm";
  return null;
}

const SHELLS = /(^|\/)(sh|bash|zsh|dash|ksh)$/;
function classifyCommandLine(line) {
  for (const segment of String(line).split(/[;&|()\n`]+/)) {
    const tokens = segment.trim().replace(/^(exec|env|command|nohup|sudo)\s+/, "").split(/\s+/).filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
    const kind = tokens.length > 0 ? classifyExec(tokens[0], tokens.slice(1)) : null;
    if (kind) return kind;
  }
  return null;
}

/**
 * "docker" | "npm" | "curl" | null: what forbidden CLI the call would start (directly, via a
 * shell command line or a shell's -c script, via `env`, or `node .../npm-cli.js`).
 */
export function classifyInvocation(command, args = [], options) {
  if (typeof command !== "string") return null;
  const list = Array.isArray(args) ? args.map(String) : [];
  const shell = options?.shell === true || typeof options?.shell === "string";
  if (shell) return classifyCommandLine([command, ...list].join(" "));
  const direct = classifyExec(command, list);
  if (direct) return direct;
  if (SHELLS.test(command)) {
    for (let index = 1; index < list.length; index += 1) {
      if (/^-\w*c\w*$/.test(list[index - 1])) {
        const kind = classifyCommandLine(list[index]);
        if (kind) return kind;
      }
    }
    return null;
  }
  if (/(^|\/)env$/.test(command)) {
    const rest = list.filter((arg) => !arg.includes("=") && !arg.startsWith("-"));
    return rest.length > 0 ? classifyExec(rest[0], rest.slice(1)) : null;
  }
  return null;
}

export const invokesDocker = (command, args, options) => classifyInvocation(command, args, options) === "docker";
export const invokesForbidden = (command, args, options) => classifyInvocation(command, args, options) !== null;

if (!globalThis[GUARD]) {
  const wrap = (name, classify) => {
    const original = childProcess[name];
    childProcess[name] = function guarded(...args) {
      const kind = classify(...args);
      if (kind) throw new Error(MESSAGES[kind]);
      return original.apply(this, args);
    };
  };
  const optionsOf = (rest) => rest.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg));
  const argsOf = (rest) => (Array.isArray(rest[0]) ? rest[0] : []);
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    wrap(name, (command, ...rest) => classifyInvocation(command, argsOf(rest), optionsOf(rest)));
  }
  wrap("exec", (command) => classifyInvocation(command, [], { shell: true }));
  wrap("execSync", (command) => classifyInvocation(command, [], { shell: true }));
  syncBuiltinESMExports();
  globalThis[GUARD] = true;
}
