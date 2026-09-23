"""Pure 'method health' analytics for the LIFO progressive ladder.

Read-only risk lenses over the CURRENT book and the realized trade record. No I/O:
callers pass plain position facts / trade stats + a StrategyConfig; these return
JSON-ready dicts, so everything is trivially unit-testable (like rules.py).

Everything here is ADVISORY. The ladder itself has no stop and no sell-the-loser
rule — its failure mode lives in the tail (a name that keeps falling while the
biggest lots go in). These functions exist to make that tail *visible*:
  - concentration_by_underlying: true single-name exposure (stock + its leveraged ETFs)
  - ladder_stress: mark-to-market at further drops (the downside the ladder walks into)
  - thesis_break: names behaving like a broken thesis the ladder would just keep buying
  - kelly_sizing: whether the fixed $ tiers are sane vs the account's own win/loss record
They recommend nothing automatically and place no orders.
"""
from __future__ import annotations

from . import rules
from .config import StrategyConfig


# --- 1) Concentration by true underlying -------------------------------------
def concentration_by_underlying(positions: list[dict]) -> list[dict]:
    """Roll each position up to its underlying — a stock and any leveraged/inverse
    ETFs tied to it are ONE exposure — so the true single-name weight is visible.
    Informational: there is no cap (removed 2026-09; it only mattered for very large
    accounts).

    positions: [{symbol, underlying (str|None), value (float)}]; value = market value.
    Returns rows sorted by exposure desc: {key, symbols, value, pct}.
    """
    groups: dict[str, dict] = {}
    for p in positions:
        val = float(p.get("value") or 0.0)
        if val <= 0:
            continue
        key = (p.get("underlying") or p["symbol"]).upper()
        g = groups.setdefault(key, {"key": key, "symbols": [], "value": 0.0})
        g["symbols"].append(p["symbol"].upper())
        g["value"] += val
    total = sum(g["value"] for g in groups.values())
    out = []
    for g in groups.values():
        pct = g["value"] / total if total else 0.0
        out.append({
            "key": g["key"],
            "symbols": sorted(set(g["symbols"])),
            "value": round(g["value"], 2),
            "pct": round(pct, 4),
        })
    out.sort(key=lambda r: r["pct"], reverse=True)
    return out


# --- 2) Downside / ladder-depth stress ---------------------------------------
def ladder_stress(positions: list[dict], drops: list[float], target_lots_deep: int) -> dict:
    """Mark each held position to market at a set of FURTHER price drops — the tail the
    'add more as it falls' ladder walks into — plus portfolio totals at each drop.

    positions: [{symbol, shares, invested, price, lots_deep}]; drops: e.g. [.1,.25,.5].
    """
    rows = []
    port_invested = 0.0
    port_now = 0.0
    port_at = {d: 0.0 for d in drops}
    for p in positions:
        shares = float(p.get("shares") or 0.0)
        invested = float(p.get("invested") or 0.0)
        price = float(p.get("price") or 0.0)
        if shares <= 0 or price <= 0:
            continue
        now_val = shares * price
        scen = []
        for d in drops:
            v = shares * price * (1.0 - d)
            scen.append({"drop": d, "value": round(v, 2), "unrealized": round(v - invested, 2)})
            port_at[d] += v
        port_invested += invested
        port_now += now_val
        lots_deep = int(p.get("lots_deep") or 0)
        rows.append({
            "symbol": p["symbol"].upper(),
            "lots_deep": lots_deep,
            "over_depth": lots_deep > target_lots_deep,
            "invested": round(invested, 2),
            "value_now": round(now_val, 2),
            "unrealized_now": round(now_val - invested, 2),
            "scenarios": scen,
        })
    rows.sort(key=lambda r: r["lots_deep"], reverse=True)
    portfolio = {
        "invested": round(port_invested, 2),
        "value_now": round(port_now, 2),
        "scenarios": [{"drop": d, "value": round(port_at[d], 2),
                       "unrealized": round(port_at[d] - port_invested, 2)} for d in drops],
    }
    return {"positions": rows, "portfolio": portfolio}


# --- 3) Thesis-break flags (advisory) ----------------------------------------
def thesis_break(position: dict, cfg: StrategyConfig) -> dict | None:
    """Warn (never act) when a held name looks like a broken thesis the ladder would
    just keep buying. Thresholds live in cfg.guardrails (advisory).

    position: {symbol, price, first_buy, min_buy, lots_deep, days_held}. Returns
    {symbol, lots_deep, reasons:[{code, text, value}]} or None when nothing trips.
    """
    g = cfg.guardrails
    down_pct = float(g.get("thesis_break_down_pct", 0.5))
    max_days = int(g.get("thesis_break_max_hold_days", 240))
    price = float(position.get("price") or 0.0)
    first_buy = float(position.get("first_buy") or 0.0)
    min_buy = float(position.get("min_buy") or 0.0)
    lots_deep = int(position.get("lots_deep") or 0)
    days_held = int(position.get("days_held") or 0)
    reasons = []
    if first_buy > 0 and price > 0:
        down = 1.0 - price / first_buy
        if down >= down_pct:
            reasons.append({"code": "deep_drawdown",
                            "text": f"Down {round(down * 100)}% from the first buy",
                            "value": round(down, 4)})
    # Fallen clean through the bottom of the ladder: below the cheapest lot by a full
    # further rung — the ladder would already have added again and price kept dropping.
    if min_buy > 0 and price > 0 and lots_deep > 0:
        next_trigger = rules.next_buy_price(min_buy, lots_deep + 1, cfg)
        if price < next_trigger:
            reasons.append({"code": "below_ladder",
                            "text": "Below the next ladder rung — price has fallen past your buy plan",
                            "value": round(next_trigger, 4)})
    if days_held >= max_days:
        reasons.append({"code": "stale",
                        "text": f"Held {days_held} days without closing out",
                        "value": days_held})
    if not reasons:
        return None
    return {"symbol": position["symbol"].upper(), "lots_deep": lots_deep, "reasons": reasons}


# --- 4) Sizing sanity check (Kelly reference) --------------------------------
def kelly_sizing(wins: int, losses: int, avg_win: float, avg_loss: float,
                 account_value: float, cfg: StrategyConfig, min_trades: int = 20) -> dict:
    """A REFERENCE, not advice: from the account's OWN realized win rate and average
    win/loss, what fraction of the book does the Kelly criterion imply per name, and how
    does that compare to the fixed $ sizing tiers? avg_win/avg_loss are positive dollar
    magnitudes. Returns {enough:false, ...} until there are enough closed trades.
    """
    n = wins + losses
    if n < min_trades or avg_loss <= 0 or account_value <= 0:
        return {"enough": False, "trades": n, "min_trades": min_trades}
    p = wins / n
    b = avg_win / avg_loss                        # payoff ratio (avg win / avg loss)
    kelly = (b * p - (1.0 - p)) / b               # full-Kelly fraction of bankroll
    kelly = max(0.0, kelly)                        # a losing edge implies bet ~0, not negative
    half = kelly / 2.0                             # half-Kelly: the usual practical cap
    return {
        "enough": True,
        "trades": n,
        "win_rate": round(p, 4),
        "payoff_ratio": round(b, 3),
        "kelly_fraction": round(kelly, 4),
        "half_kelly_fraction": round(half, 4),
        "kelly_dollars": round(kelly * account_value, 2),
        "half_kelly_dollars": round(half * account_value, 2),
        "current_tiers": [t.dollars for t in cfg.sizing_tiers],
        "account_value": round(account_value, 2),
    }
