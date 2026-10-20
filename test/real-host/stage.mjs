#!/usr/bin/env node
// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/stage.mjs
// Local modifications (see test/PROVENANCE.md): none.
// Gate 2 staging helper. Local files only: it never downloads anything.
// Run only under a separately approved Gate 2 recipe.
//
//   node test/real-host/stage.mjs inspect --kind zip|tgz --archive <file> [--expect-sha256 <hex>] [--expect-integrity <sri>]
//       --limits '<json>' (required: bounds tgz decompression and caps the listing's entries, per-file and summed sizes;
//       the exact member allowlist is a separate, later review)
//       Prints { size, sha256, sha512Integrity, entries[] }. Writes nothing.
//       Use it to review exact members and limits for the recipe.
//   node test/real-host/stage.mjs extract --kind zip|tgz --archive <file> --member <name> --dest <new file>
//       --limits '{"maxEntries":..,"maxExpandedBytes":..,"maxFileBytes":..}' --members '{"required":[..],"allowed":[..]}'
//       [--expect-sha256 <hex>] [--expect-integrity <sri>]
//       Validates the whole listing, then writes exactly one regular member (never overwrites).
//   node test/real-host/stage.mjs hash --file <file>
//
// Exit codes: 0 ok, 2 refused (validation, hash mismatch, or usage).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { extractMember, limitsProblems, listTarGz, listZip, numericCapProblems, sha256File, tarCapFor, validateEntries } from "./artifacts.mjs";

const refuse = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const [command, ...rest] = process.argv.slice(2);
let opts;
try {
  opts = parseArgs({
    args: rest,
    options: {
      kind: { type: "string" },
      archive: { type: "string" },
      file: { type: "string" },
      member: { type: "string" },
      dest: { type: "string" },
      limits: { type: "string" },
      members: { type: "string" },
      "expect-sha256": { type: "string" },
      "expect-integrity": { type: "string" },
    },
  }).values;
} catch (error) {
  refuse(error.message);
}

async function load() {
  if (opts.kind !== "zip" && opts.kind !== "tgz") refuse("--kind must be zip or tgz");
  if (!opts.archive) refuse("--archive is required");
  const buffer = await readFile(opts.archive);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const sha512Integrity = `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
  if (opts["expect-sha256"] && opts["expect-sha256"] !== sha256) refuse(`hash mismatch: expected ${opts["expect-sha256"]}, got ${sha256}`);
  if (opts["expect-integrity"] && opts["expect-integrity"] !== sha512Integrity) refuse(`integrity mismatch: expected ${opts["expect-integrity"]}, got ${sha512Integrity}`);
  let limits = null;
  try {
    limits = opts.limits ? JSON.parse(opts.limits) : null;
  } catch (error) {
    refuse(`invalid --limits JSON: ${error.message}`);
  }
  // Every inspection needs reviewed limits: a tgz listing decompresses (bounded by them), and every
  // listing's actual entry count, per-file size, and summed size are capped before any success output.
  const schema = limitsProblems(limits);
  if (schema.length > 0) refuse(`inspection requires reviewed --limits (bounded decompression and listing caps): ${schema.join("; ")}`);
  let entries;
  try {
    entries = opts.kind === "zip" ? listZip(buffer) : listTarGz(buffer, { maxTarBytes: tarCapFor(limits) });
  } catch (error) {
    refuse(`archive rejected: ${error.message}`);
  }
  const caps = numericCapProblems(entries, limits);
  if (caps.length > 0) refuse(`archive rejected by listing caps:\n- ${caps.join("\n- ")}`);
  return { buffer, sha256, sha512Integrity, entries, limits };
}

const json = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

if (command === "inspect") {
  const { buffer, sha256, sha512Integrity, entries } = await load();
  json({ size: buffer.length, sha256, sha512Integrity, entries: entries.map(({ name, type, size, linkname }) => ({ name, type, size, linkname })) });
} else if (command === "extract") {
  const { buffer, entries, limits, sha256, sha512Integrity } = await load();
  let members = null;
  try {
    members = opts.members ? JSON.parse(opts.members) : null;
  } catch (error) {
    refuse(`invalid --members JSON: ${error.message}`);
  }
  const validation = validateEntries(entries, { limits, members });
  if (!validation.ok) refuse(`archive rejected:\n- ${validation.problems.join("\n- ")}`);
  if (!opts.member || !opts.dest) refuse("--member and --dest are required");
  try {
    await extractMember({ kind: opts.kind, buffer, entries, name: opts.member, dest: opts.dest, limits });
  } catch (error) {
    refuse(`extract failed: ${error.message}`);
  }
  const digest = await sha256File(opts.dest);
  // Provenance record for the run manifest; the runtime gate re-verifies every field.
  json({ dest: opts.dest, sha256: digest, provenance: { archive: { sha256, integrity: sha512Integrity }, member: opts.member, memberSha256: digest } });
} else if (command === "hash") {
  if (!opts.file) refuse("--file is required");
  json({ file: opts.file, sha256: await sha256File(opts.file) });
} else {
  refuse("usage: stage.mjs inspect|extract|hash ... (see header)");
}
