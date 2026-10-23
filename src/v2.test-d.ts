/**
 * Type-contract tests (plan step 4). Type-checked by `npx tsc --noEmit -p tsconfig.json`
 * (tsconfig.json includes src/**\/*.ts); excluded from the build and never run by Vitest.
 *
 * V2: the REAL `@opencode/plugin@2.0.32` Promise API types must be assignable to
 * council's structural contract (`./v2-contract.ts`) exactly where council relies
 * on them, and council's values must be accepted by the real APIs. Each surface
 * is checked through its specific payload/callback, not one broad assignment.
 *
 * V1: the default export satisfies `@opencode-ai/plugin`'s `PluginModule`.
 *
 * `// @ts-expect-error` lines are negative controls: if the contract became too
 * permissive (or the real types drifted), the expected error disappears and tsc fails.
 */
import type { Plugin as OpencodeV1Plugin, PluginModule } from "@opencode-ai/plugin";
import type { Plugin as V2 } from "@opencode/plugin";

import councilPlugin, { CouncilToolPlugin } from "./index.js";
import type {
  V2AgentDraft,
  V2ContextAssistantMessage,
  V2ContextIdleMessage,
  V2ContextTextPart,
  V2AgentEditor,
  V2ModelRef,
  V2PermissionEvaluation,
  V2PermissionRule,
  V2Registration,
  V2SessionCreateInput,
  V2SetupContext,
  V2ToolContext,
  V2ToolEditor,
  V2ToolInfo,
  V2ToolResult,
} from "./v2-contract.js";
import { setup } from "./v2.js";

type RealContext = V2.Context;
type RealSession = RealContext["session"];
type RealAgentEditor = Parameters<Parameters<RealContext["agent"]["transform"]>[0]>[0];
type RealToolEditor = Parameters<Parameters<RealContext["tool"]["transform"]>[0]>[0];
type RealAgentDraft = Parameters<Parameters<RealAgentEditor["update"]>[1]>[0];
type RealToolInfo = Parameters<RealToolEditor["add"]>[0];
type RealToolContext = Parameters<RealToolInfo["execute"]>[1];
type RealRegistration = Awaited<ReturnType<RealContext["permission"]["hook"]>>;

declare const realCtx: RealContext;
declare const realAgentEditor: RealAgentEditor;
declare const realToolEditor: RealToolEditor;
declare const realAgentDraft: RealAgentDraft;
declare const realToolContext: RealToolContext;
declare const councilTool: V2ToolInfo;
declare const councilCreate: V2SessionCreateInput;

// ---------------------------------------------------------------------------
// V2 setup context: the whole real context is usable as council's context ...
const councilCtx: V2SetupContext = realCtx;
// ... and specifically each surface council reads:
const options: V2SetupContext["options"] = realCtx.options;

// agent.transform: the real editor is a council editor; council's upsert callback
// accepts the real (fresh, host-shaped) agent draft and its writes typecheck.
void realCtx.agent.transform((editor) => {
  const councilEditor: V2AgentEditor = editor;
  councilEditor.update("council-plugin-reviewer", (draft) => {
    draft.mode = "subagent";
    draft.hidden = true;
  });
});
const agentEditor: V2AgentEditor = realAgentEditor;
const agentDraft: V2AgentDraft = realAgentDraft;
realAgentEditor.update("council-plugin-reviewer", (draft) => {
  draft.mode = "subagent";
  draft.hidden = true;
  draft.system = "system";
  draft.description = "description";
  draft.permissions = [{ action: "edit", resource: "*", effect: "deny" }];
  draft.request.body.temperature = 0.3;
});

// agent.get: council's lookup input is a real input; the real output carries a
// model ref council reads as {providerID, id}.
const agentGet: V2SetupContext["agent"]["get"] = realCtx.agent.get;
type RealAgentModel = NonNullable<Awaited<ReturnType<RealContext["agent"]["get"]>>["data"]["model"]>;
const runtimeModel: V2ModelRef = {} as RealAgentModel;

// tool.transform + add: the real editor is a council editor, and council's tool
// (JSON-schema input, options.codemode:false, execute -> {content}) is a real tool.
void realCtx.tool.transform((editor) => {
  const councilEditor: V2ToolEditor = editor;
  councilEditor.add(councilTool);
});
const toolEditor: V2ToolEditor = realToolEditor;
realToolEditor.add(councilTool);
realToolEditor.add({
  name: "council_review",
  description: "d",
  input: {
    type: "object",
    properties: { prompt: { type: "string", description: "p" } },
    required: ["prompt"],
  },
  options: { codemode: false },
  execute: async (_input: unknown, context: V2ToolContext): Promise<V2ToolResult> => ({
    content: context.sessionID + String(context.signal.aborted),
  }),
});
const toolContext: V2ToolContext = realToolContext;
const toolResult: Awaited<ReturnType<RealToolInfo["execute"]>> = {} as V2ToolResult;

// session: council's payloads are real payloads; real results satisfy council's reads.
const createInput: NonNullable<Parameters<RealSession["create"]>[0]> = councilCreate;
const createResult: Awaited<ReturnType<V2SetupContext["session"]["create"]>> =
  {} as Awaited<ReturnType<RealSession["create"]>>;
const getInput: Parameters<RealSession["get"]>[0] = { sessionID: "s" };
const getResult: Awaited<ReturnType<V2SetupContext["session"]["get"]>> =
  {} as Awaited<ReturnType<RealSession["get"]>>;
const parentRules: ReadonlyArray<V2PermissionRule> | undefined = getResult.permissions;
const promptInput: Parameters<RealSession["prompt"]>[0] = { sessionID: "s", text: "t" };
const waitInput: Parameters<RealSession["wait"]>[0] = { sessionID: "s" };
const contextInput: Parameters<RealSession["context"]>[0] = { sessionID: "s" };
const contextResult: Awaited<ReturnType<V2SetupContext["session"]["context"]>> =
  {} as Awaited<ReturnType<RealSession["context"]>>;
// session.context elements: the variants and fields extractV2ChildText reads
// (assistant: type, content[] with {type:"text", text}, error; idle: type,
// outcome, error) exist in the real message union with compatible types.
type RealContextMessage = Awaited<ReturnType<RealSession["context"]>>[number];
type RealAssistantMessage = Extract<RealContextMessage, { type: "assistant" }>;
type RealIdleMessage = Extract<RealContextMessage, { type: "idle" }>;
type RealTextPart = Extract<RealAssistantMessage["content"][number], { type: "text" }>;
declare const realAssistant: RealAssistantMessage;
declare const realIdle: RealIdleMessage;
declare const realTextPart: RealTextPart;
const assistantMessage: V2ContextAssistantMessage = realAssistant;
const idleMessage: V2ContextIdleMessage = realIdle;
const textPart: V2ContextTextPart = realTextPart;
// The optional error fields council reads exist on the real variants (removing
// them upstream would make these `true` checks fail to compile).
const assistantHasError: "error" extends keyof RealAssistantMessage ? true : false = true;
const idleHasError: "error" extends keyof RealIdleMessage ? true : false = true;
// Every outcome council distinguishes is a real outcome, and vice versa.
const realOutcomes: RealIdleMessage["outcome"][] = ["succeeded", "failed", "interrupted"];
const councilOutcomes: V2ContextIdleMessage["outcome"][] = [] as RealIdleMessage["outcome"][];
const interruptInput: Parameters<RealSession["interrupt"]>[0] = { sessionID: "s", resume: false };
const interruptResult: Awaited<ReturnType<V2SetupContext["session"]["interrupt"]>> =
  {} as Awaited<ReturnType<RealSession["interrupt"]>>;
const sessionDomain: V2SetupContext["session"] = realCtx.session;

// permission.hook("evaluate"): the real event is council's event, effect/message are
// mutable, and the registration disposes.
void realCtx.permission.hook("evaluate", (event) => {
  const councilEvent: V2PermissionEvaluation = event;
  event.effect = "deny";
  event.message = "council";
  void councilEvent;
});
const permissionHook: V2SetupContext["permission"]["hook"] = realCtx.permission.hook;
const registration: V2Registration = {} as RealRegistration;

// ---------------------------------------------------------------------------
// Plugin definitions: the default export is a real V2 plugin AND a V1 module.
const v2Plugin: V2.Plugin = councilPlugin;
const v2Defined: Parameters<typeof V2.define>[0] = councilPlugin;
const v2Setup: V2.Plugin["setup"] = setup;
const v1Module: PluginModule = councilPlugin;
const v1Server: OpencodeV1Plugin = CouncilToolPlugin;
const v1ServerFromDefault: OpencodeV1Plugin = councilPlugin.server;

// ---------------------------------------------------------------------------
// Negative controls.
// @ts-expect-error V2 model refs use `id`, not `modelID`.
const badModel: V2ModelRef = { providerID: "p", modelID: "m" };
// @ts-expect-error the real create payload also rejects a `modelID` model ref.
const badRealCreate: NonNullable<Parameters<RealSession["create"]>[0]> = { model: { providerID: "p", modelID: "m" } };
// @ts-expect-error a session create payload needs the permissions list council always sends.
const badCreate: V2SessionCreateInput = { parentID: "p", title: "t" };
// @ts-expect-error a V2 tool needs a name.
const badTool: V2ToolInfo = { description: "d", input: {}, execute: async () => ({}) };
// @ts-expect-error a V2 tool result's content is text, not a number.
const badResult: V2ToolResult = { content: 42 };
// @ts-expect-error the real tool result rejects a numeric content too.
const badRealResult: Awaited<ReturnType<RealToolInfo["execute"]>> = { content: 42 };
// @ts-expect-error permission effects are allow | deny | ask.
const badRule: V2PermissionRule = { action: "x", resource: "*", effect: "block" };
// @ts-expect-error a real V2 plugin needs an id.
const badV2Plugin: V2.Plugin = { setup };
// @ts-expect-error the real idle outcome has no "done" value.
const badOutcome: RealIdleMessage["outcome"] = "done";
// @ts-expect-error a real text part's `text` is a string.
const badTextPart: RealTextPart = { type: "text", text: 42 };
// @ts-expect-error council's idle message requires an outcome.
const badIdle: V2ContextIdleMessage = { type: "idle" };
// @ts-expect-error interrupt has no `resume: "no"` string form.
const badInterrupt: Parameters<RealSession["interrupt"]>[0] = { sessionID: "s", resume: "no" };
// @ts-expect-error a V1 plugin module needs a server function.
const badV1Module: PluginModule = { id: "skwid138.opencode-council" };
// @ts-expect-error a V1 server is not the V2 setup function.
const badV1Server: OpencodeV1Plugin = setup;

export type {};
void [
  councilCtx,
  options,
  agentEditor,
  agentDraft,
  agentGet,
  runtimeModel,
  toolEditor,
  toolContext,
  toolResult,
  createInput,
  createResult,
  getInput,
  parentRules,
  promptInput,
  waitInput,
  contextInput,
  contextResult,
  assistantMessage,
  idleMessage,
  assistantHasError,
  idleHasError,
  textPart,
  realOutcomes,
  councilOutcomes,
  badOutcome,
  badTextPart,
  badIdle,
  interruptInput,
  interruptResult,
  sessionDomain,
  permissionHook,
  registration,
  v2Plugin,
  v2Defined,
  v2Setup,
  v1Module,
  v1Server,
  v1ServerFromDefault,
  badModel,
  badRealCreate,
  badCreate,
  badTool,
  badResult,
  badRealResult,
  badRule,
  badV2Plugin,
  badInterrupt,
  badV1Module,
  badV1Server,
];
