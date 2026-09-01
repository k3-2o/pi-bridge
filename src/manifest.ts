// Manifest parse/validate (FR-001/FR-002); never imports tool files — loader.ts does that.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeConfigError, manifestFileDiagnostic } from "./errors.ts";

export const DEFAULT_MANIFEST_PATH = join(homedir(), ".pi", "agent", "pi-bridge", "tools.yml");

export interface ManifestEntry {
	/** Absolute file path or bare package specifier — what loader.ts will import(). */
	specifier: string;
	factory: string;
	cwd: boolean;
	timeout: number | undefined;
	nameOverride: string | undefined;
	/** The original `from` string, for diagnostics. */
	source: string;
}

export interface ManifestResult {
	entries: ManifestEntry[];
	diagnostics: string[];
}

interface RawEntry {
	from?: unknown;
	factory?: unknown;
	name?: unknown;
	cwd?: unknown;
	timeout?: unknown;
}

/** Grammar (FR-001): bare token = package name; leading ~ = home-anchored file;
 * leading / or ./ or ../ = file path, resolved against the manifest's directory. */
function toSpecifier(
	from: string,
	dir: string,
	home: string,
): { specifier: string; file: boolean } {
	if (from === "~" || from.startsWith("~/")) {
		return { specifier: join(home, from.slice(2)), file: true };
	}
	if (from.startsWith("/") || from.startsWith("./") || from.startsWith("../")) {
		return { specifier: resolve(dir, from), file: true };
	}
	return { specifier: from, file: false };
}

function entryDiagnostic(source: string, reason: string): string {
	return new BridgeConfigError(source, reason).message;
}

/** Parse and validate manifest text. Never throws: every problem becomes a
 * diagnostic; `entries` holds only what fully validated (FR-002 rows 1-4, 8). */
export function parseManifest(
	text: string,
	opts: { dir: string; home?: string } = { dir: process.cwd() },
): ManifestResult {
	const home = opts.home ?? homedir();
	const fail = (reason: string): ManifestResult => ({
		entries: [],
		diagnostics: [manifestFileDiagnostic(opts.dir, reason)],
	});

	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(text);
	} catch (err) {
		return fail(`invalid YAML — ${err instanceof Error ? err.message : String(err)}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		return fail("top level must be a mapping");
	}
	const doc = parsed as Record<string, unknown>;
	if (doc.version !== 1) {
		return fail(`unsupported version ${JSON.stringify(doc.version) ?? "(missing)"} — expected 1`);
	}
	if (!Array.isArray(doc.tools)) {
		return fail('"tools" must be a list');
	}

	const entries: ManifestEntry[] = [];
	const diagnostics: string[] = [];
	const claimedOverrides = new Set<string>();

	for (const raw of doc.tools) {
		if (typeof raw !== "object" || raw === null) {
			diagnostics.push(entryDiagnostic("(non-object entry)", "entry must be a mapping"));
			continue;
		}
		const item = raw as RawEntry;
		const source = typeof item.from === "string" ? item.from : "(missing from)";
		if (typeof item.from !== "string" || item.from.length === 0) {
			diagnostics.push(entryDiagnostic(source, 'entry needs a "from"'));
			continue;
		}
		if (typeof item.factory !== "string" || item.factory.length === 0) {
			diagnostics.push(entryDiagnostic(source, 'entry needs a "factory"'));
			continue;
		}
		if (item.cwd !== undefined && typeof item.cwd !== "boolean") {
			diagnostics.push(entryDiagnostic(source, '"cwd" must be true or false'));
			continue;
		}
		if (
			item.timeout !== undefined &&
			(typeof item.timeout !== "number" || !Number.isFinite(item.timeout) || item.timeout <= 0)
		) {
			diagnostics.push(entryDiagnostic(source, '"timeout" must be a positive number (seconds)'));
			continue;
		}
		if (item.name !== undefined && (typeof item.name !== "string" || item.name.length === 0)) {
			diagnostics.push(entryDiagnostic(source, '"name" must be a non-empty string'));
			continue;
		}
		const nameOverride = item.name as string | undefined;
		if (nameOverride && claimedOverrides.has(nameOverride)) {
			diagnostics.push(
				entryDiagnostic(source, `duplicate tool name "${nameOverride}" — keeping the first`),
			);
			continue;
		}
		const { specifier, file } = toSpecifier(item.from, opts.dir, home);
		if (file && !existsSync(specifier)) {
			diagnostics.push(entryDiagnostic(item.from, `file not found — checked ${specifier}`));
			continue;
		}
		if (nameOverride) claimedOverrides.add(nameOverride);
		entries.push({
			specifier,
			factory: item.factory,
			cwd: (item.cwd as boolean | undefined) ?? false,
			timeout: item.timeout as number | undefined,
			nameOverride,
			source: item.from,
		});
	}
	return { entries, diagnostics };
}

/** Read the manifest from disk (FR-002 rows 1-2: missing file and unreadable file
 * both boot empty with one diagnostic naming the path). */
export async function readManifest(path: string = DEFAULT_MANIFEST_PATH): Promise<ManifestResult> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return {
			entries: [],
			diagnostics: [
				manifestFileDiagnostic(path, "not found — bridge boots with no declared tools"),
			],
		};
	}
	return parseManifest(await file.text(), { dir: resolve(path, "..") });
}
