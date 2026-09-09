"""Split inference from the positions snapshot (the RCAX 1:5 reverse split of
2026-09-09 that the TRADE-only API path never saw). Pure, DB-free."""
from datetime import date, datetime, timezone

import pytest

from app.reconstruct import (Fill, OpenLot, infer_splits, reconstruct, split_factor,
                             split_stamp)


def _lots(sym, *pairs, source="fill"):
    return [OpenLot(sym, sh, px, date(2026, 8, 25), source=source) for sh, px in pairs]


# ---------- split_factor: both signals must agree ----------

def test_reverse_split_detected_with_cash_in_lieu():
    # 729 sh @ ~$3.39 → Schwab holds 145 (145.8 minus a fractional cash-in-lieu) @ $16.95.
    assert split_factor(729, 145, 3.39, 16.95) == (5, "reverse")


def test_forward_split_detected():
    assert split_factor(100, 200, 50.0, 25.0) == (2, "forward")


def test_plain_partial_sale_is_not_a_split():
    # Selling 80% leaves a 5:1 share ratio but Schwab's average cost does not move.
    assert split_factor(729, 145, 3.39, 3.39) is None


def test_cost_moves_but_shares_do_not_match_is_not_a_split():
    assert split_factor(729, 300, 3.39, 16.95) is None


def test_missing_schwab_average_never_infers():
    assert split_factor(729, 145, 3.39, 0.0) is None


# ---------- infer_splits over a ladder ----------

def test_infers_paired_splt_for_the_rcax_case():
    lots = {"RCAX": _lots("RCAX", (600, 3.44), (129, 3.16)),
            "RCAT": _lots("RCAT", (46, 10.72))}
    positions = {"RCAX": (145.0, 16.95), "RCAT": (46.0, 10.72)}
    out = infer_splits(lots, positions, date(2026, 9, 9))
    assert len(out) == 1
    sp = out[0]
    assert (sp.symbol, sp.side, sp.shares, sp.price) == ("RCAX", "SPLT", 145.0, 729.0)
    assert sp.order_type == "INFERRED"


def test_backfilled_lots_are_never_rescaled():
    # A position-sourced lot already carries Schwab's post-split figures.
    lots = {"RCAX": _lots("RCAX", (729, 3.39), source="position")}
    assert infer_splits(lots, {"RCAX": (145.0, 16.95)}, date(2026, 9, 9)) == []


def test_symbol_absent_from_positions_is_ignored():
    lots = {"RCAX": _lots("RCAX", (729, 3.39))}
    assert infer_splits(lots, {"RCAT": (46.0, 10.72)}, date(2026, 9, 9)) == []


# ---------- end to end: the inferred SPLT rescales lots, no P/L, LIFO stays right ----------

def test_reconstruct_applies_inferred_split_and_later_sell_uses_post_split_basis():
    fills = [
        Fill("RCAX", "BUY", 600, 3.44, datetime(2026, 8, 25, 14, 0)),
        Fill("RCAX", "BUY", 129, 3.16, datetime(2026, 8, 26, 14, 0)),
    ]
    lots = reconstruct(fills)["open_lots"]
    splits = infer_splits(lots, {"RCAX": (145.0, 16.95)}, split_stamp(fills, date(2026, 9, 9)))
    assert len(splits) == 1
    fills2 = fills + splits
    r = reconstruct(fills2)
    open_ = r["open_lots"]["RCAX"]
    assert sum(l.shares for l in open_) == pytest.approx(145.0)
    # cost basis preserved across the rescale (2064 + 407.64 = 2471.64)
    assert sum(l.shares * l.price for l in open_) == pytest.approx(600 * 3.44 + 129 * 3.16, abs=0.01)
    assert r["closed"] == []                                   # a split realizes nothing
    # Selling post-split shares at the post-split price books the REAL gain, not a
    # phantom one against the $3.xx pre-split cost.
    fills3 = fills2 + [Fill("RCAX", "SELL", 145, 15.20, datetime(2026, 9, 10, 14, 0))]
    r3 = reconstruct(fills3)
    total_profit = sum(t.profit for t in r3["closed"])
    assert total_profit == pytest.approx(145 * 15.20 - (600 * 3.44 + 129 * 3.16), abs=0.05)
    assert "RCAX" not in r3["open_lots"]
    assert r3["oversold"] == []


def test_split_stamp_matches_fill_timestamp_type():
    naive = [Fill("X", "BUY", 1, 1.0, datetime(2026, 1, 1, 9, 30))]
    aware = [Fill("X", "BUY", 1, 1.0, datetime(2026, 1, 1, 9, 30, tzinfo=timezone.utc))]
    dated = [Fill("X", "BUY", 1, 1.0, date(2026, 1, 1))]
    d = date(2026, 9, 9)
    assert split_stamp(naive, d) == datetime(2026, 9, 9)
    assert split_stamp(aware, d) == datetime(2026, 9, 9, tzinfo=timezone.utc)
    assert split_stamp(dated, d) == d
    # and the stamped SPLT sorts without a date/datetime TypeError
    reconstruct(aware + [Fill("X", "SPLT", 2, 1, split_stamp(aware, d))])
