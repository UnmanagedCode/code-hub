"""code-hub host relay.

Runs on the Docker HOST and exposes a containerised code-hub's LAN share on the
host's own LAN address. code-hub dials OUT to this relay and parks upgraded
HTTP connections ("accepts") on a forward; each LAN connection to the forward's
port is spliced byte-for-byte onto one parked accept. The relay never dials
anything itself, never terminates TLS and never learns where code-hub sends the
bytes. Python 3.9+, standard library only.

The wire protocol (paths, upgrade token, error codes) lives in protocol.json
next to this file; keep the two files together. See the README's
"Host relay" section and docs/protocol.md.
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
import sys
from collections import deque
from pathlib import Path

if sys.version_info < (3, 9):
    sys.exit("code-hub relay needs Python 3.9 or newer")


def load_protocol():
    return json.loads(Path(__file__).with_name("protocol.json").read_text(encoding="utf-8"))


PROTOCOL = load_protocol()
PATHS = PROTOCOL["paths"]
ERROR_CODES = PROTOCOL["errorCodes"]
UPGRADE_TOKEN = PROTOCOL["upgradeToken"]

# Relay-only limits.
MAX_FORWARDS = 64
MAX_PARKED_PER_FORWARD = 16
MAX_QUEUED_PER_FORWARD = 64
MAX_HEAD_BYTES = 16 * 1024
HEAD_TIMEOUT_S = 5.0
MAX_BODY_BYTES = 4 * 1024
PUMP_CHUNK = 65536
LISTEN_BACKLOG = 128
KEEPALIVE_IDLE_S = 15
KEEPALIVE_INTERVAL_S = 5

DEFAULT_LISTEN = "127.0.0.1:7077"
DEFAULT_SECRET_FILE = Path.home() / ".code-hub-relay" / "secret"
DEFAULT_LEASE_MS = 30000
MIN_LEASE_MS = 100
DEFAULT_ACCEPT_WAIT_MS = 10000

# TEST-NET-1: a documentation address. A UDP connect() to it only makes the
# kernel pick the source address of the default route; nothing is sent.
PROBE_DEST = ("192.0.2.1", 9)
PROBE_DEST_ENV = "CODEHUB_RELAY_PROBE_DEST"

CGNAT = ipaddress.ip_network("100.64.0.0/10")
DOCKER_BRIDGE = ipaddress.ip_network("172.17.0.0/16")
THIS_NETWORK = ipaddress.ip_network("0.0.0.0/8")
WILDCARD_HOSTS = ("", "0.0.0.0", "::")

REASONS = {
    101: "Switching Protocols", 200: "OK", 201: "Created", 204: "No Content",
    400: "Bad Request", 401: "Unauthorized", 404: "Not Found",
    405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
    429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable",
}


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
    ipaddress.IPv4Address(host)
    return host, port


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


def ip_problem(ip, listen_host=None):
    """Why `ip` can't be advertised as the host's LAN address, or None."""
    addr = ipaddress.IPv4Address(ip)
    if addr in THIS_NETWORK:
        return "unspecified"
    if addr.is_loopback:
        return "loopback"
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
    the bearer secret is the remaining gate.
    """
    if listen_host in WILDCARD_HOSTS:
        return "--listen %r is a wildcard address, which would expose the control API on every interface" % listen_host
    if _is_loopback(listen_host):
        return None
    listen = canonical_ip(listen_host)
    if listen in [canonical_ip(a) for a in addresses]:
        return "--listen %s is also an advertised address, so LAN devices could reach the control API" % listen_host
    if default_route is not None and listen == canonical_ip(default_route):
        return "--listen %s is this host's default-route (LAN) address, so LAN devices could reach the control API" % listen_host
    return None


class SecretError(Exception):
    pass


def load_or_create_secret(path):
    path = Path(path)
    min_len = PROTOCOL["minSecretLength"]
    try:
        secret = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        os.makedirs(str(path.parent), mode=0o700, exist_ok=True)
        secret = secrets.token_urlsafe(32)
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(secret + "\n")
        return secret
    if len(secret) < min_len:
        raise SecretError("the secret in %s is shorter than %d characters" % (path, min_len))
    return secret


def bearer_ok(header, secret):
    """Constant-time check of an `Authorization: Bearer <secret>` header."""
    if not header:
        return False
    scheme, _, value = header.strip().partition(" ")
    if scheme.lower() != "bearer":
        return False
    given = hashlib.sha256(value.strip().encode("utf-8")).digest()
    expected = hashlib.sha256(secret.encode("utf-8")).digest()
    return hmac.compare_digest(given, expected)


class BadRequest(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


async def read_request(reader):
    """(method, path, headers, body) of one HTTP/1.1 request."""
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEAD_TIMEOUT_S)
    except asyncio.LimitOverrunError:
        raise BadRequest(413, "request head too large")
    except asyncio.TimeoutError:
        raise BadRequest(400, "request head timed out")
    lines = head.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
        raise BadRequest(400, "malformed request line")
    method, target = parts[0], parts[1]
    headers = {}
    for line in lines[1:]:
        if not line:
            continue
        name, sep, value = line.partition(":")
        if not sep:
            raise BadRequest(400, "malformed header line")
        headers[name.strip().lower()] = value.strip()
    if "transfer-encoding" in headers:
        raise BadRequest(400, "Transfer-Encoding is not supported; send Content-Length")
    length = headers.get("content-length", "0")
    if not length.isdigit():
        raise BadRequest(400, "bad Content-Length")
    if int(length) > MAX_BODY_BYTES:
        raise BadRequest(413, "request body too large")
    body = b""
    if int(length):
        body = await asyncio.wait_for(reader.readexactly(int(length)), HEAD_TIMEOUT_S)
    return method, target.split("?", 1)[0], headers, body


async def respond(writer, status, body=None):
    head = "HTTP/1.1 %d %s\r\nConnection: close\r\n" % (status, REASONS[status])
    payload = b""
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        head += "Content-Type: application/json\r\n"
    if status != 204:
        head += "Content-Length: %d\r\n" % len(payload)
    writer.write(head.encode("latin-1") + b"\r\n" + payload)
    try:
        await writer.drain()
    finally:
        writer.close()


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


class Parked:
    """A parked accept: an upgraded control connection waiting for a LAN client."""

    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.watcher = None


class Forward:
    def __init__(self, relay, fid, port, addresses):
        self.relay = relay
        self.id = fid
        self.port = port
        self.addresses = addresses
        self.servers = []
        self.parked = deque()
        self.waiters = deque()
        self.writers = set()
        self.tasks = set()
        self.lease = None
        self.closed = False

    async def start(self, socks):
        for sock in socks:
            self.servers.append(await asyncio.start_server(self._on_lan, sock=sock))
        self.renew()

    def renew(self):
        if self.lease is not None:
            self.lease.cancel()
        loop = asyncio.get_running_loop()
        self.lease = loop.call_later(self.relay.lease_ms / 1000.0, self._expire)

    def _expire(self):
        log("forward %s on port %d expired (lease not renewed)" % (self.id, self.port))
        self.relay.drop(self.id)

    def _task(self, coro):
        task = asyncio.get_running_loop().create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def close(self):
        """Release everything synchronously: listeners, parked, queued and spliced connections."""
        if self.closed:
            return
        self.closed = True
        if self.lease is not None:
            self.lease.cancel()
        for server in self.servers:
            server.close()
        for writer in list(self.writers):
            writer.transport.abort()
        self.writers.clear()
        for task in list(self.tasks):
            task.cancel()
        while self.waiters:
            fut = self.waiters.popleft()
            if not fut.done():
                fut.set_result(None)
        self.parked.clear()

    # --- parked accepts ---------------------------------------------------

    def park(self, reader, writer):
        """Hold an upgraded control connection until a LAN client needs it. False = cap reached."""
        if len(self.parked) >= MAX_PARKED_PER_FORWARD:
            return False
        p = Parked(reader, writer)
        self.writers.add(writer)
        set_keepalive(writer)
        # Any byte or EOF from a parked accept means its client vanished or
        # broke protocol: it is dropped. Cancelling this read consumes nothing.
        p.watcher = self._task(reader.read(1))
        p.watcher.add_done_callback(lambda t: self._parked_died(p, t))
        while self.waiters:
            fut = self.waiters.popleft()
            if not fut.done():
                fut.set_result(p)
                return True
        self.parked.append(p)
        return True

    def _parked_died(self, p, task):
        if task.cancelled():
            return
        if p in self.parked:
            self.parked.remove(p)
        self.writers.discard(p.writer)
        p.writer.transport.abort()

    def _take_parked(self):
        while self.parked:
            p = self.parked.popleft()
            if not p.watcher.done():
                return p
        return None

    async def _claim(self, p):
        """Stop watching `p` before splicing it. False when it died meanwhile."""
        p.watcher.cancel()
        await asyncio.wait([p.watcher])
        return p.watcher.cancelled()

    # --- LAN side -----------------------------------------------------------

    async def _on_lan(self, reader, writer):
        if self.closed:
            writer.transport.abort()
            return
        self.writers.add(writer)
        loop = asyncio.get_running_loop()
        while True:
            p = self._take_parked()
            if p is None:
                if len(self.waiters) >= MAX_QUEUED_PER_FORWARD:
                    break
                fut = loop.create_future()
                self.waiters.append(fut)
                try:
                    p = await asyncio.wait_for(fut, self.relay.accept_wait_ms / 1000.0)
                except asyncio.TimeoutError:
                    p = None
                finally:
                    if fut in self.waiters:
                        self.waiters.remove(fut)
                if p is None:
                    break
            if self.closed:
                break
            if await self._claim(p):
                await self._splice(reader, writer, p)
                return
        self.writers.discard(writer)
        writer.transport.abort()

    async def _splice(self, lan_reader, lan_writer, p):
        set_keepalive(lan_writer)
        p.writer.write(
            ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: %s\r\nConnection: Upgrade\r\n\r\n" % UPGRADE_TOKEN).encode("latin-1"))
        up = self._task(pump(lan_reader, p.writer, lan_writer))
        down = self._task(pump(p.reader, lan_writer, p.writer))
        try:
            await asyncio.gather(up, down, return_exceptions=True)
        finally:
            for w in (lan_writer, p.writer):
                self.writers.discard(w)
                w.close()


class Relay:
    def __init__(self, secret, advertise, listen_host, lease_ms, accept_wait_ms, probe=default_route_ipv4):
        self.secret = secret
        self.advertise = advertise
        self.listen_host = listen_host
        self.lease_ms = lease_ms
        self.accept_wait_ms = accept_wait_ms
        self.probe = probe
        self.forwards = {}
        self.routes = [(name, self._pattern(PATHS[name])) for name in ("health", "forwards", "renew", "accept", "forward")]

    @staticmethod
    def _pattern(template):
        return re.compile("^" + "([A-Za-z0-9_-]+)".join(re.escape(part) for part in template.split("{id}")) + "$")

    def addresses(self):
        return resolve_addresses(self.advertise, self.listen_host, self.probe)

    def drop(self, fid):
        fwd = self.forwards.pop(fid, None)
        if fwd is not None:
            fwd.close()
        return fwd

    def close(self):
        for fid in list(self.forwards):
            self.drop(fid)

    async def handle(self, reader, writer):
        try:
            try:
                method, path, headers, body = await read_request(reader)
            except BadRequest as e:
                await respond(writer, e.status, {"error": str(e)})
                return
            except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError):
                writer.transport.abort()
                return
            if not bearer_ok(headers.get("authorization"), self.secret):
                await respond(writer, 401)
                return
            await self._dispatch(method, path, headers, body, reader, writer)
        except Exception as e:  # never let one connection take the relay down
            log("control request failed: %r" % (e,))
            writer.transport.abort()

    async def _dispatch(self, method, path, headers, body, reader, writer):
        for name, pattern in self.routes:
            m = pattern.match(path)
            if m:
                break
        else:
            await respond(writer, 404, {"error": "no such endpoint"})
            return
        want = {"health": "GET", "forwards": "POST", "renew": "POST", "accept": "GET", "forward": "DELETE"}[name]
        if method != want:
            await respond(writer, 405, {"error": "use %s" % want})
            return
        if name == "health":
            addresses, _ = self.addresses()
            await respond(writer, 200, {
                "ok": True, "protocol": PROTOCOL["protocolVersion"], "addresses": addresses,
                "leaseMs": self.lease_ms, "forwards": len(self.forwards),
                "parked": sum(len(f.parked) for f in self.forwards.values()),
            })
            return
        if name == "forwards":
            await self._create(body, writer)
            return
        fwd = self.forwards.get(m.group(1))
        if fwd is None:
            await respond(writer, 404, {"error": "unknown or expired forward"})
            return
        if name == "renew":
            fwd.renew()
            await respond(writer, 200, {"leaseMs": self.lease_ms})
        elif name == "forward":
            self.drop(fwd.id)
            log("forward %s on port %d closed" % (fwd.id, fwd.port))
            await respond(writer, 204)
        else:
            if headers.get("upgrade", "").lower() != UPGRADE_TOKEN.lower():
                await respond(writer, 400, {"error": "expected Upgrade: %s" % UPGRADE_TOKEN})
            elif not fwd.park(reader, writer):
                await respond(writer, 429, {"error": "too many parked accepts on this forward"})

    async def _create(self, body, writer):
        try:
            req = json.loads(body.decode("utf-8")) if body else {}
        except ValueError:
            req = None
        if not isinstance(req, dict):
            await respond(writer, 400, {"error": "body must be a JSON object"})
            return
        extra = sorted(set(req) - set(PROTOCOL["createKeys"]))
        if extra:
            await respond(writer, 400, {"error": "unknown keys: %s" % ", ".join(extra)})
            return
        port = req.get("port", 0)
        lo, hi = PROTOCOL["port"]["min"], PROTOCOL["port"]["max"]
        if "port" in req and (type(port) is not int or not lo <= port <= hi):
            await respond(writer, 400, {"error": "port must be an integer from %d to %d" % (lo, hi)})
            return
        if len(self.forwards) >= MAX_FORWARDS:
            await respond(writer, 429, {"error": "too many forwards"})
            return
        addresses, problem = self.addresses()
        if problem:
            await respond(writer, 503, {"code": ERROR_CODES["noLanAddress"], "error": "no LAN address to advertise (%s)" % problem})
            return
        try:
            socks, bound = bind_all(addresses, port)
        except OSError as e:
            if is_addr_in_use(e):
                await respond(writer, 409, {"code": ERROR_CODES["portInUse"], "error": "port %d is in use on the host" % port})
            else:
                await respond(writer, 500, {"error": "bind failed: %s" % (e.strerror or e)})
            return
        fid = secrets.token_urlsafe(18)
        fwd = Forward(self, fid, bound, addresses)
        self.forwards[fid] = fwd
        try:
            await fwd.start(socks)
        except Exception as e:
            self.drop(fid)
            for sock in socks:
                sock.close()
            await respond(writer, 500, {"error": "could not serve the forward: %s" % e})
            return
        log("forward %s open on %s port %d" % (fid, ",".join(addresses), bound))
        await respond(writer, 201, {
            "id": fid, "port": bound, "addresses": addresses,
            "leaseMs": self.lease_ms, "protocol": PROTOCOL["protocolVersion"],
        })


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="relay.py",
        description="Expose a containerised code-hub's LAN share on this host's LAN address.")
    parser.add_argument("--listen", default=DEFAULT_LISTEN, metavar="IP:PORT",
                        help="control listener code-hub dials (default %(default)s)")
    parser.add_argument("--advertise", metavar="IP[,IP...]",
                        help="host LAN address(es) to expose shares on (default: the default-route IPv4)")
    parser.add_argument("--secret-file", default=str(DEFAULT_SECRET_FILE), metavar="PATH",
                        help="bearer secret, created on first run (default %(default)s)")
    parser.add_argument("--lease-ms", type=int, default=DEFAULT_LEASE_MS, metavar="N",
                        help="forward lifetime without renewal (default %(default)s)")
    parser.add_argument("--accept-wait-ms", type=int, default=DEFAULT_ACCEPT_WAIT_MS, metavar="N",
                        help="how long a LAN connection waits for a parked accept (default %(default)s)")
    args = parser.parse_args(argv)
    try:
        args.listen_host, args.listen_port = parse_ip_port(args.listen)
    except ValueError as e:
        parser.error("--listen: %s" % e)
    if args.advertise is not None:
        ips = [ip.strip() for ip in args.advertise.split(",") if ip.strip()]
        for ip in ips:
            try:
                addr = ipaddress.IPv4Address(ip)
            except ValueError:
                parser.error("--advertise: %r is not an IPv4 address" % ip)
            if addr in THIS_NETWORK:
                parser.error("--advertise: %s is a wildcard address" % ip)
        if not ips:
            parser.error("--advertise: no address given")
        args.advertise = ips
    if args.lease_ms < MIN_LEASE_MS:
        parser.error("--lease-ms must be at least %d" % MIN_LEASE_MS)
    if args.accept_wait_ms < 1:
        parser.error("--accept-wait-ms must be positive")
    return args


async def serve(args, secret, addresses):
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    relay = Relay(secret, args.advertise, args.listen_host, args.lease_ms, args.accept_wait_ms)
    sock = bind_listener(args.listen_host, args.listen_port)
    server = await asyncio.start_server(relay.handle, sock=sock, limit=MAX_HEAD_BYTES)
    host, port = sock.getsockname()[:2]

    def on_signal(signum, frame):
        loop.call_soon_threadsafe(stop.set)

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), on_signal)

    print("code-hub-relay listening on %s:%d" % (host, port), flush=True)
    log("advertising %s; forwards expire %d ms after their last renewal" % (", ".join(addresses), args.lease_ms))
    log("secret file: %s" % args.secret_file)
    log("in code-hub's environment set CODEHUB_RELAY_URL=http://host.docker.internal:%d "
        "and CODEHUB_RELAY_SECRET=<the contents of the secret file>" % port)
    await stop.wait()
    log("shutting down")
    server.close()
    relay.close()
    await server.wait_closed()


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    problem = control_listen_problem(args.listen_host, [])
    if problem:
        sys.exit("code-hub-relay: " + problem)
    try:
        ipaddress.IPv4Address(args.listen_host)
    except ValueError:
        sys.exit("code-hub-relay: --listen host must be an IPv4 address, got %r" % args.listen_host)
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
        sys.exit("code-hub-relay: no LAN address to advertise (%s) — pass --advertise <ip>" % problem)
    problem = control_listen_problem(args.listen_host, addresses, route)
    if problem:
        sys.exit("code-hub-relay: " + problem)
    try:
        secret = load_or_create_secret(args.secret_file)
    except (SecretError, OSError) as e:
        sys.exit("code-hub-relay: %s" % e)
    try:
        asyncio.run(serve(args, secret, addresses))
    except OSError as e:
        sys.exit("code-hub-relay: cannot listen on %s: %s" % (args.listen, e.strerror or e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
