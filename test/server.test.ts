import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MountedTool } from "../src/loader.ts";
import {
	BridgeServer,
	type RegistryEntry,
	pickSocketDir,
	sweepStaleSockets,
} from "../src/server.ts";

const dirs: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-bridge-server-"));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// -- fixtures --------------------------------------------------------------

function makeTool(
	name: string,
	opts: { parameters?: unknown; timeout?: number; execute?: MountedTool["tool"]["execute"] } = {},
): MountedTool {
	return {
		name,
		entry: {
			specifier: name,
			factory: "f",
			cwd: false,
			timeout: opts.timeout,
			nameOverride: undefined,
			source: name,
		},
		tool: {
			name,
			parameters: opts.parameters,
			execute: opts.execute ?? (async () => ({ content: [{ type: "text", text: `ran ${name}` }] })),
		},
	};
}

function startServer(tools: Map<string, MountedTool>, registry?: Map<string, RegistryEntry>) {
	const socketPath = join(tmp(), `pi-bridge-${process.pid}.sock`);
	const server = new BridgeServer({
		socketPath,
		tools: () => tools,
		registry: registry ? () => registry : undefined,
	});
	server.start();
	return { server, socketPath };
}

function client(path: string) {
	const socket = net.connect(path);
	const queue: Record<string, unknown>[] = [];
	const waiters: ((v: Record<string, unknown>) => void)[] = [];
	let open = true;
	socket.on("data", (chunk: Buffer) => {
		let buf = chunk.toString("utf8");
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.trim()) {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				const w = waiters.shift();
				if (w) w(parsed);
				else queue.push(parsed);
			}
			nl = buf.indexOf("\n");
		}
	});
	socket.on("close", () => {
		open = false;
		for (const w of waiters.splice(0)) w({ __closed: true });
	});
	socket.on("error", () => {});
	const connected = new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	return {
		connected,
		send: (obj: unknown) => socket.write(`${JSON.stringify(obj)}\n`),
		next: () =>
			queue.length > 0
				? Promise.resolve(queue.shift() as Record<string, unknown>)
				: new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve)),
		destroy: () => {
			open = false;
			socket.destroy();
		},
		isOpen: () => open,
	};
}

async function handshake(c: ReturnType<typeof client>): Promise<void> {
	c.send({ v: 1, op: "ping" });
	const pong = await c.next();
	expect(pong).toEqual({ v: 1, op: "pong" });
}

// -- FR-004: socket dir policy ----------------------------------------------

describe("FR-004: socket dir policy", () => {
	test("bridge-owned run dir wins and is created with 0700", () => {
		const home = tmp();
		const dir = pickSocketDir(home, {});
		expect(dir).toBe(join(home, ".pi", "agent", "pi-bridge", "run"));
		expect(existsSync(dir)).toBe(true);
	});

	test("unwritable home falls through to XDG_RUNTIME_DIR", () => {
		const home = tmp();
		const xdg = tmp();
		chmodSync(home, 0o500); // read+execute only: mkdir inside fails
		try {
			const dir = pickSocketDir(home, { XDG_RUNTIME_DIR: xdg });
			expect(dir).toBe(join(xdg, "pi-bridge"));
			expect(existsSync(dir)).toBe(true);
		} finally {
			chmodSync(home, 0o700);
		}
	});

	test("stale sockets from dead pids are swept, live pids kept", () => {
		const dir = tmp();
		const dead = spawnSync("true"); // exits immediately
		writeFileSync(join(dir, `pi-bridge-${dead.pid}.sock`), "");
		writeFileSync(join(dir, `pi-bridge-${process.pid}.sock`), "");
		writeFileSync(join(dir, "unrelated.txt"), "");
		sweepStaleSockets(dir, process.pid);
		expect(existsSync(join(dir, `pi-bridge-${dead.pid}.sock`))).toBe(false);
		expect(existsSync(join(dir, `pi-bridge-${process.pid}.sock`))).toBe(true);
		expect(existsSync(join(dir, "unrelated.txt"))).toBe(true);
	});
});

// -- FR-005: handshake -------------------------------------------------------

describe("FR-005: handshake", () => {
	test("ping answers pong with the protocol version", async () => {
		const { server, socketPath } = startServer(new Map());
		const c = client(socketPath);
		await c.connected;
		await handshake(c);
		server.stop();
		c.destroy();
	});

	test("version mismatch: loud version error, connection closed (FR-005 row 2)", async () => {
		const { server, socketPath } = startServer(new Map());
		const c = client(socketPath);
		await c.connected;
		c.send({ v: 2, op: "ping" });
		const reply = await c.next();
		expect(reply.ok).toBe(false);
		expect(reply.kind).toBe("version");
		expect(String(reply.error)).toContain("v2");
		expect(String(reply.error)).toContain("v1");
		expect(await c.next()).toEqual({ __closed: true });
		server.stop();
	});

	test("first frame that is not a ping is refused and closed (FR-005 row 3)", async () => {
		const { server, socketPath } = startServer(new Map());
		const c = client(socketPath);
		await c.connected;
		c.send({ v: 1, op: "call", id: "x", tool: "read" });
		const reply = await c.next();
		expect(reply.kind).toBe("protocol");
		expect(await c.next()).toEqual({ __closed: true });
		server.stop();
	});
});

// -- FR-007/FR-008/FR-009/FR-010: dispatch ----------------------------------

const readSchema = {
	type: "object",
	properties: { path: { type: "string" }, offset: { type: "number" } },
	required: ["path"],
};

describe("FR-010: catalog", () => {
	test("lists mounted tools with schema-derived signatures and registry metadata", async () => {
		const tools = new Map([
			["read", makeTool("read", { parameters: readSchema })],
			["bash", makeTool("bash")],
		]);
		const registry = new Map<string, RegistryEntry>([["read", { description: "Read a file." }]]);
		const { server, socketPath } = startServer(tools, registry);
		const c = client(socketPath);
		await c.connected;
		await handshake(c);
		c.send({ v: 1, op: "catalog" });
		const reply = await c.next();
		expect(reply.ok).toBe(true);
		const content = reply.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(2);
		const read = content.find((t) => t.name === "read");
		expect(read?.signature).toBe("pi.read({ path: string, offset?: number })");
		expect(read?.description).toBe("Read a file.");
		const bash = content.find((t) => t.name === "bash");
		expect(bash?.description).toBe("");
		server.stop();
		c.destroy();
	});
});

describe("FR-007: calls", () => {
	test("unknown tool: available list + did-you-mean within edit distance 3", async () => {
		const tools = new Map([["read", makeTool("read")]]);
		const { server, socketPath } = startServer(tools);
		const c = client(socketPath);
		await c.connected;
		await handshake(c);
		c.send({ v: 1, op: "call", id: "1", tool: "raed", params: {} });
		const reply = await c.next();
		expect(reply.ok).toBe(false);
		expect(reply.kind).toBe("unknown_tool");
		expect(String(reply.error)).toContain('Did you mean "read"');
		expect(String(reply.error)).toContain("Available: read");
		c.send({ v: 1, op: "call", id: "2", tool: "zzzzzz", params: {} });
		const reply2 = await c.next();
		expect(String(reply2.error)).not.toContain("Did you mean");
		server.stop();
		c.destroy();
	});

	test("schema-invalid args: verbatim problems + signature, kind args", async () => {
		const tools = new Map([["read", makeTool("read", { parameters: readSchema })]]);
		const { server, socketPath } = startServer(tools);
		const c = client(socketPath);
		await c.connected;
		await handshake(c);
		c.send({ v: 1, op: "call", id: "1", tool: "read", params: { offset: 2 } });
		const reply = await c.next();
		expect(reply.ok).toBe(false);
		expect(reply.kind).toBe("args");
		expect(String(reply.error)).toContain("invalid arguments");
		expect(String(reply.error)).toContain("pi.read({ path: string, offset?: number })");
		server.stop();
		c.destroy();
	});

	test("valid call: ok reply with host-formatted text", async () => {
		const tools = new Map([
			[
				"echo",
				makeTool("echo", {
					execute: async () => ({
						content: [{ type: "text", text: "\x1b[32mhi\x1b[0m" }],
					}),
				}),
			],
		]);
		const { server, socketPath } = startServer(tools);
		const c = client(socketPath);
		await c.connected;
		await handshake(c);
		c.send({ v: 1, op: "call", id: "e1", tool: "echo", params: {} });
		const reply = await c.next();
		expect(reply.ok).toBe(true);
		const content = reply.content as Array<{ text?: string }>;
		expect(content[0]?.text).toBe("hi"); // ANSI stripped host-side
		server.stop();
		c.destroy();
	});

	test("tool failure: passthrough message, kind tool (transport invisible)", async () => {
		const tools = new Map([
			[
				"boom",
				makeTool("boom", {
					execute: async () => {
						throw new Error("segmentation via poetry");
					},
				}),
			],
		]);
		const { server, socketPath } = startServer(tools);
		const c = client(socketPath);
		await c.connected;
		await handshake(c);
		c.send({ v: 1, op: "call", id: "b1", tool: "boom", params: {} });
		const reply = await c.next();
		expect(reply.ok).toBe(false);
		expect(reply.kind).toBe("tool");
		expect(String(reply.error)).toBe("segmentation via poetry");
		server.stop();
		c.destroy();
	});

	test("per-entry timeout: kind timeout, only that tool governed (FR-007 row 6)", async () => {
		const never = makeTool("never", {
			timeout: 0.05,
			execute: (id, params, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		const quick = makeTool("quick");
		const tools = new Map([
			["never", never],
			["quick", quick],
		]);
		const { server, socketPath } = startServer(tools);
		const c = client(socketPath);
		await c.connected;
		await handshake(c);
		c.send({ v: 1, op: "call", id: "n1", tool: "never", params: {} });
		const reply = await c.next();
		expect(reply.kind).toBe("timeout");
		expect(String(reply.error)).toContain("timed out after 0.05s");
		server.stop();
		c.destroy();
	});

	test("concurrent calls multiplex by id", async () => {
		const deferred: Array<{ resolve: (v: unknown) => void }> = [];
		const slow = makeTool("slow", {
			execute: async () =>
				new Promise((resolve) => {
					deferred.push({ resolve: (v: unknown) => resolve(v as never) });
				}),
		});
		const { server, socketPath } = startServer(new Map([["slow", slow]]));
		const c = client(socketPath);
		await c.connected;
		await handshake(c);
		c.send({ v: 1, op: "call", id: "s1", tool: "slow", params: {} });
		c.send({ v: 1, op: "call", id: "s2", tool: "slow", params: {} });
		await new Promise((r) => setTimeout(r, 30));
		expect(deferred).toHaveLength(2); // both in flight at once
		deferred[1]?.resolve({ content: [{ type: "text", text: "two" }] });
		deferred[0]?.resolve({ content: [{ type: "text", text: "one" }] });
		const ids = new Set([(await c.next()).id, (await c.next()).id]);
		expect(ids).toEqual(new Set(["s1", "s2"]));
		server.stop();
		c.destroy();
	});

	test("client drop mid-call aborts the tool's signal (FR-007 row 6)", async () => {
		let observed: AbortSignal | undefined;
		const hanging = makeTool("hanging", {
			execute: (id, params, signal) => {
				observed = signal;
				return new Promise(() => {});
			},
		});
		const { server, socketPath } = startServer(new Map([["hanging", hanging]]));
		const c = client(socketPath);
		await c.connected;
		await handshake(c);
		c.send({ v: 1, op: "call", id: "h1", tool: "hanging", params: {} });
		await new Promise((r) => setTimeout(r, 20));
		c.destroy();
		await new Promise((r) => setTimeout(r, 20));
		expect(observed?.aborted).toBe(true);
		server.stop();
	});
});

describe("live ctx.model (FR-012 parity: per-call model resolution)", () => {
	test("tools see the session model as it changes, not a session_start snapshot", async () => {
		let current: { input: string[] } | undefined = { input: ["text"] };
		let seen: unknown;
		const probe = makeTool("probe", {
			execute: async (_id, _params, _signal, _onUpdate, ctx) => {
				seen = (ctx as { model?: unknown }).model;
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		const tools = new Map([["probe", probe]]);
		const socketPath = join(tmp(), `pi-bridge-${process.pid}-model.sock`);
		const server = new BridgeServer({
			socketPath,
			tools: () => tools,
			ctx: { sessionManager: { getSessionId: () => "t" } },
			getModel: () => current,
		});
		server.start(socketPath);
		const c = client(socketPath);
		await c.connected;
		await handshake(c);

		c.send({ v: 1, op: "call", id: "m1", tool: "probe", params: {} });
		await c.next();
		expect(seen).toEqual({ input: ["text"] });

		current = { input: ["text", "image"] }; // model switched mid-session
		c.send({ v: 1, op: "call", id: "m2", tool: "probe", params: {} });
		await c.next();
		expect(seen).toEqual({ input: ["text", "image"] });

		current = undefined; // model unknown: falls back to the snapshot ctx (undefined here)
		c.send({ v: 1, op: "call", id: "m3", tool: "probe", params: {} });
		await c.next();
		expect(seen).toBeUndefined();
		server.stop();
		c.destroy();
	});
});

describe("lifecycle", () => {
	test("stop removes the socket file", () => {
		const { server, socketPath } = startServer(new Map());
		expect(server.started).toBe(true);
		expect(existsSync(socketPath)).toBe(true);
		server.stop();
		expect(server.started).toBe(false);
		expect(existsSync(socketPath)).toBe(false);
	});
});
