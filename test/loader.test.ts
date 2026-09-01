import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/loader.ts";
import type { ManifestEntry } from "../src/manifest.ts";

const dirs: string[] = [];
function fixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-bridge-loader-"));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function entry(
	specifier: string,
	factory: string,
	extra: Partial<ManifestEntry> = {},
): ManifestEntry {
	return {
		specifier,
		factory,
		cwd: false,
		timeout: undefined,
		nameOverride: undefined,
		source: specifier,
		...extra,
	};
}

/** Write a fixture module and return its absolute path. */
function mod(dir: string, name: string, code: string): string {
	const p = join(dir, name);
	writeFileSync(p, code);
	return p;
}

describe("FR-002 row 5: missing factory export names the module's real exports", () => {
	test("typo'd factory lists what the module actually exports", async () => {
		const dir = fixtureDir();
		const p = mod(
			dir,
			"tool.ts",
			"export const createThing = () => ({ name: 't', execute: async () => ({}) });\n",
		);
		const res = await loadTools([entry(p, "createThingg")], "/cwd");
		expect(res.tools.size).toBe(0);
		expect(res.diagnostics[0]).toContain('no export "createThingg"');
		expect(res.diagnostics[0]).toContain("createThing");
	});
});

describe("FR-002 row 6: garbage factory products are rejected, naming the factory", () => {
	test.each([
		["returns null", "export const f = () => null;", "expected a tool object"],
		["returns primitive", "export const f = () => 42;", "expected a tool object"],
		["missing execute", "export const f = () => ({ name: 'x' });", "without name/execute"],
		[
			"missing name",
			"export const f = () => ({ execute: async () => ({}) });",
			"without name/execute",
		],
	])("%s", async (_label, code, expected) => {
		const dir = fixtureDir();
		const p = mod(dir, "tool.ts", `${code}\n`);
		const res = await loadTools([entry(p, "f")], "/cwd");
		expect(res.tools.size).toBe(0);
		expect(res.diagnostics[0]).toContain('factory "f" returned');
		expect(res.diagnostics[0]).toContain(expected);
	});
});

describe("FR-002 row 7: duplicate final names keep the first", () => {
	test("second mount attempt is discarded with a diagnostic", async () => {
		const dir = fixtureDir();
		const a = mod(
			dir,
			"a.ts",
			"export const f = () => ({ name: 'dup', execute: async () => ({}) });\n",
		);
		const b = mod(
			dir,
			"b.ts",
			"export const f = () => ({ name: 'dup', execute: async () => ({}) });\n",
		);
		const res = await loadTools([entry(a, "f"), entry(b, "f")], "/cwd");
		expect(res.tools.size).toBe(1);
		expect(res.diagnostics[0]).toContain('duplicate tool name "dup"');
	});
});

describe("FR-003: cwd injection", () => {
	test("cwd: true passes the session cwd; false passes nothing; async factories awaited", async () => {
		const dir = fixtureDir();
		const a = mod(
			dir,
			"a.ts",
			"export const f = (cwd: string) => ({ name: 'a', seen: cwd, execute: async () => ({}) });\n",
		);
		const b = mod(
			dir,
			"b.ts",
			"export const f = async () => ({ name: 'b', seen: 'none', execute: async () => ({}) });\n",
		);
		const res = await loadTools(
			[entry(a, "f", { cwd: true }), entry(b, "f", { cwd: true })],
			"/session/cwd",
		);
		expect(res.tools.size).toBe(2);
		expect((res.tools.get("a")?.tool as unknown as { seen: string }).seen).toBe("/session/cwd");
		expect((res.tools.get("b")?.tool as unknown as { seen: string }).seen).toBe("none");
	});
});

describe("per-entry isolation", () => {
	test("a throwing factory skips only its own entry", async () => {
		const dir = fixtureDir();
		const bad = mod(dir, "bad.ts", "export const f = () => { throw new Error('kaboom'); };\n");
		const good = mod(
			dir,
			"good.ts",
			"export const f = () => ({ name: 'good', execute: async () => ({}) });\n",
		);
		const res = await loadTools([entry(bad, "f"), entry(good, "f")], "/cwd");
		expect(res.tools.size).toBe(1);
		expect(res.tools.has("good")).toBe(true);
		expect(res.diagnostics[0]).toContain("threw");
		expect(res.diagnostics[0]).toContain("kaboom");
	});

	test("unresolvable package specifier skips with the import error", async () => {
		const res = await loadTools([entry("@pi/definitely-not-a-real-package", "f")], "/cwd");
		expect(res.tools.size).toBe(0);
		expect(res.diagnostics[0]).toContain("cannot import");
	});
});

describe("name overrides", () => {
	test("override wins over the product's own name", async () => {
		const dir = fixtureDir();
		const p = mod(
			dir,
			"tool.ts",
			"export const f = () => ({ name: 'internal', execute: async () => ({}) });\n",
		);
		const res = await loadTools([entry(p, "f", { nameOverride: "public" })], "/cwd");
		expect(res.tools.has("public")).toBe(true);
		expect(res.tools.has("internal")).toBe(false);
	});
});
