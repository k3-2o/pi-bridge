import { describe, expect, test } from "bun:test";
import { ToolArgsError, TransportLostError } from "../src/errors.ts";
import {
	FrameSplitter,
	PROTOCOL_VERSION,
	encodeFrame,
	makeError,
	makeOk,
	parseRequest,
} from "../src/protocol.ts";

describe("version pairing", () => {
	test("protocol version is 1 on both reply factories", () => {
		const ok = makeOk("id-1", { content: [{ type: "text", text: "x" }] });
		const err = makeError("id-1", "tool", "boom");
		expect(PROTOCOL_VERSION).toBe(1);
		expect(ok.v).toBe(PROTOCOL_VERSION);
		expect(err.v).toBe(PROTOCOL_VERSION);
	});
});

describe("framing", () => {
	test("encodeFrame appends exactly one LF", () => {
		const frame = encodeFrame({ a: 1 });
		expect(frame).toBe('{"a":1}\n');
	});

	test("splitter reassembles a frame split across chunks", () => {
		const s = new FrameSplitter();
		const full = encodeFrame({ op: "call", id: "x" });
		const cut = Math.floor(full.length / 2);
		expect(s.feed(full.slice(0, cut))).toEqual([]);
		expect(s.feed(full.slice(cut))).toEqual([full.slice(0, -1)]);
	});

	test("splitter yields multiple frames from one chunk and skips blanks", () => {
		const s = new FrameSplitter();
		const frames = s.feed('{"a":1}\n\n\r\n{"b":2}\n');
		expect(frames).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("LF inside a JSON string never splits (rpc.md framing lesson)", () => {
		const s = new FrameSplitter();
		const frames = s.feed(encodeFrame({ text: "line1\nline2" }));
		expect(frames).toHaveLength(1);
		expect(JSON.parse(frames[0] ?? "{}")).toEqual({ text: "line1\nline2" });
	});

	test("leftover partial frame stays buffered", () => {
		const s = new FrameSplitter();
		expect(s.feed('{"partial":')).toEqual([]);
		expect(s.feed("true}\n")).toEqual(['{"partial":true}']);
	});
});

describe("parseRequest", () => {
	test("accepts the three v1 ops", () => {
		expect(parseRequest('{"v":1,"op":"ping"}')).toEqual({ v: 1, op: "ping" });
		expect(parseRequest('{"v":1,"op":"catalog"}')).toEqual({ v: 1, op: "catalog" });
		expect(
			parseRequest('{"v":1,"op":"call","id":"i","tool":"read","params":{"path":"x"}}'),
		).toEqual({
			v: 1,
			op: "call",
			id: "i",
			tool: "read",
			params: { path: "x" },
		});
	});

	test("defaults missing params to empty object", () => {
		const req = parseRequest('{"v":1,"op":"call","id":"i","tool":"ls"}');
		expect(req).toEqual({ v: 1, op: "call", id: "i", tool: "ls", params: {} });
	});

	test("rejects wrong version, unknown op, malformed JSON, non-object, bad call fields", () => {
		expect(parseRequest('{"v":2,"op":"ping"}')).toBeNull();
		expect(parseRequest('{"v":1,"op":"nope"}')).toBeNull();
		expect(parseRequest("{not json")).toBeNull();
		expect(parseRequest("[1,2]")).toBeNull();
		expect(parseRequest('{"v":1,"op":"call","id":7,"tool":"read"}')).toBeNull();
	});
});

describe("reply shapes", () => {
	test("ok reply normalizes missing content/details/isError", () => {
		const ok = makeOk("i", {});
		expect(ok).toEqual({
			v: 1,
			op: "reply",
			id: "i",
			ok: true,
			content: [],
			details: {},
			isError: false,
		});
	});

	test("error reply carries machine-readable kind", () => {
		expect(makeError("i", "unknown_tool", "nope")).toEqual({
			v: 1,
			op: "reply",
			id: "i",
			ok: false,
			error: "nope",
			kind: "unknown_tool",
		});
	});
});

describe("error taxonomy message templates", () => {
	test("args error shows verbatim problems + schema signature (FR-007)", () => {
		const e = new ToolArgsError("read", "/offset: Expected number", "pi.read({ path: string })");
		expect(e.kind).toBe("args");
		expect(e.message).toBe(
			"read: invalid arguments — /offset: Expected number. Expected: pi.read({ path: string })",
		);
	});

	test("transport loss has the single FR-008 wording (SC-004)", () => {
		const e = new TransportLostError();
		expect(e.kind).toBe("transport");
		expect(e.message).toBe(
			"pi-bridge: connection lost after the call was dispatched — the call MAY have " +
				"executed; do not blindly retry.",
		);
	});
});
