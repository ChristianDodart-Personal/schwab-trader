"""Rebuild an account's open lots + completed trades from Schwab, reconciled to truth.

Schwab is the source of truth. Two Schwab inputs combine:
  - FILLS (filled orders) → LIFO reconstruction → the per-rung ladder + closed trades.
  - POSITIONS (current holdings) → the authoritative CURRENT quantity per symbol.
We reconstruct the ladder from fills, then RECONCILE it against live positions so
each symbol's open total always equals what Schwab says you hold — recovering any
shares whose buys fall outside the fill window (or aren't exposed at all, e.g. a
managed account) as a backfilled `source=position` lot.

Safety (a rebuild WIPES then re-inserts, scoped to the account) — a wipe may only
proceed on TRUSTWORTHY inputs; an empty/partial read is never trusted to delete data:
  - fills FETCH FAILED (None) → NO-OP. Never flatten a good ladder on a transient error.
  - EMPTY positions map ({}) → treated as 'no positions' (untrustworthy as 'hold
    nothing'); reconcile is skipped so it can't zero out real holdings.
  - EMPTY fills ([]) + positions present, but the account ALREADY holds fill-derived
    data → REFUSE. Empty fills is normal for a managed account (no fills exposed) but
    an anomaly for a full-access account (its sells are fills); trusting it would wipe
    real completed trades and flatten the ladder into synthetic lots.
  - positions unavailable + no fills → NO-OP; positions unavailable + oversold → REFUSE.
  - fetch + write run inside ONE PER-ACCOUNT lock so a stale snapshot can't clobber a
    newer one, WITHOUT serializing unrelated accounts against each other.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, timedelta

from sqlalchemy import delete, func, select

from .db import SessionLocal, dialect_insert as pg_insert
from .db.models import CompletedTrade, Lot, Ticker
from .reconstruct import Fill, reconcile_open_lots, reconstruct

log = logging.getLogger(__name__)

_locks: dict[str, asyncio.Lock] = {}


def _lock_for(account_hash: str) -> asyncio.Lock:
    """Per-account lock: serialize an account's own fetch+write as one snapshot
    without blocking unrelated accounts — so a near-real-time fill poke for one
    account isn't stuck behind another account's full nightly sync. Created lazily;
    safe on a single-threaded event loop (no await between get and set)."""
    lk = _locks.get(account_hash)
    if lk is None:
        lk = _locks[account_hash] = asyncio.Lock()
    return lk


def _as_date(x):
    return x.date() if hasattr(x, "date") else x


async def _has_fill_derived_data(account_hash: str) -> bool:
    """True if the account currently holds data only a real fill history could have
    produced — completed (realized) trades, or open lots sourced from fills. Used to
    refuse an anomalous empty-fills read that would otherwise destroy it. (A managed
    account has only source='position' lots and no completed trades → returns False,
    so it still backfills from positions normally.)"""
    async with SessionLocal() as s:
        if (await s.execute(
            select(func.count()).select_from(CompletedTrade)
            .where(CompletedTrade.account_hash == account_hash)
        )).scalar():
            return True
        fill_lots = (await s.execute(
            select(func.count()).select_from(Lot)
            .where(Lot.account_hash == account_hash, Lot.source == "fill")
        )).scalar()
    return bool(fill_lots)


async def _fetch_positions_map(account_hash: str):
    """Schwab CURRENT holdings for the account: {symbol: (shares, avg_price)}, or
    None if it couldn't be read (so the caller skips reconciliation rather than wipe)."""
    from .positions_sync import _fetch_positions_sync
    from .schwab.auth import get_client

    client = get_client()
    if client is None:
        return None
    try:
        rows = await asyncio.to_thread(_fetch_positions_sync, client, account_hash)
    except Exception as e:
        log.warning(f"positions fetch failed for {account_hash[-4:]}: {e!r}")
        return None
    if rows is None:
        return None
    return {sym: (qty, avg) for sym, qty, avg in rows}


async def _write(account_hash: str, fills, positions=None) -> dict:
    """Reconstruct (+ reconcile against positions if given) + scoped replace. Holds a per-account lock."""
    if not account_hash:
        return {"ok": False, "error": "no account_hash — refusing to rebuild"}
    if fills is None:
        # Could NOT fetch fills → unknown state → NEVER wipe/flatten a good ladder.
        return {"ok": False, "error": "fills unavailable (fetch error) — left existing data intact"}

    # An EMPTY positions map is indistinguishable from a degraded/partial 200 read,
    # so it is NOT trustworthy as 'you hold nothing'. Treat it like 'no positions'
    # (skip reconcile) rather than letting it zero out real holdings.
    if positions is not None and not positions:
        positions = None

    result = reconstruct(fills)  # fills is [] or [Fill...]
    open_by_symbol = result["open_lots"]
    closed = result["closed"]
    oversold = result["oversold"]

    if positions is not None:
        # Empty fills + positions present: normal for a managed account (exposes no
        # fills → backfill open lots from positions), but an ANOMALY for an account
        # that already has fill-derived history (a full-access account's sells are
        # themselves fills). Trusting it would wipe real completed trades and flatten
        # the ladder into synthetic lots — so refuse and leave the account untouched.
        if not fills and await _has_fill_derived_data(account_hash):
            log.warning(f"{account_hash[-4:]} REFUSED — empty fills but account has "
                        f"fill-derived history (transient/misconfigured read); left data intact")
            return {"ok": False, "refused": "empty fills on an account with fill-derived history "
                    "— left existing data intact"}
        # Positions are the authoritative CURRENT holdings — reconcile to them
        # (backfills shares whose buys are outside the fill window). oversold becomes
        # informational: the position totals are the truth we align to.
        horizon = date.today() - timedelta(days=366)
        # positions here is a VERIFIED, non-empty snapshot: _fetch_positions_map returns
        # None on any read failure and an empty map is coerced to None above, so reaching
        # this line means Schwab reported the account's holdings. A symbol we reconstructed
        # as open but Schwab doesn't report is genuinely sold out → drop it (no phantoms).
        open_by_symbol = reconcile_open_lots(open_by_symbol, positions, horizon, drop_absent=True)
        if oversold:
            log.warning(f"{account_hash[-4:]} oversold reconciled against positions: {oversold}")
    else:
        # No positions truth to reconcile against → be conservative.
        if not fills:
            return {"ok": True, "skipped": "no fills, no positions — left existing data intact",
                    "open_lots": 0, "closed": 0}
        if oversold:
            log.warning(f"{account_hash[-4:]} REFUSED — oversold, no positions to reconcile: {oversold}")
            return {"ok": False, "refused": "oversold, no positions to reconcile — left existing data intact",
                    "oversold": len(oversold)}

    symbols = set(open_by_symbol) | {c.symbol for c in closed}
    n_lots = n_backfill = 0
    async with SessionLocal() as s:
        for sym in symbols:  # Ticker FK; never delete reference rows
            await s.execute(
                pg_insert(Ticker).values(symbol=sym)
                .on_conflict_do_nothing(index_elements=[Ticker.symbol])
            )
        await s.execute(delete(Lot).where(Lot.account_hash == account_hash))
        await s.execute(delete(CompletedTrade).where(CompletedTrade.account_hash == account_hash))

        for lots in open_by_symbol.values():
            for ol in lots:
                s.add(Lot(account_hash=account_hash, symbol=ol.symbol, rung=ol.rung,
                          buy_date=_as_date(ol.at), shares=ol.shares, buy_price=ol.price,
                          source=getattr(ol, "source", "fill"),
                          schwab_order_id=(getattr(ol, "order_id", "") or None)))
                n_lots += 1
                if getattr(ol, "source", "fill") == "position":
                    n_backfill += 1
        for ct in closed:
            s.add(CompletedTrade(
                account_hash=account_hash, symbol=ct.symbol, shares=ct.shares,
                buy_price=ct.buy_price, sell_price=ct.sell_price,
                cost=ct.cost, profit=ct.profit,
                opened_at=_as_date(ct.opened_at), completed_at=_as_date(ct.completed_at),
                schwab_order_id=(getattr(ct, "order_id", "") or None),
            ))
        await s.commit()

    try:
        await _prune_phantom_cusip_tickers()
    except Exception as e:
        log.warning(f"phantom-ticker prune failed (non-fatal): {e!r}")

    log.info(f"{account_hash[-4:]}: {n_lots} open lots ({n_backfill} backfilled from "
             f"positions), {len(closed)} closed trades from {len(fills)} fills")
    return {"ok": True, "open_lots": n_lots, "backfilled": n_backfill,
            "closed": len(closed), "fills": len(fills)}


async def _prune_phantom_cusip_tickers() -> int:
    """Remove CUSIP-shaped `ticker` rows that nothing references. A positions snapshot
    that reported a holding under its CUSIP (RCAX as 88636W718, 2026-09-08) inserted
    one as FK reference data; once the ladder is rebuilt under the real ticker it
    lingers as a bogus dashboard/movers/concentration entry. Real tickers are never
    CUSIP-shaped, so this cannot touch a genuine symbol; watched rows and anything a
    lot or completed trade still points at are left alone."""
    from .symbols import is_cusip_like
    n = 0
    async with SessionLocal() as s:
        rows = (await s.execute(select(Ticker.symbol).where(Ticker.watch.is_(False)))).all()
        for (sym,) in rows:
            if not is_cusip_like(sym):
                continue
            used = (await s.execute(
                select(func.count()).select_from(Lot).where(Lot.symbol == sym))).scalar() or 0
            used += (await s.execute(
                select(func.count()).select_from(CompletedTrade).where(CompletedTrade.symbol == sym))).scalar() or 0
            if not used:
                await s.execute(delete(Ticker).where(Ticker.symbol == sym))
                n += 1
        if n:
            await s.commit()
            log.info(f"pruned {n} phantom CUSIP ticker row(s)")
    return n


async def rebuild_account(account_hash: str, fills: list[Fill]) -> dict:
    """Rebuild from an explicit fills list (fills-only, no reconciliation). Used by
    tests / callers that already have fills."""
    async with _lock_for(account_hash):
        return await _write(account_hash, fills)


async def _open_lot_marks(account_hash: str) -> dict:
    """{SYMBOL: buy_price of the deepest (last) open lot} for the account — used to detect
    sell-to-zero transitions and remember the last held price."""
    async with SessionLocal() as s:
        lots = (
            await s.execute(
                select(Lot.symbol, Lot.buy_price)
                .where(Lot.account_hash == account_hash).order_by(Lot.rung)
            )
        ).all()
    marks: dict = {}
    for sym, bp in lots:
        marks[sym] = float(bp)  # ordered by rung → last write is the deepest rung
    return marks


async def _auto_watch_closed(closed: dict) -> None:
    """A position was fully sold → add it to the watchlist so it stays on the dashboard."""
    if not closed:
        return
    async with SessionLocal() as s:
        await s.execute(
            Ticker.__table__.update().where(Ticker.symbol.in_(list(closed))).values(watch=True)
        )
        await s.commit()


async def project_account(account_hash: str) -> dict:
    """Re-project the ladder from the PERSISTED fill ledger (no API fill fetch) —
    used after a CSV import lands new history, or to heal manually. Still fetches
    live positions for the reconcile step when available."""
    from . import fill_store

    async with _lock_for(account_hash):
        await fill_store.heal_ledger(account_hash)
        stored = await fill_store.load_fills(account_hash)
        if not stored:
            return {"ok": True, "skipped": "fill ledger is empty — nothing to project"}
        positions = await _fetch_positions_map(account_hash)
        return await _write(account_hash, stored, positions)


async def resync_account(account_hash: str) -> dict:
    """The production entry point: fetch fills + current positions, PERSIST the fresh
    fills into the durable ledger, project the ladder from the FULL ledger (API +
    CSV history), reconcile it to positions, and write — all under one lock. Then
    announce new fills in the bell feed."""
    from . import fill_store
    from . import fills as fills_svc
    from . import fills_hint

    async with _lock_for(account_hash):
        # Skip the (always-empty) fills probe for an account we KNOW exposes none — the
        # LLC — going straight to positions mirroring. Re-probes every ~7 days; any
        # doubt probes. The _write refuse-guard still protects a full-access account.
        capable, last_probe = await fills_hint.get_hint(account_hash)
        today = date.today()
        probe = fills_hint.should_probe(capable, last_probe, today)
        fills = await fills_svc.fetch_fills(account_hash) if probe else []
        positions = await _fetch_positions_map(account_hash)
        pre_marks = await _open_lot_marks(account_hash)   # positions held before this rebuild

        # Durable ledger: persist what the API just returned (idempotent; upgrades any
        # matching CSV rows), then project from the FULL history. A fetch ERROR (None)
        # stays a strict no-op — never project mid-unknown-state. An empty ledger falls
        # through to the legacy behavior (fills as-is → positions-mirror/refuse guards).
        effective = fills
        if fills is not None:
            if fills:
                try:
                    up = await fill_store.upsert_api_fills(account_hash, fills)
                    if up["added"] or up["upgraded_csv"]:
                        log.info(f"[resync] {account_hash[-4:]} fill ledger: +{up['added']} api "
                                 f"({up['upgraded_csv']} csv upgraded, {up['skipped']} known)")
                except Exception as e:
                    log.warning(f"[resync] fill-ledger persist failed (projecting from fetch): {e!r}")
            try:
                await fill_store.heal_ledger(account_hash)   # idempotent self-repair
            except Exception as e:
                log.warning(f"[resync] ledger heal failed (continuing): {e!r}")
            stored = await fill_store.load_fills(account_hash)
            if stored:
                effective = stored
        result = await _write(account_hash, effective, positions)
        # Positions that were held and are now flat → auto-add to the watchlist, and
        # remember the last held price so the watch row can show it.
        post_marks = await _open_lot_marks(account_hash)
        closed = {sym: px for sym, px in pre_marks.items() if sym not in post_marks}
        if closed:
            await _auto_watch_closed(closed)
            try:
                from . import ledger as ledger_svc
                await ledger_svc.set_last_held(account_hash, closed)
            except Exception as e:
                log.warning(f"[resync] last-held record failed: {e!r}")

        # Update the hint ONLY after a real probe with a trustworthy result (fills is a
        # list, not None=error). Empty + no fill-derived history ⇒ this account exposes
        # no fills; anything else ⇒ it does (probe next time).
        if probe and fills is not None:
            if fills:
                await fills_hint.set_hint(account_hash, True, today)
            elif not await _has_fill_derived_data(account_hash):
                await fills_hint.set_hint(account_hash, False, today)
            else:
                await fills_hint.set_hint(account_hash, True, today)

    try:
        from . import notifications as notifications_svc
        await notifications_svc.notify_fills(account_hash, fills or [])
    except Exception as e:
        log.warning(f"[resync] notify_fills failed: {e!r}")
    return result
