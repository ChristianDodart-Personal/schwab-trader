"""Multi-horizon trend: per-horizon returns from daily closes, and the net up-minus-down score."""
import pytest

from app.avg52 import trend_returns, trend_score


def _line(n, start=100.0, step=0.1):
    return [start + i * step for i in range(n)]


def test_full_year_uptrend_scores_plus_four():
    r = trend_returns(_line(251))
    assert all(v is not None and v > 0 for v in r.values())
    assert trend_score(r) == (4, 4)


def test_returns_anchor_h_days_back():
    closes = _line(251)
    r = trend_returns(closes)
    assert r["1M"] == pytest.approx(closes[-1] / closes[-22] - 1, abs=1e-4)
    # 250 bars back covers ≥95% of 252, so 12M anchors on the oldest close
    assert r["12M"] == pytest.approx(closes[-1] / closes[0] - 1, abs=1e-4)


def test_short_history_drops_long_horizons():
    r = trend_returns(_line(70))            # ~3 months
    assert r["6M"] is None and r["12M"] is None
    assert trend_score(r) == (2, 2)


def test_too_little_history_has_no_score():
    assert trend_score(trend_returns(_line(30))) is None   # only 1M available
    assert trend_score(None) is None


def test_mixed_trend_nets_out():
    # Fell for most of a year, then rallied over the last month.
    closes = [200 - i * 0.5 for i in range(230)] + [85 + i for i in range(21)]
    r = trend_returns(closes)
    assert r["1M"] > 0 and r["12M"] < 0
    net, n = trend_score(r)
    assert n == 4 and -4 < net < 4
