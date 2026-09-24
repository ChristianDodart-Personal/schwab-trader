"""API explorer (experimental): every READ-ONLY call the Schwab Trader API offers, runnable
from the Explore tab so a new feature starts from what Schwab actually returns.

Hard rule: only GET calls live here. Nothing in this module can place, replace, cancel or
preview an order; `run` only dispatches ids in CATALOG, and every CATALOG entry maps to a
read-only schwab-py method. Calls go through the one shared client (get_client), so they
never rotate the refresh token.

Each entry says what the app does with the endpoint today ("used_for"), so the tab doubles
as a map of which data is in use and which is sitting unused."""
from __future__ import annotations

import asyncio
import json
import time
from datetime import date, datetime, timedelta, timezone

from .schwab.auth import get_client
from .schwab import hub

_MAX_BYTES = 3_000_000   # bigger payloads come back truncated rather than freezing the UI

TXN_TYPES = ["ALL", "TRADE", "RECEIVE_AND_DELIVER", "DIVIDEND_OR_INTEREST", "ACH_RECEIPT",
             "ACH_DISBURSEMENT", "CASH_RECEIPT", "CASH_DISBURSEMENT", "ELECTRONIC_FUND",
             "WIRE_OUT", "WIRE_IN", "JOURNAL", "MEMORANDUM", "MARGIN_CALL", "MONEY_MARKET",
             "SMA_ADJUSTMENT"]
ORDER_STATUSES = ["ANY", "WORKING", "FILLED", "CANCELED", "REJECTED", "EXPIRED", "PENDING_ACTIVATION",
                  "QUEUED", "ACCEPTED", "AWAITING_PARENT_ORDER", "REPLACED"]
HISTORY_FREQ = {
    "1 minute": "get_price_history_every_minute",
    "5 minutes": "get_price_history_every_five_minutes",
    "10 minutes": "get_price_history_every_ten_minutes",
    "15 minutes": "get_price_history_every_fifteen_minutes",
    "30 minutes": "get_price_history_every_thirty_minutes",
    "1 day": "get_price_history_every_day",
    "1 week": "get_price_history_every_week",
}
MOVER_INDEXES = ["SPX", "DJI", "COMPX", "NYSE", "NASDAQ", "OTCBB", "INDEX_ALL", "EQUITY_ALL",
                 "OPTION_ALL", "OPTION_PUT", "OPTION_CALL"]
MARKETS = ["EQUITY", "OPTION", "BOND", "FUTURE", "FOREX"]
PROJECTIONS = ["SYMBOL_SEARCH", "SYMBOL_REGEX", "DESCRIPTION_SEARCH", "DESCRIPTION_REGEX",
               "SEARCH", "FUNDAMENTAL"]


def _p(name, kind, default=None, label=None, options=None, help=None):
    return {"name": name, "kind": kind, "default": default, "label": label or name,
            "options": options, "help": help}


# group, id, label, what it returns, what the app uses it for (None = unused), params
CATALOG: list[dict] = [
    # ---- accounts ----
    dict(id="account_numbers", group="Accounts", label="Account numbers",
         what="Each linked account's plain number and the hash every other account call takes.",
         used_for="Account list and the connection health probe.", params=[]),
    dict(id="account", group="Accounts", label="Account (balances + positions)",
         what="Balances (initial / current / projected) and, with positions on, every holding: long/short "
              "quantity, previous-session quantity, average price, tax-lot average, market value, day P/L, "
              "maintenance requirement.",
         used_for="Holdings sync, held-shares check before a sell, cash/margin, deployment %, per-position day P/L.",
         params=[_p("positions", "bool", True, "Include positions")]),
    dict(id="accounts", group="Accounts", label="All accounts",
         what="The same account payload for every linked account in one call.",
         used_for=None, params=[_p("positions", "bool", False, "Include positions")]),
    dict(id="user_preferences", group="Accounts", label="User preferences",
         what="Account nicknames, the display settings from Schwab's site, and the streamer connection info.",
         used_for=None, params=[]),
    # ---- transactions & orders ----
    dict(id="transactions", group="Transactions & orders", label="Transactions",
         what="Posted account activity: trades, corporate actions (RECEIVE_AND_DELIVER: splits, mergers, "
              "symbol/CUSIP changes), dividends and interest, transfers, journals. Max 1 year per request.",
         used_for="TRADE rows build the fill ledger. The ledger's cash-flow sync pulls ALL types but reads "
                  "only trades, transfers, dividends, interest and journals; RECEIVE_AND_DELIVER and the rest "
                  "are ignored today.",
         params=[_p("days", "int", 90, "Days back (max 365)"),
                 _p("type", "select", "ALL", "Type", TXN_TYPES),
                 _p("symbol", "text", "", "Symbol (optional)")]),
    dict(id="transaction", group="Transactions & orders", label="One transaction",
         what="A single transaction by its activityId, with every transfer item.",
         used_for=None, params=[_p("transaction_id", "text", "", "Transaction id")]),
    dict(id="orders", group="Transactions & orders", label="Orders",
         what="Orders entered in a window with status, legs, and execution legs (fill prices and times).",
         used_for="Orders tab, working-order badge, fill fallback when transactions are unavailable.",
         params=[_p("days", "int", 30, "Days back (max 365)"),
                 _p("status", "select", "ANY", "Status", ORDER_STATUSES)]),
    dict(id="order", group="Transactions & orders", label="One order",
         what="A single order by id, including its activity collection.",
         used_for="Replace/cancel flow reads the original order first.",
         params=[_p("order_id", "text", "", "Order id")]),
    # ---- market data ----
    dict(id="quotes", group="Market data", label="Quotes",
         what="Level-one quote per symbol. QUOTE = bid/ask/last/volume/52-wk; FUNDAMENTAL = P/E, EPS, dividend "
              "yield/amount/dates, shares outstanding, avg volume; REFERENCE = CUSIP, exchange, description, "
              "hard-to-borrow/shortable; EXTENDED = pre/post-market prices; REGULAR = regular-session last.",
         used_for="Watchlist adds, price-alert checks, dashboard fallback when the stream is down.",
         params=[_p("symbols", "text", "AAPL", "Symbols (comma-separated)"),
                 _p("fields", "select", "ALL", "Fields", ["ALL", "QUOTE", "FUNDAMENTAL", "REFERENCE", "EXTENDED", "REGULAR"])]),
    dict(id="price_history", group="Market data", label="Price history (candles)",
         what="OHLCV candles at a chosen frequency, optionally with extended hours and the previous close.",
         used_for="Drill-down chart (5-min / 30-min / daily) and the 5-year benchmark.",
         params=[_p("symbol", "text", "AAPL", "Symbol"),
                 _p("frequency", "select", "1 day", "Frequency", list(HISTORY_FREQ)),
                 _p("days", "int", 30, "Days back"),
                 _p("extended", "bool", False, "Extended hours")]),
    dict(id="market_hours", group="Market data", label="Market hours",
         what="Session open/close times (pre, regular, post) for a market on a date.",
         used_for="The hours badge and the extended-hours session choice on tickets.",
         params=[_p("market", "select", "EQUITY", "Market", MARKETS),
                 _p("date", "text", "", "Date YYYY-MM-DD (blank = today)")]),
    dict(id="movers", group="Market data", label="Movers",
         what="Top 10 movers in an index by volume, trades, or percent change.",
         used_for=None, params=[_p("index", "select", "SPX", "Index", MOVER_INDEXES),
                               _p("sort", "select", "PERCENT_CHANGE_UP", "Sort",
                                  ["PERCENT_CHANGE_UP", "PERCENT_CHANGE_DOWN", "VOLUME", "TRADES"])]),
    dict(id="option_expirations", group="Market data", label="Option expirations",
         what="Every listed expiration date for a symbol's options, with days to expiry.",
         used_for=None, params=[_p("symbol", "text", "AAPL", "Symbol")]),
    dict(id="option_chain", group="Market data", label="Option chain",
         what="Calls and puts per expiration and strike: bid/ask, greeks, implied volatility, open interest.",
         used_for=None, params=[_p("symbol", "text", "AAPL", "Symbol"),
                               _p("contract_type", "select", "ALL", "Type", ["ALL", "CALL", "PUT"]),
                               _p("strike_count", "int", 6, "Strikes around the money")]),
    # ---- instruments ----
    dict(id="instruments", group="Instruments", label="Instrument search",
         what="Look up instruments by symbol or description. FUNDAMENTAL returns a fuller fundamentals block "
              "than a quote (margins, returns, debt ratios, beta).",
         used_for=None, params=[_p("symbols", "text", "AAPL", "Symbol / search text"),
                               _p("projection", "select", "FUNDAMENTAL", "Projection", PROJECTIONS)]),
    dict(id="instrument_by_cusip", group="Instruments", label="Instrument by CUSIP",
         what="Resolve a 9-character CUSIP to its symbol and description.",
         used_for="Turns a holding Schwab reports under its CUSIP (RCAX after its reverse split) into a ticker.",
         params=[_p("cusip", "text", "", "CUSIP")]),
    # ---- streaming (what the app already has in memory) ----
    dict(id="stream_quote", group="Streaming", label="Latest streamed quote",
         what="The last level-one tick the app's streamer merged for a symbol (only symbols it streams). "
              "Other streams Schwab offers and the app doesn't subscribe to: CHART_EQUITY (1-min bars), "
              "NASDAQ_BOOK / NYSE_BOOK (level 2), SCREENER_EQUITY, LEVELONE_OPTIONS / FUTURES.",
         used_for="Live prices everywhere (LEVELONE_EQUITIES); ACCT_ACTIVITY triggers a holdings resync.",
         params=[_p("symbol", "text", "", "Symbol (blank = list streamed symbols)")]),
]

RECIPES: list[dict] = [
    dict(question="How does Schwab record a split, merger or CUSIP change?", id="transactions",
         params={"days": 365, "type": "RECEIVE_AND_DELIVER", "symbol": ""}),
    dict(question="Which transaction types does my account actually have?", id="transactions",
         params={"days": 365, "type": "ALL", "symbol": ""}),
    dict(question="What does Schwab say about each holding?", id="account", params={"positions": True}),
    dict(question="What fundamentals come with a quote?", id="quotes", params={"symbols": "AAPL", "fields": "FUNDAMENTAL"}),
]

_BY_ID = {e["id"]: e for e in CATALOG}


def catalog() -> dict:
    return {"endpoints": CATALOG, "recipes": RECIPES}


def _int(v, default, lo, hi) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = default
    return max(lo, min(hi, n))


def _call(client, eid: str, p: dict, account_hash: str):
    """Sync (run in a thread). Returns an httpx-like response."""
    C = type(client)
    now = datetime.now(timezone.utc)
    if eid == "account_numbers":
        return client.get_account_numbers()
    if eid == "account":
        return client.get_account(account_hash, fields=C.Account.Fields.POSITIONS if p.get("positions") else None)
    if eid == "accounts":
        return client.get_accounts(fields=C.Account.Fields.POSITIONS if p.get("positions") else None)
    if eid == "user_preferences":
        return client.get_user_preferences()
    if eid == "transactions":
        days = _int(p.get("days"), 90, 1, 365)
        ty = str(p.get("type") or "ALL").upper()
        kwargs = {"start_date": now - timedelta(days=days), "end_date": now}
        if ty != "ALL":
            kwargs["transaction_types"] = C.Transactions.TransactionType[ty]
        if (p.get("symbol") or "").strip():
            kwargs["symbol"] = p["symbol"].strip().upper()
        return client.get_transactions(account_hash, **kwargs)
    if eid == "transaction":
        return client.get_transaction(account_hash, str(p.get("transaction_id") or "").strip())
    if eid == "orders":
        days = _int(p.get("days"), 30, 1, 365)
        st = str(p.get("status") or "ANY").upper()
        kwargs = {"from_entered_datetime": now - timedelta(days=days), "to_entered_datetime": now}
        if st != "ANY":
            kwargs["status"] = C.Order.Status[st]
        return client.get_orders_for_account(account_hash, **kwargs)
    if eid == "order":
        return client.get_order(str(p.get("order_id") or "").strip(), account_hash)
    if eid == "quotes":
        syms = [s.strip().upper() for s in str(p.get("symbols") or "").split(",") if s.strip()]
        f = str(p.get("fields") or "ALL").upper()
        return client.get_quotes(syms, fields=None if f == "ALL" else [C.Quote.Fields[f]])
    if eid == "price_history":
        fn = getattr(client, HISTORY_FREQ.get(p.get("frequency"), "get_price_history_every_day"))
        days = _int(p.get("days"), 30, 1, 7300)
        return fn(str(p.get("symbol") or "").strip().upper(), start_datetime=now - timedelta(days=days),
                  end_datetime=now, need_extended_hours_data=bool(p.get("extended")), need_previous_close=True)
    if eid == "market_hours":
        d = str(p.get("date") or "").strip()
        m = C.MarketHours.Market[str(p.get("market") or "EQUITY").upper()]
        return client.get_market_hours([m], date=date.fromisoformat(d) if d else None)
    if eid == "movers":
        return client.get_movers(C.Movers.Index[str(p.get("index") or "SPX")],
                                 sort_order=C.Movers.SortOrder[str(p.get("sort") or "PERCENT_CHANGE_UP")])
    if eid == "option_expirations":
        return client.get_option_expiration_chain(str(p.get("symbol") or "").strip().upper())
    if eid == "option_chain":
        ct = str(p.get("contract_type") or "ALL").upper()
        return client.get_option_chain(str(p.get("symbol") or "").strip().upper(),
                                       contract_type=C.Options.ContractType[ct],
                                       strike_count=_int(p.get("strike_count"), 6, 1, 50))
    if eid == "instruments":
        syms = [s.strip() for s in str(p.get("symbols") or "").split(",") if s.strip()]
        return client.get_instruments(syms, C.Instrument.Projection[str(p.get("projection") or "FUNDAMENTAL")])
    if eid == "instrument_by_cusip":
        return client.get_instrument_by_cusip(str(p.get("cusip") or "").strip().upper())
    raise ValueError(f"unknown endpoint {eid}")


def _needs_account(eid: str) -> bool:
    return eid in {"account", "transactions", "transaction", "orders", "order"}


async def run(eid: str, params: dict, account_hash: str) -> dict:
    """Run one catalog call. Returns {ok, http, ms, bytes, data | text, truncated, error}."""
    entry = _BY_ID.get(eid)
    if entry is None:
        return {"ok": False, "error": f"unknown endpoint '{eid}'"}
    params = params or {}
    if eid == "stream_quote":
        sym = str(params.get("symbol") or "").strip().upper()
        data = hub.latest.get(sym) if sym else {"mode": hub.mode, "streamed_symbols": sorted(hub.latest)}
        return {"ok": True, "http": None, "ms": 0, "data": data, "bytes": len(json.dumps(data, default=str))}
    if _needs_account(eid) and not account_hash:
        return {"ok": False, "error": "select an account first"}
    client = get_client()
    if client is None:
        return {"ok": False, "error": "Schwab isn't connected (no token). Reconnect under Settings."}
    t0 = time.perf_counter()
    try:
        resp = await asyncio.to_thread(_call, client, eid, params, account_hash)
    except (KeyError, ValueError) as e:
        return {"ok": False, "error": f"bad parameter: {e}"}
    except Exception as e:
        if "OAuth" in type(e).__name__ or "token" in str(e).lower():
            return {"ok": False, "error": "Schwab rejected the saved login (it has expired). Reconnect under "
                                          f"Settings → Schwab connection, then run this again. ({type(e).__name__})"}
        return {"ok": False, "error": repr(e)}
    ms = round((time.perf_counter() - t0) * 1000)
    body = resp.content or b""
    out: dict = {"ok": 200 <= resp.status_code < 300, "http": resp.status_code, "ms": ms, "bytes": len(body)}
    if len(body) > _MAX_BYTES:
        out.update(truncated=True, text=body[:_MAX_BYTES].decode("utf-8", "replace"))
        return out
    try:
        out["data"] = resp.json()
    except Exception:
        out["text"] = body.decode("utf-8", "replace")
    return out
