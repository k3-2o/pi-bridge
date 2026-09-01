import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest, readManifest } from "../src/manifest.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-bridge-manifest-"));
}

describe("FR-002 row 1-2: missing file / invalid YAML boot empty with a diagnostic", () => {
	test("missing file names the path it looked at", async () => {
		const p = join(tmpDir(), "tools.yml");
		const res = await readManifest(p);
		expect(res.entries).toHaveLength(0);
		expect(res.diagnostics[0]).toContain(p);
		expect(res.diagnostics[0]).toContain("not found");
	});

	test("invalid YAML surfaces the parser message, boots empty", () => {
		const res = parseManifest("tools: [unclosed", { dir: "/x" });
		expect(res.entries).toHaveLength(0);
		expect(res.diagnostics[0]).toContain("invalid YAML");
	});
});

describe("FR-002 row 3: version refusal refuses the whole file", () => {
	test("missing version", () => {
		const res = parseManifest("tools: []", { dir: "/x" });
		expect(res.entries).toHaveLength(0);
		expect(res.diagnostics[0]).toContain("version");
	});

	test("wrong version", () => {
		const res = parseManifest("version: 2\ntools: []", { dir: "/x" });
		expect(res.entries).toHaveLength(0);
		expect(res.diagnostics[0]).toContain("unsupported version 2");
	});
});

describe("FR-002 row 4: missing file paths are skipped, siblings survive", () => {
	test("bad ./ path logs the exact checked path; good entry still mounts", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "good.ts"), "export const createGood = () => ({});\n");
		const raw = [
			"version: 1",
			"tools:",
			"  - from: ./good.ts",
			"    factory: createGood",
			"  - from: ./nope.ts",
			"    factory: createNope",
		].join("\n");
		const res = parseManifest(raw, { dir });
		expect(res.entries).toHaveLength(1);
		expect(res.entries[0]?.specifier).toBe(join(dir, "good.ts"));
		expect(res.diagnostics[0]).toContain(join(dir, "nope.ts"));
	});

	test("~/ expands against the provided home", () => {
		const res = parseManifest('version: 1\ntools:\n  - from: "~/x.ts"\n    factory: f', {
			dir: "/x",
			home: "/fakehome",
		});
		expect(res.entries).toHaveLength(0);
		expect(res.diagnostics[0]).toContain("/fakehome/x.ts");
	});

	test("package specifiers pass through untouched (no existence check)", () => {
		const res = parseManifest(
			'version: 1\ntools:\n  - from: "@pi/sdk"\n    factory: createReadTool\n    cwd: true',
			{ dir: "/x" },
		);
		expect(res.entries).toHaveLength(1);
		expect(res.entries[0]?.specifier).toBe("@pi/sdk");
		expect(res.entries[0]?.cwd).toBe(true);
	});
});

describe("FR-001: entry field validation", () => {
	test("non-object entries and missing from/factory are skipped with diagnostics", () => {
		const res = parseManifest("version: 1\ntools:\n  - 42\n  - factory: f\n  - from: pkg\n", {
			dir: "/x",
		});
		expect(res.entries).toHaveLength(0);
		expect(res.diagnostics).toHaveLength(3);
	});

	test("bad timeout / cwd / name types are skipped", () => {
		const raw = [
			"version: 1",
			"tools:",
			"  - from: a",
			"    factory: f",
			"    timeout: -3",
			"  - from: b",
			"    factory: f",
			"    cwd: yes-please",
			"  - from: c",
			"    factory: f",
			'    name: ""',
		].join("\n");
		const res = parseManifest(raw, { dir: "/x" });
		expect(res.entries).toHaveLength(0);
		expect(res.diagnostics).toHaveLength(3);
	});

	test("timeout passes through when valid; name override recorded", () => {
		const raw = [
			"version: 1",
			"tools:",
			"  - from: pkg",
			"    factory: f",
			"    timeout: 30",
			"    name: renamed",
		].join("\n");
		const res = parseManifest(raw, { dir: "/x" });
		expect(res.entries[0]?.timeout).toBe(30);
		expect(res.entries[0]?.nameOverride).toBe("renamed");
	});

	test("duplicate name overrides keep the first (FR-002 row 7, manifest level)", () => {
		const raw = [
			"version: 1",
			"tools:",
			"  - from: a",
			"    factory: f",
			"    name: same",
			"  - from: b",
			"    factory: g",
			"    name: same",
		].join("\n");
		const res = parseManifest(raw, { dir: "/x" });
		expect(res.entries).toHaveLength(1);
		expect(res.diagnostics[0]).toContain("duplicate tool name");
	});
});

describe("readManifest parses a real file on disk", () => {
	test("end-to-end read + parse", async () => {
		const dir = tmpDir();
		const p = join(dir, "tools.yml");
		writeFileSync(
			p,
			'version: 1\ntools:\n  - from: "@pi/sdk"\n    factory: createReadTool\n    cwd: true\n',
		);
		const res = await readManifest(p);
		expect(res.diagnostics).toHaveLength(0);
		expect(res.entries).toHaveLength(1);
		expect(res.entries[0]?.cwd).toBe(true);
	});
});
