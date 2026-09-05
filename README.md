# pi-bridge

pi-repl-py gives the model one tool: exec, which runs Python in a kernel. That
kernel can't call pi's other tools (read, bash, edit) because they live inside
the pi process. pi-bridge is a second extension that serves them over a local
unix socket, so your Python calls read and gets the same validated, formatted
result the model would get.

```
your Python, in the pi-repl-py kernel
  └─ your helper module            (project-local, stdlib)
       └─ JSONL over unix socket   (ping · catalog · call)
            └─ pi-bridge extension (inside pi)
                 └─ pi's real tools + your exportable ones
```

## Install

**With pi's package manager (recommended):**

```sh
pi install git:github.com/k3-2o/pi-bridge
mkdir -p ~/.pi/agent/pi-bridge
cp ~/.pi/agent/git/github.com/k3-2o/pi-bridge/examples/tools.toml \
   ~/.pi/agent/pi-bridge/tools.toml                      # then edit to taste
```

**Manual (git clone):**

```sh
git clone https://github.com/k3-2o/pi-bridge.git
cp -R pi-bridge ~/.pi/agent/extensions/pi-bridge
mkdir -p ~/.pi/agent/pi-bridge
cp pi-bridge/examples/tools.toml ~/.pi/agent/pi-bridge/tools.toml  # then edit to taste
```

**Updating:** the installed extension is a snapshot of this repo — after pulling,
re-run `pi install git:github.com/k3-2o/pi-bridge` (or re-copy). Your manifest at
`~/.pi/agent/pi-bridge/` is yours; updates never touch it.

Start `pi --repl`. At every session start, before the kernel spawns, the bridge
creates the run dir if missing (0700), sweeps stale sockets, starts listening on
a fresh `pi-bridge-<pid>.sock` (0600), and sets `PI_BRIDGE_SOCK` for the kernel.
Helpers only connect; nothing is lazy.

## The manifest

`~/.pi/agent/pi-bridge/tools.toml` decides which tools exist. Each entry is a
module plus the factory to call; the engine is tool-name-blind, so one TOML
block adds a tool. The full annotated file, both `from` forms included:
[examples/tools.toml](examples/tools.toml).

### What "exportable" means

Pi's usual custom-tool flow exports nothing: you define the tool inline and
hand it to `customTools` / `pi.registerTool`. The object never leaves your
file, so a manifest cannot reach it. Pi's built-in tools ARE exported factories
(`createReadTool`, `createBashTool`), which is why they mount by default.

Before (how ask-user-question.ts registers, the classic extension way):

```ts
export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool(createAskUserQuestionDefinition());
}
```

After (the same file also exports the factory, and that is what the manifest
mounts):

```ts
export function createAskUserQuestionDefinition() {
	return {
		name: "AskUserQuestion",
		label: "Ask User Question",
		description: "Pause execution and ask the user a multiple-choice question.",
		parameters: AskUserQuestionParams,
	};
}
```

```toml
[[tools]]
from = "~/.pi/agent/extensions/ask-user-question.ts"
factory = "createAskUserQuestionDefinition"
```

Not exported, nothing to import; exported like the SDK's own tools, it mounts
like them.

## Protocol

The protocol is a conversation over a local unix socket, in plain JSON: the
helper connects, asks which tools are mounted, calls one, and gets a clean
result back (validation, formatting, and error shaping already happened
host-side). When you create a bridge helper for a pi toolset or a specific pi
tool, the full wire contract is here:
[examples/skills/bridge-helper/references/protocol.md](examples/skills/bridge-helper/references/protocol.md).

## Examples

- `examples/tools.toml`: the manifest template, annotated line by line. Copy it
  to `~/.pi/agent/pi-bridge/tools.toml`, keep the SDK entries you want, delete
  the rest.
- `examples/skills/bridge-helper/`: a pi skill that does the helper work for
  you. It reads your live catalog, writes a project-local helper wrapping
  exactly the tools you ask for, generates a connection test, and runs it
  against the socket before calling it done. Copy the folder to
  `~/.pi/agent/skills/` and say "write a bridge helper".

Images: read over the socket returns text only.

## License

MIT
