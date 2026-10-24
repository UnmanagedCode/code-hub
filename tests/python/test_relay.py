"""Unit tests for relay/relay.py. Standard library only; run from npm test via
tests/relayPython.test.mjs, or directly: python3 -m unittest discover -s tests/python -v
"""

import ast
import json
import os
import socket
import stat
import sys
import tempfile
import unittest
from pathlib import Path

RELAY_DIR = Path(__file__).resolve().parents[2] / "relay"
sys.path.insert(0, str(RELAY_DIR))

import relay  # noqa: E402

SOURCE = (RELAY_DIR / "relay.py").read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)
PROTOCOL = json.loads((RELAY_DIR / "protocol.json").read_text(encoding="utf-8"))


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
        for ip in ("127.0.0.1", "169.254.1.1", "0.0.0.0", "224.0.0.1", "100.100.1.1", "172.17.0.1"):
            self.assertIsNotNone(relay.ip_problem(ip), ip)
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
