"""Unchanged tests for both adapters; the fixture uses real loopback HTTP sockets."""
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from payment_client import get_payment

VERSION = sys.argv.pop(1)
if VERSION not in ("A", "B"):
    raise ValueError("explicit fixture version required")


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.headers.get("Accept") != "application/json":
            self.send_error(406)
            return
        case = self.path.removeprefix("/payments/")
        if case in ("rate", "outage"):
            self.send_error(429 if case == "rate" else 503)
            return
        minor = 9007199254740993 if case == "large" else 1 if case == "one" else 1999
        amount = f"{minor // 100}.{minor % 100:02}"
        if case == "fraction":
            minor, amount = 1999.9, "19.999"
        if case == "wrong-unit":
            minor, amount = 199900, "1999.00"
        currency = "JPY" if case == "currency" else "USD"
        body = {"id": "p42", "amount_minor": minor, "currency": currency} if VERSION == "A" else {"id": "p42", "money": {"value": amount, "currency": currency}}
        raw = b"x" * 65537 if case == "oversized" else json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class PaymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_internal_minor_units_survive(self):
        for case, expected in [("normal", 1999), ("one", 1), ("large", 9007199254740993)]:
            self.assertEqual(get_payment(self.url, case), {"id": "p42", "amount_minor": expected, "currency": "USD"})

    def test_unit_corruption_is_detected_by_the_contract(self):
        self.assertNotEqual(get_payment(self.url, "wrong-unit")["amount_minor"], 1999)

    def test_invalid_data_or_provider_failure_is_not_a_payment(self):
        for case in ["fraction", "currency", "rate", "outage", "oversized"]:
            with self.subTest(case=case), self.assertRaises(Exception):
                get_payment(self.url, case)


unittest.main(verbosity=2)
