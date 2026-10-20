// Council-only (not copied). The driver -> controller result handoff.
//
// The driver prints nothing on stdout except one final line:
//   COUNCIL-RH-RESULT <base64(JSON)> <sha256-hex of the JSON bytes>\n
// The controller accepts stdout only if it is exactly that one line; anything
// else (missing, duplicate, stray output, bad digest, oversized, bad schema)
// is a FAIL that stops the batch.
import { createHash } from "node:crypto";

import { parseCellId } from "./cells.mjs";

export const FRAME_PREFIX = "COUNCIL-RH-RESULT";
export const RESULT_SCHEMA = "council-rh-result/1";
/** Bound on the decoded JSON (the controller's stdout cap is 1 MiB). */
export const MAX_RESULT_BYTES = 512 * 1024;
const VERDICTS = new Set(["PASS", "FAIL", "INVALID-FIXTURE"]);
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Per-check detail bound (bytes, marker included). */
export const MAX_DETAIL_BYTES = 2048;

/** Bounds a check detail: over MAX_DETAIL_BYTES -> a UTF-8-safe prefix + `[truncated <n> bytes sha256 <hex>]`. */
export function boundDetail(detail) {
  const text = typeof detail === "string" ? detail : String(detail ?? "");
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_DETAIL_BYTES) return text;
  const marker = ` …[truncated ${bytes} bytes sha256 ${sha256(Buffer.from(text))}]`;
  const room = MAX_DETAIL_BYTES - Buffer.byteLength(marker);
  let prefix = Buffer.from(text).subarray(0, room).toString("utf8");
  while (Buffer.byteLength(prefix) > room) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function encodeFrame(result) {
  const json = Buffer.from(JSON.stringify(result), "utf8");
  if (json.length > MAX_RESULT_BYTES) throw new Error(`result JSON exceeds ${MAX_RESULT_BYTES} bytes`);
  return `${FRAME_PREFIX} ${json.toString("base64")} ${sha256(json)}\n`;
}

export function resultProblems(result) {
  if (!isRecord(result)) return ["result is not an object"];
  const problems = [];
  if (result.schema !== RESULT_SCHEMA) problems.push(`schema must be ${RESULT_SCHEMA}`);
  try {
    parseCellId(result.cellId);
  } catch {
    problems.push("cellId is not a valid cell id");
  }
  if (!VERDICTS.has(result.verdict)) problems.push("verdict must be PASS, FAIL, or INVALID-FIXTURE");
  if (!Array.isArray(result.checks)) problems.push("checks must be an array");
  else {
    result.checks.forEach((check, index) => {
      if (!isRecord(check) || typeof check.id !== "string" || typeof check.ok !== "boolean" || typeof check.detail !== "string") problems.push(`checks[${index}] is malformed`);
    });
    if (result.verdict === "PASS" && result.checks.length === 0) problems.push("PASS verdict with no checks");
    if (result.verdict === "PASS" && result.checks.some((check) => isRecord(check) && check.ok === false)) problems.push("PASS verdict with a failed check");
  }
  return problems;
}

/** Parses the complete captured stdout. Never throws. */
export function parseResultFrame(stdout) {
  const text = typeof stdout === "string" ? stdout : "";
  const count = text.split("\n").filter((line) => line.startsWith(`${FRAME_PREFIX} `)).length;
  if (count === 0) return { ok: false, error: "missing result frame" };
  if (count > 1) return { ok: false, error: `expected exactly one result frame, found ${count}` };
  if (!text.endsWith("\n")) return { ok: false, error: "result frame must end with a newline" };
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== 1) return { ok: false, error: "stdout must contain only the result frame" };
  const parts = lines[0].split(" ");
  if (parts.length !== 3 || parts[0] !== FRAME_PREFIX || !B64.test(parts[1]) || !HEX64.test(parts[2])) return { ok: false, error: "malformed result frame" };
  const json = Buffer.from(parts[1], "base64");
  if (json.toString("base64") !== parts[1]) return { ok: false, error: "malformed result frame (non-canonical base64)" };
  if (json.length > MAX_RESULT_BYTES) return { ok: false, error: `result JSON exceeds ${MAX_RESULT_BYTES} bytes` };
  if (sha256(json) !== parts[2]) return { ok: false, error: "result frame digest mismatch" };
  let result;
  try {
    result = JSON.parse(json.toString("utf8"));
  } catch {
    return { ok: false, error: "result frame payload is not JSON" };
  }
  const problems = resultProblems(result);
  if (problems.length > 0) return { ok: false, error: `result schema invalid: ${problems.join("; ")}` };
  return { ok: true, result };
}
