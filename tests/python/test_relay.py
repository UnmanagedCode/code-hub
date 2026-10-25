"""Unit tests for relay/relay.py. Standard library only; run from npm test via
tests/relayPython.test.mjs, or directly: python3 -m unittest discover -s tests/python -v
"""

import ast
import asyncio
import io
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
SCOPES = PROTOCOL["scopes"]
FRAMES = PROTOCOL["frames"]
ERROR_CODES = PROTOCOL["errorCodes"]
LABELS = PROTOCOL["macLabels"]
RDV = PROTOCOL["rendezvous"]


REAL_IPV4 = ipaddress.IPv4Address


def lenient_ipv4(value):
    """IPv4Address as Python 3.9.0-3.9.4 parse it: leading-zero octets read as
    decimal (where the C library's bind reads them as octal)."""
    if isinstance(value, str):
        value = ".".join(str(int(part)) for part in value.split("."))
    return REAL_IPV4(value)


def protocol_ids(protocol):
    """Every protocol identifier a source file must read rather than restate."""
    ids = set()
    for group in ("frames", "roles", "scopes", "macLabels", "errorCodes", "rendezvous"):
        ids |= set(protocol[group].values())
    return ids


def is_word(ident):
    return ident.isalpha() and ident.islower()


def docstring_nodes(tree):
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                found.add(id(first.value))
    return found


def exempt_nodes(tree):
    """Docstrings, dict-display keys and subscript keys: a frame's own key names
    (`{"ports": ...}`, `msg["ports"]`) and reads of protocol.json are not restatements."""
    found = docstring_nodes(tree)
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            found |= {id(k) for k in node.keys if k is not None}
        if isinstance(node, ast.Subscript):
            key = node.slice
            index = getattr(ast, "Index", None)  # Python < 3.9 wraps the key
            if index is not None and isinstance(key, index):
                key = key.value
            found.add(id(key))
    return found


def restatements(tree, ids):
    """(line, member) for every str literal (f-string parts included) that equals
    a protocol identifier — or, for one that isn't a plain word (an error code,
    a label, a file name), contains it."""
    skip = exempt_nodes(tree)
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip:
            for member in sorted(ids):
                if node.value == member or (not is_word(member) and member in node.value):
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

    # Every address is canonicalised once in parse_args, and that canonical
    # string is what the guard checks AND what every bind receives.
    def test_padded_spellings_are_canonical_for_guard_and_bind(self):
        bound = []

        def record_and_stop(host, port):
            bound.append(host)
            raise RuntimeError("stop before serving")

        def record_and_fail(addresses, port):
            bound.extend(addresses)
            raise OSError(99, "not here")

        with mock.patch.object(relay.ipaddress, "IPv4Address", lenient_ipv4), \
                tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(relay, "log"), \
                mock.patch.object(relay, "default_route_ipv4", side_effect=OSError("no route")):
            os.mkdir(os.path.join(tmp, ".code-hub"))
            root = ["--projects-root", tmp]
            # A padded wildcard is the wildcard, refused before any bind.
            self.assertEqual(relay.parse_args(["--listen", "000.000.000.000:7077"]).listen_host, "0.0.0.0")
            with mock.patch.object(relay, "bind_listener", side_effect=AssertionError("bound a socket")):
                with self.assertRaises(SystemExit) as caught:
                    relay.main(["--listen", "000.000.000.000:0", "--advertise", "10.0.0.5"] + root)
            self.assertIn("wildcard", str(caught.exception.code))
            # A padded advertise is canonical in the args, and so in the guard.
            args = relay.parse_args(["--listen", "127.000.000.001:0", "--advertise", "010.0.0.5"])
            self.assertEqual((args.listen_host, args.advertise), ("127.0.0.1", ["10.0.0.5"]))
            # The control listener binds the canonical listen address...
            with mock.patch.object(relay, "bind_listener", record_and_stop), self.assertRaises(RuntimeError):
                relay.main(["--listen", "127.000.000.001:0", "--advertise", "010.0.0.5"] + root)
            self.assertEqual(bound, ["127.0.0.1"])
            # ...and a LAN listener binds the canonical advertised address.
            bound.clear()
            r = make_relay(tmp, advertise=args.advertise)
            session = make_session(r)
            with mock.patch.object(relay, "bind_all", record_and_fail):
                status = asyncio.run(session.apply_ports([(5000, SCOPES["lan"])]))
            self.assertEqual(bound, ["10.0.0.5"])
            self.assertEqual(status["ports"][0]["code"], ERROR_CODES["bindFailed"])

    def test_main_refuses_the_default_route_before_binding(self):
        # Process-level wiring, host-independent: the probe is stubbed and any
        # listening socket would fail the test.
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(relay, "default_route_ipv4", lambda dest=None: "192.168.1.20"), \
                mock.patch.object(relay, "bind_listener", side_effect=AssertionError("bound a socket")):
            os.mkdir(os.path.join(tmp, ".code-hub"))
            with self.assertRaises(SystemExit) as caught:
                relay.main(["--listen", "192.168.1.20:0", "--advertise", "10.0.0.5", "--projects-root", tmp])
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
        self.assertEqual(relay.ip_problem(ip), "loopback address")
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
    # --advertise takes exactly protocol.json's maxAddresses addresses, not one more.
    def test_advertise_count_bounded(self):
        exact = ["10.0.0.%d" % i for i in range(1, PROTOCOL["maxAddresses"] + 1)]
        self.assertEqual(relay.parse_args(["--advertise", ",".join(exact)]).advertise, exact)
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            relay.parse_args(["--advertise", ",".join(exact + ["10.0.1.1"])])

    # A non-IPv4 --listen host exits non-zero, naming why.
    def test_listen_must_be_ipv4(self):
        err = io.StringIO()
        with mock.patch("sys.stderr", err), self.assertRaises(SystemExit) as caught:
            relay.parse_args(["--listen", "localhost:7077"])
        self.assertNotEqual(caught.exception.code, 0)
        self.assertIn("--listen host must be an IPv4 address, got 'localhost'", err.getvalue())

    # The probe-destination seam yields the canonical address, never the raw spelling.
    def test_probe_dest_is_canonical(self):
        with mock.patch.object(relay.ipaddress, "IPv4Address", lenient_ipv4), \
                mock.patch.dict(os.environ, {relay.PROBE_DEST_ENV: "127.000.000.001:9"}):
            self.assertEqual(relay.probe_dest(), ("127.0.0.1", 9))

    # --advertise refuses a wildcard (0.0.0.0/8) address.
    def test_advertise_wildcard_refused(self):
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            relay.parse_args(["--advertise", "0.0.0.0"])
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            relay.parse_args(["--advertise", "192.168.1.20,0.0.0.0"])

    # A repeated --advertise address is kept once, order preserved (a repeat
    # would make every lan bind collide with itself).
    def test_advertise_deduplicated(self):
        args = relay.parse_args(["--advertise", "10.0.0.6,10.0.0.5,10.0.0.6"])
        self.assertEqual(args.advertise, ["10.0.0.6", "10.0.0.5"])
        # Repeats are found by canonical form (Python 3.9.0-3.9.4 accept padding).
        with mock.patch.object(relay.ipaddress, "IPv4Address", lenient_ipv4):
            self.assertEqual(relay.parse_args(["--advertise", "10.0.0.5,010.0.0.5"]).advertise, ["10.0.0.5"])

    # --projects-root is taken as given; --accept-wait-ms must be positive.
    def test_projects_root_and_accept_wait(self):
        self.assertEqual(relay.parse_args(["--projects-root", "/some/root"]).projects_root, "/some/root")
        self.assertIsNone(relay.parse_args([]).projects_root)
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            relay.parse_args(["--accept-wait-ms", "0"])


class DefaultListen(unittest.TestCase):
    """P-DefaultListen (S6): with no --listen, the control listener goes on the
    docker0 address when there is one, else on 127.0.0.1, at the default port."""

    def test_docker0_else_loopback(self):
        self.assertEqual(relay.default_listen_host(docker0=lambda: "172.17.0.1"), "172.17.0.1")
        self.assertEqual(relay.default_listen_host(docker0=lambda: None), "127.0.0.1")
        args = relay.parse_args([], default_host=lambda: "172.17.0.1")
        self.assertEqual((args.listen_host, args.listen_port), ("172.17.0.1", relay.DEFAULT_LISTEN_PORT))
        args = relay.parse_args(["--listen", "127.0.0.1:0"], default_host=lambda: "172.17.0.1")
        self.assertEqual(args.listen_host, "127.0.0.1", "an explicit --listen wins")

    def test_docker0_probe_never_raises(self):
        with mock.patch.object(relay.socket, "socket", side_effect=OSError("no sockets")):
            self.assertIsNone(relay.docker0_ipv4())


class Mac(unittest.TestCase):
    """P-Mac (S5): the MAC is HMAC-SHA256 over label, role, both nonces, session
    and conn; the two labels differ, so a relay can't reflect the hub's MAC; the
    comparison is constant-time."""

    def test_vector_and_labels(self):
        import hashlib
        import hmac as hmac_mod
        msg = "\n".join((LABELS["hub"], "control", "nr", "nh", "", ""))
        expected = hmac_mod.new(b"s" * 40, msg.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(relay.mac("s" * 40, LABELS["hub"], "control", "nr", "nh"), expected)
        hub = relay.mac("s" * 40, LABELS["hub"], "data", "nr", "nh", "S", "C")
        relay_side = relay.mac("s" * 40, LABELS["relay"], "data", "nr", "nh", "S", "C")
        self.assertNotEqual(hub, relay_side)
        self.assertTrue(relay.verify_mac(hub, hub))
        self.assertFalse(relay.verify_mac(hub, relay_side), "a relay-label MAC fails hub verification")
        self.assertFalse(relay.verify_mac(hub, relay.mac("s" * 40, LABELS["hub"], "data", "nr", "nh", "S", "other")))
        self.assertFalse(relay.verify_mac(hub, None))

    def test_verify_is_constant_time(self):
        """verify_mac compares only through hmac.compare_digest, exactly once —
        no comparison operator of any kind in it — and nothing in the relay
        compares a MAC value with an equality operator; the scan flags planted
        violations."""
        self.assertEqual(mac_compare_problems(TREE), [])
        planted = ast.parse(
            "import hmac\n"
            "def verify_mac(expected, given):\n    x = given\n    return x != expected\n"
            "def other(msg, proof):\n    return msg['mac'] == proof\n")
        self.assertEqual(len(mac_compare_problems(planted)), 3, "no compare_digest, a != in verify_mac, a MAC compared elsewhere")
        for op in ("in", "not in", "<", "is"):
            planted = ast.parse("import hmac\ndef verify_mac(expected, given):\n"
                                "    return hmac.compare_digest(expected, given) and given %s expected\n" % op)
            self.assertEqual(len(mac_compare_problems(planted)), 1, op)
        twice = ast.parse("import hmac\ndef verify_mac(e, g):\n    return hmac.compare_digest(e, g) and hmac.compare_digest(g, e)\n")
        self.assertEqual(len(mac_compare_problems(twice)), 1, "exactly one compare_digest")


def mac_compare_problems(tree):
    """Why `tree`'s MAC comparisons aren't constant-time, as a list (empty = fine)."""
    problems = []
    fn = function_named(tree, "verify_mac")
    digest = [c for c in calls(fn) if isinstance(c.func, ast.Attribute) and c.func.attr == "compare_digest"
              and isinstance(c.func.value, ast.Name) and c.func.value.id == "hmac"]
    if len(digest) != 1:
        problems.append("verify_mac does not call hmac.compare_digest exactly once")
    for node in ast.walk(fn):
        if isinstance(node, ast.Compare):  # any operator: ==, !=, is, in, <, ...
            problems.append("verify_mac compares with an operator at line %d" % node.lineno)
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Compare) and any(isinstance(op, (ast.Eq, ast.NotEq, ast.Is, ast.IsNot)) for op in node.ops)):
            continue
        if any(n is node for n in ast.walk(fn)):
            continue
        words = []
        for part in [node.left] + node.comparators:
            for n in ast.walk(part):
                if isinstance(n, ast.Name):
                    words.append(n.id)
                elif isinstance(n, ast.Attribute):
                    words.append(n.attr)
                elif isinstance(n, ast.Constant) and isinstance(n.value, str):
                    words.append(n.value)
        if any("mac" in w.lower() or "proof" in w.lower() for w in words):
            problems.append("a MAC value compared with an equality operator at line %d" % node.lineno)
    return problems


class Discovery(unittest.TestCase):
    """P-Discovery (S7): the store is the nearest ancestor of the script's
    directory holding .code-hub; --projects-root overrides; `searched` lists
    every directory looked at."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(str(self.tmp)))
        self.script = self.tmp / "root" / "a" / "b" / "relay" / "relay.py"
        self.script.parent.mkdir(parents=True)

    def test_nearest_ancestor_wins(self):
        (self.tmp / "root" / ".code-hub").mkdir()
        store, searched = relay.find_store(self.script)
        self.assertEqual(store, (self.tmp / "root" / ".code-hub").resolve())
        self.assertEqual(searched, [str((self.tmp / "root" / "a" / "b").resolve()), str((self.tmp / "root" / "a").resolve()), str((self.tmp / "root").resolve())])
        (self.tmp / "root" / "a" / ".code-hub").mkdir()
        self.assertEqual(relay.find_store(self.script)[0], (self.tmp / "root" / "a" / ".code-hub").resolve())

    def test_override_and_none(self):
        other = self.tmp / "other"
        self.assertEqual(relay.find_store(self.script, str(other)), (None, [str(other.resolve())]))
        (other / ".code-hub").mkdir(parents=True)
        self.assertEqual(relay.find_store(self.script, str(other))[0], (other / ".code-hub").resolve())
        store, searched = relay.find_store(self.script)
        if store is None:
            self.assertEqual(searched, [str(p) for p in self.script.resolve().parent.parents])


class Rendezvous(unittest.TestCase):
    """P-Rendezvous (S5/S7): read_secret refuses a missing, invalid or short
    secret naming the path; host.json is written atomically and privately; it is
    removed only while it still names our pid."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(str(self.dir)))

    def test_read_secret_refusals_name_the_path(self):
        path = self.dir / RDV["hubFile"]
        for content in (None, "not json", json.dumps([]), json.dumps({"secret": "short"}), json.dumps({"secret": 5})):
            if content is not None:
                path.write_text(content, encoding="utf-8")
            with self.assertRaises(relay.SecretUnavailable) as caught:
                relay.read_secret(self.dir)
            self.assertIn(str(path), str(caught.exception), content)
        path.write_text(json.dumps({"protocolVersion": 2, "secret": "k" * PROTOCOL["minSecretLength"]}), encoding="utf-8")
        self.assertEqual(relay.read_secret(self.dir), "k" * PROTOCOL["minSecretLength"])

    def test_host_json_written_atomically_and_removed_only_when_ours(self):
        replaced = []
        real_replace = os.replace

        def spy(src, dst):
            replaced.append((Path(src).parent, Path(dst).name))
            return real_replace(src, dst)

        with mock.patch.object(relay.os, "replace", spy):
            path = relay.write_host_json(self.dir, "127.0.0.1:7077", 4242)
        self.assertEqual(replaced, [(self.dir, RDV["relayFile"])], "renamed into place from the same dir")
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"protocolVersion": PROTOCOL["protocolVersion"], "listen": "127.0.0.1:7077", "pid": 4242})
        self.assertEqual([p.name for p in self.dir.iterdir()], [RDV["relayFile"]], "no tmp file left")
        if sys.platform != "win32":
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertFalse(relay.remove_host_json_if_ours(self.dir, 999))
        self.assertTrue(path.exists())
        self.assertTrue(relay.remove_host_json_if_ours(self.dir, 4242))
        self.assertFalse(path.exists())


class StartupErrors(unittest.TestCase):
    """A1: a rendezvous file the relay can't write, or a rendezvous dir it
    can't create in the store, names the path and, for a permission failure,
    says to run the relay as the owner; only a failed control bind is reported
    as "cannot listen"; any other OSError is reported as itself."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(str(self.tmp), ignore_errors=True))
        (self.tmp / ".code-hub").mkdir()

    def run_main(self, **patches):
        argv = ["--listen", "127.0.0.1:0", "--advertise", "127.0.0.1", "--projects-root", str(self.tmp)]
        with mock.patch.object(relay, "log"), mock.patch.object(relay, "default_route_ipv4", side_effect=OSError("no route")), \
                mock.patch.multiple(relay, **patches) if patches else mock.patch.object(relay, "LOOPBACK_HOST", relay.LOOPBACK_HOST), \
                self.assertRaises(SystemExit) as caught:
            relay.main(argv)
        return str(caught.exception.code)

    def test_permission_failures_name_the_owner(self):
        denied = PermissionError(13, "Permission denied")
        msg = relay.file_problem("write", self.tmp / "x", denied, self.tmp)
        self.assertEqual(msg, "cannot write %s: Permission denied — run the relay as the user that owns %s" % (self.tmp / "x", self.tmp))
        self.assertNotIn("run the relay", relay.file_problem("write", self.tmp / "x", OSError(28, "No space left on device"), self.tmp))
        with mock.patch.object(relay.os, "open", side_effect=denied):
            with self.assertRaises(relay.RendezvousError) as caught:
                relay.write_host_json(self.tmp, "127.0.0.1:1", 7)
        self.assertIn("run the relay as the user that owns %s" % self.tmp, str(caught.exception))
        with mock.patch.object(relay.os, "makedirs", side_effect=denied):
            with self.assertRaises(relay.RendezvousError) as caught:
                relay.relay_dir(self.tmp / ".code-hub")
        self.assertIn("cannot create", str(caught.exception))
        self.assertIn("run the relay as the user that owns", str(caught.exception))
        with mock.patch.object(relay.os, "open", side_effect=denied):
            with self.assertRaises(relay.SecretUnavailable) as caught:
                relay.read_secret(self.tmp)
        self.assertIn("run the relay as the user that owns", str(caught.exception))

    def test_main_names_what_failed(self):
        def deny_host_json(rdir, listen, pid):
            raise relay.RendezvousError(relay.file_problem("write", Path(rdir) / RDV["relayFile"], PermissionError(13, "Permission denied"), rdir))

        msg = self.run_main(write_host_json=deny_host_json)
        self.assertIn("run the relay as the user that owns", msg)
        self.assertNotIn("cannot listen", msg)

        def busy(host, port):
            raise OSError(98, "Address already in use")

        self.assertIn("cannot listen on 127.0.0.1:0: Address already in use", self.run_main(bind_listener=busy))

        async def broken(args, rdir, store):
            raise OSError(5, "Input/output error")

        msg = self.run_main(serve=broken)
        self.assertIn("Input/output error", msg)
        self.assertNotIn("cannot listen", msg)


class RendezvousFiles(unittest.TestCase):
    """A5: a rendezvous file is read only if it is a regular file within
    maxRendezvousBytes — a FIFO never blocks, an oversize file is never loaded
    — and host.json's tmp file is created exclusively, so a symlink planted at
    its path is replaced, never written through."""

    def setUp(self):
        if not hasattr(os, "mkfifo"):
            self.skipTest("POSIX FIFOs and symlinks")
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(str(self.dir)))

    def test_fifo_and_oversize_are_refused_without_blocking(self):
        hub = self.dir / RDV["hubFile"]
        os.mkfifo(str(hub))
        with self.assertRaises(relay.SecretUnavailable) as caught:
            relay.read_secret(self.dir)  # a blocking open would hang here
        self.assertIn("is not a regular file", str(caught.exception))
        host = self.dir / RDV["relayFile"]
        os.mkfifo(str(host))
        self.assertFalse(relay.remove_host_json_if_ours(self.dir, os.getpid()))
        self.assertTrue(host.exists(), "a FIFO is not removed as if it were ours")
        hub.unlink()
        hub.write_text(json.dumps({"secret": "k" * (PROTOCOL["maxRendezvousBytes"] + 1)}), encoding="utf-8")
        with self.assertRaises(relay.SecretUnavailable) as caught:
            relay.read_secret(self.dir)
        self.assertIn("is larger than %d bytes" % PROTOCOL["maxRendezvousBytes"], str(caught.exception))

    def test_tmp_symlink_is_never_followed(self):
        victim = self.dir / "victim"
        victim.write_text("untouched", encoding="utf-8")
        tmp = self.dir / (".%s.%d.tmp" % (RDV["relayFile"], 4242))
        os.symlink(str(victim), str(tmp))
        relay.write_host_json(self.dir, "127.0.0.1:7077", 4242)
        self.assertEqual(victim.read_text(encoding="utf-8"), "untouched")
        written = self.dir / RDV["relayFile"]
        self.assertFalse(written.is_symlink())
        self.assertEqual(json.loads(written.read_text(encoding="utf-8"))["pid"], 4242)
        os.symlink(str(self.dir / "nowhere"), str(tmp))  # dangling
        relay.write_host_json(self.dir, "127.0.0.1:7077", 4242)
        self.assertFalse((self.dir / "nowhere").exists())

    def test_tmp_create_is_exclusive(self):
        """The create itself is O_EXCL: a symlink planted right after the
        removal (the race the removal alone can't close) makes the write refuse."""
        victim = self.dir / "victim"
        victim.write_text("untouched", encoding="utf-8")
        tmp = self.dir / (".%s.%d.tmp" % (RDV["relayFile"], 4242))
        tmp.write_text("stale", encoding="utf-8")
        real_unlink = os.unlink

        def unlink_then_plant(path, *a, **kw):
            real_unlink(path, *a, **kw)
            if str(path) == str(tmp):
                os.symlink(str(victim), str(tmp))

        with mock.patch.object(relay.os, "unlink", unlink_then_plant):
            with self.assertRaises(relay.RendezvousError) as caught:
                relay.write_host_json(self.dir, "127.0.0.1:7077", 4242)
        self.assertIn("File exists", str(caught.exception))
        self.assertEqual(victim.read_text(encoding="utf-8"), "untouched")
        self.assertFalse((self.dir / RDV["relayFile"]).exists())

    def test_short_reads_are_gathered(self):
        """A read that returns less than asked is continued to EOF."""
        secret = "k" * PROTOCOL["minSecretLength"]
        (self.dir / RDV["hubFile"]).write_text(json.dumps({"protocolVersion": 2, "secret": secret}), encoding="utf-8")
        real_read = os.read
        with mock.patch.object(relay.os, "read", lambda fd, n: real_read(fd, min(n, 7))):
            self.assertEqual(relay.read_secret(self.dir), secret)
        big = self.dir / "big"
        big.write_text("x" * (PROTOCOL["maxRendezvousBytes"] + 1), encoding="utf-8")
        with mock.patch.object(relay.os, "fstat", lambda fd: os.stat(str(self.dir / RDV["hubFile"]))), \
                mock.patch.object(relay.os, "read", lambda fd, n: real_read(fd, min(n, 7))), \
                self.assertRaises(ValueError):
            relay.read_small_file(big)  # a file that grew past its stat size is still bounded


class FakeTransport:
    def __init__(self):
        self.aborted = False

    def abort(self):
        self.aborted = True


class FakeWriter:
    def __init__(self):
        self.data = b""
        self.transport = FakeTransport()
        self.closed = False

    def write(self, data):
        self.data += data

    def is_closing(self):
        return self.closed or self.transport.aborted

    def close(self):
        self.closed = True

    def frames(self):
        return [json.loads(line) for line in self.data.splitlines()]


def make_relay(rdir, **over):
    opts = dict(advertise=["127.0.0.1"], listen_host="127.0.0.1", accept_wait_ms=100)
    opts.update(over)
    return relay.Relay(rdir, **opts)


def make_session(r):
    addresses, problem = r.addresses()
    session = relay.Session(r, "sid", None, FakeWriter(), addresses, problem)
    r.session = session
    return session


def recording_bind_all(record):
    """A bind_all that records the hosts asked for and binds 127.0.0.1 instead."""
    real = relay.bind_all

    def bind(addresses, port):
        record.append(list(addresses))
        return real(["127.0.0.1"], port)
    return bind


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def reachable(host, port):
    try:
        socket.create_connection((host, port), timeout=1).close()
        return True
    except OSError:
        return False


def entry(status, port, scope):
    return [e for e in status["ports"] if e["port"] == port and e["scope"] == scope][0]


class Scope(unittest.TestCase):
    """P-Scope (S10): hosts_for is the one place bind hosts are chosen — loopback
    scope is 127.0.0.1 whatever the addresses, lan scope exactly the addresses —
    and apply_ports binds through it, for advertised and probed addresses alike."""

    def test_hosts_for(self):
        for addresses in (["10.0.0.5"], ["192.168.1.20", "10.0.0.5"], []):
            self.assertEqual(relay.hosts_for(SCOPES["loopback"], addresses), [relay.LOOPBACK_HOST])
            self.assertEqual(relay.hosts_for(SCOPES["lan"], addresses), addresses)
        with self.assertRaises(ValueError):
            relay.hosts_for("everywhere", ["10.0.0.5"])

    def test_apply_ports_binds_per_scope(self):
        for over in (dict(advertise=["10.0.0.5"]), dict(advertise=None, probe=lambda: "10.0.0.5")):
            record = []

            async def scenario():
                session = make_session(make_relay(None, **over))
                with mock.patch.object(relay, "bind_all", recording_bind_all(record)), mock.patch.object(relay, "log"):
                    await session.apply_ports([(free_port(), SCOPES["lan"]), (free_port(), SCOPES["loopback"])])
                session.close()

            asyncio.run(scenario())
            self.assertEqual(record, [["10.0.0.5"], [relay.LOOPBACK_HOST]], over)

    def test_real_binds_and_rebind_stay_confined(self):
        """V18's address-change half (Linux: all of 127/8 is loopback): after a
        LAN address change, lan moves to the new address only and loopback stays
        on 127.0.0.1 only."""
        if not sys.platform.startswith("linux"):
            self.skipTest("needs the 127.0.0.0/8 loopback aliases Linux configures")
        r = make_relay(None, advertise=["127.0.0.2"])

        async def scenario():
            session = make_session(r)
            lan_port, loop_port = free_port(), free_port()
            pairs = [(lan_port, SCOPES["lan"]), (loop_port, SCOPES["loopback"])]
            with mock.patch.object(relay, "log"):
                first = await session.apply_ports(pairs)
                loop_listener = session.listeners[(loop_port, SCOPES["loopback"])]
                h1, h2 = entry(first, lan_port, SCOPES["lan"])["hostPort"], entry(first, loop_port, SCOPES["loopback"])["hostPort"]
                checks = [(await asyncio.to_thread(reachable, h, p)) for h, p in
                          (("127.0.0.2", h1), ("127.0.0.1", h1), ("127.0.0.1", h2), ("127.0.0.2", h2))]
                r.advertise = ["127.0.0.3"]
                second = await session.apply_ports(pairs)
                h1b = entry(second, lan_port, SCOPES["lan"])["hostPort"]
                checks += [(await asyncio.to_thread(reachable, h, p)) for h, p in
                           (("127.0.0.3", h1b), ("127.0.0.2", h1b), ("127.0.0.1", h1b), ("127.0.0.1", h2), ("127.0.0.3", h2))]
                same = session.listeners[(loop_port, SCOPES["loopback"])] is loop_listener
                session.close()
            return checks, same, second["addresses"]

        checks, same, addresses = asyncio.run(scenario())
        self.assertEqual(checks, [True, False, True, False, True, False, False, True, False])
        self.assertTrue(same, "the loopback listener is untouched by a LAN address change")
        self.assertEqual(addresses, ["127.0.0.3"])


class Reconcile(unittest.TestCase):
    """P-Reconcile (S3): apply_ports adds new pairs, closes removed ones and keeps
    unchanged ones (the same listener and sockets); an address change rebinds
    lan only; too_many_ports counts across scopes in frame order; a failed probe
    fails lan entries with no_lan_address while loopback entries still bind."""

    def test_added_removed_unchanged(self):
        async def scenario():
            session = make_session(make_relay(None))
            a, b, c = free_port(), free_port(), free_port()
            L = SCOPES["loopback"]
            with mock.patch.object(relay, "log"):
                await session.apply_ports([(a, L), (b, L)])
                la, lb = session.listeners[(a, L)], session.listeners[(b, L)]
                b_socks = [s.sockets[0].fileno() for s in lb.servers]
                status = await session.apply_ports([(b, L), (c, L)])
            self.assertTrue(la.closed)
            self.assertFalse(any(s.is_serving() for s in la.servers))
            self.assertIs(session.listeners[(b, L)], lb)
            self.assertEqual([s.sockets[0].fileno() for s in lb.servers], b_socks)
            self.assertEqual(sorted(session.listeners), sorted([(b, L), (c, L)]))
            self.assertEqual([(e["port"], e["hostPort"]) for e in status["ports"]], [(b, b), (c, c)])
            session.close()

        asyncio.run(scenario())

    def test_address_change_rebinds_lan_only(self):
        r = make_relay(None, advertise=["10.0.0.5"])
        record = []

        async def scenario():
            session = make_session(r)
            pairs = [(free_port(), SCOPES["lan"]), (free_port(), SCOPES["loopback"])]
            with mock.patch.object(relay, "bind_all", recording_bind_all(record)), mock.patch.object(relay, "log"):
                await session.apply_ports(pairs)
                lan, loop = session.listeners[pairs[0]], session.listeners[pairs[1]]
                await session.apply_ports(pairs)
                unchanged = (session.listeners[pairs[0]] is lan, session.listeners[pairs[1]] is loop)
                r.advertise = ["10.0.0.6"]
                await session.apply_ports(pairs)
                changed = (session.listeners[pairs[0]] is lan, session.listeners[pairs[1]] is loop, lan.closed)
            session.close()
            return unchanged, changed

        unchanged, changed = asyncio.run(scenario())
        self.assertEqual(unchanged, (True, True))
        self.assertEqual(changed, (False, True, True))
        self.assertEqual(record, [["10.0.0.5"], [relay.LOOPBACK_HOST], ["10.0.0.6"]])

    def test_too_many_ports_across_scopes(self):
        async def scenario():
            session = make_session(make_relay(None))
            pairs = [(free_port(), SCOPES["lan"]), (free_port(), SCOPES["loopback"]), (free_port(), SCOPES["lan"])]
            with mock.patch.object(relay, "MAX_PORTS", 2), mock.patch.object(relay, "log"):
                status = await session.apply_ports(pairs)
            session.close()
            return pairs, status

        pairs, status = asyncio.run(scenario())
        self.assertEqual([(e["port"], e["scope"]) for e in status["ports"]], pairs)
        self.assertEqual(["hostPort" in e for e in status["ports"]], [True, True, False])
        self.assertEqual(status["ports"][2]["code"], ERROR_CODES["tooManyPorts"])

    def test_probe_failure_fails_lan_only(self):
        def no_route():
            raise OSError(101, "Network is unreachable")

        async def scenario():
            session = make_session(make_relay(None, advertise=None, probe=no_route))
            pairs = [(free_port(), SCOPES["lan"]), (free_port(), SCOPES["loopback"])]
            with mock.patch.object(relay, "log"):
                status = await session.apply_ports(pairs)
            session.close()
            return status

        status = asyncio.run(scenario())
        self.assertEqual(status["ports"][0]["code"], ERROR_CODES["noLanAddress"])
        self.assertIn("no default route", status["ports"][0]["message"])
        self.assertIn("hostPort", status["ports"][1])
        self.assertEqual(status["addresses"], [])

    def test_ports_frame_validation(self):
        good = {"t": FRAMES["ports"], "ports": [{"port": 5000, "scope": SCOPES["lan"]}]}
        self.assertEqual(relay.ports_entries(good), [(5000, SCOPES["lan"])])
        for bad in ({"t": FRAMES["ports"], "ports": [{"port": 5000, "scope": SCOPES["lan"], "host": "10.0.0.1"}]},
                    {"t": FRAMES["ports"], "ports": [{"port": 80, "scope": SCOPES["lan"]}]},
                    {"t": FRAMES["ports"], "ports": [{"port": True, "scope": SCOPES["lan"]}]},
                    {"t": FRAMES["ports"], "ports": [{"port": 5000, "scope": "everywhere"}]},
                    {"t": FRAMES["ports"], "ports": [{"port": 5000, "scope": SCOPES["lan"]}] * 2},
                    {"t": FRAMES["ports"], "ports": [], "extra": 1}):
            with self.assertRaises(relay.BadFrame, msg=json.dumps(bad)):
                relay.ports_entries(bad)


class FakeListener:
    def __init__(self, port, scope=SCOPES["loopback"]):
        self.port = port
        self.scope = scope
        self.pending = 0
        self.closed = False
        self.writers = set()


class Incoming(unittest.TestCase):
    """P-Incoming (S5): offer caps pending clients per port and per session,
    sends one incoming frame per client; claim consumes; an unclaimed client is
    dropped by its timer."""

    def test_caps_claim_and_timer(self):
        async def scenario():
            session = make_session(make_relay(None, accept_wait_ms=50))
            a, b = FakeListener(5001), FakeListener(5002)
            clients = [FakeWriter() for _ in range(5)]
            with mock.patch.object(relay, "MAX_INCOMING_PER_PORT", 2), mock.patch.object(relay, "MAX_INCOMING_TOTAL", 3):
                results = [session.offer(a, None, clients[0]), session.offer(a, None, clients[1]),
                           session.offer(a, None, clients[2]), session.offer(b, None, clients[3]),
                           session.offer(b, None, clients[4])]
            frames = [f for f in session.writer.frames() if f["t"] == FRAMES["incoming"]]
            conn = frames[0]["conn"]
            claimed = session.claim(conn)
            again = session.claim(conn)
            pending_after_claim = a.pending
            await asyncio.sleep(0.15)
            return results, frames, claimed, again, pending_after_claim, clients, session, a, b

        results, frames, claimed, again, pending_after_claim, clients, session, a, b = asyncio.run(scenario())
        self.assertEqual(results, [True, True, False, True, False])
        self.assertEqual([(f["port"], f["scope"]) for f in frames], [(5001, SCOPES["loopback"])] * 2 + [(5002, SCOPES["loopback"])])
        self.assertEqual(len({f["conn"] for f in frames}), 3)
        self.assertIs(claimed.writer, clients[0])
        self.assertIsNone(again, "a conn is consumed by its first claim")
        self.assertEqual(pending_after_claim, 1)
        self.assertFalse(clients[0].transport.aborted, "the claimed client is not dropped by its timer")
        self.assertTrue(clients[1].transport.aborted and clients[3].transport.aborted, "unclaimed clients dropped")
        self.assertEqual(session.incoming, {})
        self.assertEqual((a.pending, b.pending), (0, 0))


class SessionClose(unittest.TestCase):
    """P-SessionClose (S4): closing a session closes every listener, aborts every
    pending and spliced client and the control connection — synchronously, and
    a second close is a no-op."""

    def test_close_releases_everything(self):
        async def scenario():
            r = make_relay(None, accept_wait_ms=10000)
            session = make_session(r)
            port = free_port()
            with mock.patch.object(relay, "log"):
                await session.apply_ports([(port, SCOPES["loopback"])])
                listener = session.listeners[(port, SCOPES["loopback"])]
                pending, spliced = FakeWriter(), FakeWriter()
                self.assertTrue(session.offer(listener, None, pending))
                listener.writers.add(spliced)
                session.close()
                state = (listener.closed, [s.is_serving() for s in listener.servers], pending.transport.aborted,
                         spliced.transport.aborted, session.writer.transport.aborted, session.listeners,
                         session.incoming, r.session)
                session.close()
            return state

        closed, serving, pending, spliced, control, listeners, incoming, current = asyncio.run(scenario())
        self.assertEqual((closed, serving, pending, spliced, control), (True, [False], True, True, True))
        self.assertEqual((listeners, incoming, current), ({}, {}, None))


class Restatement(unittest.TestCase):
    # P7 — protocol identifiers have a single source (protocol.json).
    def test_scanner_flags_planted_restatements(self):
        planted = ast.parse('def f(msg, x):\n    """Docs may name bad_frame and relay.json."""\n'
                            '    a = {"t": "hello", "ports": x}\n    b = msg["ports"]\n'
                            '    c = "code bad_frame here"\n    d = f"x{a}host.json"\n    e = "lan"\n'
                            '    g = "a lan port"\n    return {"port": FRAMES["ping"]}\n')
        hits = restatements(planted, protocol_ids(PROTOCOL))
        self.assertEqual(sorted(m for _, m in hits), ["bad_frame", "hello", "host.json", "lan"])

    def test_relay_restates_no_identifier(self):
        hits = restatements(TREE, protocol_ids(PROTOCOL))
        self.assertEqual(hits, [], "restated in relay.py (line, identifier): %r" % hits)


if __name__ == "__main__":
    unittest.main()
