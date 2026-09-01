import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MountedTool } from "../src/loader.ts";
import { BridgeServer, type RegistryEntry } from "../src/server.ts";

// T015 pairing: the shipped python helper against the TS server over a real
// socket — the whole wire contract, cross-language, no mocks.
// NOTE: the python client runs via Bun.spawn (async) — a synchronous spawn would
// freeze the event loop this server needs to answer.

const repoRoot = join(import.meta.dir, "..");

function makeTool(name: string, opts: { parameters?: unknown; description?: string }): MountedTool {
	return {
		name,
		entry: {
			specifier: name,
			factory: "f",
			cwd: false,
			timeout: undefined,
			nameOverride: undefined,
			source: name,
		},
		tool: {
			name,
			parameters: opts.parameters,
			execute: async (_id, params) => ({
				content: [{ type: "text", text: `ran ${name} with ${JSON.stringify(params)}` }],
			}),
		},
	};
}

async function runPython(
	socketPath: string,
	body: string,
): Promise<{ code: number; out: string; err: string }> {
	const script = [
		"import sys, json",
		`sys.path.insert(0, ${JSON.stringify(join(repoRoot, "examples"))})`,
		"from bridge import pi, PiBridgeError",
		body,
	].join("\n");
	const proc = Bun.spawn(["python3", "-c", script], {
		env: { ...process.env, PI_BRIDGE_SOCK: socketPath },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

describe("FR-011: python helper against the TS server", () => {
	const tools = new Map<string, MountedTool>([
		[
			"read",
			makeTool("read", {
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				},
				description: "Read a file.",
			}),
		],
		["echo2", makeTool("echo2", {})],
	]);
	const registry = new Map<string, RegistryEntry>([
		["read", { description: "Read a file." }],
		["echo2", { description: "Echo params." }],
	]);
	const socketPath = join(tmpdir(), `pi-bridge-pytest-${process.pid}.sock`);
	const server = new BridgeServer({
		socketPath,
		tools: () => tools,
		registry: () => registry,
	});
	// Start inside beforeAll: at describe-collection time the listen() bind does not
	// get an event-loop turn before the first python client connects (measured).
	beforeAll(async () => {
		server.start(socketPath);
		await new Promise((r) => setTimeout(r, 50));
	});
	afterAll(() => server.stop());

	test("generic dispatch: pi.read returns the finished text", async () => {
		const r = await runPython(socketPath, `print(json.dumps({"text": pi.read(path="f.txt")}))`);
		expect(r.err).toBe("");
		expect(JSON.parse(r.out).text).toBe('ran read with {"path":"f.txt"}');
	});

	test("generic dispatch: pi.echo2 works because the manifest declares it", async () => {
		const r = await runPython(socketPath, `print(pi.echo2(hello="world"))`);
		expect(r.out).toBe('ran echo2 with {"hello":"world"}\n');
	});

	test("pi.tools() lists signatures from the catalog", async () => {
		const r = await runPython(socketPath, "print(pi.tools())");
		expect(r.out).toContain("pi.read({ path: string }) — Read a file.");
	});

	test("unknown tool: clean error naming what is available", async () => {
		const r = await runPython(
			socketPath,
			`
try:
    pi.nope()
except PiBridgeError as e:
    print(e.kind)
    print(e)`,
		);
		expect(r.out).toContain("unknown_tool");
		expect(r.out).toContain('Unknown tool "nope"');
		expect(r.out).toContain("Available: echo2, read");
	});

	test("schema-invalid args raise with pi's verbatim message + signature", async () => {
		const r = await runPython(
			socketPath,
			`
try:
    pi.raw("read", offset=2)
except PiBridgeError as e:
    print(e.kind)
    print(e)`,
		);
		expect(r.out).toContain("args");
		expect(r.out).toContain("invalid arguments");
		expect(r.out).toContain("pi.read({ path: string })");
	});
});
