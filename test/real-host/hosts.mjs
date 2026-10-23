// Council-only: host adapter lookup by family.
import { v1Host } from "./host-v1.mjs";
import { v2Host } from "./host-v2.mjs";

export function hostAdapter(family) {
  if (family === "v1") return v1Host;
  if (family === "v2") return v2Host;
  throw new Error(`unknown host family ${family}`);
}
