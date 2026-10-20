// Council-only. Host reads shared by the S1/S2 collector (runner.mjs) and the P1b drivers
// (drive.mjs): coded HTTP failures (operation + route with query keys only), V1 / V2 durable
// message reads (V2 paginated, bounded), and child identity reads. Moved out of runner.mjs
// unchanged (post Gate C p1a03 logic) plus the session-generic V2 read.
import { HarnessError, routeLabel } from "./http.mjs";
import { isRecord, str } from "./host-common.mjs";

export const ok2xx = (response) => response.status >= 200 && response.status < 300;
/** A coded failure for an HTTP step: `<operation> <METHOD /path?keys> -> <status>` (no query values, bodies, or auth). */
export const httpFailure = (code, operation, route, response) => new HarnessError(code, `${operation} ${routeLabel(route.method, route.path, route.query)} -> ${response.status}`);
export const short = (value) => (typeof value === "string" ? value.slice(0, 160) : value ?? null);

/** V1 persisted record: all messages of a session (GET /session/:id/message -> bare [{ info, parts }]). */
export async function v1Messages(client, host, project, sessionID) {
  const route = host.routes.messages({ sessionID, directory: project });
  const response = await client.request({ ...route, operation: "messages" });
  if (response.status !== 200 || !Array.isArray(response.json)) throw httpFailure("EMESSAGES", "messages", route, response);
  return response.json;
}

/** Last assistant message info and its numeric time.completed (null when absent). */
export function lastAssistant(messages) {
  const assistants = messages.filter((message) => isRecord(message?.info) && message.info.role === "assistant");
  const info = assistants.at(-1)?.info ?? {};
  const completed = isRecord(info.time) && typeof info.time.completed === "number" ? info.time.completed : null;
  return { info, completed };
}

export async function v1ChildIdentity(client, host, project, child) {
  const { info, completed } = lastAssistant(await v1Messages(client, host, project, child.id));
  // Source-verified (1.18.29 / 1.19.3): info.agent is the agent name; info.providerID /
  // info.modelID are top-level (there is no info.model). info.mode is recorded, never used.
  return {
    identity: { id: child.id, parentID: child.parentID ?? null, agent: str(info.agent), model: { providerID: str(info.providerID), modelID: str(info.modelID) } },
    completed,
    raw: { id: child.id, agent: short(info.agent), mode: short(info.mode), providerID: short(info.providerID), modelID: short(info.modelID) },
  };
}

/** Bound on V2 message pages (first page desc + cursor pages). */
export const MAX_MESSAGE_PAGES = 10;

/**
 * V2 durable session record: GET /api/session/:id/message?type=assistant&order=desc&limit=200,
 * then `cursor.next` pages (type=assistant, no `order`) until a page is empty or has no next
 * cursor. Every page is read (the evaluator needs the full count, not the first hit). Reading
 * more than MAX_MESSAGE_PAGES pages, or a repeated cursor, leaves the count unproven.
 */
export async function v2Messages(client, host, sessionID, operation = "messages") {
  const messages = [];
  const seen = new Set();
  let cursor;
  let pages = 0;
  let exceeded = false;
  for (;;) {
    if (pages >= MAX_MESSAGE_PAGES) {
      exceeded = true;
      break;
    }
    const route = host.routes.messages({ sessionID, cursor });
    const response = await client.request({ ...route, operation });
    const page = host.messagePageFrom(response);
    if (!page) throw httpFailure("EMESSAGES", operation, route, response);
    pages += 1;
    messages.push(...page.messages);
    if (page.messages.length === 0 || !page.next) break;
    if (seen.has(page.next)) {
      exceeded = true;
      break;
    }
    seen.add(page.next);
    cursor = page.next;
  }
  return { messages, pages, exceeded };
}

export async function v2ChildIdentity(client, host, child) {
  const route = host.routes.session({ sessionID: child.id });
  const response = await client.request({ ...route, operation: "session get" });
  const data = host.sessionFrom(response);
  if (!data) throw httpFailure("ESESSIONGET", "session get", route, response);
  const model = isRecord(data.model) ? data.model : {};
  return {
    id: child.id,
    parentID: data.parentID ?? child.parentID ?? null,
    agent: data.agent ?? null,
    model: { providerID: model.providerID ?? null, modelID: model.id ?? null },
    permissions: Array.isArray(data.permissions) ? data.permissions : undefined,
    // CANDIDATE (v2.modelRef): the raw session model reference, kept for the observation only.
    rawModel: isRecord(data.model) ? Object.fromEntries(Object.entries(data.model).slice(0, 8).map(([key, value]) => [key, short(value)])) : null,
  };
}
