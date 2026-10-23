/**
 * Council Review Tool Plugin
 *
 * Exposes council_review(prompt), which runs the same review prompt through a
 * configured set of reviewers in parallel, then asks an aggregator to
 * structurally aggregate the results.
 *
 * Public entrypoint. Named exports are the stable public API. The default
 * export is one dual-host plugin module object (the same object from `.` and
 * `./server`): OpenCode V1 calls `server`, OpenCode V2 calls `setup`.
 */

import { CouncilToolPlugin } from "./v1.js";
import { setup } from "./v2.js";

export { CouncilToolPlugin };
export {
  composeCouncilConfig,
  parseCouncilConfig,
  parseCouncilConfig as validateCouncilConfig,
  resolveDebug,
} from "./config.js";
export { raceWithTimeout } from "./timeout.js";

export default { id: "skwid138.opencode-council", server: CouncilToolPlugin, setup };
