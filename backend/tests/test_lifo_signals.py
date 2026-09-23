"""LIFO-honest signals: the SELL chip, LILO %, and last-position P/L all describe the
NEWEST lot, the one a sale actually retires. An older, cheaper lot must not light the
SELL chip while the newest is underwater, and a newest lot with no known cost must not
invent a profit. Pure (rules) + the dashboard row builder on in-memory lots."""
from datetime import date

from app.dashboard import _summary_row
from app.db.models import Lot
from app.schwab import hub
from app.strategy import StrategyConfig, rules

CFG = StrategyConfig.load()


def _lot(rung, shares, price, lot_id):
    return Lot(id=lot_id, account_hash="T", symbol="ZZSIG", rung=rung,
               buy_date=date(2026, 9, rung), shares=shares, buy_price=price, source="fill")


def _row(lots, price):
    hub.latest["ZZSIG"] = {"last": price, "netChange": 0.0}
    try:
        return _summary_row("ZZSIG", lots, None, (0.0, 0, None), (0.0, 0), 1000.0, CFG)
    finally:
        hub.latest.pop("ZZSIG", None)


def test_is_sell_mark_uses_a_single_target():
    assert rules.is_sell_mark(12.0, 11.0) is True
    assert rules.is_sell_mark(10.0, 11.0) is False
    assert rules.is_sell_mark(12.0, 0.0) is False


def test_lilo_is_measured_from_the_newest_lot():
    # rung 1 cheap backfill at $5, newest lot at $10; price $9 is 10% BELOW the last buy.
    row = _row([_lot(1, 10, 5.0, 1), _lot(2, 10, 10.0, 2)], price=9.0)
    assert row["lilo_pct"] == -0.1


def test_sell_chip_ignores_an_older_cheaper_lot():
    # The $5 lot's target is long cleared at $9, but a LIFO sale retires the $10 lot at a
    # loss, so there must be no SELL signal.
    row = _row([_lot(1, 10, 5.0, 1), _lot(2, 10, 10.0, 2)], price=9.0)
    assert row["sell_mark"] is False
    assert row["last_pos_profit"] == -10.0


def test_newest_lot_with_unknown_cost_is_flagged_not_counted():
    row = _row([_lot(1, 10, 8.0, 1), _lot(2, 5, 0.0, 2)], price=9.0)
    assert row["cost_unknown"] is True
    assert row["last_pos_profit"] is None and row["last_pos_cost"] is None
    assert row["lilo_pct"] is None and row["sell_mark"] is False
    # total return counts only shares whose cost we know: 10 x (9 - 8) = 10, not +45 from the $0 lot
    assert row["total_return"] == 10.0
