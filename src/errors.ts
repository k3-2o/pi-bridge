// Error taxonomy (SPEC §4): arg/tool errors pass pi's own text; transport errors are only FR-008's one message (SC-004).

export type ErrorKind =
	| "protocol"
	| "unknown_tool"
	| "args"
	| "tool"
	| "timeout"
	| "version"
	| "transport"
	| "config";

/** FR-008: the only transport error a cell can ever observe. */
export const TRANSPORT_LOST_MESSAGE =
	"pi-bridge: connection lost after the call was dispatched — the call MAY have " +
	"executed; do not blindly retry.";

export class UnknownToolError extends Error {
	readonly kind = "unknown_tool" as const;
	constructor(
		readonly tool: string,
		readonly suggestion: string | undefined,
		readonly available: string[],
	) {
		super(
			`Unknown tool "${tool}".${
				suggestion ? ` Did you mean "${suggestion}"?` : ""
			} Available: ${available.join(", ")}.`,
		);
	}
}

export class ToolArgsError extends Error {
	readonly kind = "args" as const;
	constructor(
		readonly tool: string,
		readonly problems: string,
		readonly signature: string,
	) {
		super(`${tool}: invalid arguments — ${problems}. Expected: ${signature}`);
	}
}

export class ToolExecutionError extends Error {
	readonly kind = "tool" as const;
	constructor(
		readonly tool: string,
		message: string,
		readonly details: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export class ToolTimeoutError extends Error {
	readonly kind = "timeout" as const;
	constructor(
		readonly tool: string,
		readonly seconds: number,
	) {
		super(`${tool}: timed out after ${seconds}s (manifest timeout)`);
	}
}

export class ProtocolVersionError extends Error {
	readonly kind = "version" as const;
	constructor(
		readonly clientVersion: number,
		readonly serverVersion: number,
	) {
		super(
			`pi-bridge: protocol version mismatch — client v${clientVersion}, ` +
				`server v${serverVersion}. Update one side to match the other.`,
		);
	}
}

export class TransportLostError extends Error {
	readonly kind = "transport" as const;
	constructor() {
		super(TRANSPORT_LOST_MESSAGE);
	}
}

/** File-level manifest diagnostics (FR-002 rows 1-3): whole file failed, empty surface. */
export function manifestFileDiagnostic(path: string, reason: string): string {
	return `[pi-bridge] manifest ${path}: ${reason}`;
}

/** Manifest diagnostics (FR-002): never thrown at a cell — logged, that entry skipped. */
export class BridgeConfigError extends Error {
	readonly kind = "config" as const;
	constructor(
		readonly entry: string,
		message: string,
	) {
		super(`[pi-bridge] skipped ${entry}: ${message}`);
	}
}
