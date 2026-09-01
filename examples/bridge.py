"""pi — pi's native tools inside repl cells, served by the pi-bridge extension.

The TS bridge does all the work: it loads the tool surface from
~/.pi/agent/pi-bridge/tools.yml, runs pi's real tool implementations, and sends
back finished text. This helper only carries calls over the socket and returns
what arrives — formatting, validation, and error shaping all happened host-side.

Treat each pi.* call as a real tool call, not ordinary Python: args are validated
against the tool schema before running, and a failed call raises PiBridgeError
carrying pi's own message. Sequence work as small focused pi calls instead of
one monolithic cell.
"""

# The model contract: pi-repl-py extracts this verbatim as the tool description.
helper_description = """pi — pi's real tools from the repl, over the pi-bridge bridge:
pi.tools() — start here: lists every callable tool with signatures.
pi.read/bash/write/edit/grep/ls/find — pi's native tools with pi's own semantics.
pi.web_search(query, intent), pi.clipboard_copy(text), pi.AskUserQuestion(...) — extension tools declared in the manifest.
pi.raw(tool, **params) — full reply dict; details carry truncation hints (truncated, nextOffset).
Treat each pi.* call as a real tool call: args are schema-validated, failures raise PiBridgeError with pi's message.
The manifest (~/.pi/agent/pi-bridge/tools.yml) defines the surface — anything declared there is callable as pi.<name>()."""

import json
import os
import socket
import time as _time
import uuid

SOCKET_ENV = "PI_BRIDGE_SOCK"
PROTOCOL_VERSION = 1
# Wording contract with the TS bridge (src/errors.ts TRANSPORT_LOST_MESSAGE):
# same sentence on both sides of the socket, by design.
TRANSPORT_LOST = (
    "pi-bridge: connection lost after the call was dispatched — the call MAY have "
    "executed; do not blindly retry."
)
CONNECT_BACKOFF = [0.1, 0.2, 0.4, 0.8, 1.6]  # FR-006: 5 tries, invisible on success


class PiBridgeError(RuntimeError):
    """A bridge call failed. kind: args | tool | timeout | unknown_tool | transport | ..."""

    def __init__(self, message, kind=None):
        super().__init__(message)
        self.kind = kind


def _recv_line(sock):
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = sock.recv(65536)
        if not chunk:
            return None  # connection died before a reply — FR-008 territory
        buf += chunk
    return json.loads(buf.decode("utf-8"))


def _connect(path):
    last = None
    for wait in (0.0, *CONNECT_BACKOFF):
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(path)
            return sock
        except OSError as exc:
            last = exc
            _time.sleep(wait)
    raise PiBridgeError(
        "pi bridge unreachable at %s after 5 attempts: %s" % (path, last), "transport"
    )


class _Pi:
    def __init__(self):
        self._sock_path = os.environ.get(SOCKET_ENV)

    # -- transport -----------------------------------------------------------

    def _call(self, tool, params):
        if not self._sock_path:
            raise PiBridgeError(
                "pi bridge unavailable: %s is not set. Start pi with --repl and check that "
                "the pi-bridge extension loaded." % SOCKET_ENV,
                "transport",
            )
        sock = _connect(self._sock_path)
        try:
            sock.sendall(json.dumps({"v": PROTOCOL_VERSION, "op": "ping"}).encode() + b"\n")
            pong = _recv_line(sock)
            if not pong or pong.get("op") != "pong":
                raise PiBridgeError("pi bridge handshake failed", "transport")
            sock.sendall(
                json.dumps({"v": PROTOCOL_VERSION, "op": "call", "id": uuid.uuid4().hex,
                            "tool": tool, "params": params}).encode()
                + b"\n"
            )
            reply = _recv_line(sock)
        finally:
            sock.close()
        if reply is None:
            # FR-008: the call was dispatched; silence means it MAY have executed.
            raise PiBridgeError(TRANSPORT_LOST, "transport")
        if not reply.get("ok"):
            raise PiBridgeError(reply.get("error", "bridge error"), reply.get("kind"))
        return reply

    def _text(self, reply):
        return "".join(
            b.get("text", "") for b in reply.get("content", []) if b.get("type") == "text"
        )

    # -- catalog -------------------------------------------------------------

    def _catalog(self):
        sock = _connect(self._sock_path)
        try:
            sock.sendall(json.dumps({"v": PROTOCOL_VERSION, "op": "ping"}).encode() + b"\n")
            _recv_line(sock)
            sock.sendall(json.dumps({"v": PROTOCOL_VERSION, "op": "catalog"}).encode() + b"\n")
            reply = _recv_line(sock)
        finally:
            sock.close()
        if not reply or not reply.get("ok"):
            raise PiBridgeError((reply or {}).get("error", "catalog failed"), "transport")
        return [b for b in reply.get("content", []) if b.get("type") == "tool"]

    def tools(self):
        """List the tools callable through the bridge, with signatures."""
        return "\n".join(
            "%s — %s" % (t.get("signature", "pi.%s()" % t.get("name")), t.get("description", ""))
            for t in self._catalog()
        )

    # -- generic dispatch: any manifest-declared tool is pi.<name>() ----------

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        catalog = {t.get("name"): t for t in self._catalog()}
        if name not in catalog:
            raise PiBridgeError(
                'Unknown tool "%s". Available: %s' % (name, ", ".join(sorted(catalog))),
                "unknown_tool",
            )

        def call(**params):
            return self._text(self._call(name, params))

        return call

    # -- typed sugar for the 7 built-ins (param names match pi's schemas) ----

    def read(self, path, offset=None, limit=None):
        """Read a file. Returns clean text; paging hints live in pi.raw(...) details."""
        params = {"path": path}
        if offset is not None:
            params["offset"] = offset
        if limit is not None:
            params["limit"] = limit
        return self._text(self._call("read", params))

    def bash(self, command, timeout=None):
        """Run a shell command in the session cwd. Raises on non-zero exit."""
        params = {"command": command}
        if timeout is not None:
            params["timeout"] = timeout
        reply = self._call("bash", params)
        text = self._text(reply)
        details = reply.get("details") or {}
        if reply.get("isError") or int(details.get("exitCode") or 0) != 0:
            raise PiBridgeError(text or "command failed (exit %s)" % details.get("exitCode"), "tool")
        return text

    def write(self, path, content):
        """Write a file (creates parent directories, overwrites)."""
        return self._text(self._call("write", {"path": path, "content": content}))

    def edit(self, path, edits):
        """Exact-match edits: [(old_text, new_text), ...] or {"oldText", "newText"} dicts."""
        normalized = [
            e if isinstance(e, dict) else {"oldText": e[0], "newText": e[1]} for e in edits
        ]
        return self._text(self._call("edit", {"path": path, "edits": normalized}))

    def grep(self, pattern, path=None, glob=None, ignoreCase=False, literal=False, context=None, limit=None):
        """Search file contents; respects .gitignore."""
        params = {"pattern": pattern}
        for key, value in (("path", path), ("glob", glob), ("context", context), ("limit", limit)):
            if value is not None:
                params[key] = value
        if ignoreCase:
            params["ignoreCase"] = True
        if literal:
            params["literal"] = True
        return self._text(self._call("grep", params))

    def ls(self, path=None, limit=None):
        """List a directory (default: cwd)."""
        params = {k: v for k, v in (("path", path), ("limit", limit)) if v is not None}
        return self._text(self._call("ls", params))

    def find(self, pattern, path=None, limit=None):
        """Find files by glob pattern; respects .gitignore."""
        params = {"pattern": pattern}
        if path is not None:
            params["path"] = path
        if limit is not None:
            params["limit"] = limit
        return self._text(self._call("find", params))

    def raw(self, tool, **params):
        """Call any tool; returns the full reply dict (content, details, isError)."""
        return self._call(tool, params)


pi = _Pi()
