import { describe, expect, it } from "vitest";

import { REVIEWER_PERMISSION } from "./prompts";
import type { CouncilConfig } from "./types";
import type { V2PermissionRule } from "./v2-contract";
import {
  composeV2ChildPermissions,
  expandHome,
  normalizeV2Action,
  parentDenyRules,
  translatePermissionOverride,
} from "./v2-permissions";

const HOME = "/home/u";

/**
 * Local copy of upstream permission matching at anomalyco/opencode
 * 843a6c514e606b436a7fe713422ace0a93ad3d61:
 * - packages/core/src/util/wildcard.ts `match` (posix flags)
 * - packages/core/src/permission.ts `evaluate` (last match wins, default ask)
 */
function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", "s").test(normalized);
}

function evaluate(action: string, resource: string, ...rulesets: V2PermissionRule[][]) {
  return (
    rulesets
      .flat()
      .findLast((rule) => wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource))
      ?.effect ?? "ask"
  );
}

function councilConfig(overrides: Partial<CouncilConfig> = {}): CouncilConfig {
  return {
    reviewer: "council-plugin-reviewer",
    aggregator: "council-plugin-aggregator",
    debug: false,
    models: [],
    quorum: 2,
    aggregator_model: null,
    reviewer_temperature: null,
    reviewer_permission: null,
    aggregator_permission: null,
    timeouts: {
      councillor_ms: 1,
      optional_councillor_ms: 1,
      aggregator_ms: 1,
      quorum_grace_ms: 0,
      hard_cap_ms: 1,
    },
    ...overrides,
  };
}

const AGENT_RULES = translatePermissionOverride(REVIEWER_PERMISSION, HOME);

describe("V2 permission translation", () => {
  it("renames V1 permission keys to V2 actions", () => {
    expect(["bash", "task", "write", "patch", "edit", "read", "question"].map(normalizeV2Action))
      .toEqual(["shell", "subagent", "edit", "edit", "edit", "read", "question"]);
  });

  it("translates flat and pattern maps to ordered rules, keeping ask and dropping invalid effects", () => {
    expect(
      translatePermissionOverride(
        {
          bash: { "*": "deny", "git diff*": "allow", "git push*": "ask", "rm *": "maybe" },
          task: "deny",
          webfetch: "ask",
          question: "nope",
        },
        HOME,
      ),
    ).toStrictEqual([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "git diff*", effect: "allow" },
      { action: "shell", resource: "git push*", effect: "ask" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "ask" },
    ]);
  });

  it("expands home only for external_directory, read, and edit resources", () => {
    expect(
      translatePermissionOverride(
        {
          read: { "~": "deny", "~/secrets/*": "deny", "$HOME": "deny", "$HOME/a/*": "deny", "$HOME\\b": "deny" },
          external_directory: { "~/outside/*": "allow" },
          write: { "~/notes/*": "deny" },
          bash: { "cat ~/secrets/*": "deny", "$HOME/private/*": "deny" },
          glob: { "~/x": "deny" },
        },
        HOME,
      ),
    ).toStrictEqual([
      { action: "read", resource: "/home/u", effect: "deny" },
      { action: "read", resource: "/home/u/secrets/*", effect: "deny" },
      { action: "read", resource: "/home/u", effect: "deny" },
      { action: "read", resource: "/home/u/a/*", effect: "deny" },
      { action: "read", resource: "/home/u/b", effect: "deny" },
      { action: "external_directory", resource: "/home/u/outside/*", effect: "allow" },
      { action: "edit", resource: "/home/u/notes/*", effect: "deny" },
      { action: "shell", resource: "cat ~/secrets/*", effect: "deny" },
      { action: "shell", resource: "$HOME/private/*", effect: "deny" },
      { action: "glob", resource: "~/x", effect: "deny" },
    ]);
  });

  it("mirrors upstream expandHome edge cases", () => {
    expect(expandHome("~user/x", HOME)).toBe("~user/x");
    expect(expandHome("$HOMEDIR/x", HOME)).toBe("$HOMEDIR/x");
    expect(expandHome("/abs/~/x", HOME)).toBe("/abs/~/x");
    expect(expandHome("~/secrets/*", "C:\\Users\\u")).toBe("C:\\Users\\u\\secrets\\*");
  });

  it("keeps only parent session deny rules, in order", () => {
    expect(
      parentDenyRules([
        { action: "shell", resource: "rm *", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "ask" },
        { action: "*", resource: "/secret/*", effect: "deny" },
      ]),
    ).toStrictEqual([
      { action: "shell", resource: "rm *", effect: "deny" },
      { action: "*", resource: "/secret/*", effect: "deny" },
    ]);
    expect(parentDenyRules(undefined)).toStrictEqual([]);
  });

  it.each([
    ["a non-array permissions value", { action: "shell", resource: "*", effect: "deny" }],
    ["null permissions", null],
    ["a non-object entry", [{ action: "shell", resource: "*", effect: "deny" }, "junk"]],
    ["a non-string action", [{ action: 1, resource: "*", effect: "deny" }]],
    ["a missing resource", [{ action: "shell", effect: "deny" }]],
    ["an unknown effect", [{ action: "shell", resource: "*", effect: "block" }]],
  ])("fails closed on %s", (_label, permissions) => {
    expect(() => parentDenyRules(permissions)).toThrow("malformed parent session permissions");
  });
});

describe("V2 child permission composition (D8 option C)", () => {
  const parent: V2PermissionRule[] = [
    { action: "shell", resource: "git push*", effect: "deny" },
  ];

  it("composes the reviewer as parent denies, council denies, overrides, then the final council_review deny", () => {
    const { reviewerPermission } = composeV2ChildPermissions({
      parentRules: parent,
      councilConfig: councilConfig({ reviewer_permission: { bash: { "npm *": "deny" }, read: "allow" } }),
      home: HOME,
    });

    expect(reviewerPermission).toStrictEqual([
      { action: "shell", resource: "git push*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "todowrite", resource: "*", effect: "deny" },
      { action: "shell", resource: "npm *", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "council_review", resource: "*", effect: "deny" },
    ]);
  });

  it("composes the aggregator as parent denies, deny-all, overrides, then the final council_review deny", () => {
    const { aggregatorPermission } = composeV2ChildPermissions({
      parentRules: parent,
      councilConfig: councilConfig({ aggregator_permission: { read: "allow" } }),
      home: HOME,
    });

    expect(aggregatorPermission).toStrictEqual([
      { action: "shell", resource: "git push*", effect: "deny" },
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "council_review", resource: "*", effect: "deny" },
    ]);
  });

  it("enforces the composed rules under upstream last-match-wins semantics", () => {
    const { reviewerPermission, aggregatorPermission } = composeV2ChildPermissions({
      parentRules: [
        { action: "shell", resource: "git push *", effect: "deny" },
        { action: "external_directory", resource: "*", effect: "deny" },
      ],
      councilConfig: councilConfig({
        reviewer_permission: {
          read: { "~/secrets/*": "deny" },
          bash: { "*": "deny", "git diff *": "allow", "git push *": "allow", "git reset*": "ask" },
          council_review: "allow",
          "*": "allow",
        },
        aggregator_permission: { read: "allow" },
      }),
      home: HOME,
    });
    const reviewer = (action: string, resource: string) =>
      evaluate(action, resource, AGENT_RULES, reviewerPermission);

    expect(reviewer("read", "/home/u/secrets/key")).toBe("allow"); // later "*": allow wins
    expect(reviewer("council_review", "*")).toBe("deny");
    expect(reviewer("edit", "/home/u/project/a.ts")).toBe("allow"); // later "*": allow wins over council edit deny
    expect(reviewer("shell", "git diff")).toBe("allow"); // trailing " *" matches the bare prefix
    expect(reviewer("shell", "git diff --stat")).toBe("allow");

    const strict = composeV2ChildPermissions({
      parentRules: [{ action: "*", resource: "*", effect: "deny" }],
      councilConfig: councilConfig({
        reviewer_permission: { read: { "~/secrets/*": "deny" }, bash: { "git push*": "ask" } },
      }),
      home: HOME,
    }).reviewerPermission;
    const strictReviewer = (action: string, resource: string) =>
      evaluate(action, resource, AGENT_RULES, strict);
    expect(strictReviewer("read", "/home/u/secrets/key")).toBe("deny");
    expect(strictReviewer("read", "/home/u/project/a.ts")).toBe("deny"); // parent * deny inherited
    expect(strictReviewer("shell", "git push origin")).toBe("ask"); // kept for the evaluate hook

    const homeOnly = composeV2ChildPermissions({
      parentRules: [],
      councilConfig: councilConfig({ reviewer_permission: { read: { "~/secrets/*": "deny" } } }),
      home: HOME,
    }).reviewerPermission;
    expect(evaluate("read", "/home/u/secrets/key", AGENT_RULES, homeOnly)).toBe("deny");
    expect(evaluate("read", "/home/u/project/a.ts", AGENT_RULES, homeOnly)).toBe("allow");
    expect(evaluate("edit", "/home/u/project/a.ts", AGENT_RULES, homeOnly)).toBe("deny");
    expect(evaluate("subagent", "general", AGENT_RULES, homeOnly)).toBe("deny");
    expect(evaluate("council_review", "*", AGENT_RULES, homeOnly)).toBe("deny");

    const aggregator = (action: string, resource: string) =>
      evaluate(action, resource, aggregatorPermission);
    expect(aggregator("read", "/home/u/x")).toBe("allow");
    expect(aggregator("shell", "ls")).toBe("deny");
    expect(aggregator("external_directory", "/tmp/x")).toBe("deny");
    expect(aggregator("council_review", "*")).toBe("deny");
  });

  it("drops a parent allow exception under a parent deny-all (accepted over-restriction)", () => {
    const { reviewerPermission } = composeV2ChildPermissions({
      parentRules: parentDenyRules([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ]),
      councilConfig: councilConfig(),
      home: HOME,
    });

    expect(evaluate("read", "/repo/a.ts", AGENT_RULES, reviewerPermission)).toBe("deny");
  });

  it("normalizes backslash resources like upstream", () => {
    const { reviewerPermission } = composeV2ChildPermissions({
      parentRules: [],
      councilConfig: councilConfig({ reviewer_permission: { read: { "~/secrets/*": "deny" } } }),
      home: "C:\\Users\\u",
    });

    expect(evaluate("read", "C:\\Users\\u\\secrets\\key", reviewerPermission)).toBe("deny");
  });
});
