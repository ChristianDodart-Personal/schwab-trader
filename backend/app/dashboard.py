"""Dashboard service — computes the Stock Data + Longs views.

All numbers are derived here, server-side, from: DB lots + completed trades,
the live quote (hub.latest), and the strategy engine (strategy/rules.py). The
frontend just renders what this returns — no strategy logic in the browser.
"""
from __future__ import annotations

import asyncio
import time
from datetime import date, datetime

from sqlalchemy import func, select

from . import avg52, config_store, grouping, risk as risk_mod
from .db import SessionLocal
from .db.models import CompletedTrade, Lot, Ticker
from .ledger import MARKET_TZ, get_dividends, get_etf_links, get_last_held
from .schwab import hub
from .strategy import StrategyConfig, rules
from .util import _f


def position_day_change(net_change: float, price: float, shares: float,
                        bought_today: float, cost_today: float,
                        sold_today: float = 0.0, proceeds_today: float = 0.0) -> float:
    """Schwab-style intraday P/L for a symbol, including today's realized trades.

    The identity Schwab uses: how much did this holding's value change today, counting
    cash pulled out by today's sells and cash put in by today's buys —

        day change = value_now + today's sell proceeds − today's buy cost
                     − value_at_yesterday's_close

    where value_at_close = (shares held at the open) × prior close, and
    shares_at_open = shares_now − bought_today + sold_today.

    This naturally does the right thing in every case: a plain hold reduces to
    net_change × shares; a share bought today is measured from its purchase price, not
    the prior close; and an intraday round-trip (sell then rebuy, like today's RCAX)
    books its realized gain even though the share count barely moved. Our earlier
    formula omitted the sell leg, so realized intraday gains were missing — that was
    the −$127-vs-Schwab's-+$923 gap. Deposits/withdrawals never enter here."""
    prior_close = price - net_change
    shares_at_open = shares - bought_today + sold_today
    return shares * price + proceeds_today - cost_today - shares_at_open * prior_close


def _today() -> date:
    """Market-local 'today' (matches the ledger), so the YTD boundary and ages
    don't shift by the UTC offset on a server in another timezone."""
    return datetime.now(MARKET_TZ).date()


async def _load(account_hash: str):
    async with SessionLocal() as s:
        lots = (
            await s.execute(
                select(Lot).where(Lot.account_hash == account_hash)
                .order_by(Lot.symbol, Lot.rung)
            )
        ).scalars().all()
        tickers = {
            t.symbol: t
            for t in (await s.execute(select(Ticker))).scalars().all()
        }
        agg = (
            await s.execute(
                select(
                    CompletedTrade.symbol,
                    func.sum(CompletedTrade.profit),
                    func.count(CompletedTrade.id),
                    func.min(CompletedTrade.completed_at),
                ).where(CompletedTrade.account_hash == account_hash)
                .group_by(CompletedTrade.symbol)
            )
        ).all()
        year_start = date(_today().year, 1, 1)
        agg_year = (
            await s.execute(
                select(
                    CompletedTrade.symbol,
                    func.sum(CompletedTrade.profit),
                    func.count(CompletedTrade.id),
                ).where(CompletedTrade.account_hash == account_hash,
                        CompletedTrade.completed_at >= year_start)
                .group_by(CompletedTrade.symbol)
            )
        ).all()
        # Most-recent realized sell price per symbol — "the price you last sold a lot at".
        # Ordered newest-first; the first row we see per symbol is the latest sell.
        sold_rows = (
            await s.execute(
                select(CompletedTrade.symbol, CompletedTrade.sell_price)
                .where(CompletedTrade.account_hash == account_hash)
                .order_by(CompletedTrade.symbol,
                          CompletedTrade.completed_at.desc(),
                          CompletedTrade.id.desc())
            )
        ).all()
    realized = {r[0]: (_f(r[1]), int(r[2]), r[3]) for r in agg}
    year_realized = {r[0]: (_f(r[1]), int(r[2])) for r in agg_year}
    last_sold: dict[str, float] = {}
    for sym, sp in sold_rows:
        last_sold.setdefault(sym, _f(sp))
    return lots, tickers, realized, year_realized, last_sold


def _risk(ticker) -> str:
    """Risk band for coloring the ticker (blue→red). Neutral when the ticker is unknown."""
    if ticker is None:
        return "medium"
    return risk_mod.classify(ticker.name, ticker.industry,
                             _f(ticker.market_cap) if ticker.market_cap is not None else None)


def _ref_window(symbol: str, ticker, quote: dict):
    """Reference price window for the avg / median / high / low / %-of-high columns,
    returned as (avg, median, high, low, weeks). Leveraged & inverse ETFs use a 13-week
    (one-quarter) window — their price structurally bleeds via daily rebalancing, so a
    full-year average is anchored to stale levels and a 52-week high the fund may never
    revisit. Everything else keeps the 52-week figures: candle avg/median plus the quote's
    true intraday high/low. Falls back to the 52wk path if the short window isn't warm yet
    (so a leveraged row shows honest 52wk values, labeled as such, until candles load)."""
    if grouping.is_leveraged_etf(ticker.name if ticker else None,
                                 ticker.industry if ticker else None):
        s = avg52.short_stats(symbol)
        if s:
            return s["mean"], s["median"], s["high"], s["low"], 13
    year_high = quote.get("yearHigh") or (_f(ticker.year_high) if ticker and ticker.year_high else None)
    return avg52.get(symbol), avg52.median(symbol), year_high, quote.get("yearLow"), 52


def _group(lots):
    by: dict[str, list[Lot]] = {}
    for lot in lots:
        by.setdefault(lot.symbol, []).append(lot)
    return by


def _lot_sell_target(lot: Lot, cfg: StrategyConfig) -> float:
    """Stored target if set, else the strategy default for this lot."""
    if lot.sell_target_price is not None:
        return _f(lot.sell_target_price)
    return rules.sell_target_price(_f(lot.buy_price), _f(lot.shares), cfg,
                                   mode=lot.sell_mode)


def _base_row(symbol: str, ticker: Ticker | None,
              cfg: StrategyConfig) -> tuple[dict, float | None, bool, dict]:
    """The quote + 52-week-reference fields shared IDENTICALLY by held and watch rows —
    defined once so the two builders can't drift on them. Returns the base row plus the
    derived values the caller needs for its own fields (raw price, has_price, the raw
    quote) so nothing is recomputed."""
    quote = hub.latest.get(symbol, {})
    price = quote.get("last")
    price = _f(price) if price is not None else None
    # avg / median / high / low reference window (13wk for leveraged/inverse ETFs, else 52wk).
    ref_avg, ref_median, year_high, year_low, ref_weeks = _ref_window(symbol, ticker, quote)
    has_price = price is not None and price > 0
    row = {
        "symbol": symbol,
        "name": ticker.name if ticker else None,
        "sector": ticker.sector if ticker else None,
        "risk": _risk(ticker),
        "price": round(price, 4) if has_price else None,
        "avg_52wk": ref_avg,
        "median_52wk": ref_median,
        "pct_of_high": round(price / year_high, 4) if has_price and year_high else None,
        "pct_of_low": round(price / year_low - 1, 4) if has_price and year_low else None,
        "market_cap": _f(ticker.market_cap) if ticker and ticker.market_cap is not None else None,
        "first_buy_shares": max(1, round(rules.sizing_dollars(0, cfg) / price)) if has_price else None,
        "year_high": year_high,
        "year_low": year_low,
        "ref_window_weeks": ref_weeks,
    }
    return row, price, has_price, quote


def _summary_row(symbol: str, lots: list[Lot], ticker: Ticker | None,
                 realized: tuple[float, int, date | None],
                 year_realized: tuple[float, int], total_invested: float,
                 cfg: StrategyConfig, deployed_pct: float | None = None,
                 sym_div: float = 0.0,
                 today_trade: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0),
                 schwab_day_pl: float | None = None,
                 last_sold: float | None = None) -> dict:
    base, price, has_price, quote = _base_row(symbol, ticker, cfg)

    shares = sum(_f(l.shares) for l in lots)   # total shares held (every lot)
    positions = len(lots)
    last = lots[-1]  # highest rung (loaded ordered by rung) = the lot a LIFO sale retires
    last_amount = _f(last.shares) * _f(last.buy_price)
    # If the newest lot has no known cost, the numbers that describe it (last-position
    # P/L, LILO, the SELL chip) can't be computed honestly: they're left empty and the
    # row is flagged cost_unknown so the ticker gets a 'needs review' marker instead.
    last_priced = _f(last.buy_price) > 0

    # Cost basis, P/L, signals and dip math all use only lots with a KNOWN cost basis.
    # A backfilled lot we couldn't price (buy_price <= 0 — e.g. Schwab reported no
    # average, or a rights/merger share with no basis in the CSV) would otherwise fake
    # free profit (cost $0 → all upside) AND, via a ~$0 sell target, force a permanent
    # SELL mark. Its shares still count in `shares`/`current_value`; we just don't
    # invent a cost for them. `unrealized` is None when the WHOLE position is un-priced.
    priced_lots = [l for l in lots if _f(l.buy_price) > 0]
    priced_shares = sum(_f(l.shares) for l in priced_lots)
    invested = sum(_f(l.shares) * _f(l.buy_price) for l in priced_lots)

    sell_anchor = priced_lots[-1] if priced_lots else last
    next_buy = rules.next_buy_price(_f(sell_anchor.buy_price), positions + 1, cfg, deployed_pct)
    log_profit, trades, realized_first = realized
    year_profit, year_trades = year_realized

    first_buy = min((l.buy_date for l in lots), default=None)
    # Anchor avg-monthly to when the realized profit was actually earned (first
    # closed trade), not the age of the oldest open lot — disjoint windows.
    anchor = realized_first or first_buy
    days = (_today() - anchor).days if anchor else 0
    avg_monthly = (log_profit / days * 30) if days > 0 else 0.0

    return {
        **base,   # symbol, name, sector, risk, price, avg/median_52wk, pct_of_high/low,
                  # market_cap, first_buy_shares, year_high/low, ref_window_weeks
        "is_watch": False,
        "positions": positions,
        "shares": round(shares, 4),
        "invested": round(invested, 2),
        "basis_per_share": round(rules.basis_per_share(invested, priced_shares), 4) if priced_shares > 0 else 0.0,
        "current_value": round(shares * price, 2) if has_price else None,
        # Unrealized is the gain on shares whose cost we KNOW. A fully un-priced position
        # (e.g. a rights/backfill lot at $0) resolves to 0 here — neutral, NOT the phantom
        # positive gain it used to show (price x shares against $0 cost). Kept numeric (not
        # None) so header/aggregate sums over rows don't hit float + None.
        "unrealized": round(priced_shares * price - invested, 2) if has_price else None,
        # Day change: prefer Schwab's own per-position number (exact "Day Chng $",
        # folds in same-day buys + intraday realized). Only when Schwab is unreachable
        # (demo / offline) fall back to computing it from the live quote + today's fills.
        "day_change": round(schwab_day_pl, 2) if schwab_day_pl is not None
        else (round(position_day_change(_f(quote.get("netChange")), price, shares,
                                        today_trade[0], today_trade[1],
                                        today_trade[2], today_trade[3]), 2)
              if has_price and quote.get("netChange") is not None else None),
        "lilo_pct": round(rules.lilo_pct(price, _f(last.buy_price)), 4) if has_price and last_priced else None,
        "portfolio_pct": round(invested / total_invested, 4) if total_invested else None,
        "next_buy_price": round(next_buy, 4),
        "buy_mark": rules.is_buy_mark(price, next_buy) if has_price else False,
        "sell_mark": rules.is_sell_mark(price, _lot_sell_target(last, cfg)) if has_price and last_priced else False,
        "last_pos_cost": round(last_amount, 2) if last_priced else None,
        "last_pos_profit": round(price * _f(last.shares) - last_amount, 2) if has_price and last_priced else None,
        # Some lot in this position has no known cost (e.g. a backfill Schwab gave no
        # average for): its value is kept out of cost/P/L; the UI flags it for review.
        "cost_unknown": len(priced_lots) < len(lots),
        # The price you last sold a lot of this at (most recent round-trip). A subtle
        # re-entry / trim reference on held rows — mirrors watch rows' "last held".
        "last_sold": round(last_sold, 4) if last_sold else None,
        "log_profit": round(log_profit, 2),
        "trades": trades,
        "year_profit": round(year_profit, 2),
        "year_trades": year_trades,
        "avg_monthly": round(avg_monthly, 2),
        "first_buy_date": first_buy.isoformat() if first_buy else None,
        # Dividends received for this name + full total return (realized + unrealized + divs).
        "dividends": round(sym_div, 2),
        "total_return": round(log_profit + sym_div + (priced_shares * price - invested if has_price else 0.0), 2),
    }


# Short-lived per-account snapshot cache. The ws pushes ~1x/sec PER connected client
# and the REST endpoint also calls this; without the memo, N clients = N× (~6 queries
# + avg52 scheduling) every second. A sub-second TTL collapses that to one build/sec
# with no visible staleness (quotes themselves only refresh ~1/sec).
_snap: dict[str, tuple[float, dict]] = {}
_SNAP_TTL_S = 0.9


def invalidate_dashboard_cache() -> None:
    _snap.clear()


async def build_dashboard(account_hash: str) -> dict:
    """The Stock Data view for one account: one summary row per held ticker."""
    import time as _time

    hit = _snap.get(account_hash)
    if hit and (_time.monotonic() - hit[0]) < _SNAP_TTL_S:
        return hit[1]
    snap = await _build_dashboard_uncached(account_hash)
    _snap[account_hash] = (_time.monotonic(), snap)
    return snap


async def _today_trades(account_hash: str) -> dict[str, tuple[float, float, float, float]]:
    """{symbol: (bought_qty, bought_cost, sold_qty, sold_proceeds)} from the fill ledger
    for the market-local day — feeds the Schwab-style day-change calc (baselines
    today's buys at cost and books today's realized sells). Gross of fees (pennies)."""
    from .db.models import FillRecord
    out: dict[str, list[float]] = {}
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(FillRecord.symbol, FillRecord.side, FillRecord.shares, FillRecord.price)
            .where(FillRecord.account_hash == account_hash,
                   FillRecord.side.in_(["BUY", "SELL"]), FillRecord.trade_date == _today())
        )).all()
    for sym, side, sh, px in rows:
        sh, px = _f(sh), _f(px)
        e = out.setdefault(sym, [0.0, 0.0, 0.0, 0.0])
        if side == "SELL":
            e[2] += sh; e[3] += sh * px
        else:
            e[0] += sh; e[1] += sh * px
    return {k: (v[0], v[1], v[2], v[3]) for k, v in out.items()}


# Schwab's own day-change numbers, cached briefly. From one account fetch we take BOTH:
#   • per-position currentDayProfitLoss (Schwab's "Day Chng $" — folds in same-day buys
#     and intraday realized, which our fill math can't reproduce exactly), and
#   • the account-level day change = currentBalances − initialBalances liquidationValue,
#     i.e. total account value now minus its value at today's open. By Schwab's own
#     definition this INCLUDES deposits/withdrawals + trading — the "Total day change"
#     shown in Schwab's account summary. That's what the dashboard's Day Change widget
#     shows. Refreshed ~45s; on demo / no token we fall back to the computed sum.
_daypl_cache: dict[str, tuple[float, dict[str, float], float | None]] = {}
_DAYPL_TTL_S = 45.0


async def _schwab_day_pl(account_hash: str) -> tuple[dict[str, float], float | None]:
    now = time.monotonic()
    hit = _daypl_cache.get(account_hash)
    if hit and (now - hit[0]) < _DAYPL_TTL_S:
        return hit[1], hit[2]
    from .schwab.auth import get_client
    try:
        client = get_client()
    except Exception:
        client = None
    if client is None or not account_hash:
        return (hit[1], hit[2]) if hit else ({}, None)

    def fetch():
        r = client.get_account(account_hash, fields=client.Account.Fields.POSITIONS)
        if r.status_code != 200:
            return None
        body = r.json()
        sa = body.get("securitiesAccount") if isinstance(body, dict) else None
        return sa if isinstance(sa, dict) else None

    try:
        sa = await asyncio.to_thread(fetch)
    except Exception:
        return (hit[1], hit[2]) if hit else ({}, None)   # transient — reuse last good
    if sa is None:
        return (hit[1], hit[2]) if hit else ({}, None)
    m: dict[str, float] = {}
    for p in sa.get("positions") or []:
        sym = (p.get("instrument") or {}).get("symbol")
        if sym and p.get("currentDayProfitLoss") is not None:
            m[sym] = _f(p.get("currentDayProfitLoss"))
    cur = (sa.get("currentBalances") or {}).get("liquidationValue")
    init = (sa.get("initialBalances") or {}).get("liquidationValue")
    account_dc = (_f(cur) - _f(init)) if cur is not None and init is not None else None
    _daypl_cache[account_hash] = (now, m, account_dc)
    return m, account_dc


async def _deployed_pct_if_scaling(account_hash: str, cfg: StrategyConfig) -> float | None:
    """Account deployment % for ladder scaling — only when the user enabled it (else
    None ⇒ the ladder engine no-ops and behaves exactly as the fixed ladder)."""
    if not cfg.deployment_scaling.enabled:
        return None
    from . import accounts as accounts_svc
    return await accounts_svc.deployed_pct(account_hash)


async def _build_dashboard_uncached(account_hash: str) -> dict:
    cfg = await config_store.get_strategy(account_hash)
    # Deployment-adjusted ladder: only fetch (cached ~60s) when the user has enabled it.
    deployed = await _deployed_pct_if_scaling(account_hash, cfg)
    lots, tickers, realized, year_realized, last_sold = await _load(account_hash)
    by = _group(lots)
    total_invested = sum(
        _f(l.shares) * _f(l.buy_price) for l in lots
    )
    # Dividends grouped by symbol (loaded once) for the opt-in total-return column.
    div_data = await get_dividends(account_hash)
    div_by_sym: dict[str, float] = {}
    for d in div_data.get("rows", []):
        k = (d.get("symbol") or "").upper()
        if k:
            div_by_sym[k] = round(div_by_sym.get(k, 0.0) + _f(d.get("amount")), 2)
    # Per-symbol rule overrides: each row is computed against its EFFECTIVE strategy
    # (global config + that ticker's overrides — sell target / dip depth).
    sym_overrides = await config_store.get_symbol_overrides(account_hash)
    today_trades = await _today_trades(account_hash)   # fallback day-change inputs (same-day buys + sells)
    day_pl, acct_day_change = await _schwab_day_pl(account_hash)   # Schwab's per-position + account day change
    rows = [
        _summary_row(sym, by[sym], tickers.get(sym), realized.get(sym, (0.0, 0, None)),
                     year_realized.get(sym, (0.0, 0)), total_invested,
                     config_store.apply_symbol_override(cfg, sym_overrides.get(sym)), deployed,
                     sym_div=div_by_sym.get(sym, 0.0),
                     today_trade=today_trades.get(sym, (0.0, 0.0, 0.0, 0.0)),
                     schwab_day_pl=day_pl.get(sym),
                     last_sold=last_sold.get(sym))
        for sym in by
    ]
    rows.sort(key=lambda r: r["portfolio_pct"] or 0, reverse=True)

    # Watchlist tickers (no position in this account) -> watch rows, after held.
    for t in tickers.values():
        if t.watch and t.symbol not in by:
            rows.append(_watch_row(t, cfg))

    # Flag rows that have a saved journal note (surfaces the note without opening detail).
    from .ledger import get_notes
    notes = await get_notes(account_hash)
    last_held = await get_last_held(account_hash)
    for r in rows:
        note_txt = notes.get(r["symbol"])
        r["has_note"] = bool(note_txt)
        # A short preview for the dashboard hover tooltip (full text lives on the
        # detail page). Truncated so a long journal entry doesn't bloat the payload.
        r["note_preview"] = (note_txt[:240] + "…") if note_txt and len(note_txt) > 240 else (note_txt or None)
        r["has_rules"] = r["symbol"] in sym_overrides   # per-ticker rule override active
        # Watch rows that used to be held show the last price they were held at.
        r["last_held"] = last_held.get(r["symbol"]) if r["is_watch"] else None

    # ETF grouping: link each leveraged single-stock ETF to its underlying stock (auto from
    # the fund name, per-account manual override wins) so the UI can nest it under the parent.
    etf_overrides = await get_etf_links(account_hash)
    known_syms = {r["symbol"] for r in rows}
    for r in rows:
        t = tickers.get(r["symbol"])
        r["underlying"] = grouping.resolve_underlying(
            t.name if t else None, t.industry if t else None,
            known_syms, r["symbol"], etf_overrides,
        )

    # Header metric — "Harvestable": the profit you could lock in RIGHT NOW by selling
    # every profitable last position, measured vs. each last lot's entry price. It is
    # exactly the sum of the positive "Last Pos P/L" cells in the table (bulk Sell sells
    # whole shares and needs a live Schwab quote, so it can book slightly less). $0 when every last position is
    # underwater — a ladder trader harvests winners and holds losers, so the actionable
    # header number is "what's on the table to take", NOT today's drift vs. yesterday's
    # close. ALL-OR-NOTHING: None (→ UI hides it) until every held position is priced, so
    # a warming feed never shows a wrong figure. (Per-row day_change is still emitted for
    # anyone who wants intraday drift.)
    held = [r for r in rows if not r["is_watch"]]
    # Rows whose newest lot has no known cost (last_pos_cost None) can't contribute a
    # harvestable figure; leave them out rather than hiding the whole KPI.
    known = [r for r in held if r["last_pos_cost"] is not None]
    priced = bool(known) and all(r["last_pos_profit"] is not None for r in known)
    # Aggregate header metrics for the customizable KPI widgets. All-or-nothing on the
    # priced gate (same as harvestable) so a warming feed never shows a partial total.
    # day_change can be None on a held row even when priced (quote carried no netChange),
    # so total_day_change is gated on every held row HAVING a day_change.
    day_priced = bool(held) and all(r["day_change"] is not None for r in held)
    val_priced = bool(held) and all(r["current_value"] is not None for r in held)
    # Day Change = Schwab's account-level "Total day change" (today's account value minus
    # its value at the open — includes deposits/withdrawals + trading), taken straight
    # from Schwab's balances so it matches their summary. Falls back to the per-holding
    # sum only when Schwab is unreachable (demo/offline).
    total_day_change = (round(acct_day_change, 2) if acct_day_change is not None
                        else (round(sum(r["day_change"] for r in held), 2) if day_priced else None))
    return {
        "mode": hub.mode,
        "account_hash": account_hash,
        "total_invested": round(total_invested, 2),
        "harvestable": round(sum(r["last_pos_profit"] for r in known if r["last_pos_profit"] > 0), 2) if priced else None,
        "total_day_change": total_day_change,
        "total_value": round(sum((r["current_value"] or 0) for r in held), 2) if val_priced else None,
        "total_unrealized": round(sum((r["unrealized"] or 0) for r in held), 2) if val_priced else None,
        "rows": rows,
    }


def _watch_row(ticker: Ticker, cfg: StrategyConfig) -> dict:
    base, *_ = _base_row(ticker.symbol, ticker, cfg)
    return {
        **base,   # symbol, name, sector, risk, price, avg/median_52wk, pct_of_high/low,
                  # market_cap, first_buy_shares, year_high/low, ref_window_weeks
        "is_watch": True,
        "positions": 0, "shares": 0, "invested": 0, "basis_per_share": 0,
        "current_value": None, "unrealized": None, "day_change": None, "lilo_pct": None,
        "portfolio_pct": None,
        "next_buy_price": None, "buy_mark": False, "sell_mark": False,
        "last_pos_cost": None, "last_pos_profit": None, "log_profit": 0, "trades": 0,
        "year_profit": 0, "year_trades": 0, "avg_monthly": 0,
        "first_buy_date": None,
        # Set the fields _watch_row used to omit, so the DashboardRow contract holds for
        # watch rows too (held rows always set these). Fixes the type-lie / possible-undefined.
        "dividends": 0, "total_return": 0, "last_sold": None,
    }


async def build_position_detail(symbol: str, account_hash: str) -> dict | None:
    """The Longs view for one ticker on one account: lots + projected ladder."""
    symbol = symbol.upper()
    cfg = await config_store.get_strategy(account_hash)
    # This ticker's EFFECTIVE strategy (global + per-symbol override, if any).
    sym_override = (await config_store.get_symbol_overrides(account_hash)).get(symbol)
    cfg = config_store.apply_symbol_override(cfg, sym_override)
    deployed = await _deployed_pct_if_scaling(account_hash, cfg)
    async with SessionLocal() as s:
        lots = (
            await s.execute(
                select(Lot).where(Lot.symbol == symbol, Lot.account_hash == account_hash)
                .order_by(Lot.rung, Lot.id)   # id breaks rung ties: the last row is the LIFO-next lot
            )
        ).scalars().all()
        ticker = (
            await s.execute(select(Ticker).where(Ticker.symbol == symbol))
        ).scalar_one_or_none()
        known_syms = set((await s.execute(select(Ticker.symbol))).scalars().all())
        realized = (
            await s.execute(
                select(func.coalesce(func.sum(CompletedTrade.profit), 0))
                .where(CompletedTrade.symbol == symbol, CompletedTrade.account_hash == account_hash)
            )
        ).scalar()
        last_sold_val = (
            await s.execute(
                select(CompletedTrade.sell_price)
                .where(CompletedTrade.symbol == symbol, CompletedTrade.account_hash == account_hash)
                .order_by(CompletedTrade.completed_at.desc(), CompletedTrade.id.desc())
                .limit(1)
            )
        ).scalar()
    # ETF grouping context (auto from name + per-account manual override).
    etf_overrides = await get_etf_links(account_hash)
    etf_underlying = grouping.resolve_underlying(
        ticker.name if ticker else None, ticker.industry if ticker else None,
        known_syms, symbol, etf_overrides) if ticker else None
    etf_is_lev = grouping.is_leveraged_etf(ticker.name, ticker.industry) if ticker else False

    if not lots:
        # No open position — a watch ticker (or a fully-sold name). Return a minimal
        # "watch mode" payload so the detail view can still show chart / 52wk / notes /
        # alerts (empty ladder). None only if the symbol is entirely unknown.
        if ticker is None:
            return None
        q = hub.latest.get(symbol, {})
        wprice = _f(q.get("last")) if q.get("last") is not None else None
        div_data = await get_dividends(account_hash)
        sym_div = round(sum(_f(d.get("amount")) for d in div_data.get("rows", [])
                            if (d.get("symbol") or "").upper() == symbol), 2)
        last_held = (await get_last_held(account_hash)).get(symbol)
        w_avg, w_median, _wh, _wl, w_weeks = _ref_window(symbol, ticker, q)
        return {
            "symbol": symbol, "name": ticker.name, "sector": ticker.sector, "risk": _risk(ticker),
            "price": round(wprice, 4) if wprice else None,
            "positions": 0, "shares": 0.0, "invested": 0.0, "basis_per_share": 0.0,
            "lilo_pct": None, "avg_52wk": w_avg, "median_52wk": w_median, "ref_window_weeks": w_weeks,
            "unrealized": None, "realized": round(_f(realized), 2), "dividends": sym_div,
            "total_return": round(_f(realized) + sym_div, 2),
            "is_watch": True, "last_held": last_held,
            "underlying": etf_underlying, "is_leveraged": etf_is_lev,
            "rules_override": sym_override,
            "lots": [], "projected_ladder": [],
        }

    quote = hub.latest.get(symbol, {})
    price = quote.get("last")
    price = _f(price) if price is not None else None
    has_price = price is not None and price > 0

    # Same rules as the dashboard row: cost, basis and P/L use only lots with a KNOWN
    # cost; LILO is measured from the newest lot (the one a LIFO sale retires first).
    priced = [l for l in lots if _f(l.buy_price) > 0]
    shares = sum(_f(l.shares) for l in lots)
    priced_shares = sum(_f(l.shares) for l in priced)
    invested = sum(_f(l.shares) * _f(l.buy_price) for l in priced)
    newest_bp = _f(lots[-1].buy_price) if lots else 0.0

    lot_rows = []
    prev_price = None
    for l in lots:
        bp = _f(l.buy_price)
        sh = _f(l.shares)
        known = bp > 0   # a lot with no known cost gets no target / P/L (can't be honest)
        target = _lot_sell_target(l, cfg)
        lot_rows.append({
            "id": l.id,
            "rung": l.rung,
            "source": l.source,
            "buy_date": l.buy_date.isoformat() if l.buy_date else None,
            "age_days": (_today() - l.buy_date).days if l.buy_date else None,
            "shares": round(sh, 4),
            "buy_price": round(bp, 4),
            "amount": round(sh * bp, 2),
            "pct_down_from_prev": round(1 - bp / prev_price, 4) if prev_price else None,
            "cost_unknown": not known,
            "sell_target": round(target, 4) if known else None,
            "sell_mode": l.sell_mode or cfg.sell.default_mode,
            "proj_profit": round((target - bp) * sh, 2) if known else None,
            # live P/L if this lot were sold right now
            "pl_now": round((price - bp) * sh, 2) if has_price and known else None,
            "next_buy_sug": round(rules.next_buy_price(bp, l.rung + 1, cfg, deployed), 4) if known else None,
        })
        prev_price = bp

    # Projected future positions continue from the ACTUAL last fill, not an idealized
    # rung-1 chain — so they reflect real fill drift and match the Stock Data next-buy
    # (which is derived from the deepest filled lot). There's no user cap on ladder depth
    # anymore, so we just project a short fixed horizon (the next few) — the UI reveals
    # the next 5 on demand.
    projected = []
    if lots:
        prev_price = _f(lots[-1].buy_price)
        for rung in range(len(lots) + 1, len(lots) + 1 + 5):
            trigger = rules.next_buy_price(prev_price, rung, cfg, deployed)
            dollars = rules.sizing_dollars(rung - 1, cfg)
            projected.append({
                "rung": rung,
                "trigger_price": round(trigger, 4),
                "suggested_dollars": dollars,
                "suggested_shares": round(dollars / trigger, 2) if trigger else None,
            })
            prev_price = trigger

    # Dividends received for THIS symbol (from the stored income log).
    div_data = await get_dividends(account_hash)
    sym_dividends = round(sum(_f(d.get("amount")) for d in div_data.get("rows", [])
                              if (d.get("symbol") or "").upper() == symbol), 2)
    ref_avg, ref_median, _rh, _rl, ref_weeks = _ref_window(symbol, ticker, quote)

    return {
        "symbol": symbol,
        "name": ticker.name if ticker else None,
        "sector": ticker.sector if ticker else None,
        "risk": _risk(ticker),
        "price": round(price, 4) if has_price else None,
        "positions": len(lots),
        "shares": round(shares, 4),
        "invested": round(invested, 2),
        "basis_per_share": round(rules.basis_per_share(invested, priced_shares), 4) if priced_shares > 0 else 0.0,
        "lilo_pct": round(rules.lilo_pct(price, newest_bp), 4) if has_price and newest_bp > 0 else None,
        "cost_unknown": len(priced) < len(lots),
        # Avg/median reference levels for the chart overlay (None until warmed). 13wk for
        # leveraged/inverse ETFs (decay makes a year stale), else 52wk — ref_window_weeks says which.
        "avg_52wk": ref_avg,
        "median_52wk": ref_median,
        "ref_window_weeks": ref_weeks,
        # P/L split: unrealized = mark-to-market on open lots; realized = booked round-trips;
        # dividends = income received for this name. total_return sums all three (a single
        # name — no double count: price P/L and cash dividends are distinct).
        "unrealized": round(priced_shares * price - invested, 2) if has_price else None,
        "realized": round(_f(realized), 2),
        "last_sold": round(_f(last_sold_val), 4) if last_sold_val else None,
        "dividends": sym_dividends,
        "total_return": round(_f(realized) + sym_dividends + (priced_shares * price - invested if has_price else 0.0), 2),
        "underlying": etf_underlying, "is_leveraged": etf_is_lev,
        "rules_override": sym_override,   # per-ticker override (None = global rules)
        "lots": lot_rows,
        "projected_ladder": projected,
    }
