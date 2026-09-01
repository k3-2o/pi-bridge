// Wire protocol v1 (SPEC FR-005/FR-007): JSONL over a Unix socket, LF-delimited.
// First line on connect is the ping/pong handshake; every reply carries the
// protocol version so mismatched sides fail loudly instead of weirdly.
import type { ErrorKind } from "./errors.ts";

export const PROTOCOL_VERSION = 1;

/** The server's view of a mounted tool — pi's real factory output. */
export interface ToolExecutionResult {
	content?: ContentBlock[];
	details?: Record<string, unknown>;
	isError?: boolean;
}

export type ContentBlock = { type: string } & Record<string, unknown>;

export interface BridgeTool {
	name: string;
	parameters?: unknown;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: object,
	): Promise<ToolExecutionResult>;
}

export type BridgeRequest =
	| { v: number; op: "ping" }
	| { v: number; op: "catalog" }
	| { v: number; op: "call"; id: string; tool: string; params?: Record<string, unknown> };

export type Reply =
	| {
			v: number;
			op: "reply";
			id: string;
			ok: true;
			content: ContentBlock[];
			details: Record<string, unknown>;
			isError: boolean;
	  }
	| { v: number; op: "reply"; id: string; ok: false; error: string; kind: ErrorKind };

export function makeOk(id: string, result: ToolExecutionResult): Extract<Reply, { ok: true }> {
	return {
		v: PROTOCOL_VERSION,
		op: "reply",
		id,
		ok: true,
		content: Array.isArray(result.content) ? result.content : [],
		details: result.details ?? {},
		isError: result.isError ?? false,
	};
}

export function makeError(
	id: string,
	kind: ErrorKind,
	error: string,
): Extract<Reply, { ok: false }> {
	return { v: PROTOCOL_VERSION, op: "reply", id, ok: false, error, kind };
}

/** Parse one JSONL line; null for anything that is not a v1 request (caller decides). */
export function parseRequest(line: string): BridgeRequest | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const req = raw as Record<string, unknown>;
	if (req.v !== PROTOCOL_VERSION) return null;
	if (req.op === "ping" || req.op === "catalog") {
		return { v: PROTOCOL_VERSION, op: req.op };
	}
	if (
		req.op === "call" &&
		typeof req.id === "string" &&
		typeof req.tool === "string" &&
		(req.params === undefined || (typeof req.params === "object" && req.params !== null))
	) {
		return {
			v: PROTOCOL_VERSION,
			op: "call",
			id: req.id,
			tool: req.tool,
			params: (req.params ?? {}) as Record<string, unknown>,
		};
	}
	return null;
}

export function encodeFrame(msg: unknown): string {
	return `${JSON.stringify(msg)}\n`;
}

/** Incremental JSONL framing: feed chunks, get complete lines. Splits on LF only,
 * tolerates CRLF, skips blank lines — JSON escapes inside strings never split. */
export class FrameSplitter {
	private buffer = "";

	feed(chunk: string): string[] {
		this.buffer += chunk;
		const lines: string[] = [];
		let nl = this.buffer.indexOf("\n");
		while (nl >= 0) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (trimmed.trim().length > 0) lines.push(trimmed);
			nl = this.buffer.indexOf("\n");
		}
		return lines;
	}
}
