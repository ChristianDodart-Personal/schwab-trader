"""Non-blocking sanity checks for a strategy config.

The Rules tab lets the user edit freely — including into states that are legal to
save but probably not intended (a ladder that doesn't get deeper, sizing that shrinks
with depth, a deployment tier at >100%). This surfaces those as advisory findings; it
NEVER blocks saving. Pure + defensive (tolerates missing/partial keys) so it can be
unit-tested and run on any mapping shape from `StrategyConfig.to_mapping()`.
"""
from __future__ import annotations


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def check(cfg: dict) -> list[dict]:
    """Return a list of {level: 'warn'|'info', message} findings (empty = looks consistent)."""
    out: list[dict] = []
    cfg = cfg or {}

    # --- buy ladder: drops should get DEEPER (or hold) as rungs go deeper ---
    ladder = cfg.get("buy_ladder") or {}
    drops = [d for d in (ladder.get("drops") or []) if isinstance(d, dict)]
    drops_sorted = sorted(drops, key=lambda d: _num(d.get("up_to_rung")) or 0)
    prev_drop = None
    for d in drops_sorted:
        dp = _num(d.get("drop_pct"))
        if dp is None:
            continue
        if dp <= 0:
            out.append({"level": "warn", "message": f"Buy-ladder drop through position {d.get('up_to_rung')} is {dp*100:.0f}% — a position with no drop never triggers below the last buy."})
        if prev_drop is not None and dp < prev_drop:
            out.append({"level": "warn", "message": f"Buy-ladder drops get SHALLOWER at position {d.get('up_to_rung')} ({dp*100:.0f}% < {prev_drop*100:.0f}%) — deeper positions usually need bigger drops."})
        prev_drop = dp

    # --- sizing tiers: through-rung should ascend; dollars usually grow with depth ---
    tiers = [t for t in (cfg.get("sizing_tiers") or []) if isinstance(t, dict)]
    tiers_sorted = sorted(tiers, key=lambda t: _num(t.get("up_to_rungs")) or 0)
    seen_rungs = set()
    prev_dollars = None
    for t in tiers_sorted:
        r = _num(t.get("up_to_rungs"))
        dollars = _num(t.get("dollars"))
        if r in seen_rungs:
            out.append({"level": "warn", "message": f"Two sizing tiers share 'through position {r}' — one is ignored."})
        seen_rungs.add(r)
        if dollars is not None and dollars <= 0:
            out.append({"level": "warn", "message": f"Sizing tier through position {r} deploys ${dollars:g} — a non-positive buy size."})
        if prev_dollars is not None and dollars is not None and dollars < prev_dollars:
            out.append({"level": "info", "message": f"Sizing SHRINKS at position {r} (${dollars:g} < ${prev_dollars:g}) — the ladder normally adds more as it deepens."})
        if dollars is not None:
            prev_dollars = dollars

    # (The ladder no longer has a max-positions cap, so there's nothing to cross-check
    # the deepest tier against — buys are unlimited.)

    # --- sell target ---
    sell = cfg.get("sell") or {}
    mode = sell.get("default_mode")
    if mode == "pct_above" and (_num(sell.get("pct_above")) or 0) <= 0:
        out.append({"level": "warn", "message": "Sell mode is '% above buy' but the percentage is 0 — sell targets would sit at the buy price."})
    if mode == "dollar_gain" and (_num(sell.get("dollar_gain")) or 0) <= 0:
        out.append({"level": "warn", "message": "Sell mode is 'dollar gain' but the gain is $0 — sell targets would sit at cost."})

    # --- deployment scaling ---
    ds = cfg.get("deployment_scaling") or {}
    if ds.get("enabled"):
        dtiers = [t for t in (ds.get("tiers") or []) if isinstance(t, dict)]
        if not dtiers:
            out.append({"level": "warn", "message": "Deployment scaling is ON but has no tiers — it does nothing."})
        for t in dtiers:
            pct = _num(t.get("min_deployed_pct"))
            mult = _num(t.get("drop_multiplier"))
            # Deployed % = market value ÷ your own equity: 100% = fully invested with your
            # own money, above 100% = on margin. So tiers above 100 are valid (margin tiers);
            # only a negative threshold is meaningless.
            if pct is not None and pct < 0:
                out.append({"level": "warn", "message": f"Deployment tier at {pct:g}% is negative — deployment can't be below 0%."})
            if mult is not None and mult < 1:
                out.append({"level": "warn", "message": f"Deployment multiplier {mult:g}× is below 1 — it's treated as 1.0× (scaling only ever requires deeper dips, never shallower)."})

    return out
