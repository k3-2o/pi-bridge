// Host-side formatting (FR-009): finished text out, hints in details, images stay host-side.
import type { ContentBlock, ToolExecutionResult } from "./protocol.ts";

const ANSI_RE = new RegExp(
	[
		String.raw`\x1b\[[0-9;?]*[ -/]*[@-~]`, // CSI sequences
		String.raw`\x1b\][^\x07]*\x07`, // OSC (hyperlinks etc.)
		String.raw`\x1b[\x40-\x5f]`, // 2-char escapes
	].join("|"),
);
const LONE_CR_RE = String.raw`\r(?!\n)`;

// Reader walks back the paging notice on truncated output; strip it, keep the hint in details.
const READER_NOTICE_RE = /\[(\d+) more lines? in file\. Use offset=(\d+)[^\]]*\]\s*$/;

export interface FormattedResult {
	text: string;
	details: Record<string, unknown>;
	isError: boolean;
}

export function formatResult(result: ToolExecutionResult): FormattedResult {
	const blocks: ContentBlock[] = Array.isArray(result.content) ? result.content : [];
	let text = blocks
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("");
	text = text.replace(new RegExp(ANSI_RE, "g"), "").replace(new RegExp(LONE_CR_RE, "g"), "");

	const details: Record<string, unknown> = { ...(result.details ?? {}) };
	const images = blocks.filter((b) => b.type === "image").length;
	if (images > 0) details.imagesHeld = images;

	const notice = READER_NOTICE_RE.exec(text);
	if (notice) {
		text = text.slice(0, notice.index).replace(/\n+$/, "");
		details.truncated = true;
		details.nextOffset = Number(notice[2]);
	}

	return { text, details, isError: result.isError ?? false };
}
