"""daily_balance snapshots — the head-start for balance-derived metrics — and the
in-process nightly scheduler that writes them (plus retention pruning)."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import func, select

from ..db import SessionLocal, dialect_insert as pg_insert
from ..db.models import CompletedTrade, DailyBalance
from ._shared import MARKET_TZ, _f, _today

log = logging.getLogger(__name__)


# ----- daily_balance snapshots (the head-start for balance-derived metrics) -----

async def latest_balance(account_hash: str) -> dict:
    async with SessionLocal() as s:
        row = (
            await s.execute(
                select(DailyBalance).where(DailyBalance.account_hash == account_hash)
                .order_by(DailyBalance.day.desc()).limit(1)
            )
        ).scalar_one_or_none()
    if row is None:
        return {"balance_blocked": True, "reason": "no daily_balance snapshots yet"}
    return {
        "balance_blocked": False,
        "day": row.day.isoformat(),
        "balance": _f(row.balance),
        "capital_gains": _f(row.capital_gains),
        "gross_sales": _f(row.gross_sales),
    }


async def write_snapshot(account_hash: str, balance: float | None) -> dict:
    """Upsert today's daily_balance row for the account. balance comes from Schwab;
    capital_gains/gross_sales for today are computed from completed_trade."""
    today = _today()
    async with SessionLocal() as s:
        cg, gross = (
            await s.execute(
                select(
                    func.coalesce(func.sum(CompletedTrade.profit), 0),
                    func.coalesce(func.sum(CompletedTrade.sell_price * CompletedTrade.shares), 0),
                ).where(CompletedTrade.account_hash == account_hash,
                        CompletedTrade.completed_at == today)
            )
        ).one()
        # Atomic upsert on the (account_hash, day) PK — a get-then-add would let two
        # concurrent snapshots (scheduler + a manual /snapshot) collide on INSERT.
        # balance is only overwritten when provided (don't clobber a good value w/ NULL).
        set_ = {"capital_gains": _f(cg), "gross_sales": _f(gross)}
        if balance is not None:
            set_["balance"] = balance
        stmt = (
            pg_insert(DailyBalance)
            .values(account_hash=account_hash, day=today, balance=balance,
                    capital_gains=_f(cg), gross_sales=_f(gross))
            .on_conflict_do_update(index_elements=["account_hash", "day"], set_=set_)
        )
        await s.execute(stmt)
        await s.commit()
    return {"day": today.isoformat(), "balance": balance, "capital_gains": _f(cg), "gross_sales": _f(gross)}


# --------- nightly balance snapshot scheduler (in-process, always-on app) ---------

async def _snapshot_all_accounts() -> None:
    """Snapshot every visible account's balance for today (keyed per account_hash
    so each account's series stays complete regardless of which one is selected).
    Accounts with an unreadable balance are skipped — a NULL-balance row would
    surface as $0 in the ledger."""
    from .. import accounts as accounts_svc
    from .. import rebuild as rebuild_svc

    info = await accounts_svc.list_accounts()
    today = _today()
    for acct in info.get("accounts", []):
        h, bal = acct.get("hash"), acct.get("liquidation_value")
        if not h:
            continue
        if not acct.get("tradable", True):
            # get_account failed for this account (restricted/unreadable) — a resync
            # would only spend failing API calls and no-op. Skip it entirely.
            log.info(f"[snapshot] skip {h[-4:]}: not readable")
            continue
        # Refresh holdings from Schwab (source of truth) before snapshotting:
        # reconstruct from fills + reconcile against current positions (one path).
        try:
            await rebuild_svc.resync_account(h)
        except Exception as e:
            log.warning(f"[snapshot] sync failed for {h[-4:]}: {e!r}")
        if bal is None:  # don't write a NULL-balance row (would read as $0)
            log.info(f"[snapshot] skip {h[-4:]} day={today}: balance unreadable")
            continue
        try:
            await write_snapshot(h, bal)
            log.info(f"[snapshot] {h[-4:]} day={today} bal={bal}")
        except Exception as e:
            log.warning(f"[snapshot] failed for {h[-4:]}: {e!r}")


async def run_snapshot_scheduler() -> None:
    """Once per trading day, after the close, snapshot every account into
    daily_balance. Started in main.py lifespan. We snapshot only after observing
    the market actually OPEN today (session regular/post) and then in post/closed
    — so we never fire pre-open (overnight 'closed'), on weekends/holidays (market
    never opens), or re-fire after a restart. write_snapshot makes repeats safe."""
    last_day = None
    seen_open_day = None  # the trading day we last observed the market live-open
    while True:
        try:
            from .. import market_hours as market_hours_svc

            hours = await market_hours_svc.market_hours()
            session = hours.get("session")
            now = datetime.now(MARKET_TZ)
            today = _today()
            if session in ("regular", "post"):
                seen_open_day = today
            # Fire once/day, after the market opened today, during/after post-close.
            if session in ("post", "closed") and seen_open_day == today and last_day != today:
                await _snapshot_all_accounts()
                try:
                    from .. import notifications as _notif
                    pruned = await _notif.prune_audit_log()
                    if pruned:
                        log.info(f"[audit] pruned {pruned} old audit rows")
                    pruned_n = await _notif.prune_notifications()
                    if pruned_n:
                        log.info(f"[audit] pruned {pruned_n} old notifications")
                except Exception as e:
                    log.warning(f"[audit] prune failed: {e!r}")
                last_day = today

            if last_day == today:  # done for today → resume ~13:00 MARKET_TZ tomorrow
                tgt = (now + timedelta(days=1)).replace(hour=13, minute=0, second=0, microsecond=0)
                secs = max((tgt - now).total_seconds(), 600)
            else:
                secs = 600  # ~10-min poll near the close (matches market_hours cache)
            await asyncio.sleep(secs)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # a transient API/token error must not kill the loop
            log.warning(f"[snapshot] scheduler error: {e!r}")
            await asyncio.sleep(600)
