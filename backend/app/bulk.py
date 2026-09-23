"""Bulk actions — sell the last position of each picked holding, and bulk-buy (held
names or fresh entries). The UI builds a plan (read-only), the user reviews + confirms,
then these place orders ONE BY ONE through the guarded orders.place_order path
(selected account, SELL fail-closed held-shares, stop-direction).

Selection is manual: the user picks holdings on the dashboard, then runs Sell or
Buy; the plan says which of those picks can act, and at what size and price.
Orders carry the same session the single Order Ticket would use right now (the
client derives it from the live market session), so an extended-hours limit is an
extended-hours order, not one silently queued for the next open.

HARD SAFETY: bulk-sell may only sell a symbol's LAST (highest-rung) open lot —
never a deeper lot, even if profitable — enforced server-side regardless of
what the client sends. Sell also re-checks profitability at placement.
"""
from __future__ import annotations

from sqlalchemy import select

from . import config_store
from . import orders as orders_svc
from .db import SessionLocal
from .db.models import Lot, Ticker
from .schwab import hub
from .strategy import rules
from .util import _f

_EPS = 1e-9
_BULK_MAX_NOTIONAL = 25_000.0   # per-order fat-finger ceiling (well above a ~$1.5k rung)
_BULK_PRICE_BAND = 0.25         # an edited limit (buy or sell) may sit at most this far from the market
_SESSIONS = {"NORMAL", "AM", "PM", "SEAMLESS"}


def _session(order_type: str, session: str | None) -> str:
    """The session a bulk order goes out with. MARKET is regular-session only; an
    unknown value falls back to NORMAL. Duration is always DAY (extended/seamless
    sessions are DAY-only at Schwab, and bulk never rests an order GTC)."""
    s = str(session or "NORMAL").upper()
    return "NORMAL" if order_type == "MARKET" or s not in _SESSIONS else s


async def _lots_by_symbol(account_hash: str) -> dict[str, list[Lot]]:
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(Lot).where(Lot.account_hash == account_hash).order_by(Lot.symbol, Lot.rung)
        )).scalars().all()
    by: dict[str, list[Lot]] = {}
    for l in rows:
        by.setdefault(l.symbol, []).append(l)
    return by


def _last_lot(lots: list[Lot]) -> Lot:
    # highest rung = last-in (LIFO); id breaks a rung tie the same way the drill-down and
    # orders.suggest_sell do, so every surface agrees on which lot sells next.
    return max(lots, key=lambda l: (l.rung, l.id))


async def sell_plan(account_hash: str) -> dict:
    """Every held LAST position (the lot a LIFO sale retires), so the user can sell any
    of their picks. A position whose last lot is below cost is returned with a note:
    at the current price it would be refused, but a limit raised above cost is a valid
    resting profit-taking order. A last lot with no known cost is skipped (the sale
    can't be priced or checked for profit)."""
    if not account_hash:
        return {"ok": True, "mode": hub.mode, "count": 0, "candidates": [], "note": "no account selected"}
    by = await _lots_by_symbol(account_hash)
    cands = []
    for sym, lots in by.items():
        last = _last_lot(lots)
        px = orders_svc.trusted_last_price(sym)
        if px is None:
            continue
        qty = int(_f(last.shares))
        bp = _f(last.buy_price)
        if qty < 1 or bp <= 0:
            continue
        profit = (px - bp) * qty
        cands.append({
            "symbol": sym, "lot_id": last.id, "rung": last.rung,
            "shares": qty, "buy_price": round(bp, 2), "price": round(px, 2),
            "order_type": "LIMIT", "limit_price": round(px, 2),
            "est_proceeds": round(qty * px, 2), "est_profit": round(profit, 2),
            "gain_pct": round((px - bp) / bp * 100, 2),
            "note": None if profit > _EPS else f"below cost — raise the limit above {round(bp, 2)} or it will be refused",
        })
    cands.sort(key=lambda c: c["est_profit"], reverse=True)
    return {"ok": True, "mode": hub.mode, "count": len(cands), "candidates": cands}


async def buy_plan(account_hash: str) -> dict:
    """Every BUYABLE symbol — held positions AND watchlist tickers (fresh entries).
    Sizing follows the strategy tier for the next position; buys are marketable at the
    current price."""
    if not account_hash:
        return {"ok": True, "mode": hub.mode, "count": 0, "candidates": [], "note": "no account selected"}
    cfg = await config_store.get_strategy(account_hash)
    by = await _lots_by_symbol(account_hash)
    async with SessionLocal() as s:
        watch = (await s.execute(select(Ticker.symbol).where(Ticker.watch.is_(True)))).scalars().all()
    universe = sorted(set(by) | set(watch))

    cands = []
    for sym in universe:
        px = orders_svc.trusted_last_price(sym)
        if px is None or px <= 0:
            continue
        lots = by.get(sym, [])
        filled = len(lots)
        # No cap on ladder depth — add as many positions as the dips justify.
        dollars = rules.sizing_dollars(filled, cfg)
        qty = int(dollars // px)      # whole-share, strategy-sized
        if qty < 1:                   # one share exceeds the position budget → use the single ticket
            continue
        is_new = filled == 0
        cands.append({
            "symbol": sym, "is_new": is_new, "rung": filled + 1, "shares": qty,
            "price": round(px, 2), "order_type": "LIMIT", "limit_price": round(px, 2),
            "est_cost": round(qty * px, 2), "note": None,
        })
    cands.sort(key=lambda c: c["symbol"])
    # Advisory: what you can actually deploy now, so the review modal can flag a SELECTED
    # total that exceeds it. Uses tradable_funds (settled/non-marginable) — the real
    # constraint that orders are enforced against, not a looser margin figure.
    # Informational only; never blocks (margin rules are the broker's job).
    try:
        from . import accounts as accounts_svc
        ms = await accounts_svc.margin_summary(account_hash)
        tradable = None if ms.get("blocked") else ms.get("tradable_funds")
    except Exception:
        tradable = None
    return {"ok": True, "mode": hub.mode, "buying_power": tradable,
            "count": len(cands), "candidates": cands}


async def bulk_sell(account_hash: str, items: list[dict], order_type: str = "LIMIT", confirm: bool = False,
                    session: str | None = None) -> dict:
    """Place each reviewed sell. HARD: the lot must be its symbol's LAST (highest-rung)
    lot, and shares may not exceed that lot's shares (never sell into a deeper lot).
    LIMIT places at the reviewed price (a floor — fills at that price or better, so a
    stale/edited price can't fill below it); MARKET re-checks profitability at the
    current price (no floor) and fills now."""
    ot = "MARKET" if str(order_type).upper() == "MARKET" else "LIMIT"
    sess = _session(ot, session)
    by = await _lots_by_symbol(account_hash)
    last_ids = {_last_lot(lots).id for lots in by.values()}
    id_to_lot = {l.id: l for lots in by.values() for l in lots}
    results = []
    seen_ids: set[int] = set()
    for it in items:
        lid = int(it.get("lot_id") or 0)
        shares = int(it.get("shares") or 0)
        lot = id_to_lot.get(lid)
        if lot is None:
            results.append({"lot_id": lid, "ok": False, "error": "lot not found on this account"})
            continue
        # IDENTITY: the reviewed symbol must match the lot the id resolves to. SQLite
        # reuses rowids after the wipe-and-reinsert resync, so a stale id from a plan
        # made before a resync could alias a DIFFERENT lot — refuse instead of selling
        # the wrong position. (Fail-closed: an item without a symbol is refused too.)
        want_sym = str(it.get("symbol") or "").upper()
        if not want_sym or want_sym != lot.symbol.upper():
            results.append({"lot_id": lid, "symbol": lot.symbol, "ok": False,
                            "error": "lot identity mismatch — refresh the plan and review again"})
            continue
        # One order per lot per batch: a duplicated lot_id would sell the last lot's
        # shares twice, reaching deeper inventory the per-item guard can't see.
        if lid in seen_ids:
            results.append({"lot_id": lid, "symbol": lot.symbol, "ok": False,
                            "error": "duplicate lot in this batch — refused"})
            continue
        seen_ids.add(lid)
        if lid not in last_ids:
            results.append({"lot_id": lid, "symbol": lot.symbol, "ok": False,
                            "error": "not the last position — refused (bulk-sell only sells last positions)"})
            continue
        px = orders_svc.trusted_last_price(lot.symbol)
        lot_sh = int(_f(lot.shares))
        if px is None or px <= 0:
            results.append({"lot_id": lid, "symbol": lot.symbol, "ok": False, "error": "no live price"})
            continue
        if shares < 1:
            results.append({"lot_id": lid, "symbol": lot.symbol, "ok": False, "error": "shares must be >= 1"})
            continue
        if shares > lot_sh:   # never sell more than the last lot holds (would reach a deeper lot)
            results.append({"lot_id": lid, "symbol": lot.symbol, "ok": False,
                            "error": f"exceeds the last position's {lot_sh} shares"})
            continue
        if ot == "MARKET":
            if (px - _f(lot.buy_price)) * shares <= _EPS:   # no floor → never market-sell at a loss
                results.append({"lot_id": lid, "symbol": lot.symbol, "ok": False,
                                "error": f"no longer profitable at {round(px, 2)} — skipped"})
                continue
            res = await orders_svc.place_order(lot.symbol, "SELL", shares, "MARKET", session=sess,
                                               account_hash=account_hash, confirm=True)
            results.append({"lot_id": lid, "symbol": lot.symbol, "shares": shares, "order_type": "MARKET", "limit_price": None, **res})
        else:
            lim = round(_f(it.get("limit_price")) if it.get("limit_price") else px, 2)
            if lim <= 0:
                results.append({"lot_id": lid, "symbol": lot.symbol, "ok": False, "error": "invalid limit price"})
                continue
            # Fat-finger: the same ±25% band edited bulk BUY limits get. Bulk sends
            # confirm=True, so the single ticket's 20% soft-confirm never runs here.
            if abs(lim / px - 1) > _BULK_PRICE_BAND:
                results.append({"lot_id": lid, "symbol": lot.symbol, "ok": False,
                                "error": f"limit {lim} is >25% from the market {round(px, 2)} — adjust"})
                continue
            # The floor logic only protects when the floor is ABOVE cost — an EDITED
            # limit below break-even would place a marketable losing sell. This is the
            # bulk sell only takes profit: refuse sub-break-even limits outright.
            if (lim - _f(lot.buy_price)) * shares <= _EPS:
                results.append({"lot_id": lid, "symbol": lot.symbol, "ok": False,
                                "error": f"limit {lim} is at/below the {round(_f(lot.buy_price), 2)} cost — not profitable, refused"})
                continue
            res = await orders_svc.place_order(lot.symbol, "SELL", shares, "LIMIT", limit_price=lim, session=sess,
                                               account_hash=account_hash, confirm=True)
            results.append({"lot_id": lid, "symbol": lot.symbol, "shares": shares, "order_type": "LIMIT", "limit_price": lim, **res})
    return {"ok": bool(results) and all(r.get("ok") for r in results),
            "placed": sum(1 for r in results if r.get("ok")), "count": len(results), "results": results}


async def bulk_buy(account_hash: str, items: list[dict], order_type: str = "LIMIT", confirm: bool = False,
                   session: str | None = None) -> dict:
    """Place each reviewed buy at its shares/price. Guards: ladder room, an edited
    LIMIT within +-25% of the market (fat-finger), and a per-order notional ceiling.
    LIMIT places at the reviewed price; MARKET fills now."""
    ot = "MARKET" if str(order_type).upper() == "MARKET" else "LIMIT"
    sess = _session(ot, session)
    results = []
    seen_syms: set[str] = set()
    for it in items:
        sym = str(it.get("symbol") or "").upper()
        shares = int(it.get("shares") or 0)
        px = orders_svc.trusted_last_price(sym)
        if px is None or px <= 0:
            results.append({"symbol": sym, "ok": False, "error": "no live price"})
            continue
        # One buy per symbol per batch — the review shows one row per symbol, so a
        # duplicate is a malformed request that would stack rungs past the review.
        if sym in seen_syms:
            results.append({"symbol": sym, "ok": False, "error": "duplicate symbol in this batch — refused"})
            continue
        seen_syms.add(sym)
        if shares < 1:
            results.append({"symbol": sym, "ok": False, "error": "shares must be >= 1"})
            continue
        eff = round(_f(it.get("limit_price")) if (ot == "LIMIT" and it.get("limit_price")) else px, 2)
        if ot == "LIMIT":
            if eff <= 0:
                results.append({"symbol": sym, "ok": False, "error": "invalid limit price"})
                continue
            if abs(eff / px - 1) > _BULK_PRICE_BAND:   # fat-finger on an edited buy limit (ceiling)
                results.append({"symbol": sym, "ok": False, "error": f"limit {eff} is >25% from the market {round(px, 2)} — adjust"})
                continue
        if shares * eff > _BULK_MAX_NOTIONAL:
            results.append({"symbol": sym, "ok": False, "error": f"~${shares * eff:,.0f} exceeds the ${_BULK_MAX_NOTIONAL:,.0f} bulk cap"})
            continue
        res = await orders_svc.place_order(
            sym, "BUY", shares, ot,
            limit_price=(eff if ot == "LIMIT" else None), session=sess, account_hash=account_hash, confirm=True,
        )
        results.append({"symbol": sym, "shares": shares, "order_type": ot,
                        "limit_price": (eff if ot == "LIMIT" else None), **res})
    return {"ok": bool(results) and all(r.get("ok") for r in results),
            "placed": sum(1 for r in results if r.get("ok")), "count": len(results), "results": results}
