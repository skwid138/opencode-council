// Council-only. Pure, bounded parser for the council aggregator prompt (src/aggregator.ts
// buildAggregatorPrompt), used by the fake provider so S3-S6 can be judged on the exact
// participation the plugin handed the aggregator. Only model labels (fixture-controlled
// `provider/model`, optionally ` (optional)`), constant error prefixes, and fixture markers
// are kept -- never reviewer text, prompt text, or host error text (sha256 + length only).
//
// The image harness may only import node: builtins and relative harness files, so the few
// council strings needed here are MIRRORED; aggregator-prompt.test.ts pins them to src.
import { createHash } from "node:crypto";

/** Heading that only the council aggregator prompt contains. */
export const AGGREGATOR_PROMPT_MARKER = "# Participation summary supplied by council_review";

/** Mirrored council strings (pinned to src by aggregator-prompt.test.ts). */
export const COUNCIL_TEXT = Object.freeze({
  /** src/orchestrator.ts COUNCIL_REVIEW_CANCELLED */
  cancelled: "Council review cancelled.",
  /** src/v2.ts V2_ASK_DENIED_MESSAGE (the V2 evaluate hook's deny reason) */
  v2AskDenied: "Council review sessions cannot request interactive approval; this action is unavailable in council sessions.",
  /** src/orchestrator.ts executeCouncilReview catch prefix */
  failedPrefix: "Error: council_review failed: ",
  /** src/aggregator.ts raceWithTimeout label */
  aggregatorLabel: "aggregator synthesis",
  /** src/permissions.ts warnWorkspaceAskStripped (V1) */
  workspaceAskStripped: (permission, pattern) => `Stripping ask permission from workspace ${permission}.${pattern}; child sessions cannot prompt interactively (anomalyco/opencode#28037)`,
});

/** src/timeout.ts: `${label} timed out after ${Math.round(ms / 1000)}s`. */
export const timeoutLabel = (label, timeoutMs) => `${label} timed out after ${Math.round(timeoutMs / 1000)}s`;

/** Plugin-generated failure prefixes (src/v1.ts, src/v2.ts, src/session.ts); anything else is "other". */
const KNOWN_ERROR_PREFIXES = Object.freeze([
  "prompt failed:",
  "empty response",
  "child session ",
  "assistant error:",
  "wait failed:",
  "failed to get messages:",
  "failed to get context:",
  "failed to create child session:",
  "child stop requested",
  "Council quorum reached; aborting late reviewer session.",
  "council_review cancelled",
  "child session created after its phase timeout",
]);

const LABEL = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}( \(optional\))?$/;
const MAX_ITEMS = 32;
const label = (text) => (LABEL.test(text) ? text : "[unrecognized]");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function classifyError(text) {
  if (/^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64} timed out after \d+s$/.test(text)) return { kind: "timeout", text };
  const prefix = KNOWN_ERROR_PREFIXES.find((known) => text.startsWith(known));
  if (prefix) return { kind: "known", prefix };
  return { kind: "other", length: text.length, sha256: sha256(text) };
}

/** The `- item` list right after the line `heading` (leading blank lines skipped; ends at the first non-item line). */
function listAfter(lines, heading) {
  const start = lines.indexOf(heading);
  if (start === -1) return [];
  const items = [];
  let rest = lines.slice(start + 1);
  while (rest.length > 0 && rest[0] === "") rest = rest.slice(1);
  for (const line of rest) {
    if (!line.startsWith("- ")) break;
    items.push(line.slice(2));
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/**
 * Structure of an aggregator prompt, or null when `text` is not one:
 *   responded:            labels under "Responded:"
 *   failed:               [{ label, error }] under "Failed or timed out:" (error classified)
 *   abortedParticipation: labels under "Aborted (quorum reached):"
 *   sections:             [{ index, label, optional, markers }] per "## Reviewer N: <label>"
 *   abortedSection:       labels under "## Aborted (quorum reached)"
 */
export function parseAggregatorPrompt(text, { markers = [] } = {}) {
  if (typeof text !== "string" || !text.includes(AGGREGATOR_PROMPT_MARKER)) return null;
  const summaryStart = text.indexOf(AGGREGATOR_PROMPT_MARKER);
  const responsesStart = text.indexOf("\n# Reviewer responses", summaryStart);
  const summaryLines = text.slice(summaryStart, responsesStart === -1 ? undefined : responsesStart).split("\n");
  const responded = listAfter(summaryLines, "Responded:").map(label);
  const failed = listAfter(summaryLines, "Failed or timed out:")
    .filter((item) => item !== "none")
    .map((item) => {
      const cut = item.indexOf(": ");
      return cut === -1 ? { label: label(item), error: { kind: "none" } } : { label: label(item.slice(0, cut)), error: classifyError(item.slice(cut + 2)) };
    });
  const abortedParticipation = listAfter(summaryLines, "Aborted (quorum reached):").map(label);

  const responses = responsesStart === -1 ? "" : text.slice(responsesStart);
  const abortedAt = responses.indexOf("\n## Aborted (quorum reached)\n");
  const body = abortedAt === -1 ? responses : responses.slice(0, abortedAt);
  const abortedSection = abortedAt === -1 ? [] : listAfter(responses.slice(abortedAt + 1).split("\n"), "## Aborted (quorum reached)").map(label);
  const sections = [];
  const heading = /^## Reviewer (\d+): (.*)$/gm;
  const found = [...body.matchAll(heading)].slice(0, MAX_ITEMS);
  found.forEach((match, i) => {
    const end = i + 1 < found.length ? found[i + 1].index : body.length;
    const sectionText = body.slice(match.index + match[0].length, end);
    const raw = match[2];
    const optional = raw.endsWith(" (optional)");
    const plain = optional ? raw.slice(0, -" (optional)".length) : raw;
    sections.push({ index: Number(match[1]), label: LABEL.test(raw) ? plain : "[unrecognized]", optional, markers: markers.filter((marker) => sectionText.includes(marker)) });
  });
  return { responded, failed, abortedParticipation, sections, abortedSection };
}
