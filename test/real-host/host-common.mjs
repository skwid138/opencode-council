// Council-only helpers shared by host-v1.mjs / host-v2.mjs.
import { isAbsolute } from "node:path";

import { assertLoopbackBaseURL } from "./http.mjs";

export const FAKE_PROVIDER_ID = "fake";
export const FAKE_API_KEY = "fixture-placeholder-not-a-credential";
export const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
export const str = (value) => (typeof value === "string" ? value : null);
export const seg = (value) => encodeURIComponent(value);

const EXACT_SPEC = /^@skwid138\/opencode-council@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

export function serveArgv(executable, port) {
  if (typeof executable !== "string" || !isAbsolute(executable)) throw new Error("host executable path must be absolute");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${port}`);
  return [executable, "serve", "--hostname", "127.0.0.1", "--port", String(port)];
}

export function checkConfigInput({ providerBaseURL, spec, models, parentModel }) {
  assertLoopbackBaseURL(providerBaseURL);
  if (!EXACT_SPEC.test(String(spec))) throw new Error(`plugin spec must be an exact version of @skwid138/opencode-council: ${spec}`);
  if (!Array.isArray(models) || models.length === 0 || !models.includes(parentModel)) throw new Error("models must include the parent model");
}

/** Tool part / tool event fields shared by both hosts. */
export function toolTerminal({ sessionID, callID, tool, status, output = null, error = null, interrupted = false }) {
  return { kind: "tool-terminal", sessionID, callID, tool, status, output, error, interrupted };
}

/** V2 (source-verified at 2.0.28 / 2.0.32): foreground `serve` prints this exact line only once ready. */
export const v2ListeningLine = (port) => `server listening on http://127.0.0.1:${port}`;

/** Newline-terminated lines only (CRLF tolerated): an unterminated final fragment may still be growing. */
export function terminatedLines(text) {
  return String(text).split("\n").slice(0, -1).map((line) => line.replace(/\r$/, ""));
}

/** True when some COMPLETE line equals the V2 listening line for `port`. */
export function hasListeningLine(text, port) {
  const want = v2ListeningLine(port);
  return terminatedLines(text).some((line) => line === want);
}

/** V1 (line not source-verified): `127.0.0.1:<port>` in a COMPLETE line, not as a prefix of a longer port. */
export function mentionsPort(text, port) {
  const pattern = new RegExp(`127\\.0\\.0\\.1:${port}(?!\\d)`);
  return terminatedLines(text).some((line) => pattern.test(line));
}

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const yamlString = (value) => JSON.stringify(String(value));

/**
 * Custom agent markdown (S11) at `.opencode/agent/<name>.md`: subagent, frontmatter
 * `permission` map (tool -> effect | { pattern: effect }), body = system prompt.
 * Location and frontmatter key are UNVERIFIED per family (see candidatesFor("s11")).
 */
export function renderAgentFile({ name, description, prompt, permission }) {
  if (!AGENT_NAME.test(String(name))) throw new Error(`invalid agent name ${JSON.stringify(name)}`);
  const lines = ["---", `description: ${yamlString(description)}`, "mode: subagent"];
  const entries = Object.entries(permission ?? {});
  if (entries.length > 0) {
    lines.push("permission:");
    for (const [tool, value] of entries) {
      if (typeof value === "string") lines.push(`  ${tool}: ${value}`);
      else {
        lines.push(`  ${tool}:`);
        for (const [pattern, effect] of Object.entries(value)) lines.push(`    ${yamlString(pattern)}: ${effect}`);
      }
    }
  }
  lines.push("---", String(prompt), "");
  return { path: `.opencode/agent/${name}.md`, content: lines.join("\n") };
}

const EFFECTS = new Set(["allow", "deny", "ask"]);

/** Abstract fixture rules [{ action, resource, effect }] -> checked copies (actions are fixture tool kinds). */
export function checkRules(rules) {
  if (!Array.isArray(rules)) throw new Error("permission rules must be an array");
  return rules.map((rule) => {
    if (typeof rule?.action !== "string" || typeof rule.resource !== "string" || !EFFECTS.has(rule.effect)) throw new Error(`malformed permission rule ${JSON.stringify(rule)}`);
    return { action: rule.action, resource: rule.resource, effect: rule.effect };
  });
}

/**
 * Scenario-scoped UNVERIFIED host shapes: `base` (every scenario) plus `extra[scenario]`.
 * Throws on an unknown scenario so a new scenario cannot silently claim "nothing unverified".
 */
export function scopedCandidates(base, extra) {
  return (scenario) => {
    if (!Object.hasOwn(extra, scenario)) throw new Error(`unknown scenario ${scenario}`);
    return [...base, ...extra[scenario]];
  };
}

export const bounded = (value, max = 160) => (typeof value === "string" ? value.slice(0, max) : null);
export const boundedList = (list, max = 16) => (Array.isArray(list) ? list.filter((item) => typeof item === "string").slice(0, max).map((item) => item.slice(0, 160)) : []);
