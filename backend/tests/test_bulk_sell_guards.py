"""Bulk sell: the ±25% limit band (bulk sends confirm=True, so the single ticket's soft
checks never run) and the session a bulk order goes out with. place_order is stubbed:
nothing is sent anywhere."""
import asyncio
from datetime import date

from app import bulk
from app.db.models import Lot


def _lot():
    return Lot(id=7, account_hash="T", symbol="ZZB", rung=1, buy_date=date(2026, 9, 1),
               shares=10, buy_price=10.0, source="fill")


def _patch(monkeypatch, price=12.0):
    sent = []

    async def lots_by_symbol(_acct):
        return {"ZZB": [_lot()]}

    async def place_order(symbol, side, qty, order_type, **kw):
        sent.append({"symbol": symbol, "side": side, "qty": qty, "type": order_type, **kw})
        return {"ok": True, "order_id": "X"}

    monkeypatch.setattr(bulk, "_lots_by_symbol", lots_by_symbol)
    monkeypatch.setattr(bulk.orders_svc, "trusted_last_price", lambda s: price)
    monkeypatch.setattr(bulk.orders_svc, "place_order", place_order)
    return sent


def _sell(items, **kw):
    return asyncio.run(bulk.bulk_sell("T", items, **kw))


def test_limit_sell_far_from_market_is_refused(monkeypatch):
    sent = _patch(monkeypatch, price=12.0)
    r = _sell([{"lot_id": 7, "symbol": "ZZB", "shares": 10, "limit_price": 20.0}], order_type="LIMIT")
    assert not r["ok"] and ">25% from the market" in r["results"][0]["error"]
    assert sent == []


def test_limit_sell_inside_band_goes_out_with_the_given_session(monkeypatch):
    sent = _patch(monkeypatch, price=12.0)
    r = _sell([{"lot_id": 7, "symbol": "ZZB", "shares": 10, "limit_price": 12.5}],
              order_type="LIMIT", session="PM")
    assert r["ok"] and sent[0]["session"] == "PM" and sent[0]["limit_price"] == 12.5


def test_market_sell_is_always_regular_session(monkeypatch):
    sent = _patch(monkeypatch, price=12.0)
    _sell([{"lot_id": 7, "symbol": "ZZB", "shares": 10}], order_type="MARKET", session="PM")
    assert sent[0]["session"] == "NORMAL"


def test_unknown_session_falls_back_to_normal(monkeypatch):
    sent = _patch(monkeypatch, price=12.0)
    _sell([{"lot_id": 7, "symbol": "ZZB", "shares": 10, "limit_price": 12.0}],
          order_type="LIMIT", session="BOGUS")
    assert sent[0]["session"] == "NORMAL"
