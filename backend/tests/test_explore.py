"""The Explore tab can only ever READ. A fake client records which methods were called;
every catalog entry must dispatch to a get_* method, and unknown ids never reach Schwab."""
import asyncio

import pytest
from schwab.client import Client

from app import explore


class _Resp:
    status_code = 200
    content = b'{"ok": true}'

    def json(self):
        return {"ok": True}


class _FakeClient(Client):
    """Real Client subclass so the enums resolve, with every method replaced by a recorder."""

    def __init__(self):   # skip the real constructor (no session / token)
        self.calls: list[str] = []

    def __getattribute__(self, name):
        if name.startswith(("get_", "place_", "replace_", "cancel_", "preview_")):
            calls = object.__getattribute__(self, "calls")

            def rec(*a, **k):
                calls.append(name)
                return _Resp()
            return rec
        return object.__getattribute__(self, name)


def _run_all(monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(explore, "get_client", lambda: fake)
    for e in explore.CATALOG:
        if e["id"] == "stream_quote":
            continue
        params = {p["name"]: p["default"] for p in e["params"]}
        for k, v in (("transaction_id", "1"), ("order_id", "1"), ("cusip", "88636W718")):
            if k in params:
                params[k] = v
        out = asyncio.run(explore.run(e["id"], params, "HASH"))
        assert out["ok"], (e["id"], out)
    return fake.calls


def test_every_catalog_entry_is_a_read(monkeypatch):
    calls = _run_all(monkeypatch)
    assert calls and all(c.startswith("get_") for c in calls), calls


def test_unknown_id_never_reaches_schwab(monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(explore, "get_client", lambda: fake)
    out = asyncio.run(explore.run("place_order", {}, "HASH"))
    assert out["ok"] is False and fake.calls == []


def test_account_scoped_call_needs_a_selected_account(monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(explore, "get_client", lambda: fake)
    out = asyncio.run(explore.run("transactions", {"days": 30}, ""))
    assert out["ok"] is False and "account" in out["error"] and fake.calls == []


@pytest.mark.parametrize("ty", ["RECEIVE_AND_DELIVER", "ALL"])
def test_transactions_type_filter(ty):
    seen = {}

    class Shim:
        Transactions = Client.Transactions

        def get_transactions(self, h, **kw):
            seen.update(kw)
            return _Resp()
    resp = explore._call(Shim(), "transactions", {"days": 365, "type": ty}, "HASH")
    assert resp.status_code == 200
    if ty == "ALL":
        assert "transaction_types" not in seen
    else:
        assert seen["transaction_types"] == Client.Transactions.TransactionType.RECEIVE_AND_DELIVER
