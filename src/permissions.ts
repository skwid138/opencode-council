import type { Logger } from "./logging.js";
import {
  type CouncilConfig,
  isPermissionAction,
  isPlainObject,
  type PermissionOverrideConfig,
  type PermissionRuleset,
} from "./types.js";

/**
 * Recursion fix (E2): appended LAST to every reviewer child's create-time
 * ruleset so reviewers cannot invoke council_review (last-match-wins beats any
 * workspace or reviewer_permission allow). Must stay a create-time session rule,
 * not a prompt `tools` map: a nonempty V1 prompt tools map replaces the session
 * ruleset.
 */
export const COUNCIL_REVIEW_RECURSION_DENY = {
  permission: "council_review",
  pattern: "*",
  action: "deny",
} as const satisfies PermissionRuleset[number];

export function warnAskStripped(scope: string, warn: (msg: string) => void): void {
  warn(
    `Stripping ask permission override for ${scope}; child sessions cannot prompt interactively (anomalyco/opencode#28037)`,
  );
}

/**
 * How `ask` values in reviewer/aggregator permission overrides are parsed.
 * - "strip" (V1): dropped with a warning (#28037 workaround).
 * - "keep" (V2): kept as `ask`; the V2 evaluate hook turns a still-ask decision
 *   for a council child into deny at runtime, after saved approvals apply.
 */
export type OverrideAskHandling = "strip" | "keep";

export function readPermissionOverride(
  value: unknown,
  warn: (msg: string) => void,
  askHandling: OverrideAskHandling = "strip",
): PermissionOverrideConfig | null {
  if (!isPlainObject(value)) return null;

  const result: PermissionOverrideConfig = {};
  const keepAsk = askHandling === "keep";

  for (const [permission, actionOrPatterns] of Object.entries(value)) {
    if (isPermissionAction(actionOrPatterns) || (keepAsk && actionOrPatterns === "ask")) {
      result[permission] = actionOrPatterns;
      continue;
    }

    if (actionOrPatterns === "ask") {
      warnAskStripped(permission, warn);
      continue;
    }

    if (!isPlainObject(actionOrPatterns)) continue;

    const patterns: Record<string, string> = {};
    for (const [pattern, action] of Object.entries(actionOrPatterns)) {
      if (isPermissionAction(action) || (keepAsk && action === "ask")) {
        patterns[pattern] = action;
      } else if (action === "ask") {
        warnAskStripped(`${permission}.${pattern}`, warn);
      }
    }

    if (Object.keys(patterns).length > 0) {
      result[permission] = patterns;
    }
  }

  return result;
}

export function permissionConfigToRuleset(
  config: PermissionOverrideConfig,
): PermissionRuleset {
  const ruleset: PermissionRuleset = [];
  for (const [permission, actionOrPatterns] of Object.entries(config)) {
    if (isPermissionAction(actionOrPatterns)) {
      ruleset.push({ permission, pattern: "*", action: actionOrPatterns });
      continue;
    }

    if (!isPlainObject(actionOrPatterns)) continue;
    for (const [pattern, action] of Object.entries(actionOrPatterns)) {
      if (isPermissionAction(action)) {
        ruleset.push({ permission, pattern, action });
      }
    }
  }
  return ruleset;
}

export function warnWorkspaceAskStripped(
  permission: string,
  pattern: string,
  warn: (msg: string) => void,
): void {
  warn(
    `Stripping ask permission from workspace ${permission}.${pattern}; child sessions cannot prompt interactively (anomalyco/opencode#28037)`,
  );
}

export function workspacePatternRules(
  permission: "bash" | "external_directory",
  value: unknown,
  warn: (msg: string) => void,
): PermissionRuleset {
  if (!isPlainObject(value)) return [];

  const ruleset: PermissionRuleset = [];
  for (const [pattern, action] of Object.entries(value)) {
    if (isPermissionAction(action)) {
      ruleset.push({ permission, pattern, action });
    } else if (action === "ask") {
      // Strip ask values — child sessions cannot prompt interactively (anomalyco/opencode#28037).
      warnWorkspaceAskStripped(permission, pattern, warn);
    }
  }
  return ruleset;
}

export function buildReviewerRuleset(
  permission: unknown,
  warn: (msg: string) => void,
): PermissionRuleset {
  // Temporary #28037 workaround — prevents ask prompts that hang TUI in child sessions.
  // Only bash and external_directory default to ask in opencode; other tools default to allow.
  const catchAllAllows: PermissionRuleset = [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "allow" },
  ];

  const bash = isPlainObject(permission) ? permission.bash : undefined;
  const externalDirectory = isPlainObject(permission)
    ? permission.external_directory
    : undefined;

  return [
    ...catchAllAllows,
    ...workspacePatternRules("bash", bash, warn),
    ...workspacePatternRules("external_directory", externalDirectory, warn),
  ];
}

export function aggregatorSessionPermission(
  councilConfig: CouncilConfig,
): PermissionRuleset | undefined {
  if (!councilConfig.aggregator_permission) return undefined;

  const ruleset = permissionConfigToRuleset(councilConfig.aggregator_permission);
  return ruleset.length > 0 ? ruleset : undefined;
}

/**
 * V1 child permission layering (last-match-wins in opencode's evaluator):
 * 1. Catch-all allows — #28037 workaround (lowest priority)
 * 2. Workspace deny/allow rules — from the cached workspace permission (ask values stripped)
 * 3. User reviewer_permission overrides
 * 4. council_review recursion deny (E2) — final rule, cannot be overridden
 * The aggregator gets only its explicit aggregator_permission rules (if any).
 */
export function composeV1ChildPermissions(
  workspacePermission: unknown,
  councilConfig: CouncilConfig,
  log: Logger,
): { reviewerPermission: PermissionRuleset; aggregatorPermission?: PermissionRuleset } {
  const reviewerPermission: PermissionRuleset = [
    ...buildReviewerRuleset(workspacePermission, (msg) => log("warn", msg)),
    ...(councilConfig.reviewer_permission
      ? permissionConfigToRuleset(councilConfig.reviewer_permission)
      : []),
    { ...COUNCIL_REVIEW_RECURSION_DENY },
  ];
  log("debug", "buildReviewerRuleset permission output", {
    permission_json: JSON.stringify(reviewerPermission),
  });
  const aggregatorPermission = aggregatorSessionPermission(councilConfig);
  return aggregatorPermission
    ? { reviewerPermission, aggregatorPermission }
    : { reviewerPermission };
}
