"""Unit tests for relay/relay.py. Standard library only; run from npm test via
tests/relayPython.test.mjs, or directly: python3 -m unittest discover -s tests/python -v
"""

import ast
import asyncio
import ipaddress
import json
import os
import socket
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

RELAY_DIR = Path(__file__).resolve().parents[2] / "relay"
sys.path.insert(0, str(RELAY_DIR))

import relay  # noqa: E402

SOURCE = (RELAY_DIR / "relay.py").read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)
PROTOCOL = json.loads((RELAY_DIR / "protocol.json").read_text(encoding="utf-8"))


REAL_IPV4 = ipaddress.IPv4Address


def lenient_ipv4(value):
    """IPv4Address as Python 3.9.0-3.9.4 parse it: leading-zero octets read as
    decimal (where the C library's bind reads them as octal)."""
    if isinstance(value, str):
        value = ".".join(str(int(part)) for part in value.split("."))
    return REAL_IPV4(value)


def protocol_ids(protocol):
    """Every protocol identifier a source file must read rather than restate."""
    ids = set(protocol["paths"].values()) | set(protocol["errorCodes"].values())
    ids.add(protocol["upgradeToken"])
    return ids


def docstring_nodes(tree):
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                found.add(id(first.value))
    return found


def restatements(tree, ids):
    """(line, member) for every str literal (f-string parts included, docstrings
    excluded) that contains a protocol identifier."""
    skip = docstring_nodes(tree)
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip:
            for member in sorted(ids):
                if member in node.value:
                    hits.append((getattr(node, "lineno", 0), member))
    return hits


def function_named(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError("no function %s" % name)


def calls(tree):
    return [n for n in ast.walk(tree) if isinstance(n, ast.Call)]


def call_name(call):
    f = call.func
    if isinstance(f, ast.Attribute):
        return f.attr
    if isinstance(f, ast.Name):
        return f.id
    return None


class IpProblem(unittest.TestCase):
    # P1 — the probe exclusions.
    def test_rejects_non_lan_addresses(self):
        for ip in ("127.0.0.1", "169.254.1.1", "0.0.0.0", "224.0.0.1", "100.100.1.1", "172.17.0.1", "240.0.0.1"):
            self.assertIsNotNone(relay.ip_problem(ip), ip)
        self.assertEqual(relay.ip_problem("240.0.0.1"), "reserved")
        self.assertIsNotNone(relay.ip_problem("192.168.1.20", "192.168.1.20"), "the listen address")

    def test_accepts_lan_addresses(self):
        for ip in ("192.168.1.20", "10.0.0.5", "172.20.0.5"):
            self.assertIsNone(relay.ip_problem(ip, "127.0.0.1"), ip)


class ControlListenProblem(unittest.TestCase):
    # P2 — the control listener is never LAN-reachable; the loopback exemption is exactly scoped.
    def test_refuses_wildcards(self):
        for host in ("0.0.0.0", "::", ""):
            self.assertIsNotNone(relay.control_listen_problem(host, []), repr(host))
            self.assertIsNotNone(relay.control_listen_problem(host, ["192.168.1.20"]), repr(host))

    def test_refuses_non_loopback_listen_equal_to_advertised(self):
        self.assertIsNotNone(relay.control_listen_problem("192.168.1.20", ["192.168.1.20"]))
        self.assertIsNotNone(relay.control_listen_problem("172.17.0.1", ["10.0.0.5", "172.17.0.1"]))

    def test_accepts_loopback_and_distinct_addresses(self):
        self.assertIsNone(relay.control_listen_problem("127.0.0.1", ["127.0.0.1"]))
        self.assertIsNone(relay.control_listen_problem("127.0.0.1", ["192.168.1.20"]))
        self.assertIsNone(relay.control_listen_problem("172.17.0.1", ["192.168.1.20"]))
        self.assertIsNone(relay.control_listen_problem("172.17.0.1", ["192.168.1.20"], "192.168.1.20"))
        self.assertIsNone(relay.control_listen_problem("127.0.0.1", ["127.0.0.1"], "127.0.0.1"), "loopback stays exempt")
        self.assertIsNone(relay.control_listen_problem("172.17.0.1", ["10.0.0.5"], None), "no probe answer adds nothing")

    def test_refuses_non_loopback_listen_equal_to_the_default_route(self):
        self.assertIsNotNone(relay.control_listen_problem("192.168.1.20", ["10.0.0.5"], "192.168.1.20"))

    def test_compares_canonical_spellings(self):
        # Emulate the 3.9.0-3.9.4 parser, so the guard is shown to compare
        # canonical forms, not raw strings.
        with mock.patch.object(relay.ipaddress, "IPv4Address", lenient_ipv4):
            self.assertIsNotNone(relay.control_listen_problem("192.168.001.020", ["192.168.1.20"]))
            self.assertIsNotNone(relay.control_listen_problem("192.168.1.20", ["10.0.0.5"], "192.168.01.20"))

    # Item 1 — every address is canonicalised once in parse_args, and that
    # canonical string is what the guard checks AND what every bind receives.
    def test_padded_spellings_are_canonical_for_guard_and_bind(self):
        bound = []

        def record_and_stop(host, port):
            bound.append(host)
            raise RuntimeError("stop before serving")

        def record_and_fail(host, port):
            bound.append(host)
            raise OSError(99, "not here")

        with mock.patch.object(relay.ipaddress, "IPv4Address", lenient_ipv4), \
                tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(relay, "log"), \
                mock.patch.object(relay, "default_route_ipv4", side_effect=OSError("no route")):
            secret = ["--secret-file", str(Path(tmp) / "secret")]
            # A padded wildcard is the wildcard, refused before any bind.
            self.assertEqual(relay.parse_args(["--listen", "000.000.000.000:7077"]).listen_host, "0.0.0.0")
            with mock.patch.object(relay, "bind_listener", side_effect=AssertionError("bound a socket")):
                with self.assertRaises(SystemExit) as caught:
                    relay.main(["--listen", "000.000.000.000:0", "--advertise", "10.0.0.5"] + secret)
            self.assertIn("wildcard", str(caught.exception.code))
            # A padded advertise is canonical in the args, and so in the guard.
            args = relay.parse_args(["--listen", "127.000.000.001:0", "--advertise", "010.0.0.5"])
            self.assertEqual((args.listen_host, args.advertise), ("127.0.0.1", ["10.0.0.5"]))
            # The control listener binds the canonical listen address...
            with mock.patch.object(relay, "bind_listener", record_and_stop), self.assertRaises(RuntimeError):
                relay.main(["--listen", "127.000.000.001:0", "--advertise", "010.0.0.5"] + secret)
            self.assertEqual(bound, ["127.0.0.1"])
            # ...and a forward binds the canonical advertised address.
            bound.clear()
            writer = FakeWriter()
            with mock.patch.object(relay, "bind_listener", record_and_fail):
                asyncio.run(make_relay(advertise=args.advertise)._create(b"{}", writer))
            self.assertEqual(bound, ["10.0.0.5"])
            self.assertEqual(writer.status(), 500)

    def test_main_refuses_the_default_route_before_binding(self):
        # Process-level wiring, host-independent: the probe is stubbed and any
        # listening socket would fail the test.
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(relay, "default_route_ipv4", lambda dest=None: "192.168.1.20"), \
                mock.patch.object(relay, "bind_listener", side_effect=AssertionError("bound a socket")):
            with self.assertRaises(SystemExit) as caught:
                relay.main(["--listen", "192.168.1.20:0", "--advertise", "10.0.0.5",
                            "--secret-file", str(Path(tmp) / "secret")])
        self.assertIn("default-route", str(caught.exception.code))


class RouteProbe(unittest.TestCase):
    # P3 — the probe is not outbound traffic: it sends no datagram.
    def test_probe_sends_nothing(self):
        sink = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.addCleanup(sink.close)
        sink.bind(("127.0.0.1", 0))
        port = sink.getsockname()[1]
        ip = relay.default_route_ipv4(dest=("127.0.0.1", port))
        self.assertEqual(ip, "127.0.0.1")
        self.assertEqual(relay.ip_problem(ip), "loopback")
        sink.settimeout(0.2)
        with self.assertRaises(socket.timeout):
            sink.recvfrom(64)


class StaticShape(unittest.TestCase):
    # P4 — runs with no pip install: every import is standard library.
    def test_stdlib_only(self):
        if not hasattr(sys, "stdlib_module_names"):
            self.skipTest("sys.stdlib_module_names needs Python 3.10+")
        for node in ast.walk(TREE):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            for name in names:
                self.assertIn(name.split(".")[0], sys.stdlib_module_names, name)

    # P5 — the relay never dials out and terminates nothing.
    def test_only_connect_is_the_udp_probe(self):
        connects = [c for c in calls(TREE) if isinstance(c.func, ast.Attribute) and c.func.attr == "connect"]
        self.assertEqual(len(connects), 1)
        probe = function_named(TREE, "default_route_ipv4")
        self.assertIn(connects[0], calls(probe))
        dgram = [c for c in calls(probe) if call_name(c) == "socket"
                 and any(isinstance(a, ast.Attribute) and a.attr == "SOCK_DGRAM" for a in c.args)]
        self.assertEqual(len(dgram), 1, "the probe socket is SOCK_DGRAM")
        for c in calls(probe):
            self.assertNotIn(call_name(c), ("send", "sendto", "sendall"))
        forbidden = {"connect_ex", "create_connection", "open_connection", "open_unix_connection",
                     "sock_connect", "create_datagram_endpoint"}
        for c in calls(TREE):
            self.assertNotIn(call_name(c), forbidden)
        banned = ("urllib", "http", "ftplib", "smtplib", "xmlrpc", "socketserver", "ssl")
        for node in ast.walk(TREE):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            for name in names:
                self.assertNotIn(name.split(".")[0], banned, name)

    # P6 — the Python 3.9 floor holds (checked statically).
    def test_python_floor(self):
        ast.parse(SOURCE, feature_version=(3, 7))
        for kind in ("Match", "TryStar"):
            cls = getattr(ast, kind, None)
            if cls is not None:
                self.assertFalse(any(isinstance(n, cls) for n in ast.walk(TREE)), kind)
        for node in ast.walk(TREE):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "asyncio":
                self.assertNotIn(node.attr, ("timeout", "TaskGroup"))
            if isinstance(node, ast.Call) and call_name(node) == "zip":
                self.assertFalse(any(k.arg == "strict" for k in node.keywords), "zip(strict=)")
        annotations = []
        for node in ast.walk(TREE):
            if isinstance(node, ast.arg) and node.annotation is not None:
                annotations.append(node.annotation)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.returns is not None:
                annotations.append(node.returns)
            if isinstance(node, ast.AnnAssign):
                annotations.append(node.annotation)
        for ann in annotations:
            for n in ast.walk(ann):
                self.assertFalse(isinstance(n, ast.BinOp) and isinstance(n.op, ast.BitOr), "X | Y annotation")


class ParseArgs(unittest.TestCase):
    # Item 4 — --lease-ms is bounded by protocol.json's maxLeaseMs.
    def test_lease_ms_bounded(self):
        self.assertEqual(relay.parse_args(["--lease-ms", str(PROTOCOL["maxLeaseMs"])]).lease_ms, PROTOCOL["maxLeaseMs"])
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            relay.parse_args(["--lease-ms", str(PROTOCOL["maxLeaseMs"] + 1)])

    # --advertise takes at most protocol.json's maxAddresses addresses.
    def test_advertise_count_bounded(self):
        many = ",".join("10.0.0.%d" % i for i in range(1, PROTOCOL["maxAddresses"] + 2))
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            relay.parse_args(["--advertise", many])

    # --advertise refuses a wildcard (0.0.0.0/8) address.
    def test_advertise_wildcard_refused(self):
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            relay.parse_args(["--advertise", "0.0.0.0"])
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            relay.parse_args(["--advertise", "192.168.1.20,0.0.0.0"])


class ConstantTimeBearer(unittest.TestCase):
    # P9 — the bearer check hashes both sides with sha256, compares with
    # hmac.compare_digest, and never compares the supplied value with ==/!=.
    def test_bearer_ok_shape(self):
        fn = function_named(TREE, "bearer_ok")
        sha = [c for c in calls(fn) if isinstance(c.func, ast.Attribute) and c.func.attr == "sha256"
               and isinstance(c.func.value, ast.Name) and c.func.value.id == "hashlib"]
        self.assertEqual(len(sha), 2, "both sides hashed")
        digest = [c for c in calls(fn) if isinstance(c.func, ast.Attribute) and c.func.attr == "compare_digest"
                  and isinstance(c.func.value, ast.Name) and c.func.value.id == "hmac"]
        self.assertEqual(len(digest), 1)
        secret_names = {"value", "given", "expected", "secret", "header"}
        for node in ast.walk(fn):
            if isinstance(node, ast.Compare) and any(isinstance(op, (ast.Eq, ast.NotEq, ast.Is, ast.IsNot)) for op in node.ops):
                for part in [node.left] + node.comparators:
                    names = {n.id for n in ast.walk(part) if isinstance(n, ast.Name)}
                    self.assertFalse(names & secret_names, "compared with ==/!= at line %d" % node.lineno)
        self.assertTrue(relay.bearer_ok("Bearer " + "s" * 40, "s" * 40))
        self.assertFalse(relay.bearer_ok("Bearer " + "s" * 39, "s" * 40))


class FakeWriter:
    def __init__(self):
        self.data = b""
        self.closed = False

    def write(self, data):
        self.data += data

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    def status(self):
        return int(self.data.split(b" ", 2)[1])

    def body(self):
        return json.loads(self.data.split(b"\r\n\r\n", 1)[1])


def make_relay(**over):
    opts = dict(secret="s" * 40, advertise=["127.0.0.1"], listen_host="127.0.0.1", lease_ms=1000, accept_wait_ms=100)
    opts.update(over)
    return relay.Relay(**opts)


class Create(unittest.TestCase):
    # A create whose fresh probe yields no LAN address answers 503 no_lan_address.
    def test_no_lan_address_at_create_time(self):
        r = make_relay(advertise=None, probe=lambda: "127.0.0.1")
        writer = FakeWriter()
        asyncio.run(r._create(b"{}", writer))
        self.assertEqual(writer.status(), 503)
        self.assertEqual(writer.body()["code"], PROTOCOL["errorCodes"]["noLanAddress"])
        self.assertIn("loopback", writer.body()["error"])
        self.assertEqual(r.forwards, {})

    # A5 — a forward that fails to start is dropped and its sockets closed.
    def test_failed_start_rolls_back(self):
        r = make_relay()
        bound = []
        real_bind_all = relay.bind_all

        def recording_bind_all(addresses, port):
            socks, port = real_bind_all(addresses, port)
            bound.extend(socks)
            return socks, port

        async def failing_start(self, socks):
            raise RuntimeError("boom")

        writer = FakeWriter()
        with mock.patch.object(relay, "bind_all", recording_bind_all), \
                mock.patch.object(relay.Forward, "start", failing_start), \
                mock.patch.object(relay, "log"):
            asyncio.run(r._create(b"{}", writer))
        self.assertEqual(writer.status(), 500)
        self.assertEqual(r.forwards, {})
        self.assertTrue(bound)
        for sock in bound:
            self.assertEqual(sock.fileno(), -1, "socket closed")


class ForwardClose(unittest.TestCase):
    # Item 3 — dropping a forward (DELETE or lease expiry) stops its listeners
    # serving, closes their sockets, and aborts its parked accepts.
    def run_drop(self, finish):
        async def scenario():
            r = make_relay(lease_ms=60000)
            socks, port = relay.bind_all(["127.0.0.1"], 0)
            fwd = relay.Forward(r, "fid", port, ["127.0.0.1"])
            r.forwards["fid"] = fwd
            await fwd.start(socks)
            accepted = asyncio.get_running_loop().create_future()

            async def on_conn(reader, writer):
                accepted.set_result((reader, writer))

            control = await asyncio.start_server(on_conn, "127.0.0.1", 0)
            peer_reader, peer_writer = await asyncio.open_connection(*control.sockets[0].getsockname()[:2])
            reader, writer = await accepted
            self.assertTrue(fwd.park(reader, writer))
            self.assertTrue(all(server.is_serving() for server in fwd.servers))

            await finish(r, fwd)

            self.assertNotIn("fid", r.forwards)
            self.assertTrue(fwd.servers)
            for server in fwd.servers:
                self.assertFalse(server.is_serving())
            for sock in socks:
                self.assertEqual(sock.fileno(), -1, "listener socket closed")
            self.assertTrue(writer.transport.is_closing(), "parked accept aborted")
            try:
                tail = await asyncio.wait_for(peer_reader.read(), 2)
            except ConnectionResetError:
                tail = b""
            self.assertEqual(tail, b"", "the parked peer sees the connection end")
            peer_writer.close()
            control.close()

        with mock.patch.object(relay, "log"):
            asyncio.run(scenario())

    def test_delete(self):
        async def delete(r, fwd):
            writer = FakeWriter()
            await r._dispatch("DELETE", relay.PATHS["forward"].replace("{id}", "fid"), {}, b"", None, writer)
            self.assertEqual(writer.status(), 204)

        self.run_drop(delete)

    def test_expiry(self):
        async def expire(r, fwd):
            fwd._expire()

        self.run_drop(expire)


class Lease(unittest.TestCase):
    # B14 — the lease is exactly lease_ms, and a renewal cancels and reschedules it.
    def test_renew_schedules_lease_ms(self):
        delays, handles = [], []

        class Handle:
            def __init__(self):
                self.cancelled = False

            def cancel(self):
                self.cancelled = True

        class Loop:
            def call_later(self, delay, fn):
                delays.append(delay)
                handles.append(Handle())
                return handles[-1]

        fwd = relay.Forward(make_relay(lease_ms=1234), "fid", 5000, ["127.0.0.1"])
        with mock.patch.object(relay.asyncio, "get_running_loop", lambda: Loop()):
            fwd.renew()
            fwd.renew()
        self.assertEqual(delays, [1.234, 1.234])
        self.assertEqual([h.cancelled for h in handles], [True, False])


class Restatement(unittest.TestCase):
    # P7 — protocol identifiers have a single source (protocol.json).
    def test_scanner_flags_planted_restatements(self):
        planted = ast.parse('def f(fid, port):\n    """Docs may name /v1/forwards."""\n'
                            '    a = "/v1/forwards/" + fid\n    b = "port_in_use"\n'
                            '    c = f"x{fid}code-hub-relay/1"\n    return {"port": port}\n')
        hits = restatements(planted, protocol_ids(PROTOCOL))
        self.assertEqual(sorted(m for _, m in hits), ["/v1/forwards", "code-hub-relay/1", "port_in_use"])

    def test_relay_restates_no_identifier(self):
        hits = restatements(TREE, protocol_ids(PROTOCOL))
        self.assertEqual(hits, [], "restated in relay.py (line, identifier): %r" % hits)


class Secret(unittest.TestCase):
    # P8 — provisioning: 0600 file in a 0700 dir, reused, short secrets refused.
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_created_then_reused(self):
        path = Path(self.tmp.name) / "fresh" / "secret"
        first = relay.load_or_create_secret(path)
        self.assertGreaterEqual(len(first), PROTOCOL["minSecretLength"])
        self.assertEqual(relay.load_or_create_secret(path), first)
        if sys.platform == "win32":
            self.skipTest("POSIX modes are not enforced on NTFS")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(path.parent).st_mode), 0o700)

    def test_short_secret_refused(self):
        path = Path(self.tmp.name) / "secret"
        path.write_text("too-short\n", encoding="utf-8")
        with self.assertRaises(relay.SecretError):
            relay.load_or_create_secret(path)


if __name__ == "__main__":
    unittest.main()
