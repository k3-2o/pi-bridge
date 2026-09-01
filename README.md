# pi-bridge

Call **pi's real tools** from Python cells inside the pi repl — through a local
unix socket, invisibly. A cell calling `pi.read(...)` runs the same read tool, with
the same schema validation, the same output shaping, and the same errors the model
would get natively.

```mermaid
flowchart LR
    cell["python cell: pi.read(...)"] --> helper["examples/bridge.py"]
    helper -- "JSONL over unix socket" --> server["pi-bridge extension (in pi)"]
    server --> tools["pi's real tools + your exportable ones"]
```

Companion to the `pi-repl` extension, which replaces all of pi's tools with a
single Python cell. Zero changes to that package.

## How it works

- **The manifest is the surface.** `~/.pi/agent/pi-bridge/tools.yml` declares every
  callable tool: an import source (SDK package or `~/`/`./` file) plus an exported
  factory name. The engine is tool-name-blind — adding a tool is one YAML line.
- **The engine owns everything.** `index.ts` + `src/` load the manifest, mount
  pi's real tool factories, run a JSONL server, validate every call against the
  tool's real schema, execute with pi's real context, and format output host-side.
- **The helper is dumb on purpose.** `examples/bridge.py` connects, handshakes,
  and returns finished text. `pi.anything()` works for anything the manifest declares.

Reliability contract: cells only ever see (1) pi's verbatim schema errors,
(2) the tool's own failures, or (3) one loud message when a connection died
mid-call (which may have executed — never blindly retried). Connect-phase races
are retried invisibly. Everything else about the socket is unobservable.

## Install

```sh
# 1. the extension (this repo root IS the extension)
cp -R . ~/.pi/agent/extensions/pi-bridge    # or: ln -s "$PWD" ~/.pi/agent/extensions/pi-bridge

# 2. the manifest
mkdir -p ~/.pi/agent/pi-bridge
cp tools.yml.example ~/.pi/agent/pi-bridge/tools.yml   # then edit to taste

# 3. the cell helper
cp examples/bridge.py ~/.pi/agent/pi-repl/helpers/bridge.py
```

Start `pi --repl`. `pi.tools()` from any cell lists what the manifest mounted.

## Manifest reference

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | must be `1` |
| `tools[].from` | yes | package name, `~/` file, or `./` path relative to the manifest |
| `tools[].factory` | yes | exported function returning `{ name, execute }` |
| `tools[].cwd` | no | pass session cwd to the factory (SDK tools: `true`) |
| `tools[].name` | no | mount under a different name |
| `tools[].timeout` | no | per-tool call timeout in seconds |

Broken entries never take the bridge down: each failure is skipped with a precise
diagnostic (wrong path, missing export, garbage factory product, duplicate name),
and `pi.tools()` only shows what actually mounted.

## Declaring npm-installed packages

`from:` can point at any file on disk, including a package in pi's npm store.
`pi install npm:<pkg>` drops packages at `~/.pi/agent/npm/node_modules/<pkg>/`:

```yaml
  - from: "~/.pi/agent/npm/node_modules/@k3_2o/pi-read-image/index.ts"
    factory: createReadImageTool
    cwd: true
```

Two rules keep this reliable:

- **The package must ship its runtime imports as real `dependencies`** (pi's
  documented rule for installed packages), not only `peerDependencies`. Peers are
  never installed into the store, and the plain import chain from a store copy
  finds only what physically sits in `~/.pi/agent/npm/node_modules`. A
  peers-only package fails with `Cannot find package '...'` — even though the
  identical file loads from `extensions/`, because loose files outside any npm
  project get bun's automatic fetch, while files inside the store don't.
- **Prefer the `~/` store path over a bare package name.** A bare token resolves
  through bun's own machinery (it may pull a fresh copy from the registry cache
  instead of the store you installed), so reference the file you actually have.

After adding an entry, `pi.tools()` in a fresh or `/reload`ed session shows it;
a skipped entry always has its reason on pi's stderr at boot.

## The helper

```python
pi.read("notes.txt")            # clean text, ANSI-free, ready to use
pi.bash("ls -la")               # raises PiBridgeError on non-zero exit
pi.web_search(query="...")      # your exportable tools, one YAML line each
pi.tools()                      # what is callable right now, with signatures
pi.raw(tool, **params)          # full reply dict (content, details, isError)
```

Stdlib only. Truncation paging arrives as machine hints: `pi.raw(...)["details"]`
carries `truncated` / `nextOffset` instead of text notices.

## Troubleshooting

- **`PI_BRIDGE_SOCK is not set`** — the extension did not activate: start pi with
  `--repl` (or `PI_REPL_FORCE=1`), and check stderr for `[pi-bridge]` diagnostics.
- **`protocol version mismatch`** — an old helper met a new server (or vice versa);
  update the side that lags. Never silent by design.
- **`connection lost after the call was dispatched`** — the socket died mid-call;
  the call may have run, so re-issue deliberately rather than retrying blindly.
- **A tool is missing from `pi.tools()`** — its manifest entry was skipped; the
  exact reason is in pi's stderr at boot.
- **`Cannot find package '...'` for an npm store copy** — the package's runtime
  deps are not in the store; use a version that carries them as `dependencies`
  (see *Declaring npm-installed packages*).
- **Stale sockets** — swept automatically at every start (pid-liveness probe).

## Development

```sh
just setup   # bun install
just ci      # fmt + typecheck + lint + 63 tests (incl. cross-language interop)
just smoke   # extension imports cleanly
```

Requires bun 1.4+ (pi's own runtime). The python helper is stdlib-only.

## License

MIT
