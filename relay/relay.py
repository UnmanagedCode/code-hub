"""code-hub host relay.

Runs on the Docker HOST and exposes a containerised code-hub's ports on the
host: each LAN share on the host's LAN address, and every running app on the
host's 127.0.0.1. code-hub dials OUT to this relay and holds one authenticated
control session carrying the full set of ports to expose; the relay binds a
host listener per port and, for each client, asks code-hub over that session to
open one fresh authenticated data connection, which it splices byte-for-byte to
the client. The relay never dials anything itself, never terminates TLS and
never learns where code-hub sends the bytes. Python 3.9+, standard library only.

The two sides meet through a rendezvous directory in code-hub's store
(<projectsRoot>/.code-hub/relay/): code-hub writes the shared secret there, the
relay writes its listen address. The wire protocol (frames, MAC labels, caps,
timings, error codes) lives in protocol.json next to this file; keep the two
files together. See docs/host-relay.md and docs/protocol.md.
"""

import argparse
import asyncio
import errno
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import signal
import socket
import stat
import struct
import sys
from pathlib import Path

if sys.version_info < (3, 9):
    sys.exit("code-hub relay needs Python 3.9 or newer")


def load_protocol():
    return json.loads(Path(__file__).with_name("protocol.json").read_text(encoding="utf-8"))


PROTOCOL = load_protocol()
VERSION = PROTOCOL["protocolVersion"]
RENDEZVOUS = PROTOCOL["rendezvous"]
LABELS = PROTOCOL["macLabels"]
FRAMES = PROTOCOL["frames"]
ROLES = PROTOCOL["roles"]
SCOPES = PROTOCOL["scopes"]
ERROR_CODES = PROTOCOL["errorCodes"]
PORT_MIN, PORT_MAX = PROTOCOL["port"]["min"], PROTOCOL["port"]["max"]
NONCE_BYTES = PROTOCOL["nonceBytes"]
MAX_RENDEZVOUS_BYTES = PROTOCOL["maxRendezvousBytes"]
MAX_FRAME_BYTES = PROTOCOL["maxFrameBytes"]
MAX_PORTS = PROTOCOL["maxPorts"]
MAX_PENDING_HANDSHAKES = PROTOCOL["maxPendingHandshakes"]
MAX_INCOMING_PER_PORT = PROTOCOL["maxIncomingPerPort"]
MAX_INCOMING_TOTAL = PROTOCOL["maxIncomingTotal"]
HANDSHAKE_TIMEOUT_S = PROTOCOL["handshakeTimeoutMs"] / 1000.0
PING_INTERVAL_S = PROTOCOL["pingIntervalMs"] / 1000.0
KEEPALIVE_TIMEOUT_S = PROTOCOL["keepaliveTimeoutMs"] / 1000.0

# Relay-only limits.
PUMP_CHUNK = 65536
LISTEN_BACKLOG = 128
KEEPALIVE_IDLE_S = 15
KEEPALIVE_INTERVAL_S = 5

STORE_DIRNAME = ".code-hub"
DEFAULT_LISTEN_PORT = 7077
DEFAULT_ACCEPT_WAIT_MS = 10000
# The only address a loopback-scope listener ever binds.
LOOPBACK_HOST = "127.0.0.1"
SIOCGIFADDR = 0x8915
DOCKER0 = b"docker0"

# TEST-NET-1: a documentation address. A UDP connect() to it only makes the
# kernel pick the source address of the default route; nothing is sent.
PROBE_DEST = ("192.0.2.1", 9)
PROBE_DEST_ENV = "CODEHUB_RELAY_PROBE_DEST"

CGNAT = ipaddress.ip_network("100.64.0.0/10")
DOCKER_BRIDGE = ipaddress.ip_network("172.17.0.0/16")
THIS_NETWORK = ipaddress.ip_network("0.0.0.0/8")
WILDCARD_HOSTS = ("", "0.0.0.0", "::")

NONCE_RE = re.compile(r"\A[A-Za-z0-9_-]{%d}\Z" % ((NONCE_BYTES * 8 + 5) // 6))
MAC_RE = re.compile(r"\A[0-9a-f]{64}\Z")
ID_RE = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")
SCOPE_VALUES = frozenset(SCOPES.values())

# Frame shapes: exactly these keys, each of this type. A dict literal per
# shape, so frame keys are never confused with protocol identifiers.
AUTH_SHAPES = {
    ROLES["control"]: {"t": str, "v": int, "role": str, "nonce": str, "mac": str},
    ROLES["data"]: {"t": str, "v": int, "role": str, "nonce": str, "mac": str, "session": str, "conn": str},
}
BARE_SHAPE = {"t": str}
PORTS_SHAPE = {"t": str, "ports": list}
PORT_ENTRY_SHAPE = {"port": int, "scope": str}


def log(msg):
    print("code-hub-relay: " + msg, file=sys.stderr, flush=True)


def parse_ip_port(value):
    host, sep, port = value.rpartition(":")
    if not sep or not port.isdigit() or int(port) > 65535:
        raise ValueError("expected <ip>:<port>, got %r" % value)
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    return host, int(port)


def probe_dest():
    override = os.environ.get(PROBE_DEST_ENV)
    if not override:
        return PROBE_DEST
    host, port = parse_ip_port(override)
    return str(ipaddress.IPv4Address(host)), port


def default_route_ipv4(dest=None):
    """The source address the kernel would use toward `dest` (the default route).

    A UDP connect() only records the default peer after a route lookup; no
    datagram leaves the host until send()/sendto(), and none is ever called.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(dest or probe_dest())
        return sock.getsockname()[0]
    finally:
        sock.close()


def docker0_ipv4():
    """The IPv4 address of the docker0 bridge (native Linux Docker), or None."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        import fcntl
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            packed = fcntl.ioctl(sock.fileno(), SIOCGIFADDR, struct.pack("256s", DOCKER0))
        finally:
            sock.close()
        return socket.inet_ntoa(packed[20:24])
    except (OSError, ImportError):
        return None


def default_listen_host(docker0=docker0_ipv4):
    """Where the control listener goes without --listen: the docker0 address a
    native-Linux container reaches the host on, else loopback (Docker Desktop
    forwards host.docker.internal to the host's loopback)."""
    return docker0() or LOOPBACK_HOST


def ip_problem(ip, listen_host=None):
    """Why `ip` can't be advertised as the host's LAN address, or None."""
    addr = ipaddress.IPv4Address(ip)
    if addr in THIS_NETWORK:
        return "unspecified"
    if addr.is_loopback:
        return "loopback address"
    if addr.is_link_local:
        return "link-local"
    if addr.is_multicast:
        return "multicast"
    if addr.is_reserved:
        return "reserved"
    if addr in CGNAT:
        return "CGNAT 100.64.0.0/10, likely a VPN"
    if addr in DOCKER_BRIDGE:
        return "Docker default bridge 172.17.0.0/16"
    if listen_host is not None and ip == listen_host:
        return "it is the control listen address"
    return None


def resolve_addresses(advertise, listen_host, probe=default_route_ipv4):
    """(addresses, problem): the explicit --advertise list, else the probe's answer."""
    if advertise:
        return list(advertise), None
    try:
        ip = probe()
    except OSError as e:
        return [], "no default route: %s" % (e.strerror or e)
    problem = ip_problem(ip, listen_host)
    if problem:
        return [], problem
    return [ip], None


def canonical_ip(ip):
    """The canonical spelling of an IPv4 address (Python 3.9.0-3.9.4 accept
    leading zeros), or `ip` unchanged when it doesn't parse."""
    try:
        return str(ipaddress.IPv4Address(ip))
    except ValueError:
        return ip


def _is_loopback(host):
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def control_listen_problem(listen_host, addresses, default_route=None):
    """Why the control listener would be reachable from the LAN, or None.

    Refuses a wildcard --listen, and a non-loopback --listen equal to an
    advertised address or to the default-route address (`default_route`, the
    probe's answer, None when the probe found none). A loopback --listen is
    never LAN-reachable and is always allowed. What it can't know: a --listen
    on some other LAN interface the relay neither advertises nor probes; there,
    the challenge-response handshake is the remaining gate.
    """
    if listen_host in WILDCARD_HOSTS:
        return "--listen %r is a wildcard address, which would expose the control port on every interface" % listen_host
    if _is_loopback(listen_host):
        return None
    listen = canonical_ip(listen_host)
    if listen in [canonical_ip(a) for a in addresses]:
        return "--listen %s is also an advertised address, so LAN devices could reach the control port" % listen_host
    if default_route is not None and listen == canonical_ip(default_route):
        return "--listen %s is this host's default-route (LAN) address, so LAN devices could reach the control port" % listen_host
    return None


# --- rendezvous ---------------------------------------------------------------

def find_store(script_path, override=None):
    """(store_dir or None, searched): code-hub's .code-hub store.

    With `override` (--projects-root), <override>/.code-hub. Otherwise the
    nearest ancestor of the script's directory holding a .code-hub directory,
    so the answer never depends on the working directory.
    """
    if override is not None:
        root = Path(override).resolve()
        store = root / STORE_DIRNAME
        return (store if store.is_dir() else None), [str(root)]
    searched = []
    for parent in Path(script_path).resolve().parent.parents:
        searched.append(str(parent))
        if (parent / STORE_DIRNAME).is_dir():
            return parent / STORE_DIRNAME, searched
    return None, searched


class RendezvousError(Exception):
    """A rendezvous file or directory can't be used; the message says why, and
    for a permission failure also what to do (see file_problem)."""


def file_problem(action, path, e, rdir):
    """`cannot <action> <path>: <cause>`, plus the fix when the cause is permissions."""
    msg = "cannot %s %s: %s" % (action, path, e.strerror or e)
    if isinstance(e, PermissionError):
        msg += " — run the relay as the user that owns %s" % rdir
    return msg


def relay_dir(store):
    path = Path(store) / RENDEZVOUS["dir"]
    try:
        os.makedirs(str(path), mode=0o700, exist_ok=True)
    except OSError as e:
        raise RendezvousError(file_problem("create", path, e, Path(store)))
    return path


class SecretUnavailable(Exception):
    pass


def read_small_file(path):
    """The text of `path` if it is a regular file of at most maxRendezvousBytes.

    Opened non-blocking and checked on the open descriptor, so a FIFO can't
    block the event loop and a huge file can't bloat it. Raises
    OSError for an I/O failure, ValueError for a file that isn't usable.
    """
    fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("%s is not a regular file" % path)
        if info.st_size > MAX_RENDEZVOUS_BYTES:
            raise ValueError("%s is larger than %d bytes" % (path, MAX_RENDEZVOUS_BYTES))
        # A read may return less than asked: read on until EOF or one byte past the bound.
        data = b""
        while len(data) <= MAX_RENDEZVOUS_BYTES:
            chunk = os.read(fd, MAX_RENDEZVOUS_BYTES + 1 - len(data))
            if not chunk:
                break
            data += chunk
    finally:
        os.close(fd)
    if len(data) > MAX_RENDEZVOUS_BYTES:
        raise ValueError("%s is larger than %d bytes" % (path, MAX_RENDEZVOUS_BYTES))
    return data.decode("utf-8")


def read_secret(rdir):
    """The secret code-hub wrote, re-read on every call so a regenerated one
    applies at once. Raises SecretUnavailable naming the path and the cause."""
    path = Path(rdir) / RENDEZVOUS["hubFile"]
    try:
        raw = read_small_file(path)
    except OSError as e:
        raise SecretUnavailable(file_problem("read", path, e, rdir))
    except ValueError as e:
        raise SecretUnavailable(str(e))
    try:
        obj = json.loads(raw)
    except ValueError as e:
        raise SecretUnavailable("%s is not valid JSON: %s" % (path, e))
    secret = obj.get("secret") if isinstance(obj, dict) else None
    if not isinstance(secret, str) or len(secret) < PROTOCOL["minSecretLength"]:
        raise SecretUnavailable("%s holds no secret of at least %d characters" % (path, PROTOCOL["minSecretLength"]))
    return secret


def write_host_json(rdir, listen, pid):
    """Atomically publish where the relay listens (tmp file in the same dir,
    created exclusively, then renamed). Raises RendezvousError saying why."""
    path = Path(rdir) / RENDEZVOUS["relayFile"]
    tmp = Path(rdir) / (".%s.%d.tmp" % (RENDEZVOUS["relayFile"], pid))
    payload = json.dumps({"protocolVersion": VERSION, "listen": listen, "pid": pid}) + "\n"
    try:
        if os.path.lexists(str(tmp)):
            os.unlink(str(tmp))
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(str(tmp), str(path))
    except OSError as e:
        raise RendezvousError(file_problem("write", path, e, rdir))
    return path


def remove_host_json_if_ours(rdir, pid):
    """Remove host.json only while it still names `pid`: a newer relay's file stays."""
    path = Path(rdir) / RENDEZVOUS["relayFile"]
    try:
        obj = json.loads(read_small_file(path))
    except (OSError, ValueError):
        return False
    if not isinstance(obj, dict) or obj.get("pid") != pid:
        return False
    try:
        path.unlink()
    except OSError:
        return False
    return True


# --- frames and the handshake --------------------------------------------------

class BadFrame(Exception):
    pass


def encode(frame):
    return json.dumps(frame, separators=(",", ":")).encode("utf-8") + b"\n"


def parse_frame(line):
    try:
        msg = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise BadFrame("not a JSON line")
    if not isinstance(msg, dict) or not isinstance(msg.get("t"), str):
        raise BadFrame("not an object with a string t")
    return msg


def check_shape(obj, shape, what):
    if set(obj) != set(shape):
        raise BadFrame("%s must have exactly the keys %s" % (what, ", ".join(sorted(shape))))
    for key, kind in shape.items():
        value = obj[key]
        if type(value) is not kind:
            raise BadFrame("%s: %s must be %s" % (what, key, kind.__name__))


def mac(secret, label, role, nonce_relay, nonce_hub, session="", conn=""):
    msg = "\n".join((label, role, nonce_relay, nonce_hub, session, conn))
    return hmac.new(secret.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_mac(expected, given):
    """Constant-time comparison of a MAC against the expected one."""
    if not isinstance(given, str):
        return False
    return hmac.compare_digest(expected.encode("utf-8"), given.encode("utf-8"))


def hosts_for(scope, addresses):
    """The ONLY place bind hosts are chosen: loopback scope binds 127.0.0.1 and
    nothing else, lan scope binds exactly the advertised addresses."""
    if scope == SCOPES["loopback"]:
        return [LOOPBACK_HOST]
    if scope == SCOPES["lan"]:
        return list(addresses)
    raise ValueError("unknown scope %r" % scope)


def ports_entries(msg):
    """The (port, scope) pairs of a ports frame, in frame order. Raises BadFrame."""
    check_shape(msg, PORTS_SHAPE, "a ports frame")
    pairs = []
    for entry in msg["ports"]:
        if not isinstance(entry, dict):
            raise BadFrame("a ports entry must be an object")
        check_shape(entry, PORT_ENTRY_SHAPE, "a ports entry")
        port, scope = entry["port"], entry["scope"]
        if not PORT_MIN <= port <= PORT_MAX:
            raise BadFrame("port %d is outside %d-%d" % (port, PORT_MIN, PORT_MAX))
        if scope not in SCOPE_VALUES:
            raise BadFrame("unknown scope %r" % scope)
        if (port, scope) in pairs:
            raise BadFrame("duplicate entry for port %d, scope %s" % (port, scope))
        pairs.append((port, scope))
    return pairs


# --- sockets --------------------------------------------------------------------

def set_keepalive(writer):
    sock = writer.get_extra_info("socket")
    if sock is None:
        return
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, "TCP_KEEPIDLE"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, KEEPALIVE_IDLE_S)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, KEEPALIVE_INTERVAL_S)
        elif sys.platform == "darwin" and hasattr(socket, "TCP_KEEPALIVE"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPALIVE, KEEPALIVE_IDLE_S)
        elif hasattr(socket, "SIO_KEEPALIVE_VALS") and hasattr(sock, "ioctl"):
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, KEEPALIVE_IDLE_S * 1000, KEEPALIVE_INTERVAL_S * 1000))
    except OSError:
        pass


def is_addr_in_use(e):
    return e.errno == errno.EADDRINUSE or getattr(e, "winerror", None) == 10048


def bind_listener(host, port):
    """A listening, non-blocking TCP socket on host:port."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if sys.platform == "win32":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        sock.listen(LISTEN_BACKLOG)
        sock.setblocking(False)
    except OSError:
        sock.close()
        raise
    return sock


def bind_all(addresses, port):
    """Listening sockets on every address at one port (0 = kernel's choice).

    A failed bind closes the sockets already bound, so no partial bind remains.
    """
    socks = []
    try:
        for host in addresses:
            sock = bind_listener(host, port)
            socks.append(sock)
            port = sock.getsockname()[1]
    except OSError:
        for sock in socks:
            sock.close()
        raise
    return socks, port


async def pump(reader, writer, other):
    """Copy reader → writer until EOF; on an error, abort both connections."""
    try:
        while True:
            data = await reader.read(PUMP_CHUNK)
            if not data:
                break
            writer.write(data)
            await writer.drain()
        if writer.can_write_eof() and not writer.is_closing():
            writer.write_eof()
    except (ConnectionError, OSError):
        writer.transport.abort()
        other.transport.abort()


class PortError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class Incoming:
    """A host client waiting for code-hub to claim it with a data connection."""

    def __init__(self, listener, reader, writer, timer):
        self.listener = listener
        self.reader = reader
        self.writer = writer
        self.timer = timer


class Listener:
    """The host listener(s) for one (port, scope) pair of a session."""

    def __init__(self, session, port, scope, host_port, fallback):
        self.session = session
        self.port = port
        self.scope = scope
        self.host_port = host_port
        self.fallback = fallback
        self.servers = []
        self.writers = set()
        self.tasks = set()
        self.pending = 0
        self.closed = False

    async def start(self, socks):
        for sock in socks:
            self.servers.append(await asyncio.start_server(self._on_client, sock=sock))

    async def _on_client(self, reader, writer):
        if self.closed or not self.session.offer(self, reader, writer):
            writer.transport.abort()

    def _task(self, coro):
        task = asyncio.get_running_loop().create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def splice(self, client_reader, client_writer, data_reader, data_writer):
        if self.closed:
            client_writer.transport.abort()
            data_writer.transport.abort()
            return
        self.writers.add(client_writer)
        self.writers.add(data_writer)
        set_keepalive(client_writer)
        set_keepalive(data_writer)
        up = self._task(pump(client_reader, data_writer, client_writer))
        down = self._task(pump(data_reader, client_writer, data_writer))
        try:
            await asyncio.gather(up, down, return_exceptions=True)
        finally:
            for w in (client_writer, data_writer):
                self.writers.discard(w)
                w.close()

    def close(self):
        """Release everything synchronously: listeners, pending and spliced connections."""
        if self.closed:
            return
        self.closed = True
        for server in self.servers:
            server.close()
        for writer in list(self.writers):
            writer.transport.abort()
        self.writers.clear()
        for task in list(self.tasks):
            task.cancel()


class Session:
    """The one authenticated control session, and every listener it asked for."""

    def __init__(self, relay, sid, reader, writer, addresses, problem):
        self.relay = relay
        self.id = sid
        self.reader = reader
        self.writer = writer
        self.lan_addresses = addresses
        self.lan_problem = problem
        self.listeners = {}
        self.incoming = {}
        self.closed = False
        self.silence = None
        self.pinger = None

    def send(self, frame):
        if self.closed or self.writer.is_closing():
            return
        self.writer.write(encode(frame))

    # --- liveness -------------------------------------------------------------

    def _heard(self):
        if self.silence is not None:
            self.silence.cancel()
        self.silence = asyncio.get_running_loop().call_later(KEEPALIVE_TIMEOUT_S, self._silent)

    def _silent(self):
        log("control session %s: no frame for over %d ms — closing it" % (self.id, PROTOCOL["keepaliveTimeoutMs"]))
        self.close()

    async def _ping(self):
        while not self.closed:
            await asyncio.sleep(PING_INTERVAL_S)
            self.send({"t": FRAMES["ping"]})

    async def run(self):
        self._heard()
        self.pinger = asyncio.get_running_loop().create_task(self._ping())
        try:
            while not self.closed:
                try:
                    line = await self.reader.readline()
                except ValueError:
                    self.fatal(ERROR_CODES["badFrame"], "a frame is longer than %d bytes" % MAX_FRAME_BYTES)
                    return
                if not line.endswith(b"\n"):
                    return
                self._heard()
                try:
                    await self._on_frame(parse_frame(line))
                except BadFrame as e:
                    log("control session %s: bad frame (%s) — closing it" % (self.id, e))
                    self.fatal(ERROR_CODES["badFrame"], str(e))
                    return
        except (ConnectionError, OSError):
            pass
        finally:
            self.close()

    async def _on_frame(self, msg):
        t = msg["t"]
        if t == FRAMES["ping"]:
            check_shape(msg, BARE_SHAPE, "a ping frame")
            self.send({"t": FRAMES["pong"]})
        elif t == FRAMES["pong"]:
            check_shape(msg, BARE_SHAPE, "a pong frame")
        elif t == FRAMES["ports"]:
            status = await self.apply_ports(ports_entries(msg))
            self.send(status)
        else:
            raise BadFrame("unexpected %r frame on a control session" % t)

    # --- listeners --------------------------------------------------------------

    def _drop_listener(self, key):
        listener = self.listeners.pop(key, None)
        if listener is None:
            return
        for conn, inc in list(self.incoming.items()):
            if inc.listener is listener:
                self.incoming.pop(conn)
                inc.timer.cancel()
        listener.close()
        log("closed %s port %d (host port %d)" % (listener.scope, listener.port, listener.host_port))

    async def _open(self, port, scope):
        if scope == SCOPES["lan"] and self.lan_problem:
            raise PortError(ERROR_CODES["noLanAddress"], "no LAN address to advertise (%s)" % self.lan_problem)
        hosts = hosts_for(scope, self.lan_addresses)
        fallback = False
        try:
            socks, bound = bind_all(hosts, port)
        except OSError as e:
            if not is_addr_in_use(e):
                raise PortError(ERROR_CODES["bindFailed"], "bind failed: %s" % (e.strerror or e))
            try:
                socks, bound = bind_all(hosts, 0)
            except OSError as e2:
                raise PortError(ERROR_CODES["bindFailed"], "bind failed: %s" % (e2.strerror or e2))
            fallback = True
        listener = Listener(self, port, scope, bound, fallback)
        try:
            await listener.start(socks)
        except Exception as e:
            listener.close()
            for sock in socks:
                sock.close()
            raise PortError(ERROR_CODES["bindFailed"], "could not serve the port: %s" % e)
        log("%s port %d on host %s port %d%s" % (scope, port, ",".join(hosts), bound,
                                                 " (requested port busy)" if fallback else ""))
        return listener

    async def apply_ports(self, pairs):
        """Reconcile the listeners with the full requested set; returns the status frame."""
        addresses, problem = self.relay.addresses()
        if (addresses, problem) != (self.lan_addresses, self.lan_problem):
            log("LAN addresses changed from %s to %s — rebinding LAN listeners"
                % (",".join(self.lan_addresses) or "none", ",".join(addresses) or "none (%s)" % problem))
            for key in [k for k in self.listeners if k[1] == SCOPES["lan"]]:
                self._drop_listener(key)
            self.lan_addresses, self.lan_problem = addresses, problem
        wanted = pairs[:MAX_PORTS]
        for key in list(self.listeners):
            if key not in wanted:
                self._drop_listener(key)
        results = []
        for port, scope in wanted:
            listener = self.listeners.get((port, scope))
            if listener is None:
                try:
                    listener = await self._open(port, scope)
                except PortError as e:
                    results.append({"port": port, "scope": scope, "code": e.code, "message": e.message})
                    continue
                if self.closed:
                    listener.close()
                    continue
                self.listeners[(port, scope)] = listener
            results.append({"port": port, "scope": scope, "hostPort": listener.host_port, "fallback": listener.fallback})
        for port, scope in pairs[MAX_PORTS:]:
            results.append({"port": port, "scope": scope, "code": ERROR_CODES["tooManyPorts"],
                            "message": "at most %d ports per session" % MAX_PORTS})
        return {"t": FRAMES["status"], "addresses": list(self.lan_addresses), "ports": results}

    # --- the data path ------------------------------------------------------------

    def offer(self, listener, reader, writer):
        """Register a host client and ask code-hub to claim it. False = refused (closed or capped)."""
        if self.closed or listener.closed:
            return False
        if listener.pending >= MAX_INCOMING_PER_PORT or len(self.incoming) >= MAX_INCOMING_TOTAL:
            return False
        conn = secrets.token_urlsafe(12)
        timer = asyncio.get_running_loop().call_later(self.relay.accept_wait_ms / 1000.0, self._unclaimed, conn)
        self.incoming[conn] = Incoming(listener, reader, writer, timer)
        listener.pending += 1
        listener.writers.add(writer)
        self.send({"t": FRAMES["incoming"], "port": listener.port, "scope": listener.scope, "conn": conn})
        return True

    def claim(self, conn):
        """The pending client `conn`, consumed; None when unknown or already claimed."""
        inc = self.incoming.pop(conn, None)
        if inc is None:
            return None
        inc.timer.cancel()
        inc.listener.pending -= 1
        return inc

    def _unclaimed(self, conn):
        inc = self.incoming.pop(conn, None)
        if inc is None:
            return
        inc.listener.pending -= 1
        inc.listener.writers.discard(inc.writer)
        inc.writer.transport.abort()

    # --- teardown ---------------------------------------------------------------------

    def fatal(self, code, message):
        """Send an error frame, then close (flushing the frame first)."""
        self.send({"t": FRAMES["error"], "code": code, "message": message})
        self.close(flush=True)

    def close(self, flush=False):
        """Close synchronously and idempotently: every listener, every pending
        and spliced client, and the control connection."""
        if self.closed:
            return
        self.closed = True
        if self.silence is not None:
            self.silence.cancel()
        if self.pinger is not None:
            self.pinger.cancel()
        for key in list(self.listeners):
            self._drop_listener(key)
        for inc in self.incoming.values():
            inc.timer.cancel()
            inc.writer.transport.abort()
        self.incoming.clear()
        if flush:
            self.writer.close()
        else:
            self.writer.transport.abort()
        if self.relay.session is self:
            self.relay.session = None
        log("control session %s closed" % self.id)


class Relay:
    def __init__(self, rdir, advertise, listen_host, accept_wait_ms, probe=default_route_ipv4):
        self.relay_dir = rdir
        self.advertise = advertise
        self.listen_host = listen_host
        self.accept_wait_ms = accept_wait_ms
        self.probe = probe
        self.pending_handshakes = 0
        self.session = None
        self.conns = set()
        self.closing = False

    def addresses(self):
        return resolve_addresses(self.advertise, self.listen_host, self.probe)

    def close(self):
        self.closing = True
        if self.session is not None:
            self.session.close()
        for writer in list(self.conns):
            writer.transport.abort()
        self.conns.clear()

    async def handle(self, reader, writer):
        if self.closing or self.pending_handshakes >= MAX_PENDING_HANDSHAKES:
            writer.transport.abort()
            return
        self.pending_handshakes += 1
        self.conns.add(writer)
        try:
            try:
                then = await asyncio.wait_for(self._handshake(reader, writer), HANDSHAKE_TIMEOUT_S)
            except asyncio.TimeoutError:
                writer.transport.abort()
                return
            finally:
                self.pending_handshakes -= 1
            if then is not None:
                await then()
        except Exception as e:  # never let one connection take the relay down
            log("connection failed: %r" % (e,))
            writer.transport.abort()
        finally:
            self.conns.discard(writer)

    async def _refuse(self, writer, code, message):
        writer.write(encode({"t": FRAMES["error"], "code": code, "message": message}))
        try:
            await writer.drain()
        finally:
            writer.close()

    async def _handshake(self, reader, writer):
        """Authenticate one connection. Returns what to run once it is no longer
        pre-auth, or None when it was refused or dropped."""
        nonce_relay = secrets.token_urlsafe(NONCE_BYTES)
        writer.write(encode({"t": FRAMES["hello"], "v": VERSION, "nonce": nonce_relay}))
        await writer.drain()
        try:
            line = await reader.readline()
        except (ValueError, ConnectionError):
            writer.transport.abort()
            return None
        if not line.endswith(b"\n"):
            writer.transport.abort()
            return None
        try:
            msg = parse_frame(line)
            if msg["t"] != FRAMES["auth"]:
                raise BadFrame("expected an auth frame")
        except BadFrame as e:
            await self._refuse(writer, ERROR_CODES["badFrame"], str(e))
            return None
        try:
            secret = read_secret(self.relay_dir)
        except SecretUnavailable as e:
            log(str(e))
            await self._refuse(writer, ERROR_CODES["noSecret"], str(e))
            return None
        if msg.get("v") != VERSION:
            await self._refuse(writer, ERROR_CODES["versionMismatch"],
                               "this relay speaks protocol %d, the client %r — update the relay/ copy on the host" % (VERSION, msg.get("v")))
            return None
        role = msg.get("role")
        shape = AUTH_SHAPES.get(role)
        try:
            if shape is None:
                raise BadFrame("unknown role %r" % (role,))
            check_shape(msg, shape, "an auth frame")
            if not NONCE_RE.match(msg["nonce"]):
                raise BadFrame("malformed nonce")
            if not MAC_RE.match(msg["mac"]):
                raise BadFrame("malformed mac")
            session = msg.get("session", "")
            conn = msg.get("conn", "")
            if role == ROLES["data"] and not (ID_RE.match(session) and ID_RE.match(conn)):
                raise BadFrame("malformed session or conn")
        except BadFrame as e:
            await self._refuse(writer, ERROR_CODES["badFrame"], str(e))
            return None
        expected = mac(secret, LABELS["hub"], role, nonce_relay, msg["nonce"], session, conn)
        if not verify_mac(expected, msg["mac"]):
            log("refused a %s connection: wrong MAC" % role)
            await self._refuse(writer, ERROR_CODES["authFailed"], "authentication failed")
            return None
        proof = mac(secret, LABELS["relay"], role, nonce_relay, msg["nonce"], session, conn)
        if role == ROLES["control"]:
            return lambda: self._run_control(reader, writer, proof)
        current = self.session
        if current is None or session != current.id:
            await self._refuse(writer, ERROR_CODES["staleSession"], "no current session %s" % session)
            return None
        inc = current.claim(conn)
        if inc is None:
            await self._refuse(writer, ERROR_CODES["unknownConn"], "no pending connection %s" % conn)
            return None
        return lambda: self._splice(inc, reader, writer, proof)

    async def _run_control(self, reader, writer, proof):
        addresses, problem = self.addresses()
        if self.session is not None:
            log("a new control session replaces %s" % self.session.id)
            self.session.close()
        sid = secrets.token_urlsafe(12)
        session = Session(self, sid, reader, writer, addresses, problem)
        self.session = session
        set_keepalive(writer)
        session.send({"t": FRAMES["welcome"], "mac": proof, "session": sid, "addresses": addresses})
        log("control session %s opened; LAN addresses %s" % (sid, ",".join(addresses) or "none (%s)" % problem))
        await session.run()

    async def _splice(self, inc, reader, writer, proof):
        writer.write(encode({"t": FRAMES["welcome"], "mac": proof}))
        await inc.listener.splice(inc.reader, inc.writer, reader, writer)


def parse_args(argv, default_host=default_listen_host):
    parser = argparse.ArgumentParser(
        prog="relay.py",
        description="Expose a containerised code-hub's LAN shares on this host's LAN address, "
                    "and its running apps on this host's loopback.")
    parser.add_argument("--listen", metavar="IP:PORT",
                        help="control listener code-hub dials (default: the docker0 address, else 127.0.0.1, port %d)"
                        % DEFAULT_LISTEN_PORT)
    parser.add_argument("--advertise", metavar="IP[,IP...]",
                        help="host LAN address(es) to expose shares on (default: the default-route IPv4)")
    parser.add_argument("--projects-root", metavar="DIR",
                        help="code-hub's projects root, holding .code-hub (default: the nearest parent of this script's directory that has one)")
    parser.add_argument("--accept-wait-ms", type=int, default=DEFAULT_ACCEPT_WAIT_MS, metavar="N",
                        help="how long a host client waits for code-hub to claim it (default %(default)s)")
    args = parser.parse_args(argv)
    if args.listen is None:
        args.listen = "%s:%d" % (default_host(), DEFAULT_LISTEN_PORT)
    try:
        args.listen_host, args.listen_port = parse_ip_port(args.listen)
    except ValueError as e:
        parser.error("--listen: %s" % e)
    # Every address is canonicalised ONCE, here, and only the canonical string
    # is used from then on — by the guard and by every bind. Python 3.9.0-3.9.4
    # read a leading-zero octet as decimal while the C library's bind reads it
    # as octal, so checking one spelling and binding another could put the
    # control port on an address the guard never saw.
    if args.listen_host not in WILDCARD_HOSTS:
        try:
            args.listen_host = str(ipaddress.IPv4Address(args.listen_host))
        except ValueError:
            parser.error("--listen host must be an IPv4 address, got %r" % args.listen_host)
    if args.advertise is not None:
        ips = []
        for ip in (part.strip() for part in args.advertise.split(",")):
            if not ip:
                continue
            try:
                addr = ipaddress.IPv4Address(ip)
            except ValueError:
                parser.error("--advertise: %r is not an IPv4 address" % ip)
            if addr in THIS_NETWORK:
                parser.error("--advertise: %s is a wildcard address" % ip)
            if str(addr) not in ips:  # a repeat would make every lan bind collide with itself
                ips.append(str(addr))
        if not ips:
            parser.error("--advertise: no address given")
        if len(ips) > PROTOCOL["maxAddresses"]:
            parser.error("--advertise: at most %d addresses" % PROTOCOL["maxAddresses"])
        args.advertise = ips
    if args.accept_wait_ms < 1:
        parser.error("--accept-wait-ms must be positive")
    return args


class ListenError(Exception):
    pass


async def serve(args, rdir, store):
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    relay = Relay(rdir, args.advertise, args.listen_host, args.accept_wait_ms)
    try:
        sock = bind_listener(args.listen_host, args.listen_port)
    except OSError as e:
        raise ListenError("cannot listen on %s: %s" % (args.listen, e.strerror or e))
    server = await asyncio.start_server(relay.handle, sock=sock, limit=MAX_FRAME_BYTES)
    host, port = sock.getsockname()[:2]
    pid = os.getpid()
    write_host_json(rdir, "%s:%d" % (host, port), pid)

    def on_signal(signum, frame):
        loop.call_soon_threadsafe(stop.set)

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), on_signal)

    print("code-hub-relay listening on %s:%d" % (host, port), flush=True)
    log("code-hub store: %s" % store)
    addresses, problem = relay.addresses()
    log("LAN shares go on %s; running apps on %s" % (",".join(addresses) or "no address (%s)" % problem, LOOPBACK_HOST))
    hub_file = Path(rdir) / RENDEZVOUS["hubFile"]
    if not os.path.lexists(str(hub_file)):
        log("waiting for code-hub to create %s" % hub_file)
    await stop.wait()
    log("shutting down")
    relay.close()
    remove_host_json_if_ours(rdir, pid)
    server.close()
    await server.wait_closed()


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    problem = control_listen_problem(args.listen_host, [])
    if problem:
        sys.exit("code-hub-relay: " + problem)
    try:
        dest = probe_dest()
    except ValueError as e:
        sys.exit("code-hub-relay: %s: %s" % (PROBE_DEST_ENV, e))
    # Probed even with --advertise: the listen guard refuses the default-route
    # address too. A failed probe only means there is nothing to compare.
    try:
        route = default_route_ipv4(dest)
        route_error = None
    except OSError as e:
        route, route_error = None, e

    def probe():
        if route_error is not None:
            raise route_error
        return route

    addresses, problem = resolve_addresses(args.advertise, args.listen_host, probe)
    if problem:
        log("no LAN address to advertise (%s) — LAN shares fail until there is one (or pass --advertise <ip>); "
            "running apps are still mirrored on %s" % (problem, LOOPBACK_HOST))
    problem = control_listen_problem(args.listen_host, addresses, route)
    if problem:
        sys.exit("code-hub-relay: " + problem)
    store, searched = find_store(__file__, args.projects_root)
    if store is None:
        if args.projects_root is not None:
            sys.exit("code-hub-relay: no %s directory in %s — start code-hub once with that projects root so it creates one"
                     % (STORE_DIRNAME, searched[0]))
        sys.exit("code-hub-relay: no %s found in any parent of %s (searched: %s) — start code-hub once so it creates "
                 "<projectsRoot>/%s, or pass --projects-root <dir>"
                 % (STORE_DIRNAME, Path(__file__).resolve().parent, ", ".join(searched), STORE_DIRNAME))
    try:
        rdir = relay_dir(store)
        asyncio.run(serve(args, rdir, store))
    except (ListenError, RendezvousError) as e:
        sys.exit("code-hub-relay: %s" % e)
    except OSError as e:
        sys.exit("code-hub-relay: %s" % e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
