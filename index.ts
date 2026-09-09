// Repo root IS the extension. This stub is all a non-repl session ever evaluates;
// the real wiring loads behind the repl gate (argv/PI_REPL_FORCE — getFlag() only sees own flags).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function replRequested(): boolean {
	return (
		process.argv.some((arg) => arg === "--repl" || arg === "--repl=true") ||
		process.env.PI_REPL_FORCE === "1"
	);
}

export default async function (pi: ExtensionAPI): Promise<void> {
	if (!replRequested()) return;
	const { startBridge } = await import("./src/bridge.ts");
	await startBridge(pi);
}
