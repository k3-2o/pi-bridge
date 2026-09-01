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

/** Array params show array-of-item so "edits: [{ oldText, newText }]" is understood. */
function propertyType(prop: unknown): string {
	const p = (prop ?? {}) as {
		type?: string;
		enum?: unknown[];
		items?: { properties?: Record<string, unknown>; required?: string[] };
	};
	if (p.type === "array" && p.items?.properties) {
		const required = new Set(p.items.required ?? []);
		const fields = Object.entries(p.items.properties)
			.map(([name, item]) => `${name}${required.has(name) ? "" : "?"}: ${propertyType(item)}`)
			.join(", ");
		return `[{ ${fields} }]`;
	}
	if (Array.isArray(p.enum) && p.enum.length > 0) {
		return p.enum.map((value) => JSON.stringify(value)).join(" | ");
	}
	return p.type ?? "unknown";
}

/** pi.read({ path: string, offset?: number, limit?: number }) — schema-derived, never drifts. */
export function toolSignature(name: string, schema: unknown): string {
	const s = (schema ?? {}) as {
		required?: string[];
		properties?: Record<string, unknown>;
	};
	const required = new Set(s.required ?? []);
	const params = Object.entries(s.properties ?? {})
		.map(
			([propName, prop]) =>
				`${propName}${required.has(propName) ? "" : "?"}: ${propertyType(prop)}`,
		)
		.join(", ");
	return `pi.${name}({ ${params} })`;
}

function levenshtein(a: string, b: string): number {
	const dist: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const row = dist[i] ?? [];
			const prev = dist[i - 1] ?? [];
			row[j] = Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
		}
	}
	return dist[a.length]?.[b.length] ?? 0;
}

/** Closest candidate within edit distance 3, for "did you mean" suggestions. */
export function nearestName(name: string, candidates: Iterable<string>): string | undefined {
	let best: { name: string; distance: number } | undefined;
	for (const candidate of candidates) {
		const distance = levenshtein(name.toLowerCase(), candidate.toLowerCase());
		if (!best || distance < best.distance) best = { name: candidate, distance };
	}
	return best && best.distance <= 3 ? best.name : undefined;
}

export function encodeFrame(msg: unknown): string {
	return `${JSON.stringify(msg)}\n`;
}

/** Incremental JSONL framing: feed chunks, get complete LF-delimited lines. */
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
