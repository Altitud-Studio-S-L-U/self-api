"""Synthetic customer's original API adapter, using only the Python standard library."""
import json
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
    minor = body["amount_minor"]
    currency = body["currency"]
    if type(minor) is not int or minor < 0 or currency != "USD":
        raise ValueError("invalid internal payment")
    return {"id": body["id"], "amount_minor": minor, "currency": currency}
