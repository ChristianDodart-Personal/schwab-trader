"""Persisting inferred splits: a 1:1 row is never written, the caller learns which rows
are new (so it notifies once, not every resync), and heal removes a no-op row left by
the pre-v0.99.1 detector along with the duplicate notices it posted. DB-backed on a
throwaway account, like test_suggest_sell_lifo."""
import asyncio
from datetime import date, datetime

from sqlalchemy import delete, func, select

from app import fill_store
from app.db import SessionLocal, init_db
from app.db.models import FillRecord, Notification
from app.reconstruct import Fill

ACCT = "TEST_INFERRED_SPLIT_STORE"
SYM = "ZZSPLT"


def _run(coro):
    return asyncio.run(coro)


async def _cleanup():
    async with SessionLocal() as s:
        await s.execute(delete(FillRecord).where(FillRecord.account_hash == ACCT))
        await s.execute(delete(Notification).where(Notification.symbol == SYM))
        await s.commit()


async def _splits() -> list[tuple[float, float]]:
    async with SessionLocal() as s:
        rows = (await s.execute(select(FillRecord.shares, FillRecord.price).where(
            FillRecord.account_hash == ACCT, FillRecord.side == "SPLT"))).all()
    return [(float(a), float(b)) for a, b in rows]


def test_upsert_skips_noop_and_reports_only_new_rows():
    async def go():
        await init_db()
        await _cleanup()
        try:
            at = datetime(2026, 9, 24)
            noop = Fill(SYM, "SPLT", shares=1.0, price=1.0, at=at, order_type="INFERRED", order_id="")
            real = Fill(SYM, "SPLT", shares=145.0, price=729.0, at=at, order_type="INFERRED", order_id="")
            assert await fill_store.upsert_inferred_splits(ACCT, [noop]) == []
            assert await _splits() == []
            first = await fill_store.upsert_inferred_splits(ACCT, [real])
            assert [f.shares for f in first] == [145.0]
            assert await fill_store.upsert_inferred_splits(ACCT, [real]) == []   # already stored
            assert await _splits() == [(145.0, 729.0)]
        finally:
            await _cleanup()
    _run(go())


def test_heal_drops_noop_inferred_split_and_its_notices():
    async def go():
        await init_db()
        await _cleanup()
        try:
            async with SessionLocal() as s:
                s.add(FillRecord(account_hash=ACCT, symbol=SYM, side="SPLT", shares=1, price=1,
                                 at=datetime(2026, 9, 24), trade_date=date(2026, 9, 24),
                                 order_type="INFERRED", order_id=None, source="inferred",
                                 fill_key=f"inferred|{ACCT}|{SYM}|2026-09-24|1.0|1.0"))
                for _ in range(3):
                    s.add(Notification(symbol=SYM, kind="notice", read=False,
                                       message=f"{SYM} 1:1 split detected: 1 → 1 shares. Lots rescaled."))
                s.add(Notification(symbol=SYM, kind="fill", read=False, message=f"Filled: sold 1 {SYM}"))
                await s.commit()
            assert await fill_store._drop_noop_inferred_splits(ACCT) == 1
            assert await _splits() == []
            async with SessionLocal() as s:
                kinds = (await s.execute(select(Notification.kind, func.count()).where(
                    Notification.symbol == SYM).group_by(Notification.kind))).all()
            assert dict(kinds) == {"fill": 1}          # only the bogus notices went
        finally:
            await _cleanup()
    _run(go())
