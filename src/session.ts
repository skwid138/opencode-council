import type {
  CouncilPluginContext,
  ModelConfig,
  PermissionRuleset,
  ReviewState,
} from "./types";

export function extractLatestAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const assistantMessages = messages
    .filter(
      (msg): msg is Record<string, unknown> =>
        typeof msg === "object" && msg !== null,
    )
    .filter((msg) => {
      const info = msg.info as Record<string, unknown> | undefined;
      return info?.role === "assistant";
    })
    .sort((a, b) => {
      const aTime = (a.info as Record<string, unknown>)?.time as
        | Record<string, number>
        | undefined;
      const bTime = (b.info as Record<string, unknown>)?.time as
        | Record<string, number>
        | undefined;
      return (bTime?.created ?? 0) - (aTime?.created ?? 0);
    });

  const lastMessage = assistantMessages[0];
  if (!lastMessage) return null;

  const parts = lastMessage.parts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts)) return null;

  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

export async function parentDirectory(
  ctx: CouncilPluginContext,
  sessionID: string,
): Promise<string> {
  const parentSession = await ctx.client.session
    .get({ path: { id: sessionID } })
    .catch(() => null);
  return parentSession?.data?.directory ?? ctx.directory;
}

export async function createChildSession(
  ctx: CouncilPluginContext,
  parentSessionID: string,
  title: string,
  directory: string,
  permission?: PermissionRuleset,
  reviewState?: ReviewState,
): Promise<string> {
  if (reviewState?.hardCapTimedOut) {
    throw new Error("council_review hard cap already triggered");
  }

  const body: Record<string, unknown> = {
    parentID: parentSessionID,
    title,
  };
  if (permission) body.permission = permission;

  const createResult = await ctx.client.session.create({
    body,
    query: { directory },
  } as Parameters<typeof ctx.client.session.create>[0]) as {
    data?: { id?: string };
    error?: unknown;
  };

  if (createResult.error) {
    throw new Error(`failed to create child session: ${createResult.error}`);
  }

  const sessionID = createResult.data?.id;
  if (!sessionID) {
    throw new Error("failed to create child session: missing session id");
  }

  reviewState?.activeSessions.add(sessionID);
  if (reviewState?.hardCapTimedOut) {
    reviewState.activeSessions.delete(sessionID);
    await ctx.client.session
      .abort({ path: { id: sessionID } })
      .catch(() => {});
    throw new Error("council_review hard cap already triggered");
  }

  return sessionID;
}

export async function promptAndExtract(
  ctx: CouncilPluginContext,
  input: {
    sessionID: string;
    agent: string;
    prompt: string;
    model?: ModelConfig;
    tools?: Record<string, boolean>;
  },
): Promise<string> {
  const body: Record<string, unknown> = {
    agent: input.agent,
    parts: [{ type: "text", text: input.prompt }],
  };

  if (input.model) body.model = input.model;
  if (input.tools) body.tools = input.tools;

  const promptResult = await ctx.client.session.prompt({
    path: { id: input.sessionID },
    body,
  } as Parameters<typeof ctx.client.session.prompt>[0]) as { error?: unknown };

  if (promptResult.error) {
    throw new Error(`prompt failed: ${JSON.stringify(promptResult.error)}`);
  }

  const messagesResult = await ctx.client.session.messages({
    path: { id: input.sessionID },
  }) as { data?: unknown; error?: unknown };

  if (messagesResult.error) {
    throw new Error(`failed to get messages: ${messagesResult.error}`);
  }

  const responseText = extractLatestAssistantText(messagesResult.data);
  if (!responseText) {
    throw new Error("empty response");
  }

  return responseText;
}
