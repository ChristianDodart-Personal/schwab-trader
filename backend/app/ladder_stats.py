"""Ladder read: price-history measures that inform a buy-the-dip, sell-LIFO ladder.

Five measures, all from ONE 5-year daily-candle fetch per symbol per day (plus SPY as the
market benchmark), each tied to the account's own rules:

  bounce     Past dips the size of your first ladder drop (rung 2): how often the price
             then reached your sell target within ~3 months, how long it took, and how
             many further rungs the dip would have triggered on the way.
  chop       Over ~3 months: did the price swing back and forth (the ladder earns on each
             swing) or move one way? A net move of 1.5+ rungs is a trend whatever the daily
             noise; otherwise the efficiency ratio (net move ÷ total daily movement) decides.
  dip        How far the price is below your newest buy (held) or its recent high
             (watchlist), compared with a normal move for that many days (σ × √days), and
             how many normal DAILY moves away the next rung is.
  why_down   How much of that fall the market explains: the stock's beta to the S&P 500
             times the S&P's move over the same days, vs the stock's actual move.
  decay      Leveraged/inverse ETFs only: the estimated monthly loss to daily rebalancing
             at current volatility.

Reference only. Nothing in the strategy, signals or order path reads these. Uses the same
in-server Schwab client as the charts (never a side script: that rotates the token)."""
from __future__ import annotations

import asyncio
import bisect
import statistics
import time
from datetime import date, datetime, timezone

from . import market_data
from .ledger import MARKET_TZ
from .strategy import rules
from .strategy.config import StrategyConfig

BENCH = "SPY"
LOOKBACK = 20          # trading days: a dip is measured from the highest close this far back
WINDOW = 63            # trading days (~3 months) a dip gets to reach the sell target
CHOP_DAYS = 63         # efficiency-ratio window
MOVE_DAYS = 63         # typical-daily-move window
BETA_DAYS = 252        # beta regression window
MIN_EVENTS = 3         # fewer completed dips than this → no bounce rate (too few to mean anything)
CHOPPY_BELOW = 0.15    # efficiency ratio: a random walk over 63 days sits near 0.13
TRENDING_ER = 0.30     # this efficient AND at least half a rung of net move = a trend
TREND_RUNGS = 1.5      # a net move this many rung-2 drops = a trend, however noisy the path


# ---------------------------------------------------------------- pure math

def pct_changes(closes: list[float]) -> list[float]:
    return [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes)) if closes[i - 1] > 0]


def typical_move(closes: list[float], n: int = MOVE_DAYS) -> float | None:
    """Standard deviation of daily % changes over the last n days (0.04 = ±4% a day)."""
    r = pct_changes(closes[-(n + 1):])
    return statistics.pstdev(r) if len(r) >= 20 else None


def efficiency_ratio(closes: list[float], n: int = CHOP_DAYS) -> float | None:
    """|close_t − close_t−n| ÷ Σ|daily change| over the window, 0..1."""
    w = closes[-(n + 1):]
    if len(w) < 21:
        return None
    path = sum(abs(w[i] - w[i - 1]) for i in range(1, len(w)))
    return abs(w[-1] - w[0]) / path if path > 0 else 0.0


def chop_label(er: float | None, net: float | None, dip: float) -> str | None:
    """choppy | mixed | trending_up | trending_down. Measured in the ladder's own units:
    a volatile stock's efficiency ratio stays low even while it slides 25%, but for a
    ladder that slide is 2+ rungs bought into a trend, so net movement in rungs wins."""
    if er is None:
        return None
    n = net or 0.0
    if abs(n) >= TREND_RUNGS * dip or (er >= TRENDING_ER and abs(n) >= dip / 2):
        return "trending_up" if n >= 0 else "trending_down"
    return "choppy" if er < CHOPPY_BELOW else "mixed"


_CHOP_ORDER = {"choppy": 0, "mixed": 1, "trending_up": 2, "trending_down": 3}


def chop_rank(label: str | None, er: float | None) -> float | None:
    """Sort key: choppiest first, steady falls last."""
    return None if label is None else _CHOP_ORDER[label] + min(er or 0.0, 0.999)


def beta(stock: dict[date, float], bench: dict[date, float], n: int = BETA_DAYS) -> float | None:
    """Slope of the stock's daily returns on the benchmark's over the last n shared days."""
    days = sorted(set(stock) & set(bench))[-(n + 1):]
    if len(days) < 60:
        return None
    s = [stock[days[i]] / stock[days[i - 1]] - 1 for i in range(1, len(days))]
    b = [bench[days[i]] / bench[days[i - 1]] - 1 for i in range(1, len(days))]
    mb = sum(b) / len(b)
    ms = sum(s) / len(s)
    var = sum((x - mb) ** 2 for x in b)
    if var <= 0:
        return None
    return sum((x - mb) * (y - ms) for x, y in zip(b, s)) / var


def move_split(stock_ret: float, bench_ret: float, b: float, move: float | None) -> dict | None:
    """Split a fall into the part the market explains (beta × S&P move) and the rest.
    None when the stock isn't meaningfully down (less than one typical daily move)."""
    if stock_ret >= 0 or (move and abs(stock_ret) < move):
        return None
    expected = b * bench_ret
    share = max(0.0, min(1.0, expected / stock_ret)) if expected < 0 else 0.0
    label = "market" if share >= 0.6 else "stock" if share <= 0.35 else "both"
    return {"stock_pct": round(stock_ret, 4), "market_pct": round(bench_ret, 4), "beta": round(b, 2),
            "expected_pct": round(expected, 4), "specific_pct": round(stock_ret - expected, 4),
            "market_share": round(share, 3), "label": label}


def bounce_events(closes: list[float], highs: list[float], lows: list[float], dip: float,
                  target: float, extra_drops: list[float], window: int = WINDOW,
                  lookback: int = LOOKBACK) -> list[dict]:
    """Walk the history for dips of `dip` below the highest close of the prior `lookback`
    days. Each dip "buys" at that day's close and gets `window` days for the daily high to
    reach entry × (1 + target). Along the way, each further drop in `extra_drops` (rung 3,
    4, … of the ladder, from the previous trigger) counts as another rung. Dips don't
    overlap: the next search starts the day after one resolves. Returns one dict per dip:
    {i, entry, outcome: recovered|expired|open, days, low_pct, extra_rungs}."""
    out: list[dict] = []
    n = len(closes)
    i = lookback
    while i < n:
        ref = max(closes[i - lookback:i])
        if ref <= 0 or closes[i] > ref * (1 - dip):
            i += 1
            continue
        entry = closes[i]
        goal = entry * (1 + target)
        low = entry
        rungs = 0
        trig = entry * (1 - extra_drops[0]) if extra_drops else None
        outcome, days, j = "open", None, i
        for j in range(i + 1, min(n, i + window + 1)):
            low = min(low, lows[j])
            while trig is not None and lows[j] <= trig:        # further rungs triggered
                rungs += 1
                trig *= 1 - extra_drops[min(rungs, len(extra_drops) - 1)]
            if highs[j] >= goal:
                outcome, days = "recovered", j - i
                break
        else:
            if i + window < n:
                outcome = "expired"
        out.append({"i": i, "entry": round(entry, 4), "outcome": outcome, "days": days,
                    "low_pct": round(low / entry - 1, 4), "extra_rungs": rungs,
                    "rung_reached": 2 + rungs,          # the dip buy is rung 2
                    "age": (n - 1 - i) if outcome == "open" else None})
        i = j + 1
    return out


DEEP_RUNG = 8   # rung 8+ is the deepest sizing tier: a dip that got there cost the most


def bounce_summary(events: list[dict]) -> dict:
    done = [e for e in events if e["outcome"] != "open"]
    rec = [e for e in done if e["outcome"] == "recovered"]
    worst = min(done, key=lambda e: e["low_pct"], default=None)
    return {
        "dips": len(done),
        "recovered": len(rec),
        "rate": round(len(rec) / len(done), 3) if len(done) >= MIN_EVENTS else None,
        "median_days": round(statistics.median(e["days"] for e in rec)) if rec else None,
        "more_rungs": sum(1 for e in done if e["extra_rungs"] > 0),
        "deep": sum(1 for e in done if e["rung_reached"] >= DEEP_RUNG),
        # Both "worst" figures come from the SAME dip (the one that fell furthest), so a
        # sentence joining them describes one real event.
        "worst_rung": worst["rung_reached"] if worst else None,
        "worst_low_pct": worst["low_pct"] if worst else None,
        "past_ten": sum(1 for e in done if e["rung_reached"] > 10),
        "open": len(events) - len(done),
    }


def base_rate(closes: list[float], highs: list[float], target: float, window: int = WINDOW) -> float | None:
    """The comparison for the bounce rate: on ANY day (not just after a dip), how often did
    the daily high reach that close × (1 + target) within `window` days? A volatile stock
    hits +10% from almost anywhere, so a high bounce rate only says something about dips
    when it beats this."""
    n = len(closes)
    days = n - window - 1
    if days < 60:
        return None
    hits = sum(1 for i in range(days) if max(highs[i + 1:i + window + 1]) >= closes[i] * (1 + target))
    return round(hits / days, 3)


def leverage_decay_month(move: float | None, leverage: float | None) -> float | None:
    """Monthly (21-day) value lost to daily rebalancing, from the fund's own daily vol:
    (L² − L)/2 × σ_underlying² per day, with σ_underlying = σ_fund / |L|."""
    if not move or not leverage or leverage == 1:
        return None
    su = move / abs(leverage)
    return 21 * (leverage * leverage - leverage) / 2 * su * su


def ladder_params(cfg: StrategyConfig) -> tuple[float, float, list[float]]:
    """(dip, target, extra_drops) from the account's rules, unscaled by deployment:
    dip = the rung-2 drop; target = the sell gain on a rung-2 buy (in $-gain mode, the $
    gain ÷ the rung-2 dollar size); extra drops = rungs 3..10."""
    dip = rules._drop_for_rung(2, cfg)
    if cfg.sell.default_mode == "pct_above":
        target = cfg.sell.pct_above
    else:
        size = rules.sizing_dollars(1, cfg)
        target = cfg.sell.dollar_gain / size if size > 0 else 0.0
    extra = [rules._drop_for_rung(r, cfg) for r in range(3, 11)]
    return dip, target, extra


# ---------------------------------------------------------------- cache + fetch

_cache: dict[str, dict] = {}     # symbol -> {"dates", "closes", "highs", "lows", "asof"}
_derived: dict[tuple[str, date], dict] = {}
_bounce: dict[tuple, tuple[dict, list[dict]]] = {}
_inflight: set[str] = set()
_next_try: dict[str, float] = {}
_FAIL_BACKOFF_S = 300.0
_sem = asyncio.Semaphore(1)       # one 5-year fetch at a time: Schwab throttles bursts


def _today() -> date:
    return datetime.now(MARKET_TZ).date()


def reset_backoff() -> None:
    _next_try.clear()


def _ensure(symbol: str) -> dict | None:
    entry = _cache.get(symbol)
    fresh = entry and entry["asof"] == _today()
    if not fresh and symbol not in _inflight and time.monotonic() >= _next_try.get(symbol, 0.0):
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            _inflight.add(symbol)
            loop.create_task(_refresh(symbol))
    return entry


async def _refresh(symbol: str) -> None:
    try:
        async with _sem:
            hist = await market_data.price_history(symbol, "5Y")
            await asyncio.sleep(0.25)
        rows = [c for c in hist.get("candles", [])
                if c.get("close") is not None and c.get("high") is not None and c.get("low") is not None]
        if not rows or hist.get("stale"):
            _next_try[symbol] = time.monotonic() + _FAIL_BACKOFF_S
            if not rows:
                return
        else:
            _next_try.pop(symbol, None)
        _cache[symbol] = {
            # Daily candles are stamped at midnight-ish UTC of their session, so the UTC
            # date is the trading day (an Eastern conversion could shift it back a day).
            "dates": [datetime.fromtimestamp(c["time"], tz=timezone.utc).date() for c in rows],
            "closes": [float(c["close"]) for c in rows],
            "highs": [float(c["high"]) for c in rows],
            "lows": [float(c["low"]) for c in rows],
            "asof": _today(),
        }
    finally:
        _inflight.discard(symbol)


def _derive(symbol: str, h: dict) -> dict:
    key = (symbol, h["asof"], len(h["closes"]))
    d = _derived.get(key)
    bench = _cache.get(BENCH)
    bench_mark = (bench["asof"], len(bench["closes"])) if bench else None
    if d is None or d["bench_mark"] != bench_mark:   # recompute once the S&P history lands
        closes = h["closes"]
        er = efficiency_ratio(closes)
        w = closes[-(CHOP_DAYS + 1):]
        net = (w[-1] / w[0] - 1) if len(w) > 1 and w[0] > 0 else None   # replaced by the live price in read()
        b = None
        if bench is not None and symbol != BENCH:
            b = beta(dict(zip(h["dates"], closes)), dict(zip(bench["dates"], bench["closes"])))
        elif symbol == BENCH:
            b = 1.0
        d = {"move": typical_move(closes), "er": er, "chop_net": net, "chop_base": w[0] if w else None,
             "beta": b, "bench_mark": bench_mark}
        _derived[key] = d
    return d


def _bounce_for(symbol: str, h: dict, cfg: StrategyConfig) -> tuple[dict, list[dict]]:
    dip, target, extra = ladder_params(cfg)
    key = (symbol, h["asof"], len(h["closes"]), round(dip, 4), round(target, 4), tuple(round(x, 4) for x in extra))
    hit = _bounce.get(key)
    if hit is None:
        ev = bounce_events(h["closes"], h["highs"], h["lows"], dip, target, extra)
        summ = {**bounce_summary(ev), "dip_pct": round(dip, 4), "target_pct": round(target, 4),
                "window_days": WINDOW, "years": round(len(h["closes"]) / 252, 1),
                "base_rate": base_rate(h["closes"], h["highs"], target)}
        # Dollars the ladder would have put in across rungs 2..worst (rung 1 already held).
        wr = summ["worst_rung"]
        summ["worst_dollars"] = (round(sum(rules.sizing_dollars(r - 1, cfg) for r in range(2, wr + 1)))
                                 if wr else None)
        hit = (summ, ev)
        _bounce[key] = hit
    return hit


def _close_on_or_before(dates: list[date], closes: list[float], d: date) -> float | None:
    k = bisect.bisect_right(dates, d) - 1
    return closes[k] if k >= 0 else None


def read(symbol: str, cfg: StrategyConfig, price: float | None, *,
         anchor: tuple[float, date | None] | None = None, next_buy: float | None = None,
         leverage: float | None = None, events: bool = False) -> dict | None:
    """The ladder read for one symbol. `anchor` = (newest priced lot's buy price, its buy
    date) for a held row; None for a watchlist row (then the reference is the highest
    close of the last LOOKBACK days). None until the history has loaded. Non-blocking."""
    symbol = symbol.upper()
    h = _ensure(symbol)
    _ensure(BENCH)
    if not h or len(h["closes"]) < LOOKBACK + 2:
        return None
    d = _derive(symbol, h)
    summ, ev = _bounce_for(symbol, h, cfg)
    closes, dates = h["closes"], h["dates"]
    px = price if price and price > 0 else closes[-1]

    # --- dip: from your newest buy (held) or the recent high (watchlist), vs a normal
    # move over that many trading days (moves grow with √time, so a drop that built up
    # over weeks is compared with weeks of normal movement, not one day's).
    if anchor and anchor[0] > 0:
        ref, ref_date, ref_kind = anchor[0], anchor[1], "last_buy"
        days = len(dates) - bisect.bisect_right(dates, ref_date) if ref_date else 1
    else:
        k = max(range(len(closes) - LOOKBACK, len(closes)), key=lambda i: closes[i])
        ref, ref_date, ref_kind = closes[k], dates[k], "recent_high"
        days = len(closes) - 1 - k
    days = max(1, days)
    dip_pct = px / ref - 1
    # The yardstick is the stock's normal move BEFORE the drop (the 63 days up to the
    # reference day): measured over a window that contains the crash, a crash sets its
    # own baseline and reads as normal. Falls back to the recent window when the
    # reference predates the history.
    k_ref = bisect.bisect_right(dates, ref_date) - 1 if ref_date else len(closes) - 1
    move = (typical_move(closes[:k_ref + 1]) if k_ref >= 21 else None) or d["move"]
    span = move * days ** 0.5 if move else None
    dip = {"from": ref_kind, "ref_price": round(ref, 4), "ref_date": ref_date.isoformat() if ref_date else None,
           "pct": round(dip_pct, 4), "days": days, "move": round(move, 4) if move else None,
           "span_move": round(span, 4) if span else None,
           "norm": round(dip_pct / span, 2) if span else None}
    if next_buy and move and px > 0:
        dip["next_rung_price"] = round(next_buy, 4)
        dip["next_rung_pct"] = round(next_buy / px - 1, 4)
        dip["next_rung_moves"] = round((next_buy / px - 1) / move, 2)

    # --- why down: the S&P's move over the same days × beta vs the stock's move
    why = None
    bench = _cache.get(BENCH)
    if bench and d["beta"] is not None and ref_date and symbol != BENCH:
        b0 = _close_on_or_before(bench["dates"], bench["closes"], ref_date)
        if b0:
            why = move_split(dip_pct, bench["closes"][-1] / b0 - 1, d["beta"], move)
            if why:
                why["since"] = ref_date.isoformat()

    rung = summ["dip_pct"]
    chop_net = (px / d["chop_base"] - 1) if d.get("chop_base") else d["chop_net"]
    label = chop_label(d["er"], chop_net, rung)
    out = {
        "asof": h["asof"].isoformat(),
        "bounce": summ,
        "chop": {"er": round(d["er"], 3) if d["er"] is not None else None, "label": label,
                 "rank": chop_rank(label, d["er"]),
                 "net_pct": round(chop_net, 4) if chop_net is not None else None,
                 "net_rungs": round(chop_net / rung, 1) if chop_net is not None and rung else None,
                 "days": CHOP_DAYS},
        "typical_move": round(d["move"], 4) if d["move"] else None,   # current (the decay uses this)
        "dip": dip,
        "why_down": why,
        "leverage": leverage,
        "decay_month": (round(x, 4) if (x := leverage_decay_month(d["move"], leverage)) is not None else None),
    }
    if events:
        out["events"] = [{"date": dates[e["i"]].isoformat(), **{k: v for k, v in e.items() if k != "i"}}
                         for e in reversed(ev[-8:])]
    return out


def status(symbol: str) -> str:
    """ready | loading | unavailable (the last fetch failed; retrying after the backoff) |
    short (loaded, but a new listing with too little history to read)."""
    symbol = symbol.upper()
    if symbol in _cache:
        return "ready" if len(_cache[symbol]["closes"]) >= LOOKBACK + 2 else "short"
    if symbol not in _inflight and _next_try.get(symbol, 0.0) > time.monotonic():
        return "unavailable"
    return "loading"


def row_fields(symbol: str, read_out: dict | None) -> dict:
    """Flat, sortable dashboard fields plus the compact nested read (no event list). The
    table's first sort click is DESCENDING, so each key is oriented for that click to put
    the most ladder-relevant rows first: highest bounce rate, choppiest, deepest dip,
    most market-driven, biggest decay."""
    why = (read_out or {}).get("why_down")
    rank = read_out["chop"]["rank"] if read_out else None
    norm = read_out["dip"]["norm"] if read_out else None
    return {
        "ladder": read_out,
        "ladder_status": "ready" if read_out else status(symbol),
        "bounce_rate": read_out["bounce"]["rate"] if read_out else None,
        "chop_score": round(3.999 - rank, 3) if rank is not None else None,
        "dip_depth": -norm if norm is not None else None,
        "why_market_share": why["market_share"] if why else None,
        "decay_month": read_out["decay_month"] if read_out else None,
    }
