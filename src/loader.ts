import { BridgeConfigError } from "./errors.ts";
import type { ManifestEntry } from "./manifest.ts";
// Tool loading (FR-003): import each manifest entry, call its factory, verify the
// product's shape, mount under its final name. Every failure is per-entry: one bad
// factory never prevents the others from mounting (FR-002 rows 5-8).
import type { BridgeTool } from "./protocol.ts";

export interface MountedTool {
	name: string;
	tool: BridgeTool;
	entry: ManifestEntry;
}

export interface LoadResult {
	tools: Map<string, MountedTool>;
	diagnostics: string[];
}

function diag(entry: ManifestEntry, reason: string): string {
	return new BridgeConfigError(entry.source, reason).message;
}

/** Load and mount tools. cwd is passed only to factories whose entry says `cwd: true`. */
export async function loadTools(entries: ManifestEntry[], cwd: string): Promise<LoadResult> {
	const tools = new Map<string, MountedTool>();
	const diagnostics: string[] = [];

	for (const entry of entries) {
		let mod: Record<string, unknown>;
		try {
			mod = (await import(entry.specifier)) as Record<string, unknown>;
		} catch (err) {
			diagnostics.push(
				diag(entry, `cannot import — ${err instanceof Error ? err.message : String(err)}`),
			);
			continue;
		}
		const factory = mod[entry.factory];
		if (typeof factory !== "function") {
			const exports = Object.keys(mod).join(", ") || "(none)";
			diagnostics.push(diag(entry, `no export "${entry.factory}" — module exports: ${exports}`));
			continue;
		}
		let product: unknown;
		try {
			product = entry.cwd
				? await (factory as (cwd: string) => unknown)(cwd)
				: await (factory as () => unknown)();
		} catch (err) {
			diagnostics.push(
				diag(
					entry,
					`factory "${entry.factory}" threw — ${err instanceof Error ? err.message : String(err)}`,
				),
			);
			continue;
		}
		if (typeof product !== "object" || product === null) {
			diagnostics.push(
				diag(
					entry,
					`factory "${entry.factory}" returned ${String(product)} — expected a tool object`,
				),
			);
			continue;
		}
		const tool = product as Partial<BridgeTool>;
		const name = entry.nameOverride ?? tool.name;
		if (typeof name !== "string" || name.length === 0 || typeof tool.execute !== "function") {
			diagnostics.push(
				diag(
					entry,
					`factory "${entry.factory}" returned a shape without name/execute — ` +
						`got name: ${typeof tool.name}, execute: ${typeof tool.execute}`,
				),
			);
			continue;
		}
		if (tools.has(name)) {
			diagnostics.push(diag(entry, `duplicate tool name "${name}" — keeping the first`));
			continue;
		}
		tools.set(name, { name, tool: product as BridgeTool, entry });
	}
	return { tools, diagnostics };
}
