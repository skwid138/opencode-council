// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/signals.test.ts
// Local modifications (see test/PROVENANCE.md): none.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { exitCodeFor, installSignalHandlers } from "./signals.mjs";

function fakes() {
  const proc = Object.assign(new EventEmitter(), { exits: [] as number[], exit(code: number) { this.exits.push(code); } });
  const supervisor = { stops: 0, async stopAll() { this.stops += 1; return []; } };
  return { proc, supervisor, controller: new AbortController() };
}

describe("signal handling", () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    it(`${signal}: aborts the run and stops owned processes first, without exiting (cleanup and report still run)`, async () => {
      const { proc, supervisor, controller } = fakes();
      const { uninstall } = installSignalHandlers({ controller, supervisor, proc });
      proc.emit(signal);
      await new Promise((resolve) => setImmediate(resolve));
      expect(controller.signal.aborted).toBe(true);
      expect(supervisor.stops).toBe(1);
      expect(proc.exits).toEqual([]);
      uninstall();
      expect(proc.listenerCount(signal)).toBe(0);
    });
  }

  it("a second signal exits immediately with 130 after stopping owned processes again", async () => {
    const { proc, supervisor, controller } = fakes();
    installSignalHandlers({ controller, supervisor, proc });
    proc.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    proc.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    expect(supervisor.stops).toBe(2);
    expect(proc.exits).toEqual([130]);
  });

  it("catches a rejecting shutdown stop, records it, and leaves no unhandled rejection", async () => {
    const { proc, controller } = fakes();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const supervisor = { async stopAll() { throw new Error("group 77 survived stop"); } };
      const handlers = installSignalHandlers({ controller, supervisor, proc });
      proc.emit("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handlers.failures()).toEqual(["SIGTERM shutdown stop failed: group 77 survived stop"]);
      expect(controller.signal.aborted).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("exit codes", () => {
  it("is 130 for an aborted run, 0 only for a complete matrix or a passed pilot verdict, else 1", () => {
    expect(exitCodeFor({ aborted: true, report: { status: "complete" }, pilot: null })).toBe(130);
    expect(exitCodeFor({ aborted: false, report: { status: "complete" }, pilot: null })).toBe(0);
    expect(exitCodeFor({ aborted: false, report: { status: "incomplete" }, pilot: { passed: true, problems: [] } })).toBe(0);
    expect(exitCodeFor({ aborted: false, report: { status: "incomplete" }, pilot: { passed: false, problems: ["cleanup"] } })).toBe(1);
    expect(exitCodeFor({ aborted: false, report: { status: "failed" }, pilot: null })).toBe(1);
  });
});
