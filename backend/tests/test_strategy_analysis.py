"""Pure 'method health' analytics — concentration by underlying, ladder-depth stress,
thesis-break flags, and the Kelly sizing reference. All hand-computed against the
default strategy config."""
from __future__ import annotations

from app.strategy.analysis import (
    concentration_by_underlying,
    kelly_sizing,
    ladder_stress,
    thesis_break,
)
from app.strategy.config import StrategyConfig

CFG = StrategyConfig.load()  # the shipped default_strategy.yaml


# --- concentration_by_underlying ---------------------------------------------
def test_concentration_rolls_etfs_into_underlying():
    # RCAT stock 4% + its 2x ETF 3% => one 7% exposure.
    positions = [
        {"symbol": "RCAT", "underlying": None, "value": 400.0},
        {"symbol": "RCATX", "underlying": "RCAT", "value": 300.0},
        {"symbol": "BIG", "underlying": None, "value": 9300.0},
    ]
    rows = concentration_by_underlying(positions)
    by = {r["key"]: r for r in rows}
    assert by["RCAT"]["value"] == 700.0
    assert by["RCAT"]["pct"] == 0.07
    assert by["RCAT"]["symbols"] == ["RCAT", "RCATX"]
    assert "over_cap" not in by["RCAT"]            # no cap any more: exposure only
    assert rows[0]["key"] == "BIG"               # sorted by exposure desc


def test_concentration_ignores_zero_and_negative_values():
    rows = concentration_by_underlying(
        [{"symbol": "A", "underlying": None, "value": 0.0},
         {"symbol": "B", "underlying": None, "value": -5.0}])
    assert rows == []


# --- ladder_stress -----------------------------------------------------------
def test_ladder_stress_marks_to_market_at_drops():
    positions = [
        {"symbol": "X", "shares": 100.0, "invested": 1000.0, "price": 8.0, "lots_deep": 7},
        {"symbol": "Y", "shares": 50.0, "invested": 500.0, "price": 10.0, "lots_deep": 3},
    ]
    res = ladder_stress(positions, drops=[0.10, 0.50], target_lots_deep=6)
    x = res["positions"][0]
    assert x["symbol"] == "X" and x["over_depth"] is True     # 7 > 6, deepest first
    assert x["unrealized_now"] == -200.0                      # 800 value vs 1000 cost
    assert x["scenarios"][1] == {"drop": 0.50, "value": 400.0, "unrealized": -600.0}
    y = res["positions"][1]
    assert y["over_depth"] is False
    port = res["portfolio"]
    assert port["invested"] == 1500.0 and port["value_now"] == 1300.0
    assert port["scenarios"][1] == {"drop": 0.50, "value": 650.0, "unrealized": -850.0}


# --- thesis_break ------------------------------------------------------------
def test_thesis_break_deep_drawdown_and_below_ladder():
    pos = {"symbol": "Z", "price": 4.0, "first_buy": 10.0, "min_buy": 5.0,
           "lots_deep": 2, "days_held": 10}
    res = thesis_break(pos, CFG)
    codes = {r["code"] for r in res["reasons"]}
    assert "deep_drawdown" in codes    # down 60% >= 50%
    assert "below_ladder" in codes     # 4.0 < 5.0*(1-0.13)=4.35 (rung-3 drop)
    assert "stale" not in codes


def test_thesis_break_stale_only():
    pos = {"symbol": "OLD", "price": 10.0, "first_buy": 10.0, "min_buy": 10.0,
           "lots_deep": 1, "days_held": 300}
    res = thesis_break(pos, CFG)
    assert [r["code"] for r in res["reasons"]] == ["stale"]


def test_thesis_break_none_when_healthy():
    pos = {"symbol": "OK", "price": 9.5, "first_buy": 10.0, "min_buy": 9.0,
           "lots_deep": 1, "days_held": 5}
    assert thesis_break(pos, CFG) is None


# --- kelly_sizing ------------------------------------------------------------
def test_kelly_positive_edge():
    res = kelly_sizing(wins=30, losses=20, avg_win=100.0, avg_loss=50.0,
                       account_value=10000.0, cfg=CFG)
    assert res["enough"] is True
    assert res["win_rate"] == 0.6
    assert res["payoff_ratio"] == 2.0
    assert res["kelly_fraction"] == 0.4      # (2*0.6 - 0.4)/2
    assert res["half_kelly_fraction"] == 0.2
    assert res["kelly_dollars"] == 4000.0
    assert res["half_kelly_dollars"] == 2000.0
    assert res["current_tiers"] == [500.0, 1000.0, 1500.0]


def test_kelly_losing_edge_clamps_to_zero():
    res = kelly_sizing(wins=10, losses=40, avg_win=50.0, avg_loss=100.0,
                       account_value=10000.0, cfg=CFG)
    assert res["enough"] is True
    assert res["kelly_fraction"] == 0.0      # negative edge -> bet ~0, never negative


def test_kelly_insufficient_trades():
    res = kelly_sizing(wins=5, losses=5, avg_win=100.0, avg_loss=50.0,
                       account_value=10000.0, cfg=CFG)
    assert res["enough"] is False and res["trades"] == 10
