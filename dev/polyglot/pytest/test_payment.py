"""Synthetic provider B over real loopback HTTP; pytest runs these unchanged for both adapters."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from payment_client import get_payment


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        case = self.path.removeprefix('/payments/')
        if self.headers.get('Accept') != 'application/json':
            self.send_error(406)
            return
        if case in ('rate', 'outage'):
            self.send_error(429 if case == 'rate' else 503)
            return
        minor = 9007199254740993 if case == 'large' else 1 if case == 'one' else 1999
        amount = f'{minor // 100}.{minor % 100:02}'
        if case == 'fraction':
            amount = '19.999'
        if case == 'wrong-unit':
            amount = '1999.00'
        invalid_amounts = {
            'fraction-sign': '19.+1', 'fraction-space': '19. 1', 'fraction-unicode': '19.\u0661\u0662',
            'whole-unicode': '\u0661\u0669.99', 'negative': '-19.99', 'exponent': '1e2.00',
            'leading-zero': '019.99', 'trailing-space': '19.99 ', 'overflow': '10000000000000000.00',
        }
        amount = invalid_amounts.get(case, amount)
        currency = 'JPY' if case == 'currency' else 'USD'
        body = {'id': 'p42', 'money': {'value': amount, 'currency': currency}}
        raw = b'x' * 65537 if case == 'oversized' else json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


@pytest.fixture(scope='module')
def provider():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize(('case', 'expected'), [('normal', 1999), ('one', 1), ('large', 9007199254740993)])
def test_internal_minor_units_survive(provider, case, expected):
    assert get_payment(provider, case) == {'id': 'p42', 'amount_minor': expected, 'currency': 'USD'}


def test_unit_corruption_is_detected(provider):
    assert get_payment(provider, 'wrong-unit')['amount_minor'] != 1999


@pytest.mark.parametrize('case', ['fraction', 'currency', 'rate', 'outage', 'oversized',
                                'fraction-sign', 'fraction-space', 'fraction-unicode', 'whole-unicode',
                                'negative', 'exponent', 'leading-zero', 'trailing-space', 'overflow'])
def test_invalid_response_is_not_a_payment(provider, case):
    with pytest.raises(Exception):
        get_payment(provider, case)
