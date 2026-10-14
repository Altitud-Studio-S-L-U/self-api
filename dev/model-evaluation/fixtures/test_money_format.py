"""Independent boundary challenge, intentionally withheld from model context."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from payment_client import get_payment

VALUES = ['0.00', '9999999999999999.99', '19', '19.9', '19.999', '19.+1', '19.-1',
          '19. 1', '19.\u0661\u0662', '\u0661\u0669.99', '019.99', '1e2.00', '-19.99',
          ' 19.99', '19.99 ', '10000000000000000.00']


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        value = VALUES[int(self.path.removeprefix('/payments/'))]
        raw = json.dumps({'id': 'p42', 'money': {'value': value, 'currency': 'USD'}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def test_exact_bounded_ascii_amounts():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f'http://127.0.0.1:{server.server_port}'
        assert get_payment(base, '0')['amount_minor'] == 0
        assert get_payment(base, '1')['amount_minor'] == 999999999999999999
        for index in range(2, len(VALUES)):
            with pytest.raises(Exception):
                get_payment(base, str(index))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
