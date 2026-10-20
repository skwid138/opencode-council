import { describe, expect, it } from "vitest";

import { buildAggregatorPrompt } from "../../src/aggregator.js";
import { COUNCIL_REVIEW_CANCELLED } from "../../src/orchestrator.js";
import { warnWorkspaceAskStripped } from "../../src/permissions.js";
import { V2_ASK_DENIED_MESSAGE } from "../../src/v2.js";
import { AGGREGATOR_PROMPT_MARKER, COUNCIL_TEXT, parseAggregatorPrompt, timeoutLabel } from "./aggregator-prompt.mjs";

const fake = (modelID: string, optional?: boolean) => ({ providerID: "fake", modelID, ...(optional === undefined ? {} : { optional }) });

describe("parseAggregatorPrompt (structure of src/aggregator.ts buildAggregatorPrompt; labels + fixture markers only)", () => {
  const markers = ["MA", "MB", "MO", "MC", "P-1"];
  const prompt = buildAggregatorPrompt({
    originalPrompt: "council-review-n MC",
    successes: [
      { model: fake("reviewer-a"), response: "## found\nMA body", attempts: 1 },
      { model: fake("reviewer-o", true), response: "MO body", attempts: 1 },
      { model: fake("reviewer-b"), response: "MB", attempts: 1 },
    ],
    failures: [
      { model: fake("r1"), error: "fake/r1 timed out after 20s" },
      { model: fake("r2"), error: "empty response" },
      { model: fake("r3"), error: "prompt failed: secret host text P-1" },
      { model: fake("r4", true), error: "something unknown" },
    ],
    aborted: [{ model: fake("reviewer-c") }],
  });

  it("parses Responded / Failed / Aborted participation and the reviewer sections, with markers per section", () => {
    const parsed = parseAggregatorPrompt(prompt, { markers });
    expect(parsed).not.toBeNull();
    expect(parsed!.responded).toEqual(["fake/reviewer-a", "fake/reviewer-o (optional)", "fake/reviewer-b"]);
    expect(parsed!.sections).toEqual([
      { index: 1, label: "fake/reviewer-a", optional: false, markers: ["MA"] },
      { index: 2, label: "fake/reviewer-o", optional: true, markers: ["MO"] },
      { index: 3, label: "fake/reviewer-b", optional: false, markers: ["MB"] },
    ]);
    expect(parsed!.abortedParticipation).toEqual(["fake/reviewer-c"]);
    expect(parsed!.abortedSection).toEqual(["fake/reviewer-c"]);
    expect(parsed!.failed.map((entry: { label: string }) => entry.label)).toEqual(["fake/r1", "fake/r2", "fake/r3", "fake/r4 (optional)"]);
    expect(parsed!.failed[0].error).toEqual({ kind: "timeout", text: "fake/r1 timed out after 20s" });
    expect(parsed!.failed[1].error).toEqual({ kind: "known", prefix: "empty response" });
    expect(parsed!.failed[2].error).toMatchObject({ kind: "known", prefix: "prompt failed:" });
    expect(parsed!.failed[3].error).toMatchObject({ kind: "other", length: "something unknown".length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("never records host error text (only constant prefixes, sha256 and length)", () => {
    expect(JSON.stringify(parseAggregatorPrompt(prompt, { markers }))).not.toContain("secret host text");
    expect(JSON.stringify(parseAggregatorPrompt(prompt, { markers }))).not.toContain("something unknown");
  });

  it("a marker in the ORIGINAL prompt is not attributed to a reviewer section", () => {
    const parsed = parseAggregatorPrompt(prompt, { markers });
    expect(parsed!.sections.flatMap((section: { markers: string[] }) => section.markers)).not.toContain("MC");
  });

  it("no aborted councillors -> no Aborted section at all (empty lists)", () => {
    const plain = buildAggregatorPrompt({ originalPrompt: "x", successes: [{ model: fake("a"), response: "MA", attempts: 1 }, { model: fake("b"), response: "MB", attempts: 1 }], failures: [], aborted: [] });
    const parsed = parseAggregatorPrompt(plain, { markers });
    expect(parsed).toMatchObject({ abortedParticipation: [], abortedSection: [], failed: [] });
  });

  it("returns null for text that is not an aggregator prompt", () => {
    expect(parseAggregatorPrompt("hello", { markers })).toBeNull();
    expect(parseAggregatorPrompt(undefined as never, { markers })).toBeNull();
  });

  it("an unrecognized label is recorded as [unrecognized] (bounded)", () => {
    const odd = buildAggregatorPrompt({ originalPrompt: "x", successes: [{ model: { providerID: "fake", modelID: "has space: colon" }, response: "MA", attempts: 1 }, { model: fake("b"), response: "MB", attempts: 1 }], failures: [], aborted: [] });
    const parsed = parseAggregatorPrompt(odd, { markers })!;
    expect(parsed.sections[0].label).toBe("[unrecognized]");
    // The participation lists use the same bound (never a host-chosen string verbatim).
    expect(parsed.responded[0]).toBe("[unrecognized]");
    const failing = buildAggregatorPrompt({ originalPrompt: "x", successes: [{ model: fake("a"), response: "MA", attempts: 1 }, { model: fake("b"), response: "MB", attempts: 1 }], failures: [{ model: { providerID: "fake", modelID: "odd label" }, error: "e" }], aborted: [{ model: { providerID: "fake", modelID: "odd label" } }] });
    const odd2 = parseAggregatorPrompt(failing, { markers })!;
    expect(odd2.failed[0].label).toBe("[unrecognized]");
    expect(odd2.abortedParticipation).toEqual(["[unrecognized]"]);
    expect(odd2.abortedSection).toEqual(["[unrecognized]"]);
  });

  it("timeoutLabel mirrors src/timeout.ts + councillor label (plain provider/model, rounded seconds)", () => {
    expect(timeoutLabel("fake/reviewer-c", 20_000)).toBe("fake/reviewer-c timed out after 20s");
    expect(timeoutLabel("aggregator synthesis", 15_400)).toBe("aggregator synthesis timed out after 15s");
  });
});

describe("mirrored council strings (pinned to src)", () => {
  it("match the plugin's exported constants and formats", () => {
    expect(COUNCIL_TEXT.cancelled).toBe(COUNCIL_REVIEW_CANCELLED);
    expect(COUNCIL_TEXT.v2AskDenied).toBe(V2_ASK_DENIED_MESSAGE);
    expect(AGGREGATOR_PROMPT_MARKER).toBe("# Participation summary supplied by council_review");
    expect(buildAggregatorPrompt({ originalPrompt: "x", successes: [], failures: [], aborted: [] })).toContain(AGGREGATOR_PROMPT_MARKER);
    const warned: string[] = [];
    warnWorkspaceAskStripped("bash", "echo ASK-n*", (message) => warned.push(message));
    expect(warned).toEqual([COUNCIL_TEXT.workspaceAskStripped("bash", "echo ASK-n*")]);
  });
});
