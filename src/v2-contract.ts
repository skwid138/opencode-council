/**
 * Structural contract for the subset of the OpenCode V2 Promise plugin API that
 * this plugin uses. TYPE-ONLY: nothing here imports `@opencode/plugin`,
 * `@opencode/client`, or `effect`, so neither the emitted JS nor the emitted
 * declarations depend on the V2 SDK.
 *
 * Provenance (source read, not executed):
 * - Pin:   anomalyco/opencode 843a6c514e606b436a7fe713422ace0a93ad3d61 (v2.0.32)
 *          packages/plugin/src/promise/{plugin,agent,tool,permission,session,registration}.ts
 *          packages/client (generated promise client: session.*, agent.get)
 *          packages/schema/src/tool.ts (Tool.Info / Options / Result)
 * - Floor: anomalyco/opencode 026b106bc5d41b679ffc413264229c340871e4d3 (v2.0.28);
 *          the same members exist with the same shapes (2.0.32 only adds
 *          `permission.assert`, which this plugin does not use).
 *
 * Methods use method syntax on purpose (bivariant parameters) so the real host
 * types stay assignable; step-4 type-contract tests verify that against the
 * real `@opencode/plugin` declarations.
 */

export type V2PermissionEffect = "allow" | "deny" | "ask";

/** Session/agent permission rule; rulesets are ordered and last-match-wins. */
export type V2PermissionRule = {
  readonly action: string;
  readonly resource: string;
  readonly effect: V2PermissionEffect;
};

/** `Model.Ref`. This plugin never sets `variant`. */
export type V2ModelRef = {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
};

export type V2Registration = {
  readonly dispose: () => Promise<void>;
};

/** `Transform<Editor>`: the callback replays on every host reload. */
export type V2Transform<Editor> = (callback: (editor: Editor) => void) => Promise<V2Registration>;

/**
 * Mutable agent draft passed to `AgentEditor.update` (subset of `Agent.Info`).
 * Only the fields council writes are declared. `model` is deliberately absent:
 * the real draft is `DeepMutable<Agent.Info>`, whose branded model-ref strings
 * are not plain `string`s, and council never touches the draft's model.
 */
export type V2AgentDraft = {
  request: {
    settings: Record<string, unknown>;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
  system?: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  permissions: Array<{ action: string; resource: string; effect: V2PermissionEffect }>;
};

export interface V2AgentEditor {
  /** Upsert: creates the agent with host defaults when missing, then applies `update`. */
  update(id: string, update: (agent: V2AgentDraft) => void): void;
}

export interface V2ToolContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly signal: AbortSignal;
}

export type V2ToolResult = {
  readonly content?: string;
};

export type V2JsonSchema = { readonly [key: string]: unknown };

export type V2ToolInfo = {
  readonly name: string;
  readonly description: string;
  readonly input: V2JsonSchema;
  readonly options?: { readonly codemode: boolean };
  readonly execute: (input: unknown, context: V2ToolContext) => Promise<V2ToolResult>;
};

export interface V2ToolEditor {
  add(tool: V2ToolInfo): void;
}

/** `permission.hook("evaluate")` event. `effect` and `message` are mutable. */
export type V2PermissionEvaluation = {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  effect: V2PermissionEffect;
  message?: string;
};

export type V2SessionCreateInput = {
  readonly parentID: string;
  readonly title: string;
  readonly agent?: string;
  readonly model?: V2ModelRef;
  readonly permissions: ReadonlyArray<V2PermissionRule>;
};

/** Assistant text content entry that council reads (`SessionMessageAssistantText`). */
export type V2ContextTextPart = {
  readonly type: "text";
  readonly text: string;
};

/** The fields of an `assistant` context entry that council reads. */
export type V2ContextAssistantMessage = {
  readonly type: "assistant";
  readonly content: ReadonlyArray<{ readonly type: string }>;
  readonly error?: unknown;
};

/** The fields of an `idle` (run-terminal) context entry that council reads. */
export type V2ContextIdleMessage = {
  readonly type: "idle";
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly error?: unknown;
};

export interface V2SessionDomain {
  create(input: V2SessionCreateInput): Promise<{ readonly id: string }>;
  get(input: { readonly sessionID: string }): Promise<{
    readonly permissions?: ReadonlyArray<V2PermissionRule>;
  }>;
  /** Resolves when the prompt is admitted (not when the run ends). */
  prompt(input: { readonly sessionID: string; readonly text: string }): Promise<unknown>;
  /** Resolves when the session's current run settles. */
  wait(input: { readonly sessionID: string }): Promise<unknown>;
  /**
   * The session's message log, returned directly as an array (`SessionMessageInfo[]`).
   * Kept `unknown`: council narrows every entry at runtime (`extractV2ChildText`);
   * the `assistant` / `idle` / text-part fields it reads are pinned against the
   * real union in `v2.test-d.ts` via `V2ContextAssistantMessage`,
   * `V2ContextIdleMessage`, and `V2ContextTextPart`.
   */
  context(input: { readonly sessionID: string }): Promise<ReadonlyArray<unknown>>;
  interrupt(input: {
    readonly sessionID: string;
    readonly resume?: boolean;
  }): Promise<{ readonly interrupted: boolean }>;
}

export interface V2SetupContext {
  readonly options: unknown;
  readonly app?: { readonly name?: string; readonly version?: string };
  readonly agent: {
    readonly transform: V2Transform<V2AgentEditor>;
    get(input: { readonly agentID: string }): Promise<{
      readonly data: { readonly model?: V2ModelRef };
    }>;
  };
  readonly tool: {
    readonly transform: V2Transform<V2ToolEditor>;
  };
  readonly session: V2SessionDomain;
  readonly permission: {
    hook(
      name: "evaluate",
      callback: (event: V2PermissionEvaluation) => Promise<void> | void,
    ): Promise<V2Registration>;
  };
}

export type V2Cleanup = () => Promise<void>;
