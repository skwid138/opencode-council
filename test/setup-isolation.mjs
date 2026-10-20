// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/setup-isolation.mjs
// Local modifications (see test/PROVENANCE.md): provenance header only.
//
// Worker-side guard: runs before each test file's imports so no test module
// resolves home, XDG, or temp paths outside the launcher-owned root.
import { assertIsolated } from "./isolated-env.mjs";

assertIsolated();
