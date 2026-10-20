import { defineConfig } from "vitest/config";

import { assertIsolated } from "./test/isolated-env.mjs";

// Fail before any test module (or anything that resolves home/XDG/temp paths)
// is imported when tests are not launched through test/run-isolated.mjs
// (`npm test`). Pattern from skwid138/opencode-command-normalizer @ 7ddab8d6
// (see test/PROVENANCE.md).
assertIsolated();

export default defineConfig({
  test: {
    globals: false,
    // setup-isolation: environment guard (copied); no-docker-guard: council-only,
    // makes any docker invocation throw during `npm test`.
    setupFiles: ["./test/setup-isolation.mjs", "./test/no-docker-guard.mjs"],
  },
});
