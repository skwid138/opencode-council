import {
  type CouncilConfig,
  isPermissionAction,
  isPlainObject,
  type PermissionOverrideConfig,
  type PermissionRuleset,
} from "./types";

export function warnAskStripped(scope: string, warn: (msg: string) => void): void {
  warn(
    `Stripping ask permission override for ${scope}; child sessions cannot prompt interactively (anomalyco/opencode#28037)`,
  );
}

export function readPermissionOverride(
  value: unknown,
  warn: (msg: string) => void,
): PermissionOverrideConfig | null {
  if (!isPlainObject(value)) return null;

  const result: PermissionOverrideConfig = {};

  for (const [permission, actionOrPatterns] of Object.entries(value)) {
    if (isPermissionAction(actionOrPatterns)) {
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
      if (isPermissionAction(action)) {
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
