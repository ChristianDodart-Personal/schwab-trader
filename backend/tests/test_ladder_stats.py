"""Ladder read math on hand-built price series whose right answers are known."""
from datetime import date, timedelta

import pytest

from app import ladder_stats as ls
from app.grouping import leverage_factor
from app.strategy.config import StrategyConfig

CFG = StrategyConfig.load()


def _days(n, start=date(2025, 1, 2)):
    return [start + timedelta(days=i) for i in range(n)]


# ---------- typical move / efficiency ratio / chop label ----------

def test_typical_move_of_alternating_two_percent_days():
    closes = [100.0]
    for i in range(80):
        closes.append(closes[-1] * (1.02 if i % 2 == 0 else 0.98))
    assert ls.typical_move(closes) == pytest.approx(0.02, abs=1e-3)


def test_typical_move_needs_twenty_days():
    assert ls.typical_move([100.0] * 10) is None


def test_efficiency_ratio_straight_line_is_one_and_zigzag_is_near_zero():
    assert ls.efficiency_ratio([100 + i for i in range(70)]) == pytest.approx(1.0)
    zig = [100 + (5 if i % 2 else 0) for i in range(64)]      # ends where it started ±5
    assert ls.efficiency_ratio(zig) < 0.05


def test_chop_labels_in_rung_units():
    assert ls.chop_label(0.05, 0.01, 0.10) == "choppy"
    assert ls.chop_label(0.20, -0.02, 0.10) == "mixed"
    assert ls.chop_label(0.40, 0.08, 0.10) == "trending_up"      # efficient + half a rung
    assert ls.chop_label(0.40, -0.30, 0.10) == "trending_down"
    assert ls.chop_label(None, None, 0.10) is None


def test_a_noisy_slide_of_two_rungs_is_a_trend_not_chop():
    # A 4-5%-a-day stock sliding 28% over 3 months keeps a low efficiency ratio, but for a
    # ladder that's ~3 rungs bought into a falling price.
    assert ls.chop_label(0.05, -0.28, 0.10) == "trending_down"
    assert ls.chop_label(0.05, -0.12, 0.10) == "choppy"          # under 1.5 rungs of net move


def test_chop_rank_orders_choppy_first_and_falls_last():
    ranks = [ls.chop_rank(l, 0.1) for l in ("choppy", "mixed", "trending_up", "trending_down")]
    assert ranks == sorted(ranks) and ls.chop_rank(None, None) is None


# ---------- beta / market-vs-stock split ----------

def test_beta_of_a_two_times_fund():
    d = _days(200)
    bench, stock = [100.0], [100.0]
    for i in range(1, 200):
        r = 0.01 * (1 if i % 3 else -1.5)
        bench.append(bench[-1] * (1 + r))
        stock.append(stock[-1] * (1 + 2 * r))
    assert ls.beta(dict(zip(d, stock)), dict(zip(d, bench))) == pytest.approx(2.0, abs=1e-6)


def test_move_split_labels():
    m = ls.move_split(-0.10, -0.04, 2.0, 0.03)          # beta 2 × −4% explains −8% of −10%
    assert m["label"] == "market" and m["market_share"] == pytest.approx(0.8)
    assert m["specific_pct"] == pytest.approx(-0.02)
    assert ls.move_split(-0.10, 0.0, 1.2, 0.03)["label"] == "stock"
    assert ls.move_split(-0.10, -0.045, 1.0, 0.03)["label"] == "both"
    assert ls.move_split(-0.01, -0.05, 1.0, 0.03) is None     # smaller than a typical day
    assert ls.move_split(0.05, -0.05, 1.0, 0.03) is None      # not down


# ---------- bounce events ----------

def _flat_then(path, pre=25, level=100.0):
    closes = [level] * pre + path
    return closes, [c * 1.001 for c in closes], [c * 0.999 for c in closes]


def test_dip_that_recovers_counts_days_to_target():
    # 25 flat days at 100, then 89 (an 11% dip), then climbs 2%/day: target +5% ≈ 93.45
    closes, highs, lows = _flat_then([89.0, 90.8, 92.6, 94.4] + [95.0] * 70)
    ev = ls.bounce_events(closes, highs, lows, dip=0.10, target=0.05, extra_drops=[0.13])
    assert ev[0]["outcome"] == "recovered" and ev[0]["days"] == 3
    assert ev[0]["extra_rungs"] == 0 and ev[0]["entry"] == 89.0


def test_dip_that_keeps_falling_counts_extra_rungs_and_expires():
    path = [89.0] + [89.0 * (0.99 ** k) for k in range(1, 70)]   # slides ~50% over the window
    closes, highs, lows = _flat_then(path)
    ev = ls.bounce_events(closes, highs, lows, dip=0.10, target=0.05, extra_drops=[0.13, 0.13, 0.16])
    assert ev[0]["outcome"] == "expired"
    assert ev[0]["extra_rungs"] >= 3                    # −13%, then −13% more, then −16% more
    assert ev[0]["low_pct"] < -0.45


def test_dip_near_the_end_is_open_and_excluded_from_the_rate():
    closes, highs, lows = _flat_then([89.0, 89.5, 90.0])
    ev = ls.bounce_events(closes, highs, lows, dip=0.10, target=0.05, extra_drops=[0.13])
    assert [e["outcome"] for e in ev] == ["open"]
    s = ls.bounce_summary(ev)
    assert s["dips"] == 0 and s["open"] == 1 and s["rate"] is None


def test_summary_needs_three_completed_dips():
    rec = {"outcome": "recovered", "days": 5, "low_pct": -0.02, "extra_rungs": 0, "rung_reached": 2}
    exp = {"outcome": "expired", "days": None, "low_pct": -0.30, "extra_rungs": 2, "rung_reached": 4}
    assert ls.bounce_summary([rec, rec])["rate"] is None
    s = ls.bounce_summary([rec, rec, exp])
    assert s["rate"] == pytest.approx(0.667, abs=1e-3)
    assert s["median_days"] == 5 and s["more_rungs"] == 1 and s["worst_low_pct"] == -0.30
    assert s["worst_rung"] == 4 and s["deep"] == 0 and s["past_ten"] == 0


def test_worst_figures_come_from_the_same_dip():
    a = {"outcome": "expired", "days": None, "low_pct": -0.20, "extra_rungs": 5, "rung_reached": 7}   # more rungs
    b = {"outcome": "expired", "days": None, "low_pct": -0.35, "extra_rungs": 3, "rung_reached": 5}   # fell further
    ok = {"outcome": "recovered", "days": 3, "low_pct": -0.01, "extra_rungs": 0, "rung_reached": 2}
    s = ls.bounce_summary([a, b, ok])
    assert (s["worst_rung"], s["worst_low_pct"]) == (5, -0.35)


def test_summary_counts_dips_that_reached_the_deepest_tier():
    deep = {"outcome": "recovered", "days": 40, "low_pct": -0.6, "extra_rungs": 7, "rung_reached": 9}
    ok = {"outcome": "recovered", "days": 3, "low_pct": -0.01, "extra_rungs": 0, "rung_reached": 2}
    s = ls.bounce_summary([deep, ok, ok])
    assert s["deep"] == 1 and s["worst_rung"] == 9


def test_median_days_is_a_whole_number():
    e = lambda d: {"outcome": "recovered", "days": d, "low_pct": 0.0, "extra_rungs": 0, "rung_reached": 2}
    assert ls.bounce_summary([e(12), e(13), e(1), e(30)])["median_days"] == 12   # 12.5 → 12 (banker's)


def test_base_rate_is_how_often_any_day_reached_the_target():
    # Steady +1%/day: from any day the high reaches +5% within 63 days → 100%.
    up = [100 * 1.01 ** i for i in range(300)]
    assert ls.base_rate(up, [c * 1.001 for c in up], 0.05) == 1.0
    # Flat forever: never reaches +5%.
    flat = [100.0] * 300
    assert ls.base_rate(flat, flat, 0.05) == 0.0
    assert ls.base_rate(flat[:100], flat[:100], 0.05) is None                   # too short


def test_dips_do_not_overlap():
    # One long slide below the trigger is ONE dip, not one per day.
    closes, highs, lows = _flat_then([89.0] * 40)
    ev = ls.bounce_events(closes, highs, lows, dip=0.10, target=0.05, extra_drops=[0.13])
    assert len(ev) == 1


# ---------- rules / leverage ----------

def test_ladder_params_follow_the_account_rules():
    dip, target, extra = ls.ladder_params(CFG)
    assert dip == pytest.approx(0.10)                                    # rung-2 drop
    assert target == pytest.approx(CFG.sell.dollar_gain / 500.0)        # $ gain on a $500 rung-2 buy
    assert extra[0] == pytest.approx(0.13) and extra[-1] == pytest.approx(0.16)


def test_leverage_decay_month():
    assert ls.leverage_decay_month(0.06, 2) == pytest.approx(21 * 1 * 0.03 ** 2)
    assert ls.leverage_decay_month(0.06, -1) == pytest.approx(21 * 1 * 0.06 ** 2)
    assert ls.leverage_decay_month(0.06, 1) is None
    assert ls.leverage_decay_month(None, 2) is None


@pytest.mark.parametrize("name,lev", [
    ("DEFIANCE DAILY TARGET 2X LONG RCAT ETF", 2.0),
    ("Tradr 2X Short QBTS Daily ETF", -2.0),
    ("ProShares UltraPro Short QQQ ETF", -3.0),
    ("ProShares Ultra QQQ ETF", 2.0),
    ("Direxion Daily -1X Inverse ETF", -1.0),
    ("GraniteShares 1.5x Long COIN Daily ETF", 1.5),
    ("SPDR S&P 500 ETF", None),
    ("Rocket Lab Corp", None),
])
def test_leverage_factor(name, lev):
    assert leverage_factor(name, None) == lev


# ---------- read(): end to end on an injected history ----------

@pytest.fixture
def injected(monkeypatch):
    n = 400
    d = _days(n)
    bench = [400 * (1 + 0.0005 * i) for i in range(n)]
    # Stock tracks 1.5× the market's daily moves plus a zigzag, then falls 12% over the
    # last 10 days while the market is flat.
    stock = [50.0]
    for i in range(1, n):
        mr = bench[i] / bench[i - 1] - 1
        stock.append(stock[-1] * (1 + 1.5 * mr + (0.02 if i % 2 else -0.02)))
    for i in range(n - 10, n):
        stock[i] = stock[n - 11] * (1 - 0.012 * (i - (n - 11)))
    today = ls._today()
    mk = lambda c: {"dates": d, "closes": c, "highs": [x * 1.01 for x in c], "lows": [x * 0.99 for x in c], "asof": today}
    monkeypatch.setattr(ls, "_cache", {"ZZLAD": mk(stock), "SPY": mk(bench)})
    monkeypatch.setattr(ls, "_derived", {})
    monkeypatch.setattr(ls, "_bounce", {})
    return d, stock


def test_read_held_row_measures_from_the_newest_buy(injected):
    d, stock = injected
    buy_px, buy_day = stock[-11], d[-11]
    out = ls.read("ZZLAD", CFG, stock[-1], anchor=(buy_px, buy_day), next_buy=buy_px * 0.87, leverage=None)
    assert out["dip"]["from"] == "last_buy"
    assert out["dip"]["pct"] == pytest.approx(stock[-1] / buy_px - 1, abs=1e-4)
    assert out["dip"]["days"] == 10                                  # trading days since the buy
    # The yardstick is the normal move BEFORE the drop (up to the buy day), not one that
    # includes the fall itself.
    assert out["dip"]["move"] == pytest.approx(ls.typical_move(stock[:-10]), abs=1e-4)
    assert out["dip"]["norm"] == pytest.approx(out["dip"]["pct"] / (out["dip"]["move"] * 10 ** 0.5), abs=0.02)
    assert out["dip"]["next_rung_pct"] == pytest.approx(buy_px * 0.87 / stock[-1] - 1, abs=1e-4)
    assert out["dip"]["norm"] < 0 and "next_rung_moves" in out["dip"]
    assert out["why_down"]["label"] == "stock"          # the market barely moved
    assert out["chop"]["label"] in {"choppy", "mixed", "trending_up", "trending_down"}
    assert out["bounce"]["dip_pct"] == pytest.approx(0.10)
    assert "events" not in out


def test_read_watch_row_uses_recent_high_and_lists_events(injected):
    out = ls.read("ZZLAD", CFG, None, events=True)
    assert out["dip"]["from"] == "recent_high"
    assert isinstance(out["events"], list)
    flat = ls.row_fields("ZZLAD", out)
    assert flat["ladder_status"] == "ready"
    assert flat["dip_depth"] == -out["dip"]["norm"] and flat["bounce_rate"] == out["bounce"]["rate"]
    assert flat["chop_score"] == pytest.approx(3.999 - out["chop"]["rank"], abs=1e-3)
    assert out["bounce"]["base_rate"] is not None
    assert out["bounce"]["worst_rung"] is None or out["bounce"]["worst_rung"] >= 2


def test_a_crash_is_measured_against_the_calm_before_it(monkeypatch):
    n = 300
    d = _days(n)
    calm = [50 * (1.01 if i % 2 else 0.99) ** 1 for i in range(n - 16)]      # ±1% a day
    crash = [calm[-1] * (0.94 ** k) for k in range(1, 17)]                  # −6% a day for 16 days
    c = calm + crash
    today = ls._today()
    mk = {"dates": d, "closes": c, "highs": c, "lows": c, "asof": today}
    monkeypatch.setattr(ls, "_cache", {"ZZC": mk})
    monkeypatch.setattr(ls, "_derived", {})
    monkeypatch.setattr(ls, "_bounce", {})
    out = ls.read("ZZC", CFG, c[-1], anchor=(calm[-1], d[n - 17]))
    assert out["dip"]["pct"] < -0.6
    assert out["dip"]["norm"] <= -2                                          # rare, not "normal"


def test_read_is_none_until_history_loads(monkeypatch):
    monkeypatch.setattr(ls, "_cache", {})
    assert ls.read("NOPE", CFG, 10.0) is None
    flat = ls.row_fields("NOPE", None)
    assert flat["bounce_rate"] is None and flat["ladder_status"] == "loading"


def test_status_reports_a_failed_fetch_as_unavailable(monkeypatch):
    import time as _t
    monkeypatch.setattr(ls, "_cache", {})
    monkeypatch.setattr(ls, "_inflight", set())
    monkeypatch.setattr(ls, "_next_try", {"DOWN": _t.monotonic() + 300})
    assert ls.status("DOWN") == "unavailable"
    assert ls.status("OTHER") == "loading"
    monkeypatch.setattr(ls, "_cache", {"NEW": {"closes": [1.0] * 10}})
    assert ls.status("NEW") == "short"


def test_sort_keys_put_the_ladder_relevant_rows_first_on_a_descending_click():
    mk = lambda label, er, norm: {"bounce": {"rate": 0.5}, "chop": {"rank": ls.chop_rank(label, er)},
                                  "dip": {"norm": norm}, "why_down": None, "decay_month": None}
    choppy, falling = ls.row_fields("A", mk("choppy", 0.05, -2.0)), ls.row_fields("B", mk("trending_down", 0.4, -0.5))
    assert choppy["chop_score"] > falling["chop_score"]        # choppiest first
    assert choppy["dip_depth"] > falling["dip_depth"]          # deepest dip first
