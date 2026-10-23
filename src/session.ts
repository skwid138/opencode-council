import { awaitStop, CouncilCancelledError, raceCancellation } from "./cancellation.js";
import type { ChildPermission, CouncilHost, RunChildInput } from "./host.js";
import type { ModelConfig, ReviewState } from "./types.js";

/**
 * Extract the newest assistant message's text parts from a V1 `session.messages`
 * payload. Pure; used by the V1 host's `runChild`.
 */
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

  // E3: the newest assistant message decides. A host-marked error fails it even
  // when it carries partial text (no backtracking to an older reply). The host
  // error is never copied into the thrown error.
  const lastError = (lastMessage.info as Record<string, unknown>).error;
  if (lastError !== null && lastError !== undefined) throw new Error("assistant error: failed");

  const parts = lastMessage.parts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts)) return null;

  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

/**
 * Per-attempt state shared by a councillor/aggregator attempt and its phase
 * timeout callback. `expired` is set when the phase timeout fires.
 */
export type AttemptState = { expired: boolean };

export async function createChildSession(
  host: CouncilHost,
  parentSessionID: string,
  title: string,
  directory: string,
  permission?: ChildPermission,
  reviewState?: ReviewState,
  abortIfQuorumReached: boolean = false,
  identity?: { agent: string; model?: ModelConfig },
  attempt?: AttemptState,
): Promise<string> {
  if (reviewState?.hardCapTimedOut) {
    throw new Error("council_review hard cap already triggered");
  }
  const cancellation = reviewState?.cancellation;
  if (cancellation?.cancelled) throw new CouncilCancelledError();

  const created = host.createChild({
    parentID: parentSessionID,
    title,
    directory,
    ...(permission ? { permission } : {}),
    ...(identity ? { agent: identity.agent } : {}),
    ...(identity?.model ? { model: identity.model } : {}),
  });

  let sessionID: string;
  try {
    sessionID = await raceCancellation(created, cancellation);
  } catch (error) {
    if (cancellation?.cancelled) {
      // Cancelled while create was pending: a child created late stops itself
      // (detached, same sweep deadline). A late create failure is swallowed.
      created.then(
        (lateSessionID) => {
          void host.stopChild(lateSessionID, { deadline: cancellation.stopDeadline });
        },
        () => {},
      );
    }
    throw error;
  }

  reviewState?.activeSessions.add(sessionID);
  if (attempt?.expired) {
    // The phase timeout already fired (and returned its result) while create
    // was pending, so the timeout callback had no id to stop. Stop the late
    // child now, detached, and never prompt it.
    reviewState?.activeSessions.delete(sessionID);
    void host.stopChild(sessionID); // detached (see host.ts table)
    throw new Error("child session created after its phase timeout; stopped without prompting");
  }
  if (cancellation?.cancelled) {
    reviewState?.activeSessions.delete(sessionID);
    void host.stopChild(sessionID, { deadline: cancellation.stopDeadline }); // detached (see host.ts table)
    throw new CouncilCancelledError();
  }

  if (reviewState?.hardCapTimedOut) {
    reviewState.activeSessions.delete(sessionID);
    await awaitStop(host.stopChild(sessionID), cancellation); // awaited (see host.ts table)
    throw new Error("council_review hard cap already triggered");
  }

  if (abortIfQuorumReached && reviewState?.quorumReached) {
    reviewState.activeSessions.delete(sessionID);
    void host.stopChild(sessionID); // detached (see host.ts table)
    throw new Error("Council quorum reached; aborting late reviewer session.");
  }

  return sessionID;
}

export function promptAndExtract(host: CouncilHost, input: RunChildInput): Promise<string> {
  return host.runChild(input);
}
