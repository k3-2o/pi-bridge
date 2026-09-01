// T003 smoke entry — proves extensions/<dir>/index.ts loads with helper imports.
// Replaced by the real extension entry in T014; not grown into.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { smoke } from "./src/log.ts";

const MARKER = "/tmp/pi-bridge-smoke-loaded.marker";

export default function (_pi: ExtensionAPI): void {
	smoke(MARKER);
}
