// Council-only. Gate receipts are written ATOMICALLY (temp file in the same directory +
// rename), so a receipt is either the old content or the complete new content, and a
// cancelled run can always overwrite a receipt it just wrote. A receipt that says
// "accepted" / "completed" is marked "cancelled" (fields kept, `previousStatus` recorded)
// when an operator signal arrives during or after its write; downstream gates refuse any
// receipt that is not "accepted".
//
// createReceiptGuard(): the per-invocation guard run.mjs uses for every gate receipt.
// cancelSync() (called SYNCHRONOUSLY from the signal handler, first signal included) sets
// the guard's cancelled flag, unlinks pending temp files, and marks every receipt THIS
// invocation published as cancelled (deleting it if marking fails). The publish decision is
// synchronous (flag check + renameSync in one tick), so no signal handler can run between
// them: once cancelled, an accepted / completed receipt is never published, even if the
// process exits immediately on a second signal.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { DIAGNOSTIC_SCHEMA } from "./diagnostic.mjs";

const tempFor = (path) => join(dirname(path), `.${basename(path)}.tmp-${randomBytes(6).toString("hex")}`);
// "complete": the Gate D qualification report's success status (post-P1b audit frame-2 MA2).
// "terminal": the S11 diagnostic's outcome receipt (any outcome; cancel-markable like the others).
const USABLE = new Set(["accepted", "completed", "complete", "terminal"]);

export async function writeAtomic(path, text) {
  const temp = tempFor(path);
  try {
    await writeFile(temp, text, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export function writeAtomicSync(path, text) {
  const temp = tempFor(path);
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // never created
    }
    throw error;
  }
}

/** Parsed receipt, `{ unreadable: true }` for a corrupt file, or null when it does not exist. */
function parse(text) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { unreadable: true };
  }
}

function cancelledVersion(existing, fields) {
  if (existing === null) return null;
  if (existing.unreadable) return { status: "cancelled", previousStatus: "unreadable", ...fields };
  if (!USABLE.has(existing.status)) return null;
  const { status, ...rest } = existing;
  // A diagnostic terminal receipt: cancellation is its authoritative outcome (the stale one is
  // kept as `previousOutcome`). Every other receipt keeps its fields as before.
  if (existing.schema === DIAGNOSTIC_SCHEMA) return { status: "cancelled", previousStatus: status, ...rest, ...fields, outcome: "cancelled", previousOutcome: existing.outcome ?? null };
  return { status: "cancelled", previousStatus: status, ...rest, ...fields };
}

/** Marks an existing accepted / completed (or unreadable) receipt as cancelled. Returns whether it rewrote it. */
export async function markReceiptCancelled(path, fields = {}) {
  const next = cancelledVersion(parse(await readFile(path, "utf8").catch(() => null)), fields);
  if (!next) return false;
  await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

/** Synchronous variant for the signal handler (runs before signals.mjs may exit on a second signal). */
export function markReceiptCancelledSync(path, fields = {}) {
  let text = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null;
  }
  const next = cancelledVersion(parse(text), fields);
  if (!next) return false;
  writeAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

/** Thrown when a usable (accepted / completed) receipt would be published after cancellation. */
export class PublishRefused extends Error {}

const statusOf = (text) => {
  try {
    return JSON.parse(text)?.status ?? null;
  } catch {
    return null;
  }
};
const unlinkQuietly = (path) => {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
};

export function createReceiptGuard({ hooks = {}, markSync = markReceiptCancelledSync, mark = markReceiptCancelled } = {}) {
  let cancelled = false;
  const pending = new Set();
  const owned = new Set();
  /** Synchronous publish: refuse a usable status once cancelled; otherwise rename and take ownership. */
  const publish = (temp, path, text) => {
    if (cancelled && USABLE.has(statusOf(text))) {
      unlinkQuietly(temp);
      throw new PublishRefused(`refused to publish ${statusOf(text)} receipt after cancellation: ${path}`);
    }
    renameSync(temp, path);
    owned.add(path);
  };
  return {
    get cancelled() {
      return cancelled;
    },
    owned,
    pendingCount: () => pending.size,
    async write(path, text) {
      await hooks.beforeWrite?.(path, text);
      const temp = tempFor(path);
      pending.add(temp);
      try {
        await writeFile(temp, text, { flag: "wx", mode: 0o600 });
        await hooks.beforeRename?.(path, text);
        publish(temp, path, text);
      } finally {
        pending.delete(temp);
        unlinkQuietly(temp);
      }
      await hooks.afterPublish?.(path, text);
    },
    writeSync(path, text) {
      const temp = tempFor(path);
      try {
        writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
        publish(temp, path, text);
      } finally {
        unlinkQuietly(temp);
      }
    },
    /** Signal handler path: entirely synchronous. Returns problems (never throws). */
    cancelSync(fields = {}) {
      cancelled = true;
      const problems = [];
      for (const temp of pending) unlinkQuietly(temp);
      for (const path of owned) {
        try {
          markSync(path, fields);
        } catch (error) {
          problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          if (!unlinkQuietly(path) && existsSyncSafe(path)) problems.push(`${path}: could not delete either`);
        }
      }
      return problems;
    },
    /** Async path (cancelledExit): mark owned receipts cancelled, deleting any that cannot be marked. */
    async markOwnedCancelled(fields = {}) {
      cancelled = true;
      const problems = [];
      for (const path of owned) {
        try {
          await mark(path, fields);
        } catch (error) {
          problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          if (!unlinkQuietly(path) && existsSyncSafe(path)) problems.push(`${path}: could not delete either`);
        }
      }
      return problems;
    },
  };
}

function existsSyncSafe(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
