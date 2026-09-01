import { describe, expect, test } from "bun:test";
import { formatResult } from "../src/format.ts";

describe("FR-009 row 1: clean text", () => {
	test("joins text blocks and strips ANSI escapes and lone CRs", () => {
		const res = formatResult({
			content: [
				{ type: "text", text: "\x1b[32mgreen\x1b[0m plain\r" },
				{ type: "text", text: "\x1b]8;;http://x\x07 link\x1b]8;;\x07 more\rX" },
			],
		});
		expect(res.text).toBe("green plain link moreX");
	});

	test("real CRLF line endings survive (only lone CR dies)", () => {
		const res = formatResult({ content: [{ type: "text", text: "a\r\nb\rc" }] });
		expect(res.text).toBe("a\r\nbc");
	});
});

describe("FR-009 row 2: reader notice becomes machine hints", () => {
	test("trailing notice stripped, truncated + nextOffset set", () => {
		const res = formatResult({
			content: [
				{
					type: "text",
					text: "line1\nline2\n[19 more lines in file. Use offset=3 to continue.]\n",
				},
			],
		});
		expect(res.text).toBe("line1\nline2");
		expect(res.details.truncated).toBe(true);
		expect(res.details.nextOffset).toBe(3);
	});

	test("no notice: text returns untouched, no hints", () => {
		const res = formatResult({ content: [{ type: "text", text: "ends normally\n\n" }] });
		expect(res.text).toBe("ends normally\n\n");
		expect(res.details.truncated).toBeUndefined();
	});

	test("bracketed line that is not a reader notice stays", () => {
		const res = formatResult({ content: [{ type: "text", text: "[INFO] done" }] });
		expect(res.text).toBe("[INFO] done");
	});
});

describe("FR-009 row 3: images held host-side, counted in details", () => {
	test("image blocks never reach text; count lands in details", () => {
		const res = formatResult({
			content: [
				{ type: "text", text: "before" },
				{ type: "image", source: { data: "..." } },
				{ type: "image", source: { data: "..." } },
			],
		});
		expect(res.text).toBe("before");
		expect(res.details.imagesHeld).toBe(2);
	});
});

describe("passthrough", () => {
	test("original details merge in; isError defaults false", () => {
		const res = formatResult({ details: { exitCode: 3 }, isError: true });
		expect(res.details.exitCode).toBe(3);
		expect(res.isError).toBe(true);
	});

	test("missing content is empty text", () => {
		expect(formatResult({}).text).toBe("");
	});
});
