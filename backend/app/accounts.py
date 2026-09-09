"""Schwab account discovery + selection.

One Schwab login can expose several investment accounts. Schwab also hides some
(e.g. managed accounts) from the Accounts & Trading API entirely, so we list
exactly what the API returns and let the user pick the active one. The selection
is persisted in app_setting and used for positions/balances/orders. (Market-data
quotes are account-agnostic and unaffected.)
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone

from .db import SessionLocal, dialect_insert as pg_insert
from .db.models import AppSetting
from .schwab import auth as _auth
from .schwab.auth import get_client

import logging
from .util import _f
from .symbols import resolve_symbol

log = logging.getLogger("schwab.accounts")
# Strong refs to fire-and-forget background tasks so the loop can't GC them mid-run;
# the done-callback discards each when it finishes.
_bg_tasks: set[asyncio.Task] = set()

REAUTH_ERROR = "Schwab reauthorization required"

SELECTED_KEY = "selected_account_hash"   # the active account: scopes all views AND trading

# Schwab transaction types that represent OUTSIDE money crossing the account
# boundary (not trades, dividends, or internal marks). The type only GATES whether a
# row is a transfer at all — DIRECTION comes from netAmount's sign (see parse_transfers),
# because ELECTRONIC_FUND is bidirectional: Schwab files both deposits AND withdrawals
# under it, so a withdrawal keyed off the type alone flips into a phantom deposit. JOURNAL
# is intentionally EXCLUDED — it's an internal transfer and often nets to zero / ambiguous.
_TRANSFER_IN = {"ACH_RECEIPT", "WIRE_IN", "CASH_RECEIPT", "ELECTRONIC_FUND"}
_TRANSFER_OUT = {"ACH_DISBURSEMENT", "WIRE_OUT", "CASH_DISBURSEMENT"}


def _sel_key() -> str:
    """The selected-account setting key, scoped to the ACTIVE profile so each
    profile remembers its own selection."""
    from . import profiles
    return profiles.pkey(SELECTED_KEY)


def _mask(num) -> str:
    s = str(num)
    return f"...{s[-4:]}" if len(s) > 4 else s


async def get_setting(key: str) -> str | None:
    async with SessionLocal() as s:
        row = await s.get(AppSetting, key)
        return row.value if row else None


async def set_setting(key: str, value: str) -> None:
    # Atomic upsert — avoids a get-then-insert race to a duplicate-PK error when
    # two requests first-write the same key concurrently.
    stmt = (
        pg_insert(AppSetting)
        .values(key=key, value=value)
        .on_conflict_do_update(index_elements=[AppSetting.key], set_={"value": value})
    )
    async with SessionLocal() as s:
        await s.execute(stmt)
        await s.commit()


def _fetch_accounts_sync(client) -> list[dict]:
    nums = client.get_account_numbers().json()
    if not isinstance(nums, list):  # error payload (e.g. {"error": ...}) — not accounts
        return []
    out: list[dict] = []
    for n in nums:
        h = n.get("hashValue")
        entry = {
            "hash": h,
            "mask": _mask(n.get("accountNumber")),
            "type": None,
            "liquidation_value": None,
            "cash": None,
            "positions_count": None,
            "day_profit": None,     # sum of per-position currentDayProfitLoss
            "invested": None,       # long market value
            "tradable": True,
        }
        try:
            r = client.get_account(h, fields=client.Account.Fields.POSITIONS)
            if r.status_code == 200:
                sa = r.json().get("securitiesAccount", {})
                bal = sa.get("currentBalances", {}) or {}
                positions = sa.get("positions", []) or []
                entry["type"] = sa.get("type")
                entry["liquidation_value"] = bal.get("liquidationValue")
                entry["cash"] = bal.get("cashBalance")
                entry["positions_count"] = len(positions)
                entry["day_profit"] = round(sum(
                    float(p.get("currentDayProfitLoss") or 0.0) for p in positions), 2)
                entry["invested"] = bal.get("longMarketValue")
            else:
                entry["tradable"] = False  # API reachable but this account is restricted
        except Exception:
            entry["tradable"] = False
        out.append(entry)
    return out


async def list_accounts() -> dict:
    client = get_client()
    if client is None:
        return {"accounts": [], "selected_hash": None, "error": "no Schwab token"}
    try:
        # load_client() succeeds on a stale token file; the real auth failure
        # (refresh token expired ~weekly, or superseded by another instance) surfaces
        # here on the first API call.
        accounts = await asyncio.to_thread(_fetch_accounts_sync, client)
    except Exception:
        _auth.mark_reauth_needed()  # so token_status reflects the real (rejected) state
        return {"accounts": [], "selected_hash": None, "error": REAUTH_ERROR}
    _auth.clear_reauth_needed()  # a successful call means the token is good
    selected = await get_setting(_sel_key())
    if not selected and accounts:  # default to the first account
        selected = accounts[0]["hash"]
        await set_setting(_sel_key(), selected)
    return {"accounts": accounts, "selected_hash": selected}


async def _bg_resync(account_hash: str) -> None:
    """Guarded fire-and-forget resync so a failure logs instead of surfacing as an
    'unretrieved task exception'. resync_account is idempotent + per-account-locked."""
    from . import rebuild as rebuild_svc  # lazy import to avoid an import cycle
    try:
        await rebuild_svc.resync_account(account_hash)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        log.warning(f"[select-resync] {account_hash[-4:]} failed: {e!r}")


async def select_account(account_hash: str) -> dict:
    await set_setting(_sel_key(), account_hash)
    # Auto-sync the newly-selected account immediately so switching accounts refreshes
    # it now — including a non-trading account, which the activity resync loop skips.
    # Retain a strong ref + discard on completion so the task isn't GC'd mid-flight.
    t = asyncio.create_task(_bg_resync(account_hash))
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)
    return {"selected_hash": account_hash}


async def get_trading_account() -> str | None:
    """The account orders go to: the SELECTED account (no trading gate)."""
    return await get_setting(_sel_key())   # the selected account; no trading gate


async def held_shares(account_hash: str, symbol: str) -> float | None:
    """Long shares currently held for `symbol` on the account, or None if the
    account isn't readable. Used to block accidental over-sells/shorts."""
    client = get_client()
    if client is None or not account_hash:
        return None
    symbol = symbol.upper()

    def fetch():
        r = client.get_account(account_hash, fields=client.Account.Fields.POSITIONS)
        if r.status_code != 200:
            return None
        sa = r.json().get("securitiesAccount", {})
        for p in sa.get("positions", []) or []:
            # Resolve CUSIP-reported holdings so a sell of RCAX isn't refused (held=0)
            # just because Schwab listed the shares under 88636W718 that day.
            if resolve_symbol(client, p.get("instrument", {}) or {}) == symbol:
                return float(p.get("longQuantity") or 0)
        return 0.0

    try:
        return await asyncio.to_thread(fetch)
    except Exception:
        return None


async def account_balances(account_hash: str) -> dict:
    """Live currentBalances for one account (no positions payload — lighter).
    Returns {blocked: True, ...} when unreadable so the ledger can fall back to the
    last daily snapshot instead of showing $0. All figures are point-in-time and
    mark-to-market; margin/buying-power drift intraday (Reg-T + marginable mix)."""
    client = get_client()
    if client is None or not account_hash:
        return {"blocked": True, "error": "no Schwab token / account"}

    def fetch():
        r = client.get_account(account_hash)   # balances only, no POSITIONS field
        if r.status_code != 200:
            return None
        return r.json().get("securitiesAccount", {})

    try:
        sa = await asyncio.to_thread(fetch)
    except Exception:
        _auth.mark_reauth_needed()
        return {"blocked": True, "error": REAUTH_ERROR}
    if sa is None:
        return {"blocked": True, "error": "account not accessible"}
    _auth.clear_reauth_needed()
    bal = sa.get("currentBalances", {}) or {}
    return {
        "blocked": False,
        "type": sa.get("type"),
        "account_value": bal.get("liquidationValue"),
        "cash": bal.get("cashBalance"),
        "buying_power": bal.get("buyingPower"),
        "margin_buying_power": bal.get("marginBuyingPower"),
        "long_market_value": bal.get("longMarketValue"),
        "available_funds": bal.get("availableFunds"),
        # Conservative "what can I actually deploy now" candidates. The NON-marginable
        # figures are settled-cash + fully-paid-securities borrowing — Schwab's account
        # page shows these as "Settled Funds" / "Funds Available to Withdraw", and they
        # are the real trading constraint. Reg-T `buyingPower` overstates it (assumes
        # everything is marginable at 25% maint), so orders sized to it get rejected.
        "available_funds_non_marginable": bal.get("availableFundsNonMarginableTrade"),
        "buying_power_non_marginable": bal.get("buyingPowerNonMarginableTrade"),
        "day_trading_buying_power": bal.get("dayTradingBuyingPower"),
        "sma": bal.get("sma"),
        # Margin-account fields (present only when type == MARGIN). marginBalance is the
        # borrowed debit (negative when carrying a loan); equity is the trader's own money.
        "margin_balance": bal.get("marginBalance"),
        "equity": bal.get("equity"),
        "maintenance_requirement": bal.get("maintenanceRequirement"),
    }


# Deployment % is read on the dashboard hot path (per tick) when ladder scaling is
# on, but it only moves as fills/prices change — cache it so we hit Schwab at most
# once a minute per account instead of every render.
_deploy_cache: dict[str, tuple[float, float | None]] = {}
_DEPLOY_TTL_S = 60.0


async def deployed_pct(account_hash: str) -> float | None:
    """Cached account deployment % (market value ÷ capacity, 0–100). None when balances
    are unavailable — callers treat None as 'unknown' so ladder scaling no-ops."""
    now = time.monotonic()
    hit = _deploy_cache.get(account_hash)
    if hit and (now - hit[0]) < _DEPLOY_TTL_S:
        return hit[1]
    m = await margin_summary(account_hash)
    val = None if m.get("blocked") else m.get("deployed_pct")
    _deploy_cache[account_hash] = (now, val)
    return val


def select_tradable_funds(b: dict) -> float | None:
    """The amount actually deployable RIGHT NOW, from Schwab's balance fields — pure so
    it's unit-tested. Prefers the conservative non-marginable-trade availability (settled
    cash + borrowing against fully-paid stock — what Schwab shows as "Settled Funds" /
    "Funds Available to Withdraw"), then looser figures, finally Reg-T buying power. This
    is the real constraint: sizing to Reg-T `buyingPower` on a partly-settled or
    concentrated account gets the order rejected even though buying power "looks" larger.
    Returns None only when no figure is available (caller then omits the flag)."""
    def _n(x):
        return float(x) if isinstance(x, (int, float)) else None
    for key in ("available_funds_non_marginable", "buying_power_non_marginable",
                "available_funds", "buying_power"):
        v = _n(b.get(key))
        if v is not None:
            return round(v, 2)
    return None


def deployment_pct(lmv: float | None, equity: float | None) -> float | None:
    """THE canonical capital-deployment figure: long market value as a % of your OWN equity.
    ~100% when fully invested; OVER 100% when margin buys more than your equity (the
    'am I stretched?' signal — deliberately uncapped, and NOT counting margin buying power as
    capacity). None when a balance is missing or equity is zero, so callers read it as
    'unknown' rather than a misleading number. Pure so it's unit-tested; one definition,
    rendered by the account-band meter and the glossary and read by ladder deployment-scaling."""
    if lmv is None or not equity:
        return None
    return round(lmv / equity * 100, 1)


async def margin_summary(account_hash: str) -> dict:
    """Capital-deployment / leverage view for an account — the sheet's 'how much of my
    capacity is in the market, how much is borrowed, how far from a margin call' picture,
    built entirely from Schwab's live currentBalances (no invented 'total available').

    All figures point-in-time & mark-to-market. `blocked` mirrors account_balances so the
    UI can degrade gracefully. `is_margin` is False for cash accounts (debt/leverage N/A)."""
    b = await account_balances(account_hash)
    if b.get("blocked"):
        return {"blocked": True, "error": b.get("error")}

    def _n(x):
        return float(x) if isinstance(x, (int, float)) else None

    equity = _n(b.get("equity"))
    lmv = _n(b.get("long_market_value"))
    acct_value = _n(b.get("account_value"))
    bp = _n(b.get("buying_power"))
    margin_bp = _n(b.get("margin_buying_power"))
    maint = _n(b.get("maintenance_requirement"))
    mbal = _n(b.get("margin_balance"))
    is_margin = (b.get("type") == "MARGIN")
    # Borrowed = the negative margin balance (debit). Positive credit ⇒ no loan.
    debt = round(-mbal, 2) if (mbal is not None and mbal < 0) else 0.0
    # Leverage = long exposure / your own equity (1.0 = unlevered, >1 = using margin).
    eq_base = equity if equity is not None else acct_value
    # Deployed % = long market value vs. YOUR OWN capital (equity) — the canonical figure
    # (see deployment_pct): all-cash-invested reads ~100%, margin pushes it OVER 100%.
    deployed_pct = deployment_pct(lmv, eq_base)
    leverage = round(lmv / eq_base, 2) if (lmv is not None and eq_base) else None
    # Cushion to a maintenance call: equity above the required maintenance.
    maint_cushion = round(eq_base - maint, 2) if (eq_base is not None and maint is not None) else None
    maint_cushion_pct = round(maint_cushion / eq_base * 100, 1) if (maint_cushion is not None and eq_base) else None

    return {
        "blocked": False,
        "is_margin": is_margin,
        "account_value": acct_value,
        "equity": equity if equity is not None else acct_value,
        "long_market_value": lmv,
        "cash": _n(b.get("cash")),
        "debt": debt,                       # "Debt on Owned" — borrowed against positions
        "buying_power": bp,                 # Reg-T buying power (the loose, marginable figure)
        "margin_buying_power": margin_bp,
        # The conservative "what I can actually trade with now" figure — see
        # select_tradable_funds. This is what the app's advisory affordability checks and
        # the "Available to trade" display should use, NOT buying_power.
        "tradable_funds": select_tradable_funds(b),
        "available_funds": _n(b.get("available_funds")),
        "available_funds_non_marginable": _n(b.get("available_funds_non_marginable")),
        "buying_power_non_marginable": _n(b.get("buying_power_non_marginable")),
        "day_trading_buying_power": _n(b.get("day_trading_buying_power")),
        "sma": _n(b.get("sma")),
        "maintenance_requirement": maint,
        "maint_cushion": maint_cushion,     # equity above the maintenance floor
        "maint_cushion_pct": maint_cushion_pct,
        "deployed_pct": deployed_pct,       # % of capacity currently in the market
        "leverage": leverage,               # long exposure ÷ equity
    }


async def fetch_transactions_raw(account_hash: str, days: int = 60) -> list | None:
    """The raw trailing-window transactions payload — ONE Schwab call that feeds every
    consumer (transfers, dividends, trade fees, margin interest; see ledger.sync_activity).
    Returns the raw list or None on error/no-token (caller treats None as 'unknown' —
    never wipe a log on it).

    NOTE: the endpoint actually serves history back to the account's thinkorswim/API
    enablement (max 1 YEAR per request), NOT just 60 days — 60 is the cheap INCREMENTAL
    window used by the hourly sync. The one-time full-history pull pages 1-year windows
    via fetch_transactions_window (see ledger.backfill_activity)."""
    end = datetime.now(timezone.utc)
    return await fetch_transactions_window(
        account_hash, end - timedelta(days=min(max(days, 1), 365)), end)


async def fetch_transactions_window(account_hash: str, start: datetime, end: datetime) -> list | None:
    """Raw transactions for an EXPLICIT window (caller must keep it <= 1 year — Schwab
    400s a wider range). Returns the raw list, or None on error/no-token."""
    client = get_client()
    if client is None or not account_hash:
        return None

    def fetch():
        r = client.get_transactions(account_hash, start_date=start, end_date=end)
        if r.status_code != 200:
            return None
        data = r.json()
        return data if isinstance(data, list) else None

    try:
        return await asyncio.to_thread(fetch)
    except Exception:
        return None


def parse_transfers(data: list) -> list[dict]:
    """Filter a raw transactions payload to outside-money transfers → normalized
    {schwab_txn_id, day, amount(signed), kind} rows. Pure.

    DIRECTION comes from netAmount's sign (Schwab signs cash-out negative), NOT the type:
    ELECTRONIC_FUND carries both deposits and withdrawals, so a −$20,000 ELECTRONIC_FUND
    withdrawal keyed off the type would flip into a phantom +$20,000 deposit (the Andrew
    ...580 bug). The one-way types agree with the sign; a guard keeps a DISBURSEMENT a
    withdrawal even in the unlikely event a row arrives with an unsigned (positive) net."""
    out: list[dict] = []
    for t in data:
        ty = t.get("type")
        is_in, is_out = ty in _TRANSFER_IN, ty in _TRANSFER_OUT
        if not (is_in or is_out):
            continue
        net = round(_f(t.get("netAmount")), 2)
        if net == 0:
            continue
        # Trust netAmount's sign; only override when a strictly one-way OUT type arrives
        # positive (defensive against an unsigned amount — never lets a disbursement read
        # as a deposit). Bidirectional ELECTRONIC_FUND therefore keeps its real sign.
        amount = -abs(net) if (is_out and not is_in and net > 0) else net
        day = (t.get("tradeDate") or t.get("time") or "")[:10]
        txid = str(t.get("activityId") or t.get("transactionId") or t.get("id") or "")
        out.append({
            "schwab_txn_id": txid or None,
            "day": day,
            "amount": round(amount, 2),
            "kind": "deposit" if amount >= 0 else "withdrawal",
            "type": ty,
        })
    return out


async def fetch_transfers(account_hash: str, days: int = 60) -> list[dict] | None:
    """Outside-money transfers (deposits/withdrawals) — fetch_transactions_raw +
    parse_transfers. None means 'unknown' (never wipe the log)."""
    data = await fetch_transactions_raw(account_hash, days)
    return None if data is None else parse_transfers(data)


async def fetch_dividends(account_hash: str, days: int = 60) -> list[dict] | None:
    """Dividend/interest income — fetch_transactions_raw + dividends.parse_dividends.
    None means 'unknown' (never wipe the stored log)."""
    from . import dividends as dividends_mod

    data = await fetch_transactions_raw(account_hash, days)
    return None if data is None else dividends_mod.parse_dividends(data)


async def selected_account_positions() -> dict:
    """Live positions/balances for the currently selected account."""
    client = get_client()
    sel = await get_setting(_sel_key())
    if client is None or not sel:
        return {"selected_hash": sel, "positions": [], "error": "no account selected"}

    def fetch():
        r = client.get_account(sel, fields=client.Account.Fields.POSITIONS)
        if r.status_code != 200:
            return None
        return r.json().get("securitiesAccount", {})

    try:
        sa = await asyncio.to_thread(fetch)
    except Exception:
        _auth.mark_reauth_needed()
        return {"selected_hash": sel, "positions": [], "error": REAUTH_ERROR}
    if sa is None:
        return {"selected_hash": sel, "positions": [], "error": "account not accessible"}
    _auth.clear_reauth_needed()

    bal = sa.get("currentBalances", {}) or {}
    positions = [
        {
            # Ticker when resolvable; the raw identifier otherwise so the row is still shown.
            "symbol": resolve_symbol(client, p.get("instrument", {}) or {}) or (p.get("instrument", {}) or {}).get("symbol"),
            "shares": p.get("longQuantity"),
            "avg_price": p.get("averagePrice"),
            "market_value": p.get("marketValue"),
        }
        for p in (sa.get("positions", []) or [])
    ]
    return {
        "selected_hash": sel,
        "type": sa.get("type"),
        "liquidation_value": bal.get("liquidationValue"),
        "cash": bal.get("cashBalance"),
        "positions": positions,
    }
