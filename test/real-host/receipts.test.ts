import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createReceiptGuard, markReceiptCancelled, markReceiptCancelledSync, PublishRefused, writeAtomic } from "./receipts.mjs";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rh-rcpt-")));
  created.push(dir);
  return dir;
}

describe("atomic receipt writes", () => {
  it("writes via a temp file + rename (replacing any previous content), leaving no temp file behind", async () => {
    const dir = await scratch();
    const path = join(dir, "gate-x.json");
    await writeFile(path, "old");
    await writeAtomic(path, '{"status":"accepted"}\n');
    expect(await readFile(path, "utf8")).toBe('{"status":"accepted"}\n');
    expect(await readdir(dir)).toEqual(["gate-x.json"]);
  });
});

describe("marking a receipt cancelled (never left accepted)", () => {
  it.each([
    ["async", (path: string, fields: Record<string, unknown>) => markReceiptCancelled(path, fields)],
    ["sync (signal handler)", async (path: string, fields: Record<string, unknown>) => markReceiptCancelledSync(path, fields)],
  ])("%s: an accepted / completed receipt keeps its fields but becomes status cancelled", async (_label, mark) => {
    const dir = await scratch();
    // "complete" is the Gate D report's success status (post-P1b audit frame-2 MA2).
    for (const status of ["accepted", "completed", "complete"]) {
      const path = join(dir, `r-${status}.json`);
      await writeFile(path, JSON.stringify({ status, images: { a: 1 } }));
      expect(await mark(path, { reason: "signal" })).toBe(true);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ status: "cancelled", previousStatus: status, images: { a: 1 }, reason: "signal" });
    }
  });

  it("leaves a missing, failed, or already-cancelled receipt alone", async () => {
    const dir = await scratch();
    expect(await markReceiptCancelled(join(dir, "missing.json"), {})).toBe(false);
    for (const status of ["failed", "cancelled", "rejected", "incomplete"]) {
      const path = join(dir, `${status}.json`);
      await writeFile(path, JSON.stringify({ status }));
      expect(markReceiptCancelledSync(path, {})).toBe(false);
      expect(JSON.parse(await readFile(path, "utf8")).status).toBe(status);
    }
  });

  it("an unreadable (corrupt) file claiming nothing is replaced by a cancelled marker", async () => {
    const dir = await scratch();
    const path = join(dir, "corrupt.json");
    await writeFile(path, '{"status":"accep');
    expect(await markReceiptCancelled(path, {})).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ status: "cancelled", previousStatus: "unreadable" });
  });
});

describe("receipt guard: once cancelled, no accepted/completed receipt can be published or left in place", () => {
  const accepted = '{"status":"accepted"}\n';

  it("a cancel while the write is outstanding (temp written, rename pending) refuses the publish; no temp left", async () => {
    const dir = await scratch();
    const path = join(dir, "gate-b.json");
    const guard = createReceiptGuard({ hooks: { beforeRename: () => guard.cancelSync({}) } });
    await expect(guard.write(path, accepted)).rejects.toThrow(PublishRefused);
    expect(await readdir(dir)).toEqual([]);
  });

  it("a cancel before the temp file is even created also refuses the publish", async () => {
    const dir = await scratch();
    const path = join(dir, "gate-b.json");
    const guard = createReceiptGuard({ hooks: { beforeWrite: () => guard.cancelSync({}) } });
    await expect(guard.write(path, accepted)).rejects.toThrow(PublishRefused);
    expect(await readdir(dir)).toEqual([]);
  });

  it("cancelSync unlinks pending temp files synchronously", async () => {
    const dir = await scratch();
    let seen: string[] = [];
    const guard = createReceiptGuard({
      hooks: {
        beforeRename: async () => {
          seen = await readdir(dir);
          guard.cancelSync({});
          seen.push("|after|", ...(await readdir(dir)));
        },
      },
    });
    await expect(guard.write(join(dir, "r.json"), accepted)).rejects.toThrow(PublishRefused);
    expect(seen[0]).toMatch(/^\.r\.json\.tmp-/);
    expect(seen.slice(seen.indexOf("|after|") + 1)).toEqual([]);
  });

  it("cancelled-status writes still publish after the cancel", async () => {
    const dir = await scratch();
    const guard = createReceiptGuard();
    guard.cancelSync({});
    await guard.write(join(dir, "c.json"), '{"status":"cancelled"}\n');
    guard.writeSync(join(dir, "d.json"), '{"status":"cancelled"}\n');
    expect(guard.cancelled).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(["c.json", "d.json"]);
    expect(() => guard.writeSync(join(dir, "e.json"), accepted)).toThrow(PublishRefused);
  });

  it("cancelSync marks ONLY receipts this invocation wrote (ownership); others are untouched", async () => {
    const dir = await scratch();
    const prior = join(dir, "prior.json");
    await writeFile(prior, accepted);
    const guard = createReceiptGuard();
    await guard.write(join(dir, "mine.json"), accepted);
    expect([...guard.owned]).toEqual([join(dir, "mine.json")]);
    guard.cancelSync({ by: "signal" });
    expect(JSON.parse(await readFile(join(dir, "mine.json"), "utf8"))).toMatchObject({ status: "cancelled", previousStatus: "accepted", by: "signal" });
    expect(await readFile(prior, "utf8")).toBe(accepted);
  });

  it("if marking throws, the owned receipt is deleted synchronously instead (sync and async paths)", async () => {
    const dir = await scratch();
    const boom = () => {
      throw new Error("mark failed");
    };
    const guard = createReceiptGuard({ markSync: boom, mark: async () => boom() });
    const a = join(dir, "a.json");
    await guard.write(a, accepted);
    guard.cancelSync({});
    expect(await readdir(dir)).toEqual([]);
    const second = createReceiptGuard({ markSync: boom, mark: async () => boom() });
    await second.write(a, accepted);
    const problems = await second.markOwnedCancelled({});
    expect(await readdir(dir)).toEqual([]);
    expect(problems.join()).toMatch(/mark failed/);
  });
});
