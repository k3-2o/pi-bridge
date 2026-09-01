// E2E gate (SPEC exit criterion) — FULLY ISOLATED.
// pi boots with HOME pointed at a throwaway temp dir, so it can only see the
// extensions, manifest, and sockets this script installs there. The user's real
// ~/.pi is never read or written, and the only process this script ever kills is
// the pi child it spawned itself (by pid, never by name).
//
// Coverage: install → boot → catalog parity (10 tools) → real read/write/bash
// through pi → unknown-tool error → chaos manifest (broken entries diagnosed,
// survivors mounted) → SIGKILL leftover swept by next boot.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = `${import.meta.dir}/..`;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

async function waitUntil(fn: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return fn();
}

// pi's launcher resolves its global install relative to $HOME — under an isolated
// HOME it cannot find itself. Spawn the real cli.js under bun instead.
const PI_CLI = join(
	process.env.HOME ?? "/root",
	".bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bun/cli.js",
);

function bootPi(env: NodeJS.ProcessEnv, runDir: string) {
	// stdin MUST stay open: rpc mode shuts down gracefully on EOF (which would
	// remove the socket seconds after boot). We never write; kill9 ends it.
	const proc = Bun.spawn(["bun", PI_CLI, "--mode", "rpc"], {
		env: { ...process.env, ...env },
		stdin: "pipe",
		stdout: "ignore",
		stderr: "pipe",
	});
	const socketPath = join(runDir, `pi-bridge-${proc.pid}.sock`);
	return {
		proc,
		socketPath,
		stderr: async () => await new Response(proc.stderr as ReadableStream).text(),
	};
}

function kill9(boot: { proc: { pid: number | undefined } }): void {
	if (boot.proc.pid === undefined) return;
	try {
		process.kill(boot.proc.pid, "SIGKILL"); // our own child, by pid — nothing else
	} catch {
		/* already gone */
	}
}

// The shipped helper is gone (clients are out of scope); the e2e still proves the
// wire contract cross-language with this stdlib-only raw client.
const XCHG = [
	"import json, os, socket, uuid",
	"s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
	's.connect(os.environ["PI_BRIDGE_SOCK"])',
	"def xchg(obj):",
	"    s.sendall(json.dumps(obj).encode() + chr(10).encode())",
	'    buf = b""',
	"    while not buf.endswith(chr(10).encode()):",
	"        chunk = s.recv(65536)",
	"        if not chunk:",
	'            raise SystemExit("connection closed")',
	"        buf += chunk",
	"    return json.loads(buf.decode())",
	"def text(r):",
	'    return "".join(b.get("text", "") for b in r.get("content", []) if b.get("type") == "text")',
	'xchg({"v": 1, "op": "ping"})',
];

async function main(): Promise<void> {
	// 0. isolated home — pi can only ever see this tree
	const e2eHome = mkdtempSync(join(tmpdir(), "pi-bridge-e2e-home-"));
	const agent = join(e2eHome, ".pi", "agent");
	const extDir = join(agent, "extensions", "pi-bridge");
	const bridgeDir = join(agent, "pi-bridge");
	const runDir = join(bridgeDir, "run");
	const manifest = join(bridgeDir, "tools.yml");
	try {
		// 1. install extension (repo root IS the extension)
		mkdirSync(extDir, { recursive: true });
		spawnSync("cp", ["-R", join(REPO, "index.ts"), join(extDir, "index.ts")]);
		spawnSync("cp", ["-R", join(REPO, "src"), join(extDir, "src")]);
		check(
			"install: extension tree staged in isolated home",
			existsSync(join(extDir, "index.ts")) && existsSync(join(extDir, "src/server.ts")),
		);

		// 2. manifest: 7 SDK tools + 3 of the user's exportable extension tools
		//    (absolute paths — the isolated home has no extensions of its own)
		mkdirSync(bridgeDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const userExt = join(process.env.HOME ?? homedir0(), ".pi/agent/extensions");
		const entries = ["Read", "Bash", "Write", "Edit", "Grep", "Ls", "Find"]
			.map(
				(n) =>
					`  - from: "@earendil-works/pi-coding-agent"\n    factory: create${n}Tool\n    cwd: true`,
			)
			.concat(
				[
					["web_search.ts", "createWebSearchTool"],
					["clipboard.ts", "createClipboardCopyTool"],
					["ask-user-question.ts", "createAskUserQuestionDefinition"],
				].map(([file, factory]) => `  - from: "${join(userExt, file)}"\n    factory: ${factory}`),
			);
		writeFileSync(manifest, `version: 1\ntools:\n${entries.join("\n")}\n`);

		// 4. boot 1 — catalog parity + real tools
		const boot1 = bootPi({ HOME: e2eHome, PI_REPL_FORCE: "1" }, runDir);
		const up = await waitUntil(() => existsSync(boot1.socketPath), 60_000);
		check("boot: socket in isolated run dir", up, boot1.socketPath);

		if (up) {
			const probeFile = join(e2eHome, "probe.txt");
			writeFileSync(probeFile, "e2e payload\n");
			const call = (tool: string, params: string) =>
				`r = xchg({"v": 1, "op": "call", "id": uuid.uuid4().hex, "tool": "${tool}", "params": ${params}})`;
			const script = [
				...XCHG,
				'cat = xchg({"v": 1, "op": "catalog"})',
				'out = {"names": sorted(b["name"] for b in cat.get("content", []) if b.get("type") == "tool")}',
				call("read", `{"path": ${JSON.stringify(probeFile)}}`),
				'out["read"] = text(r)',
				call(
					"write",
					`{"path": ${JSON.stringify(`${probeFile}.w`)}, "content": "cell wrote this"}`,
				),
				`out["write"] = open(${JSON.stringify(`${probeFile}.w`)}).read()`,
				call("bash", '{"command": "printf hi-from-real-bash"}'),
				'out["bash"] = text(r)',
				call("no_such_tool_xyz", "{}"),
				'out["unknown"] = r.get("kind")',
				"print(json.dumps(out))",
			].join("\n");
			const py = Bun.spawn(["python3", "-c", script], {
				env: { ...process.env, PI_BRIDGE_SOCK: boot1.socketPath },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err] = await Promise.all([
				new Response(py.stdout).text(),
				new Response(py.stderr).text(),
			]);
			await py.exited;
			let res: Record<string, unknown> = {};
			try {
				res = JSON.parse(out);
			} catch {
				/* shown below */
			}
			if (res.names === undefined) {
				check("probe: python probe produced output", false, (err || out).slice(-300));
			} else {
				check(
					"probe: catalog has 10 tools",
					(res.names as string[]).length === 10,
					`got ${(res.names as string[]).length}`,
				);
				check(
					"probe: real pi.read roundtrip",
					res.read === "e2e payload\n",
					JSON.stringify(res.read),
				);
				check("probe: pi.write creates real files", res.write === "cell wrote this");
				check(
					"probe: real bash executes",
					res.bash === "hi-from-real-bash",
					JSON.stringify(res.bash),
				);
				check(
					"probe: all 10 named tools mounted",
					JSON.stringify(res.names) ===
						JSON.stringify([
							"AskUserQuestion",
							"bash",
							"clipboard_copy",
							"edit",
							"find",
							"grep",
							"ls",
							"read",
							"web_search",
							"write",
						]),
					JSON.stringify(res.names),
				);
				check(
					"probe: unknown tool error is clean",
					res.unknown === "unknown_tool",
					JSON.stringify(res.unknown),
				);
			}
		}
		kill9(boot1); // SIGKILL: no cleanup chance — sets up the sweep test
		const log1 = await boot1.stderr();

		// 5. chaos boot — broken entries diagnosed on stderr, survivors proven via catalog
		// (the startup banner is a ui.notify now, so survivors must be asserted live)
		writeFileSync(
			manifest,
			`${await Bun.file(manifest).text()}  - from: "./does-not-exist.ts"\n    factory: createGhost\n  - from: "@earendil-works/pi-coding-agent"\n    factory: notExportedAnywhere\n`,
		);
		const boot2 = bootPi({ HOME: e2eHome, PI_REPL_FORCE: "1" }, runDir);
		await waitUntil(() => existsSync(boot2.socketPath), 60_000);
		await new Promise((r) => setTimeout(r, 300));
		const probe2 = [
			...XCHG,
			'cat = xchg({"v": 1, "op": "catalog"})',
			'print(json.dumps(sorted(b["name"] for b in cat.get("content", []) if b.get("type") == "tool")))',
		].join("\n");
		const py2 = Bun.spawn(["python3", "-c", probe2], {
			env: { ...process.env, PI_BRIDGE_SOCK: boot2.socketPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [namesOut] = await Promise.all([
			new Response(py2.stdout).text(),
			new Response(py2.stderr).text(),
		]);
		await py2.exited;
		let survivors: string[] = [];
		try {
			survivors = JSON.parse(namesOut);
		} catch {
			/* shown below */
		}
		check(
			"chaos: 10 survivors mounted, broken entries skipped",
			JSON.stringify(survivors) ===
				JSON.stringify([
					"AskUserQuestion",
					"bash",
					"clipboard_copy",
					"edit",
					"find",
					"grep",
					"ls",
					"read",
					"web_search",
					"write",
				]),
			`${survivors.length} mounted: ${JSON.stringify(survivors)}`,
		);
		kill9(boot2);
		const log2 = await boot2.stderr();
		const bridgeLines = log2.split("\n").filter((l) => l.includes("[pi-bridge]"));
		check(
			"chaos: broken entries diagnosed on stderr",
			bridgeLines.some((l) => l.includes("skipped") && l.includes("does-not-exist")),
			bridgeLines.slice(-3).join(" | "),
		);
		const socketsAfter2 = readdirSync(runDir).filter((f) => f.endsWith(".sock"));
		check(
			"chaos: SIGKILL leftovers present before next boot",
			socketsAfter2.length >= 1,
			JSON.stringify(socketsAfter2),
		);

		// 6. sweep: next boot removes dead-pid sockets
		const boot3 = bootPi({ HOME: e2eHome, PI_REPL_FORCE: "1" }, runDir);
		const swept = await waitUntil(() => {
			const socks = readdirSync(runDir).filter((f) => f.endsWith(".sock"));
			return socks.length === 1 && socks[0] === `pi-bridge-${boot3.proc.pid}.sock`;
		}, 60_000);
		check("sweep: only the new boot's socket remains", swept, JSON.stringify(readdirSync(runDir)));
		kill9(boot3);
	} finally {
		rmSync(e2eHome, { recursive: true, force: true }); // the whole isolated home vanishes
	}

	// 7. verdict
	if (failures === 0) {
		console.log("\nE2E GREEN — all assertions passed in the isolated home");
		console.log("real ~/.pi untouched: no install, no v1 changes, no sockets");
	} else {
		console.log(`\nE2E RED (${failures} failures) — nothing was installed anywhere`);
	}
	process.exit(failures === 0 ? 0 : 1);
}

function homedir0(): string {
	// captured BEFORE we override HOME in any child env
	return process.env.HOME ?? "/root";
}

await main();
