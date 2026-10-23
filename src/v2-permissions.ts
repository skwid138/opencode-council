/**
 * V2 permission model (D8 option C) and V1 -> V2 permission translation.
 *
 * Mirrors upstream anomalyco/opencode 843a6c514e606b436a7fe713422ace0a93ad3d61:
 * - packages/core/src/v1/config/migrate.ts `normalizeAction` (bash -> shell,
 *   task -> subagent, write/patch -> edit)
 * - packages/core/src/config/plugin/agent.ts `expandHome` / `expandPermissions`
 *   (home expansion only for external_directory, read, edit; shell text untouched)
 */
import { posix, win32 } from "node:path";

import type { CouncilConfig, PermissionOverrideConfig } from "./types.js";
import { isPlainObject } from "./types.js";
import type { V2PermissionEffect, V2PermissionRule } from "./v2-contract.js";

const PATH_ACTIONS = new Set(["external_directory", "read", "edit"]);

/** Council reviewer tool-level restriction: no edit or delegation tools (D2). */
const REVIEWER_COUNCIL_DENIES = ["edit", "subagent", "question", "todowrite"] as const;

/** Recursion fix (E2) on V2: always the final session rule. */
export const V2_COUNCIL_REVIEW_DENY: V2PermissionRule = {
  action: "council_review",
  resource: "*",
  effect: "deny",
};

export function normalizeV2Action(action: string): string {
  if (action === "write" || action === "patch") return "edit";
  if (action === "task") return "subagent";
  if (action === "bash") return "shell";
  return action;
}

export function expandHome(resource: string, home: string): string {
  if (resource === "~" || resource === "$HOME") return home;
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined;
  if (relative !== undefined) return (posix.isAbsolute(home) ? posix : win32).join(home, relative);
  return resource;
}

function isEffect(value: unknown): value is V2PermissionEffect {
  return value === "allow" || value === "deny" || value === "ask";
}

function rule(action: string, resource: string, effect: V2PermissionEffect, home: string) {
  return {
    action,
    resource: PATH_ACTIONS.has(action) ? expandHome(resource, home) : resource,
    effect,
  };
}

/**
 * Translate a V1-style permission map (flat `key: effect` or `key: {pattern: effect}`)
 * to ordered V2 rules, preserving key order. `ask` is kept (the evaluate hook
 * resolves it for council children); other values are dropped.
 */
export function translatePermissionOverride(
  config: PermissionOverrideConfig | Readonly<Record<string, unknown>>,
  home: string,
): V2PermissionRule[] {
  const rules: V2PermissionRule[] = [];
  for (const [key, value] of Object.entries(config)) {
    const action = normalizeV2Action(key);
    if (isEffect(value)) {
      rules.push(rule(action, "*", value, home));
      continue;
    }
    if (!isPlainObject(value)) continue;
    for (const [pattern, effect] of Object.entries(value)) {
      if (isEffect(effect)) rules.push(rule(action, pattern, effect, home));
    }
  }
  return rules;
}

export const MALFORMED_PARENT_PERMISSIONS = "malformed parent session permissions";

/**
 * Parent session DENY rules only, in order; valid allow/ask rules are dropped
 * by design. Absent (`undefined`) permissions mean no parent rules. Anything
 * else that is not an array of well-formed `{action, resource, effect}` rules
 * throws, so the review fails closed instead of silently losing parent denies.
 */
export function parentDenyRules(permissions: unknown): V2PermissionRule[] {
  if (permissions === undefined) return [];
  if (!Array.isArray(permissions)) throw new Error(MALFORMED_PARENT_PERMISSIONS);
  const rules: V2PermissionRule[] = [];
  for (const entry of permissions as unknown[]) {
    if (
      !isPlainObject(entry) ||
      typeof entry.action !== "string" ||
      typeof entry.resource !== "string" ||
      !isEffect(entry.effect)
    ) {
      throw new Error(MALFORMED_PARENT_PERMISSIONS);
    }
    if (entry.effect === "deny") rules.push({ action: entry.action, resource: entry.resource, effect: "deny" });
  }
  return rules;
}

export function composeV2ChildPermissions(input: {
  parentRules: ReadonlyArray<V2PermissionRule>;
  councilConfig: CouncilConfig;
  home: string;
}): { reviewerPermission: V2PermissionRule[]; aggregatorPermission: V2PermissionRule[] } {
  const { parentRules, councilConfig, home } = input;
  return {
    reviewerPermission: [
      ...parentRules,
      ...REVIEWER_COUNCIL_DENIES.map((action) => ({ action, resource: "*", effect: "deny" as const })),
      ...(councilConfig.reviewer_permission
        ? translatePermissionOverride(councilConfig.reviewer_permission, home)
        : []),
      { ...V2_COUNCIL_REVIEW_DENY },
    ],
    aggregatorPermission: [
      ...parentRules,
      { action: "*", resource: "*", effect: "deny" },
      ...(councilConfig.aggregator_permission
        ? translatePermissionOverride(councilConfig.aggregator_permission, home)
        : []),
      { ...V2_COUNCIL_REVIEW_DENY },
    ],
  };
}
