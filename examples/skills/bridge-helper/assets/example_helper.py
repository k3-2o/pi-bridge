"""pi — pi's native tools inside repl cells, served by the pi-bridge extension.

The TS bridge does all the work: it loads the tool surface from
~/.pi/agent/pi-bridge/tools.toml, runs pi's real tool implementations, and sends
back finished text. This helper is a pipe: it opens one socket connection,
carries calls over it, and returns what arrives — formatting, validation, and
error shaping all happened host-side.

The connection is made once (with connect-phase retries) and kept for the
helper's lifetime; a lock keeps one call on the wire at a time. If the
connection dies after a call was dispatched, that call raises TRANSPORT_LOST
and is never retried — the next call simply opens a fresh connection.

Treat each pi.* call as a real tool call, not ordinary Python: args are validated
against the tool schema before running, and a failed call raises PiBridgeError
carrying pi's own message. Sequence work as small focused pi calls instead of
one monolithic cell.
"""

# The model contract: pi-repl-py extracts this verbatim as the tool description.
helper_description = """pi — pi's real tools from the repl, over the pi-bridge bridge:
pi.tools() — start here: lists every loaded tool with signatures.
pi.<name>(**params) — any tool in ~/.pi/agent/pi-bridge/tools.toml; keyword args only.
pi.raw(tool, **params) — full reply dict; details carry truncation hints (truncated, nextOffset).
Treat each pi.* call as a real tool call: args are schema-validated, failures raise PiBridgeError with pi's message, unknown names get a did-you-mean from the server.
The manifest (~/.pi/agent/pi-bridge/tools.toml) defines the surface — nothing is hardcoded in this helper."""

import json
import os
import socket
import threading
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
CONNECT_BACKOFF = [0.1, 0.2, 0.4, 0.8, 1.6]  # FR-006: 5 retries, invisible on success


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


class _Pi:
    def __init__(self):
        self._sock_path = os.environ.get(SOCKET_ENV)
        self._sock = None
        # One call on the wire at a time: reply pairing is positional, not by id.
        self._lock = threading.Lock()

    # -- transport -----------------------------------------------------------

    def _drop(self):
        """Forget the connection; the next call reconnects (a fresh call, never a retry)."""
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _connection(self):
        """The helper's one socket, connected and handshaked on first use."""
        if self._sock is not None:
            return self._sock
        if not self._sock_path:
            raise PiBridgeError(
                "pi bridge unavailable: %s is not set. Start pi with --repl and check that "
                "the pi-bridge extension loaded." % SOCKET_ENV,
                "transport",
            )
        last = None
        for wait in (0.0, *CONNECT_BACKOFF):
            try:
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.connect(self._sock_path)
                sock.sendall(json.dumps({"v": PROTOCOL_VERSION, "op": "ping"}).encode() + b"\n")
                pong = _recv_line(sock)
            except OSError as exc:
                last = exc
                _time.sleep(wait)
                continue
            if not pong or pong.get("op") != "pong":
                try:
                    sock.close()
                except OSError:
                    pass
                raise PiBridgeError("pi bridge handshake failed", "transport")
            self._sock = sock
            return sock
        raise PiBridgeError(
            "pi bridge unreachable at %s after 5 attempts: %s" % (self._sock_path, last),
            "transport",
        )

    def _exchange(self, frame):
        """Send one frame, return its reply, keep the connection for the next call."""
        sock = self._connection()
        try:
            sock.sendall(frame)
            reply = _recv_line(sock)
        except OSError:
            self._drop()
            raise PiBridgeError(TRANSPORT_LOST, "transport")
        if reply is None:
            # FR-008: the call was dispatched; silence means it MAY have executed.
            self._drop()
            raise PiBridgeError(TRANSPORT_LOST, "transport")
        return reply

    def _call(self, tool, params):
        frame = (
            json.dumps(
                {
                    "v": PROTOCOL_VERSION,
                    "op": "call",
                    "id": uuid.uuid4().hex,
                    "tool": tool,
                    "params": params,
                }
            ).encode()
            + b"\n"
        )
        with self._lock:
            reply = self._exchange(frame)
        if not reply.get("ok"):
            raise PiBridgeError(reply.get("error", "bridge error"), reply.get("kind"))
        return reply

    def _text(self, reply):
        text = "".join(
            b.get("text", "") for b in reply.get("content", []) if b.get("type") == "text"
        )
        if reply.get("isError"):
            raise PiBridgeError(text or "tool failed", "tool")
        return text

    # -- catalog -------------------------------------------------------------

    def _catalog(self):
        frame = json.dumps({"v": PROTOCOL_VERSION, "op": "catalog"}).encode() + b"\n"
        with self._lock:
            reply = self._exchange(frame)
        if not reply.get("ok"):
            raise PiBridgeError(reply.get("error", "catalog failed"), "transport")
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
        # No local name check: the server owns the mounted surface and its
        # unknown_tool error carries a did-you-mean — pre-checking would cost a
        # catalog roundtrip per call and shadow the better message.
        def call(**params):
            return self._text(self._call(name, params))

        return call

    def raw(self, tool, **params):
        """Call any tool; returns the full reply dict (content, details, isError)."""
        return self._call(tool, params)


pi = _Pi()
