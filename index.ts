// Repo root IS the extension; companion to pi-repl-py, zero changes. Gate: argv/PI_REPL_FORCE (getFlag() only sees own flags).

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTools } from "./src/loader.ts";
import type { MountedTool } from "./src/loader.ts";
import { readManifest } from "./src/manifest.ts";
import { BridgeServer, type RegistryEntry, pickSocketDir } from "./src/server.ts";

/** Env var the kernel reads to find the socket; set before the kernel spawns. */
export const BRIDGE_ENV = "PI_BRIDGE_SOCK";

function replRequested(): boolean {
	return (
		process.argv.some((arg) => arg === "--repl" || arg === "--repl=true") ||
		process.env.PI_REPL_FORCE === "1"
	);
}

export default function (pi: ExtensionAPI): void {
	if (!replRequested()) return;

	let server: BridgeServer | undefined;
	let socketPath: string | undefined;
	// tools() reads the CURRENT map, so a session_start rebind needs no server restart.
	let tools = new Map<string, MountedTool>();
	const registry = new Map<string, RegistryEntry>();

	// Global extensions load before packages: socket + env var are race-free with kernel spawn.
	pi.on("session_start", async (_event, ctx) => {
		const manifest = await readManifest();
		for (const line of manifest.diagnostics) console.error(line);

		const loaded = await loadTools(manifest.entries, ctx.cwd);
		for (const line of loaded.diagnostics) console.error(line);
		tools = loaded.tools;

		try {
			registry.clear();
			const all = (pi.getAllTools() ?? []) as Array<{
				name?: string;
				description?: string;
				sourceInfo?: unknown;
			}>;
			for (const tool of all) {
				if (tool.name) {
					registry.set(tool.name, { description: tool.description, sourceInfo: tool.sourceInfo });
				}
			}
		} catch {
			/* registry metadata is best-effort; the execution map is independent */
		}

		server ??= new BridgeServer({
			tools: () => tools,
			registry: () => registry,
			ctx,
		});
		socketPath ??= join(pickSocketDir(), `pi-bridge-${process.pid}.sock`);
		server.start(socketPath);
		process.env[BRIDGE_ENV] = socketPath;
		if (ctx.hasUI) ctx.ui.notify(`pi-bridge: ${tools.size} tools ready`, "info");
	});

	pi.on("session_shutdown", async () => {
		server?.stop();
		delete process.env[BRIDGE_ENV];
	});
}
