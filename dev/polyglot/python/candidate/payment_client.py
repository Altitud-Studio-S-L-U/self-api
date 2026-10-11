"""Manually reviewed candidate fixture. Keepseam does not yet propose Python edits."""
import json
import re
from decimal import Decimal
from urllib.request import Request, urlopen


def get_payment(base_url, case):
    request = Request(base_url + "/payments/" + case, headers={"Accept": "application/json"})
    with urlopen(request, timeout=3) as response:
        if response.status != 200:
            raise ValueError("unexpected HTTP status")
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("oversized response")
        body = json.loads(raw)
    money = body["money"]
    value, currency = money["value"], money["currency"]
    if type(value) is not str or not re.fullmatch(r"(?:0|[1-9][0-9]{0,15})\.[0-9]{2}", value) or currency != "USD":
        raise ValueError("invalid internal payment")
    minor = int(Decimal(value) * 100)
    return {"id": body["id"], "amount_minor": minor, "currency": currency}
