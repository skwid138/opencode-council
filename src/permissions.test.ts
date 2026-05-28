import { describe, expect, it, vi } from "vitest";

import {
  aggregatorSessionPermission,
  buildReviewerRuleset,
  permissionConfigToRuleset,
  readPermissionOverride,
  warnAskStripped,
  warnWorkspaceAskStripped,
  workspacePatternRules,
} from "./permissions";
import type { CouncilConfig } from "./types";

function councilConfig(overrides: Partial<CouncilConfig> = {}): CouncilConfig {
  return {
    reviewer: "reviewer",
    aggregator: "aggregator",
    debug: false,
    models: [
      { providerID: "provider-a", modelID: "model-a" },
      { providerID: "provider-b", modelID: "model-b" },
    ],
    aggregator_model: null,
    reviewer_temperature: null,
    reviewer_permission: null,
    aggregator_permission: null,
    timeouts: {
      councillor_ms: 180_000,
      councillor_retry_ms: 90_000,
      aggregator_ms: 120_000,
      hard_cap_ms: 420_000,
    },
    ...overrides,
  };
}

describe("permission overrides", () => {
  it("keeps allow and deny overrides and strips ask overrides with warnings", () => {
    const warn = vi.fn();

    expect(
      readPermissionOverride(
        {
          bash: "deny",
          read: "allow",
          question: "ask",
          external_directory: { "/tmp/*": "allow", "/secret/*": "ask" },
        },
        warn,
      ),
    ).toEqual({
      bash: "deny",
      read: "allow",
      external_directory: { "/tmp/*": "allow" },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Stripping ask permission override for question"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Stripping ask permission override for external_directory./secret/*"),
    );
  });

  it("returns null for non-object overrides", () => {
    expect(readPermissionOverride("deny", vi.fn())).toBeNull();
    expect(readPermissionOverride(["deny"], vi.fn())).toBeNull();
  });

  it("converts flat and nested override config to ordered rules", () => {
    expect(
      permissionConfigToRuleset({
        bash: "deny",
        external_directory: { "/tmp/*": "allow", "/secret/*": "deny" },
      }),
    ).toEqual([
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "/tmp/*", action: "allow" },
      { permission: "external_directory", pattern: "/secret/*", action: "deny" },
    ]);
  });
});

describe("workspace permission rules", () => {
  it("builds reviewer rules with catch-all allows before workspace rules", () => {
    const warn = vi.fn();

    expect(
      buildReviewerRuleset(
        {
          bash: { "git *": "allow", "sudo *": "deny" },
          external_directory: { "/tmp/*": "allow" },
        },
        warn,
      ),
    ).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "git *", action: "allow" },
      { permission: "bash", pattern: "sudo *", action: "deny" },
      { permission: "external_directory", pattern: "/tmp/*", action: "allow" },
    ]);
  });

  it("strips workspace ask values and warns", () => {
    const warn = vi.fn();

    expect(workspacePatternRules("bash", { "npm *": "ask", "git *": "allow" }, warn))
      .toEqual([{ permission: "bash", pattern: "git *", action: "allow" }]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Stripping ask permission from workspace bash.npm *"),
    );
  });

  it("uses catch-all allows when workspace permissions are absent", () => {
    expect(buildReviewerRuleset(undefined, vi.fn())).toEqual([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ]);
  });
});

describe("aggregatorSessionPermission", () => {
  it("returns undefined without explicit aggregator permission", () => {
    expect(aggregatorSessionPermission(councilConfig())).toBeUndefined();
  });

  it("returns undefined for empty explicit aggregator permissions", () => {
    expect(
      aggregatorSessionPermission(councilConfig({ aggregator_permission: {} })),
    ).toBeUndefined();
  });

  it("returns only explicit aggregator permission rules", () => {
    expect(
      aggregatorSessionPermission(
        councilConfig({ aggregator_permission: { bash: "deny" } }),
      ),
    ).toEqual([{ permission: "bash", pattern: "*", action: "deny" }]);
  });
});

describe("warning helpers", () => {
  it("formats ask stripping warnings", () => {
    const warn = vi.fn();

    warnAskStripped("bash", warn);
    warnWorkspaceAskStripped("bash", "*", warn);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Stripping ask permission override for bash"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Stripping ask permission from workspace bash.*"),
    );
  });
});
