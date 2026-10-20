// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/provider-evidence.test.ts
// Local modifications (see test/PROVENANCE.md): added the no-profile case.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BASE_KEYS } from "./env.mjs";
import { createProviderEvidence } from "./provider-evidence.mjs";

// In-memory, socket-free. Profile bytes are injected (or read from a file inside the isolated root).
const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const ROOT = "/fixture/root";
const ENV = Object.fromEntries(BASE_KEYS.map((key: string) => [key, `/fixture/root/${key.toLowerCase()}`]));
const PROFILE = Buffer.from(`(version 1)\n(deny default)\n(allow file-read* (subpath "${ROOT}"))\n`);
const launch = (overrides: Record<string, unknown> = {}) => ({
  label: "preflight.provider",
  argv: ["/usr/bin/sandbox-exec", "-f", `${ROOT}/run/profile.sb`, "/staging/node", `${ROOT}/run/fake-provider.mjs`],
  cwd: `${ROOT}/run`,
  env: ENV,
  profilePath: `${ROOT}/run/profile.sb`,
  redactProfileText: (text: string) => text.split(ROOT).join("<FIXTURE>"),
  ...overrides,
});
const evidenceWith = (profile: Buffer = PROFILE) => createProviderEvidence({ readProfile: async () => profile });

describe("provider evidence: the intended launch is captured before spawn", () => {
  it("records role, label, argv, cwd, the nine-key env, and the raw-profile digest with labelled redacted text", async () => {
    const evidence = evidenceWith();
    await evidence.begin(ROOT, launch());
    const [record] = evidence.report(ROOT).launches;
    expect(record).toEqual({
      role: "provider",
      label: "preflight.provider",
      intended: { argv: launch().argv, cwd: `${ROOT}/run`, env: ENV },
      profile: {
        sha256: sha(PROFILE),
        bytes: PROFILE.length,
        digestOf: "raw profile bytes used for this launch",
        text: '(version 1)\n(deny default)\n(allow file-read* (subpath "<FIXTURE>"))\n',
        textNote: "path-redacted diagnostic text; not replayable; sha256 is of the raw bytes, not of this text",
      },
      acquisition: { outcome: "not-started" },
      startup: null,
      exit: null,
      stop: null,
    });
    expect(sha(Buffer.from(record.profile.text))).not.toBe(record.profile.sha256);
  });
});

describe("provider evidence: capture limits fail before launch (never silently truncated)", () => {
  const fails = async (overrides: Record<string, unknown>, message: RegExp, profile?: Buffer) => {
    const evidence = evidenceWith(profile);
    const error = await evidence.begin(ROOT, launch(overrides)).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ProviderEvidenceError");
    expect((error as Error).message).toMatch(message);
    const report = evidence.report(ROOT);
    expect(report.launches).toEqual([]);
    expect(report.captureFailures).toEqual([{ label: expect.any(String), reason: (error as Error).message.replace(/^provider launch evidence capture failed: /, "") }]);
    return { error: error as Error, report };
  };
  const argvOf = (count: number) => Array.from({ length: count }, (_, index) => `a${index}`);

  it("accepts exactly 16 argv elements and rejects 17", async () => {
    await expect(evidenceWith().begin(ROOT, launch({ argv: argvOf(16) }))).resolves.toMatchObject({ intended: { argv: argvOf(16) } });
    await fails({ argv: argvOf(17) }, /argv has 17 elements \(limit 16\)/);
  });

  it("accepts a 4096-byte argv element and rejects 4097 bytes, counting UTF-8 bytes", async () => {
    await expect(evidenceWith().begin(ROOT, launch({ argv: ["x".repeat(4096)] }))).resolves.toBeTruthy();
    await fails({ argv: [`${"é".repeat(2048)}x`] }, /argv\[0\] is 4097 UTF-8 bytes \(limit 4096\)/);
  });

  it("rejects an oversized or non-string label or cwd", async () => {
    await fails({ cwd: "c".repeat(4097) }, /cwd is 4097 UTF-8 bytes/);
    await fails({ label: 7 }, /label is not a string/);
  });

  it("requires exactly the nine minimal env keys with bounded string values, and never echoes a value", async () => {
    const secret = `rh-${"S".repeat(43)}`;
    const { error, report } = await fails({ env: { ...ENV, OPENCODE_SERVER_PASSWORD: secret } }, /env key OPENCODE_SERVER_PASSWORD is not a provider env key/);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
    const { HOME: _home, ...missing } = ENV;
    await fails({ env: missing }, /env key HOME is missing/);
    await fails({ env: { ...ENV, LANG: 1 } }, /env\.LANG is not a string/);
    await fails({ env: { ...ENV, PATH: "p".repeat(4097) } }, /env\.PATH is 4097 UTF-8 bytes/);
  });

  it("records a launch without a sandbox profile as profile: null and never reads one (council in-process provider)", async () => {
    let reads = 0;
    const evidence = createProviderEvidence({ readProfile: async () => (reads += 1, PROFILE) });
    const { profilePath: _profilePath, redactProfileText: _redact, ...withoutProfile } = launch({});
    const record = await evidence.begin(ROOT, withoutProfile as never);
    expect(record.profile).toBeNull();
    expect(reads).toBe(0);
  });

  it("accepts a 65536-byte profile and rejects 65537 bytes with a bounded read (real file inside the isolated root)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rh-evidence-"));
    created.push(dir);
    const evidence = createProviderEvidence();
    await writeFile(join(dir, "ok.sb"), Buffer.alloc(65536, 0x61));
    await expect(evidence.begin(ROOT, launch({ profilePath: join(dir, "ok.sb") }))).resolves.toMatchObject({ profile: { bytes: 65536 } });
    await writeFile(join(dir, "big.sb"), Buffer.alloc(65537 + 100_000, 0x61));
    const error = await evidence.begin(ROOT, launch({ profilePath: join(dir, "big.sb") })).catch((caught: Error) => caught);
    expect((error as Error).message).toMatch(/profile exceeds 65536 bytes/);
    const missing = await evidence.begin(ROOT, launch({ profilePath: join(dir, "absent.sb") })).catch((caught: Error) => caught);
    expect((missing as Error).message).toMatch(/profile unreadable \(ENOENT\)/);
    expect(evidence.report(ROOT).launches).toHaveLength(1);
  });

  it("keeps at most 32 launch records per fixture; the 33rd launch fails before spawn", async () => {
    const evidence = evidenceWith();
    for (let i = 0; i < 32; i += 1) await evidence.begin(ROOT, launch());
    const error = await evidence.begin(ROOT, launch()).catch((caught: Error) => caught);
    expect((error as Error).message).toMatch(/provider launch record limit 32 reached/);
    expect(evidence.report(ROOT).launches).toHaveLength(32);
    await expect(evidence.begin("/fixture/other", launch())).resolves.toBeTruthy();
  });
});

describe("provider evidence: post-acquisition facts are recorded in memory and never throw", () => {
  const begun = async () => {
    const evidence = evidenceWith();
    const record = await evidence.begin(ROOT, launch());
    return { evidence, record, last: () => evidence.report(ROOT).launches.at(-1) };
  };
  const throwingGetter = (base: Record<string, unknown>, key: string) =>
    Object.defineProperty({ ...base }, key, {
      get() {
        throw new Error("evidence getter failure");
      },
    });

  it("records the direct launcher pid/pgid and its exit event (code or signal), including a late exit", async () => {
    const { evidence, record, last } = await begun();
    let exit!: (value: unknown) => void;
    evidence.acquired(record, { pid: 4242, pgid: 4242, exited: new Promise((resolve) => (exit = resolve)) });
    expect(last()).toMatchObject({ acquisition: { outcome: "acquired", pid: 4242, pgid: 4242 }, exit: null });
    evidence.startup(record, { outcome: "ready" });
    exit({ code: null, signal: "SIGTERM" });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(last()).toMatchObject({ startup: { outcome: "ready" }, exit: { event: "exit", code: null, signal: "SIGTERM" } });
  });

  it("applies the numeric/boolean schema and absorbs a failing handle without throwing", async () => {
    const { evidence, record, last } = await begun();
    expect(() => evidence.acquired(record, { pid: "4242", pgid: 1.5, exited: Promise.resolve({ code: "1", signal: "not a signal" }) })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(last()).toMatchObject({ acquisition: { outcome: "acquired", pid: null, pgid: null }, exit: { event: "exit", code: null, signal: null } });
    const second = await begun();
    expect(() => second.evidence.acquired(second.record, throwingGetter({ pgid: 7 }, "pid"))).not.toThrow();
    expect(second.last()).toMatchObject({ acquisition: { outcome: "acquired", evidence: "unavailable" } });
  });

  it("records a spawn failure as a bounded name/code with no pid and no message", async () => {
    const { evidence, record, last } = await begun();
    evidence.spawnFailed(record, Object.assign(new Error("spawn failed: sk-injected-secret-value-123"), { code: "ENOENT" }));
    expect(last()).toMatchObject({ acquisition: { outcome: "spawn-failed", error: { name: "Error", code: "ENOENT" } } });
    expect(JSON.stringify(last())).not.toContain("sk-injected");
    evidence.spawnFailed(record, { name: "bad name with spaces", code: "not bounded!" });
    expect(last().acquisition).toEqual({ outcome: "spawn-failed", error: { name: "unknown", code: null } });
  });

  it("a spawn failure after acquisition does not erase the acquisition", async () => {
    const { evidence, record, last } = await begun();
    evidence.acquired(record, { pid: 5, pgid: 5, exited: new Promise(() => {}) });
    evidence.spawnFailed(record, new Error("work aborted during spawn"));
    expect(last().acquisition).toEqual({ outcome: "acquired", pid: 5, pgid: 5 });
  });

  it("records the raw stop result before any termination check, with the schema, including unsafe and aliveAfter", async () => {
    const { evidence, record, last } = await begun();
    evidence.stopReturned(record, { pgid: 9, termSent: true, killSent: true, aliveAfter: true, unsafe: true, alreadyGone: "no", extra: "ignored" });
    expect(last().stop).toEqual({ outcome: "returned", pgid: 9, termSent: true, killSent: true, aliveAfter: true, unsafe: true, alreadyGone: null });
    expect(() => evidence.stopReturned(record, throwingGetter({ pgid: 9, aliveAfter: false }, "killSent"))).not.toThrow();
    expect(last().stop).toEqual({ outcome: "returned", evidence: "unavailable" });
    expect(() => evidence.stopReturned(record, null)).not.toThrow();
    expect(last().stop).toEqual({ outcome: "returned", pgid: null, termSent: null, killSent: null, aliveAfter: null, unsafe: null, alreadyGone: null });
  });

  it("records a rejected stop as a bounded name/code only", async () => {
    const { evidence, record, last } = await begun();
    evidence.stopRejected(record, Object.assign(new Error(`refusing: ${"x".repeat(5000)} sk-injected-secret-value-123`), { code: "EPERM" }));
    expect(last().stop).toEqual({ outcome: "rejected", error: { name: "Error", code: "EPERM" } });
  });
});
