// Bridge wiring (FR-012): session lifecycle, manifest→loader→server orchestration, env var.
// Loaded only when the repl gate passes — a plain coding session never pays for it.

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTools } from "./loader.ts";
import type { MountedTool } from "./loader.ts";
import { readManifest } from "./manifest.ts";
import { BridgeServer, type RegistryEntry, pickSocketDir } from "./server.ts";

/** Env var the kernel reads to find the socket; set before the kernel spawns. */
export const BRIDGE_ENV = "PI_BRIDGE_SOCK";

export async function startBridge(pi: ExtensionAPI): Promise<void> {
	let server: BridgeServer | undefined;
	let socketPath: string | undefined;
	// Session cwd at call time — a new session rebinds factories without a server restart (FR-003-2).
	let currentCwd = "";
	let mounted: Promise<Map<string, MountedTool>> | undefined;
	let mountedCwd: string | undefined;
	const registry = new Map<string, RegistryEntry>();

	/** Manifest+loader run on the first frame that needs tools, once per cwd (FR-002 holds; only the timing moves). */
	function tools(): Promise<Map<string, MountedTool>> {
		if (!mounted || mountedCwd !== currentCwd) {
			mountedCwd = currentCwd;
			mounted = (async () => {
				const manifest = await readManifest();
				for (const line of manifest.diagnostics) console.error(line);
				const loaded = await loadTools(manifest.entries, currentCwd);
				for (const line of loaded.diagnostics) console.error(line);
				return loaded.tools;
			})();
			mounted.catch(() => {
				mounted = undefined;
			});
		}
		return mounted;
	}

	// Global extensions load before packages: socket + env var are race-free with kernel spawn.
	pi.on("session_start", async (_event, ctx) => {
		currentCwd = ctx.cwd;

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
			tools,
			registry: () => registry,
			ctx,
		});
		socketPath ??= join(pickSocketDir(), `pi-bridge-${process.pid}.sock`);
		server.start(socketPath);
		process.env[BRIDGE_ENV] = socketPath;
		if (ctx.hasUI) ctx.ui.notify("pi-bridge: socket ready — tools load on first call", "info");
	});

	pi.on("session_shutdown", async () => {
		server?.stop();
		delete process.env[BRIDGE_ENV];
	});
}
