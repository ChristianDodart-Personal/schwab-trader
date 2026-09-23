"""Order placement / status / list / cancel — Phase 5 trading.

Human-in-the-loop: nothing executes automatically; the UI order ticket is the
confirm step. Server-side safety rails:
  - Orders only on the SELECTED account — never an account you're not viewing.
  - SELL refused unless held shares are positively confirmed >= quantity
    (fail-CLOSED — an unreadable position blocks the sell; no accidental shorts).
  - STOP/STOP_LIMIT refused if the stop is on the wrong side of the last price
    (would convert to an immediate market order).
  - All order types supported; MARKET and triggered orders fill at the
    prevailing price (the ticket warns).
  - Cancel refused only for terminal statuses (denylist).
"""
from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from . import accounts as accounts_svc
from . import config_store
from .db import SessionLocal
from .db.models import Lot
from .schwab import hub
from .order_eligibility import combo_error
from .order_guards import OrderIntent, check_held, evaluate_order
from .order_status import is_cancelable, is_settled, is_working
from .schwab.auth import get_client
from .strategy import rules
from .util import _f

log = logging.getLogger(__name__)


def trusted_last_price(symbol: str) -> float | None:
    """Last price for validating a real order — TRUSTED (schwab-sourced) quotes
    only. A demo/synthetic quote must read as 'no reference' so the rails fail
    CLOSED (require confirmation) instead of validating against a random-walk price.
    Shared by the guard evaluator and bulk placement — one trusted-price definition."""
    q = hub.latest.get(symbol.upper(), {}) or {}
    if q.get("source") != "schwab":
        return None
    p = q.get("last")
    return _f(p) if p else None


def _avg_fill_price(o: dict):
    """Qty-weighted average EXECUTION price from the order's execution legs, or
    None if nothing has executed. The top-level order `price` is the limit/working
    price (null for MARKET orders) — NOT what it actually filled at."""
    tot_qty = tot_val = 0.0
    for act in o.get("orderActivityCollection") or []:
        if act.get("activityType") != "EXECUTION":
            continue
        for ex in act.get("executionLegs") or []:
            q, p = ex.get("quantity"), ex.get("price")
            if isinstance(q, (int, float)) and isinstance(p, (int, float)) and q > 0 and p > 0:
                tot_qty += q
                tot_val += q * p
    return (tot_val / tot_qty) if tot_qty > 0 else None


async def _account_hash(explicit: str | None) -> str | None:
    # MUST use the profile-scoped key (like every other selected-account read), not
    # the bare SELECTED_KEY — otherwise order list/get/cancel resolve a stale,
    # non-active-profile account under the active profile's token.
    return explicit or await accounts_svc.get_setting(accounts_svc._sel_key())


def _build_order(symbol: str, side: str, quantity: int, order_type: str,
                 limit_price=None, stop_price=None, trailing_offset=None,
                 trailing_type: str = "PERCENT", duration: str = "DAY",
                 session: str = "NORMAL"):
    """Hand-built via OrderBuilder so we support stop/stop-limit/trailing
    (schwab-py has no prebuilt helpers for those)."""
    from schwab.orders.common import (
        Duration, EquityInstruction, OrderStrategyType, OrderType, Session,
        StopPriceLinkBasis, StopPriceLinkType,
    )
    from schwab.orders.generic import OrderBuilder

    symbol, side, order_type = symbol.upper(), side.upper(), order_type.upper()
    if quantity <= 0:
        raise ValueError("quantity must be > 0")
    if side not in ("BUY", "SELL"):
        raise ValueError("side must be BUY or SELL")
    try:
        ot = OrderType[order_type]
    except KeyError:
        raise ValueError(f"unsupported order type: {order_type}") from None
    try:
        dur = Duration[str(duration).upper()]
    except KeyError:
        raise ValueError(f"unsupported duration: {duration}") from None
    try:
        sess = Session[str(session).upper()]
    except KeyError:
        raise ValueError(f"unsupported session: {session}") from None

    # Cross-field broker rule (the enums above only validate each field on its own): a
    # MARKET/STOP/etc. or a GTC order in an extended-hours session is a combo Schwab
    # rejects. Fail it here, the single authoritative gate every path builds through.
    err = combo_error(order_type, session, duration)
    if err:
        raise ValueError(err)

    ob = OrderBuilder()
    ob.set_session(sess)
    ob.set_duration(dur)
    ob.set_order_strategy_type(OrderStrategyType.SINGLE)
    ob.set_order_type(ot)

    if order_type in ("LIMIT", "STOP_LIMIT"):
        if not limit_price or float(limit_price) <= 0:
            raise ValueError("a positive limit price is required")
        ob.set_price(f"{float(limit_price):.2f}")
    if order_type in ("STOP", "STOP_LIMIT"):
        if not stop_price or float(stop_price) <= 0:
            raise ValueError("a positive stop price is required")
        ob.set_stop_price(f"{float(stop_price):.2f}")
    if order_type == "TRAILING_STOP":
        if not trailing_offset or float(trailing_offset) <= 0:
            raise ValueError("a positive trailing offset is required")
        tt = str(trailing_type).upper()
        try:
            lt = StopPriceLinkType[tt]  # PERCENT or VALUE
        except KeyError:
            raise ValueError(f"unsupported trailing type: {trailing_type}") from None
        off = float(trailing_offset)
        # sanity bounds (PERCENT is whole-number percent: 5 == 5%, not 0.05)
        if tt == "PERCENT" and not (0.1 <= off <= 50):
            raise ValueError("trailing percent must be 0.1–50 (e.g. 5 = 5%)")
        if tt == "VALUE" and off <= 0:
            raise ValueError("trailing dollar offset must be > 0")
        ob.set_stop_price_link_type(lt)
        ob.set_stop_price_link_basis(StopPriceLinkBasis.MARK)
        ob.set_stop_price_offset(off)

    instr = EquityInstruction.BUY if side == "BUY" else EquityInstruction.SELL
    ob.add_equity_leg(instr, symbol, int(quantity))
    return ob


async def place_order(symbol: str, side: str, quantity: int,
                      order_type: str = "LIMIT", limit_price=None,
                      stop_price=None, trailing_offset=None,
                      trailing_type: str = "PERCENT", duration: str = "DAY",
                      session: str = "NORMAL",
                      account_hash: str | None = None,
                      confirm: bool = False) -> dict:
    client = get_client()
    if client is None:
        return {"ok": False, "error": "no Schwab token"}

    # --- HARD GUARD: orders only on the SELECTED account. A client-supplied
    # account_hash may not diverge from the selected account.
    target = await accounts_svc.get_trading_account()
    if not target:
        return {"ok": False, "error": "No Schwab account selected."}
    if account_hash and account_hash != target:
        return {"ok": False, "error": "orders may only be placed on the selected account"}

    try:
        builder = _build_order(symbol, side, quantity, order_type, limit_price,
                               stop_price, trailing_offset, trailing_type,
                               duration, session)
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    # --- pre-trade soft rails (stop-direction, fat-finger, notional) — order_guards ---
    verdict = evaluate_order(
        OrderIntent(symbol=symbol, side=side, quantity=quantity, order_type=order_type,
                    limit_price=limit_price, stop_price=stop_price),
        trusted_last_price(symbol), confirm=confirm,
    )
    if verdict.action == "reject":
        return {"ok": False, "error": verdict.reason}
    if verdict.action == "confirm":
        return {"ok": False, "needs_confirm": True, "warning": verdict.reason}

    # --- SELL held-shares rail (fail CLOSED). Runs after the soft rails pass — it needs
    # the held lookup, which we make only for a SELL, exactly as before. ---
    if side.upper() == "SELL":
        held = await accounts_svc.held_shares(target, symbol)
        hv = check_held(quantity, held, verb="sell")
        if hv.action == "reject":
            return {"ok": False, "error": hv.reason}

    def go():
        from schwab.utils import Utils
        resp = client.place_order(target, builder.build())
        oid, warn = None, None
        try:
            oid = Utils(client, target).extract_order_id(resp)
        except Exception as e:  # missing Location header returns None; mismatch raises
            warn = f"order-id not resolved: {e!r}"
        return resp.status_code, resp.text, oid, warn

    try:
        status, body, oid, warn = await asyncio.to_thread(go)
    except Exception as e:
        return {"ok": False, "error": repr(e)}
    ok = status in (200, 201)
    if ok:
        # We just changed the account — trigger the fill re-sync now instead of waiting
        # for Schwab's ACCT_ACTIVITY stream poke, so the dashboard reflects it promptly.
        from .schwab import poke_resync
        poke_resync()
    return {
        "ok": ok,
        "http": status,
        "order_id": oid,
        "needs_verify": bool(ok and not oid),   # placed but id unresolved -> check Orders
        "warning": warn,
        "detail": None if ok else (body[:300] or f"HTTP {status}"),
    }


async def get_order(order_id, account_hash: str | None = None) -> dict:
    client = get_client()
    h = await _account_hash(account_hash)
    if client is None or not h:
        return {"error": "no client/account"}

    def go():
        r = client.get_order(order_id, h)
        return r.json() if r.status_code == 200 else None

    err = None
    try:
        o = await asyncio.to_thread(go)
    except Exception as e:
        o, err = None, repr(e)
    if isinstance(o, dict) and o.get("status"):
        # `settled` lets the ticket's poll stop without re-deriving Schwab statuses itself.
        return {**o, "settled": is_settled(o.get("status"))}
    # A freshly placed order isn't always queryable by id for a few seconds, which left
    # the order ticket's status poll hanging on "checking…". The account order LIST is a
    # different Schwab endpoint that registers a new order sooner, so fall back to it for
    # the status (same shape, includes "status") so the poll resolves promptly.
    try:
        for ro in await list_orders(days=1, account_hash=h):
            if str(ro.get("order_id")) == str(order_id):
                return {**ro, "settled": is_settled(ro.get("status"))}
    except Exception as e:
        err = err or repr(e)
    return o if isinstance(o, dict) else {"error": err or "not found"}


async def list_orders(days: int = 7, account_hash: str | None = None) -> list[dict]:
    client = get_client()
    h = await _account_hash(account_hash)
    if client is None or not h:
        return []

    def go():
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days)
        r = client.get_orders_for_account(h, from_entered_datetime=start,
                                          to_entered_datetime=end)
        return r.json() if r.status_code == 200 else []

    try:
        data = await asyncio.to_thread(go)
    except Exception as e:
        log.warning(f"order list fetch failed for {h[-4:]}: {e!r}")
        return []

    out = []
    for o in data if isinstance(data, list) else []:
        legs = o.get("orderLegCollection", []) or []
        leg = legs[0] if legs else {}
        limit_price = o.get("price")
        fill = _avg_fill_price(o)
        out.append({
            "order_id": o.get("orderId"),
            "symbol": leg.get("instrument", {}).get("symbol"),
            "side": leg.get("instruction"),
            "quantity": o.get("quantity"),
            "filled": o.get("filledQuantity"),
            "type": o.get("orderType"),
            # show the actual fill price once anything executes (MARKET orders have
            # no limit price), else the working/limit price.
            "price": round(fill, 4) if fill is not None else limit_price,
            "limit_price": limit_price,
            "fill_price": round(fill, 4) if fill is not None else None,
            "status": o.get("status"),
            "working": is_working(o.get("status")),   # live → cancelable/editable (nav badge, row actions)
            "entered": (o.get("enteredTime") or "")[:19],
            "realized_pl": None,
        })

    # Realized P/L per SELL order — the round-trips this order closed (its SELL fill
    # retired long lots LIFO; each became a completed_trade tagged with the order id).
    # Computed by us from the fill history (Schwab doesn't hand back a per-order P/L),
    # so the UI marks it as app-calculated. Populated after the next resync for
    # API-sourced sells; CSV-only sells have no order id and stay blank ("—").
    sell_ids = [str(o["order_id"]) for o in out
                if o.get("side") == "SELL" and o.get("order_id") is not None]
    if sell_ids:
        try:
            from sqlalchemy import func, select
            from .db import SessionLocal
            from .db.models import CompletedTrade
            async with SessionLocal() as s:
                rows = (await s.execute(
                    select(CompletedTrade.schwab_order_id, func.sum(CompletedTrade.profit))
                    .where(CompletedTrade.account_hash == h,
                           CompletedTrade.schwab_order_id.in_(sell_ids))
                    .group_by(CompletedTrade.schwab_order_id)
                )).all()
            pl = {str(oid): float(p) for oid, p in rows if oid is not None}
            for o in out:
                oid = str(o.get("order_id"))
                if o.get("side") == "SELL" and oid in pl:
                    o["realized_pl"] = round(pl[oid], 2)
        except Exception as e:
            log.warning(f"order P/L join failed for {h[-4:]}: {e!r}")
    return out


async def working_count(account_hash: str | None = None) -> int:
    """Count of still-working orders on the account — powers the ambient nav badge.
    READ-ONLY (reuses list_orders); never touches place/cancel."""
    orders = await list_orders(days=7, account_hash=account_hash)
    return sum(1 for o in orders if is_working(o.get("status")))


async def working_summary(account_hash: str | None = None) -> dict:
    """Nav-badge count PLUS a per-symbol breakdown, so dashboard rows can mark
    tickers that already have a resting order (prevents double-placing a rung).
    READ-ONLY (reuses list_orders); never touches place/cancel."""
    orders = await list_orders(days=7, account_hash=account_hash)
    count = 0
    by_symbol: dict[str, int] = {}
    for o in orders:
        if not is_working(o.get("status")):
            continue
        count += 1
        if o.get("symbol"):
            by_symbol[o["symbol"]] = by_symbol.get(o["symbol"], 0) + 1
    return {"count": count, "by_symbol": by_symbol}


async def replace_order(order_id, new_quantity: int | None = None,
                        new_limit_price=None, account_hash: str | None = None,
                        confirm: bool = False) -> dict:
    """Modify a WORKING limit order (price and/or quantity) via Schwab's native
    replace — the broker cancels the original and books the replacement in one
    operation, so there is never a moment with no order resting.

    Same posture as place_order: hard guards (selected account, working single-leg
    LIMIT only), then the same soft rails on the NEW terms (fat-finger, notional,
    sell-held). place_order itself is untouched.
    """
    client = get_client()
    if client is None:
        return {"ok": False, "error": "no Schwab token"}

    target = await accounts_svc.get_trading_account()
    if not target:
        return {"ok": False, "error": "No Schwab account selected."}
    if account_hash and account_hash != target:
        return {"ok": False, "error": "orders may only be placed on the selected account"}

    try:
        orig = await asyncio.to_thread(lambda: client.get_order(order_id, target).json() or {})
    except Exception as e:
        return {"ok": False, "error": f"could not read the original order: {e!r}"}

    status = orig.get("status")
    if not is_working(status):
        return {"ok": False, "error": f"order is {status or 'unknown'} — only a working order can be modified"}
    legs = orig.get("orderLegCollection") or []
    if len(legs) != 1:
        return {"ok": False, "error": "only single-leg orders can be modified here"}
    side = (legs[0].get("instruction") or "").upper()
    if side not in ("BUY", "SELL"):
        return {"ok": False, "error": f"unsupported instruction {side or 'unknown'} — modify it at Schwab"}
    if (orig.get("orderType") or "").upper() != "LIMIT":
        return {"ok": False, "error": "only LIMIT orders can be modified here — cancel and re-place instead"}
    symbol = (legs[0].get("instrument") or {}).get("symbol")
    if not symbol:
        return {"ok": False, "error": "could not resolve the order's symbol"}

    quantity = int(new_quantity) if new_quantity else int(_f(orig.get("quantity")))
    limit_price = float(new_limit_price) if new_limit_price else _f(orig.get("price"))
    if quantity <= 0 or limit_price <= 0:
        return {"ok": False, "error": "quantity and limit price must be positive"}
    if quantity == int(_f(orig.get("quantity"))) and abs(limit_price - _f(orig.get("price"))) < 0.005:
        return {"ok": False, "error": "nothing changed — adjust the price or quantity first"}

    # Partial fills: the replacement's quantity is IN ADDITION to what already
    # executed (those shares are done). Make the user acknowledge that.
    filled = _f(orig.get("filledQuantity"))
    if filled > 0 and not confirm:
        return {"ok": False, "needs_confirm": True,
                "warning": f"{filled:g} of {_f(orig.get('quantity')):g} shares already filled — "
                           f"the replacement {side.lower()}s {quantity} MORE shares on top of those. Confirm."}

    # --- same soft rails as place_order (order_guards), applied to the NEW terms. A
    # replacement is always LIMIT, so only the fat-finger / notional rails can trip. ---
    verdict = evaluate_order(
        OrderIntent(symbol=symbol, side=side, quantity=quantity, order_type="LIMIT",
                    limit_price=limit_price),
        trusted_last_price(symbol), confirm=confirm,
    )
    if verdict.action == "confirm":
        return {"ok": False, "needs_confirm": True, "warning": verdict.reason}
    if verdict.action == "reject":
        return {"ok": False, "error": verdict.reason}

    # --- SELL held-shares rail (fail CLOSED). The original order's shares still count
    # as held (they haven't sold), so held >= quantity is the right bound. ---
    if side == "SELL":
        held = await accounts_svc.held_shares(target, symbol)
        hv = check_held(quantity, held, verb="modify")
        if hv.action == "reject":
            return {"ok": False, "error": hv.reason}

    try:
        builder = _build_order(symbol, side, quantity, "LIMIT", limit_price,
                               duration=orig.get("duration") or "DAY",
                               session=orig.get("session") or "NORMAL")
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    def go():
        from schwab.utils import Utils
        resp = client.replace_order(target, order_id, builder.build())
        oid, warn = None, None
        try:
            oid = Utils(client, target).extract_order_id(resp)
        except Exception as e:
            warn = f"replacement order-id not resolved: {e!r}"
        return resp.status_code, resp.text, oid, warn

    try:
        http, body, oid, warn = await asyncio.to_thread(go)
    except Exception as e:
        return {"ok": False, "error": repr(e)}
    ok = http in (200, 201)
    if ok:
        from .schwab import poke_resync
        poke_resync()
    return {
        "ok": ok,
        "http": http,
        "order_id": oid,
        "needs_verify": bool(ok and not oid),
        "warning": warn,
        "detail": None if ok else (body[:300] or f"HTTP {http}"),
    }


async def cancel_order(order_id, account_hash: str | None = None) -> dict:
    client = get_client()
    h = await _account_hash(account_hash)
    if client is None or not h:
        return {"ok": False, "error": "no client/account"}

    def go():
        status = (client.get_order(order_id, h).json() or {}).get("status")
        if not is_cancelable(status):
            return {"ok": False, "error": f"order is {status}; not cancelable", "status": status}
        c = client.cancel_order(order_id, h)
        return {"ok": c.status_code in (200, 201), "http": c.status_code, "status": status}

    try:
        res = await asyncio.to_thread(go)
    except Exception as e:
        return {"ok": False, "error": repr(e)}
    if res.get("ok"):
        from .schwab import poke_resync
        poke_resync()  # working-order set changed → refresh promptly
    return res


# ---- strategy-driven order suggestions (the user confirms, then places) ----

async def suggest_buy(symbol: str, account_hash: str) -> dict:
    symbol = symbol.upper()
    cfg = await config_store.get_strategy(account_hash)
    async with SessionLocal() as s:
        lots = (await s.execute(
            select(Lot).where(Lot.symbol == symbol, Lot.account_hash == account_hash)
            .order_by(Lot.rung)
        )).scalars().all()
    filled = len(lots)
    next_rung = filled + 1
    if filled == 0:
        return {"symbol": symbol, "error": "no existing lots; first-buy price is manual"}
    # No cap on ladder depth — you can add as many positions as your dips justify.

    # Match the dashboard/ladder: scale the trigger by account deployment when the
    # user enabled it (no-op / cached when off).
    from . import accounts as accounts_svc
    deployed = await accounts_svc.deployed_pct(account_hash) if cfg.deployment_scaling.enabled else None
    trigger = rules.next_buy_price(_f(lots[-1].buy_price), next_rung, cfg, deployed)
    dollars = rules.sizing_dollars(filled, cfg)
    raw_qty = math.floor(dollars / trigger) if trigger else 0
    out = {
        "symbol": symbol, "side": "BUY", "order_type": "LIMIT",
        "rung": next_rung, "limit_price": round(trigger, 2),
        "quantity": raw_qty, "sizing_dollars": dollars,
        "est_cost": round(raw_qty * trigger, 2),
        "rationale": f"Position {next_rung}: {dollars:.0f} ÷ {trigger:.2f} trigger",
    }
    if raw_qty < 1:  # one share already exceeds the position budget — let the human size it
        out["note"] = f"one share (~${trigger:.0f}) exceeds the ${dollars:.0f} position budget — set quantity manually"
    # Advisory only: what you can actually deploy now (tradable_funds — settled/non-
    # marginable), so the ticket flags an order that exceeds the REAL limit rather than a
    # looser margin figure. NEVER a hard block — the broker enforces margin.
    try:
        ms = await accounts_svc.margin_summary(account_hash)
        bp = None if ms.get("blocked") else ms.get("tradable_funds")
    except Exception:
        bp = None
    out["buying_power"] = bp
    out["affordable"] = (out["est_cost"] <= bp) if bp is not None else None
    return out


async def suggest_sell(lot_id: int, account_hash: str) -> dict:
    async with SessionLocal() as s:
        lot = (await s.execute(
            select(Lot).where(Lot.id == lot_id, Lot.account_hash == account_hash)
        )).scalar_one_or_none()
    if lot is None:
        return {"error": f"lot {lot_id} not found"}
    # Sells are LIFO. Schwab only ever receives "sell N shares of SYMBOL", and the ledger
    # retires the NEWEST lot first, so a ticket priced off an older lot would show shares,
    # a target and a profit that aren't what gets booked. Only the last-in lot (highest
    # rung, the same rule bulk-sell enforces) gets a per-lot suggestion; larger sells go
    # through the share-count LIFO ticket.
    async with SessionLocal() as s:
        newest = (await s.execute(
            select(Lot).where(Lot.account_hash == account_hash, Lot.symbol == lot.symbol)
            .order_by(Lot.rung.desc(), Lot.id.desc()).limit(1)
        )).scalar_one_or_none()
    if newest is not None and newest.id != lot.id:
        return {"error": f"{lot.symbol} sells last-in first: the next shares sold come from "
                         f"position {newest.rung}, not {lot.rung}. Sell from that position, or use "
                         f"'Sell shares' to sell more than it holds."}
    cfg = await config_store.get_strategy(account_hash)
    bp = _f(lot.buy_price)
    sh = _f(lot.shares)
    qty = int(sh)  # whole-share order
    target = (_f(lot.sell_target_price) if lot.sell_target_price is not None
              else rules.sell_target_price(bp, sh, cfg, mode=lot.sell_mode))
    out = {
        "symbol": lot.symbol, "side": "SELL", "order_type": "LIMIT",
        "lot_id": lot_id, "rung": lot.rung, "limit_price": round(target, 2),
        "quantity": qty, "buy_price": round(bp, 2),
        # est_* derived from the INTEGER qty actually ordered, so they match
        "est_proceeds": round(qty * target, 2),
        "est_profit": round((target - bp) * qty, 2),
    }
    if qty == 0:
        out["note"] = f"lot holds {sh:g} (<1) share — set quantity manually"
    elif qty < sh:
        out["note"] = f"lot holds {sh:g}; whole-share order of {qty} leaves {sh - qty:g}"
    return out
