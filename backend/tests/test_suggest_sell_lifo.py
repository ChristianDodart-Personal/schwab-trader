"""A per-lot sell suggestion is only offered for the LIFO-next (newest) lot. An older
lot's ticket would show its own shares/target/profit while the sale actually books
against the newest lot. DB-backed on a throwaway account, like test_trade_stats."""
import asyncio
from datetime import date

from sqlalchemy import delete, select

from app.db import SessionLocal, init_db
from app.db.models import Lot, Ticker
from app.db import dialect_insert
from app.orders import suggest_sell

ACCT = "TEST_SUGGEST_SELL_LIFO"
SYM = "ZZLIFO"


def _run(coro):
    return asyncio.run(coro)


async def _seed() -> list[int]:
    await init_db()
    async with SessionLocal() as s:
        await s.execute(delete(Lot).where(Lot.account_hash == ACCT))
        await s.execute(dialect_insert(Ticker).values(symbol=SYM).on_conflict_do_nothing(index_elements=[Ticker.symbol]))
        for rung, (sh, px) in enumerate([(10, 20.0), (15, 18.0), (20, 16.0)], start=1):
            s.add(Lot(account_hash=ACCT, symbol=SYM, rung=rung, buy_date=date(2026, 9, rung),
                      shares=sh, buy_price=px, source="fill"))
        await s.commit()
        rows = (await s.execute(select(Lot.id).where(Lot.account_hash == ACCT).order_by(Lot.rung))).scalars().all()
    return list(rows)


async def _cleanup():
    async with SessionLocal() as s:
        await s.execute(delete(Lot).where(Lot.account_hash == ACCT))
        await s.commit()


def test_only_the_newest_lot_gets_a_sell_suggestion():
    ids = _run(_seed())
    try:
        oldest, middle, newest = ids
        ok = _run(suggest_sell(newest, ACCT))
        assert "error" not in ok
        assert ok["rung"] == 3 and ok["quantity"] == 20 and ok["buy_price"] == 16.0
        for older in (oldest, middle):
            r = _run(suggest_sell(older, ACCT))
            assert "error" in r and "position 3" in r["error"]
    finally:
        _run(_cleanup())
