import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
// The bridge server (FR-004..FR-008, FR-010): owns the socket lifecycle, the
// handshake, and dispatch. Transport is invisible by construction — the only
// errors that leave this file are tool-arg errors, tool failures, timeouts, and
// the single mid-call transport message (FR-008).
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import {
	ProtocolVersionError,
	TRANSPORT_LOST_MESSAGE,
	ToolArgsError,
	ToolExecutionError,
	ToolTimeoutError,
	UnknownToolError,
} from "./errors.ts";
import { formatResult } from "./format.ts";
import type { MountedTool } from "./loader.ts";
import {
	type BridgeRequest,
	FrameSplitter,
	PROTOCOL_VERSION,
	type Reply,
	encodeFrame,
	makeError,
	makeOk,
	nearestName,
	parseRequest,
	toolSignature,
} from "./protocol.ts";

export interface RegistryEntry {
	description?: string;
	sourceInfo?: unknown;
}

export interface BridgeServerOptions {
	socketPath: string;
	/** Live tools lookup — the index rebinds per session cwd without a server restart. */
	tools: () => Map<string, MountedTool>;
	/** pi registry metadata (descriptions, sourceInfo) for catalog replies. */
	registry?: () => Map<string, RegistryEntry>;
	/** Execution context passed to tool.execute; real one arrives in session_start. */
	ctx?: object;
}

const CTX_SHIM = {
	model: undefined,
	thinkingLevel: undefined,
	sessionManager: {
		getSessionId: () => "pi-bridge",
		getSessionFile: () => "pi-bridge",
	},
};

/** FR-004 row 1: run dir first (bridge-owned), then XDG, then /tmp. Creates 0700. */
export function pickSocketDir(
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	const candidates = [join(home, ".pi", "agent", "pi-bridge", "run")];
	if (env.XDG_RUNTIME_DIR) candidates.push(join(env.XDG_RUNTIME_DIR, "pi-bridge"));
	candidates.push(tmpdir());
	for (const dir of candidates) {
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			return dir;
		} catch {
			/* unwritable — try the next candidate */
		}
	}
	return tmpdir();
}

/** FR-004 row 3: sockets from dead pids are provably stale (SIGKILL leftovers
 * included — the dead process can never clean up); live pids are never touched. */
export function sweepStaleSockets(dir: string, ownPid: number): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const match = /^pi-bridge-(\d+)\.sock$/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid === ownPid) continue;
		let alive = true;
		try {
			process.kill(pid, 0); // signal 0 = existence probe
		} catch {
			alive = false; // ESRCH = dead; EPERM would be alive-but-other-user and throws too, but
			// a socket naming another user's pid is not ours to judge — still, dead is the only
			// state we remove, and EPERM pids are alive, so keep the conservative mapping.
		}
		if (alive) continue;
		try {
			rmSync(join(dir, name), { force: true });
		} catch {
			/* best effort */
		}
	}
}

interface Flight {
	ac: AbortController;
	timer: NodeJS.Timeout | undefined;
}

export class BridgeServer {
	private server: net.Server | undefined;
	private readonly connections = new Set<net.Socket>();
	private readonly inFlight = new Map<string, Flight>();

	constructor(private readonly opts: BridgeServerOptions) {}

	start(): void {
		if (this.server) return;
		sweepStaleSockets(dirname(this.opts.socketPath), process.pid);
		rmSync(this.opts.socketPath, { force: true });
		const server = net.createServer((conn) => this.handle(conn));
		server.unref(); // never keep pi alive on its own
		server.on("error", (err) => console.error("[pi-bridge] server:", err));
		server.listen(this.opts.socketPath, () => {
			try {
				chmodSync(this.opts.socketPath, 0o600);
			} catch {
				/* best effort; same-user socket */
			}
		});
		this.server = server;
	}

	get started(): boolean {
		return this.server !== undefined;
	}

	stop(): void {
		for (const flight of this.inFlight.values()) {
			flight.ac.abort();
			if (flight.timer) clearTimeout(flight.timer);
		}
		this.inFlight.clear();
		for (const conn of this.connections) conn.destroy();
		this.connections.clear();
		this.server?.close();
		this.server = undefined;
		rmSync(this.opts.socketPath, { force: true });
	}

	private write(conn: net.Socket, reply: Reply): void {
		if (conn.destroyed) return;
		try {
			conn.write(encodeFrame(reply));
		} catch {
			conn.destroy();
		}
	}

	private handle(conn: net.Socket): void {
		this.connections.add(conn);
		let handshook = false;
		const splitter = new FrameSplitter();
		const local = new Set<string>(); // call ids in flight on THIS connection
		conn.on("data", (chunk: Buffer) => {
			for (const line of splitter.feed(chunk.toString("utf8"))) {
				if (!handshook) {
					handshook = this.handshake(conn, line);
					continue;
				}
				void this.dispatch(conn, line, local);
			}
		});
		conn.on("close", () => {
			// FR-007 row 6: a dropped connection aborts its in-flight tools (Esc semantics).
			this.connections.delete(conn);
			for (const id of local) {
				const flight = this.inFlight.get(id);
				if (flight) {
					flight.ac.abort();
					if (flight.timer) clearTimeout(flight.timer);
					this.inFlight.delete(id);
				}
			}
			local.clear();
		});
		conn.on("error", () => conn.destroy());
	}

	/** FR-005: first frame must be the ping; version mismatch fails loudly and closes. */
	private handshake(conn: net.Socket, line: string): boolean {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			raw = null;
		}
		const req = (raw ?? {}) as { v?: unknown; op?: unknown };
		if (req.op !== "ping") {
			this.write(conn, makeError("", "protocol", 'first frame must be {"v":1,"op":"ping"}'));
			conn.destroy();
			return false;
		}
		if (req.v !== PROTOCOL_VERSION) {
			this.write(
				conn,
				makeError("", "version", new ProtocolVersionError(Number(req.v), PROTOCOL_VERSION).message),
			);
			conn.destroy();
			return false;
		}
		this.write(conn, { v: PROTOCOL_VERSION, op: "pong" } as unknown as Reply);
		return true;
	}

	private async dispatch(conn: net.Socket, line: string, local: Set<string>): Promise<void> {
		const req: BridgeRequest | null = parseRequest(line);
		if (!req) {
			this.write(conn, makeError("", "protocol", "unparseable frame"));
			return;
		}
		if (req.op === "catalog") {
			this.write(conn, this.catalogReply());
			return;
		}
		if (req.op !== "call") return;
		await this.call(conn, req, local);
	}

	private catalogReply(): Reply {
		const tools = this.opts.tools();
		const registry = this.opts.registry?.() ?? new Map<string, RegistryEntry>();
		const content = [...tools.values()].map((m) => {
			const meta = registry.get(m.name);
			return {
				type: "tool",
				name: m.name,
				signature: toolSignature(m.name, m.tool.parameters),
				description: meta?.description ?? "",
				sourceInfo: meta?.sourceInfo,
			};
		});
		return makeOk("catalog", { content });
	}

	private async call(
		conn: net.Socket,
		req: Extract<BridgeRequest, { op: "call" }>,
		local: Set<string>,
	): Promise<void> {
		const tools = this.opts.tools();
		const mounted = tools.get(req.tool);
		if (!mounted) {
			const suggestion = nearestName(req.tool, tools.keys());
			this.write(
				conn,
				makeError(
					req.id,
					"unknown_tool",
					new UnknownToolError(req.tool, suggestion, [...tools.keys()]).message,
				),
			);
			return;
		}
		const schema = mounted.tool.parameters;
		if (schema) {
			const valid = Value.Check(schema as never, req.params);
			if (!valid) {
				const problems = [...Value.Errors(schema as never, req.params)]
					.slice(0, 3)
					.map((e) => {
						const te = e as { instancePath?: string; message?: string };
						return te.instancePath
							? `${te.instancePath}: ${te.message}`
							: (te.message ?? "invalid");
					})
					.join("; ");
				this.write(
					conn,
					makeError(
						req.id,
						"args",
						new ToolArgsError(req.tool, problems, toolSignature(req.tool, schema)).message,
					),
				);
				return;
			}
		}

		const ac = new AbortController();
		const flight: Flight = { ac, timer: undefined };
		this.inFlight.set(req.id, flight);
		local.add(req.id);
		let timedOut = false;
		if (mounted.entry.timeout !== undefined) {
			const seconds = mounted.entry.timeout;
			flight.timer = setTimeout(() => {
				timedOut = true;
				ac.abort();
			}, seconds * 1000);
		}
		try {
			const result = await mounted.tool.execute(
				req.id,
				req.params ?? {},
				ac.signal,
				undefined,
				this.opts.ctx ?? CTX_SHIM,
			);
			// FR-009: the wire carries the FINISHED text as one clean block — the helper
			// returns it as-is. Truncation/image hints ride in details.
			const formatted = formatResult(result);
			this.write(
				conn,
				makeOk(req.id, {
					content: [{ type: "text", text: formatted.text }],
					details: formatted.details,
					isError: formatted.isError,
				}),
			);
		} catch (err) {
			if (timedOut) {
				this.write(
					conn,
					makeError(
						req.id,
						"timeout",
						new ToolTimeoutError(req.tool, mounted.entry.timeout ?? 0).message,
					),
				);
			} else if (conn.destroyed) {
				// FR-008: client is gone — nothing to say to anyone; the abort already fired.
			} else if (err instanceof Error && err.name === "AbortError") {
				this.write(conn, makeError(req.id, "transport", TRANSPORT_LOST_MESSAGE));
			} else {
				this.write(
					conn,
					makeError(
						req.id,
						"tool",
						new ToolExecutionError(req.tool, err instanceof Error ? err.message : String(err))
							.message,
					),
				);
			}
		} finally {
			if (flight.timer) clearTimeout(flight.timer);
			this.inFlight.delete(req.id);
			local.delete(req.id);
		}
	}
}
