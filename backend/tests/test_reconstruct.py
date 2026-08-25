from datetime import date, datetime

from app.reconstruct import Fill, reconstruct


def test_lifo_sell_retires_most_recent_lot():
    fills = [
        Fill("RCAT", "BUY", 10, 10.0, date(2026, 1, 1)),
        Fill("RCAT", "BUY", 5, 12.0, date(2026, 1, 2)),
        Fill("RCAT", "SELL", 5, 15.0, date(2026, 1, 3)),
    ]
    r = reconstruct(fills)
    # LIFO: the 12.0 lot (most recent) is sold
    assert len(r["closed"]) == 1
    t = r["closed"][0]
    assert t.buy_price == 12.0 and t.sell_price == 15.0 and t.shares == 5
    assert round(t.profit, 2) == 15.0
    # one open lot remains: the original 10@10, now rung 1
    assert list(r["open_lots"].keys()) == ["RCAT"]
    lot = r["open_lots"]["RCAT"][0]
    assert lot.shares == 10 and lot.price == 10.0 and lot.rung == 1
    assert r["oversold"] == []


def test_partial_sell_splits_a_lot():
    fills = [
        Fill("X", "BUY", 10, 10.0, date(2026, 1, 1)),
        Fill("X", "SELL", 4, 11.0, date(2026, 1, 2)),
    ]
    r = reconstruct(fills)
    assert r["closed"][0].shares == 4
    assert r["open_lots"]["X"][0].shares == 6  # remainder still open


def test_same_day_daytrade_buy_before_sell():
    fills = [
        Fill("Y", "SELL", 5, 10.0, date(2026, 1, 1)),  # listed first but BUY wins tie
        Fill("Y", "BUY", 5, 9.0, date(2026, 1, 1)),
    ]
    r = reconstruct(fills)
    assert "Y" not in r["open_lots"]            # fully closed
    assert round(r["closed"][0].profit, 2) == 5.0
    assert r["oversold"] == []


def test_same_day_sell_stamped_before_buy_still_closes():
    # A pure-CSV same-day round trip can be stamped sell-then-buy (Schwab's export isn't
    # reliably execution-ordered within a day). That day goes negative in a long-only
    # stream, so it's canonicalized to buy-first: the pair closes cleanly instead of
    # leaving a phantom open lot + a spurious oversell.
    fills = [
        Fill("L", "SELL", 210, 4.72, datetime(2025, 7, 25, 0, 0, 30)),
        Fill("L", "BUY", 210, 4.59, datetime(2025, 7, 25, 0, 0, 31)),
    ]
    r = reconstruct(fills)
    assert "L" not in r["open_lots"]                       # no phantom holding
    assert r["oversold"] == []                             # no spurious oversell
    assert round(r["closed"][0].profit, 2) == round((4.72 - 4.59) * 210, 2)


def test_same_day_buy_sell_buy_keeps_real_order():
    # A day that never goes negative must keep its real intra-day order: the sell retires
    # the SAME-DAY buy (LIFO), leaving the LATER buy open — NOT canonicalized to buy-first
    # (which would wrongly strand the earlier, cheaper lot). Guards the INMB regression.
    fills = [
        Fill("Q", "BUY", 100, 10.00, datetime(2025, 3, 1, 9, 30)),
        Fill("Q", "SELL", 100, 10.50, datetime(2025, 3, 1, 10, 0)),
        Fill("Q", "BUY", 100, 10.80, datetime(2025, 3, 1, 14, 0)),
    ]
    r = reconstruct(fills)
    assert r["oversold"] == []
    assert [round(l.price, 2) for l in r["open_lots"]["Q"]] == [10.80]  # the later buy stays open
    assert round(r["closed"][0].profit, 2) == 50.0                       # sold the 10.00 lot


def test_market_order_legs_merge_into_one_lot_by_order_id():
    # A market buy that fills across several counterparties arrives as several BUY
    # executions sharing ONE order id. They must collapse into a single rung at the
    # share-weighted price — not several tiny positions (the RCAX 600+683 report).
    fills = [
        Fill("RCAX", "BUY", 600, 3.44, datetime(2026, 8, 25, 9, 30, 1), order_id="A1"),
        Fill("RCAX", "BUY", 683, 3.44, datetime(2026, 8, 25, 9, 30, 1), order_id="A1"),
    ]
    lots = reconstruct(fills)["open_lots"]["RCAX"]
    assert len(lots) == 1
    assert lots[0].shares == 1283
    assert round(lots[0].price, 4) == 3.44
    assert lots[0].rung == 1


def test_merge_share_weights_varying_leg_prices():
    # One order, legs at slightly different prices → one lot at the weighted average.
    fills = [
        Fill("X", "BUY", 100, 3.40, datetime(2026, 8, 25, 9, 30), order_id="O"),
        Fill("X", "BUY", 300, 3.48, datetime(2026, 8, 25, 9, 30), order_id="O"),
    ]
    lot = reconstruct(fills)["open_lots"]["X"][0]
    assert lot.shares == 400
    assert round(lot.price, 4) == round((100 * 3.40 + 300 * 3.48) / 400, 4)  # 3.46


def test_same_price_same_day_merges_without_order_id():
    # Distinct orders (no/ different ids) at the SAME price on the SAME day are one rung.
    fills = [
        Fill("Y", "BUY", 500, 3.44, datetime(2026, 8, 25, 9, 30)),
        Fill("Y", "BUY", 500, 3.44, datetime(2026, 8, 25, 9, 31)),
    ]
    lots = reconstruct(fills)["open_lots"]["Y"]
    assert len(lots) == 1 and lots[0].shares == 1000


def test_same_price_different_days_stay_separate_rungs():
    # Same price but different days = deliberate separate rungs → do NOT merge.
    fills = [
        Fill("Z", "BUY", 100, 3.44, date(2026, 8, 25)),
        Fill("Z", "BUY", 100, 3.44, date(2026, 8, 26)),
    ]
    lots = reconstruct(fills)["open_lots"]["Z"]
    assert len(lots) == 2


def test_merge_does_not_cross_a_sell():
    # buy(same order id partial) → SELL → buy(same order id) must not merge across the
    # sell: the sell pops the first lot, so the later buy opens a fresh lot. LIFO intact.
    fills = [
        Fill("Q", "BUY", 100, 10.0, datetime(2026, 3, 1, 9, 30), order_id="G"),
        Fill("Q", "SELL", 100, 11.0, datetime(2026, 3, 1, 10, 0)),
        Fill("Q", "BUY", 100, 10.0, datetime(2026, 3, 1, 14, 0), order_id="G"),
    ]
    r = reconstruct(fills)
    assert r["oversold"] == []
    assert len(r["open_lots"]["Q"]) == 1 and r["open_lots"]["Q"][0].shares == 100
    assert round(r["closed"][0].profit, 2) == 100.0


def test_oversell_is_flagged_not_crashed():
    r = reconstruct([Fill("Z", "SELL", 3, 10.0, date(2026, 1, 1))])
    assert r["oversold"] and r["oversold"][0][0] == "Z"
    assert r["closed"] == []


def test_rungs_assigned_oldest_first():
    fills = [
        Fill("A", "BUY", 1, 20.0, date(2026, 1, 1)),
        Fill("A", "BUY", 1, 18.0, date(2026, 1, 2)),
        Fill("A", "BUY", 1, 16.0, date(2026, 1, 3)),
    ]
    lots = reconstruct(fills)["open_lots"]["A"]
    assert [l.rung for l in lots] == [1, 2, 3]
    assert [l.price for l in lots] == [20.0, 18.0, 16.0]
