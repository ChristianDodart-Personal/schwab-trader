"""Pure strategy functions — the LIFO progressive-ladder engine.

Every function takes a StrategyConfig and plain numbers. No I/O, no Schwab, no
DB. This is what makes the strategy malleable: change YAML -> behavior changes,
and these functions stay trivially unit-testable against the spreadsheet.

Mapping back to the sheet (Longs tab):
  suggested_shares    <- E6   (ifs on rungs filled -> $500/$1000/$1500 / price)
  next_buy_price      <- K10..K18  (prev price * (1 - tier drop))
  lilo_pct            <- J6   ((current / newest lot's buy) - 100%)
  basis_per_share     <- J19  (total invested / total shares)
  is_buy_mark         <- I6   (current < next buy-sug)
  is_sell_mark        <- G6   (current > the newest lot's sell target)
"""
from __future__ import annotations

from .config import StrategyConfig


def sizing_dollars(filled_rungs: int, cfg: StrategyConfig) -> float:
    """Dollars to deploy on the NEXT buy, given how many rungs are already filled."""
    next_rung = filled_rungs + 1
    for tier in cfg.sizing_tiers:
        if next_rung <= tier.up_to_rungs:
            return tier.dollars
    return cfg.sizing_tiers[-1].dollars  # past the last tier -> use the deepest


def suggested_shares(filled_rungs: int, price: float, cfg: StrategyConfig) -> float:
    if price <= 0:
        return 0.0
    return sizing_dollars(filled_rungs, cfg) / price


def deployment_drop_multiplier(deployed_pct: float | None, cfg: StrategyConfig) -> float:
    """Multiplier applied to the base ladder drop based on how deployed the account is.
    Returns 1.0 (no change) when scaling is disabled or `deployed_pct` is unknown — so
    the fixed-ladder behavior is fully preserved unless the user opts in."""
    ds = cfg.deployment_scaling
    if not ds.enabled or deployed_pct is None:
        return 1.0
    for t in ds.tiers:  # sorted descending: first tier whose floor we've reached wins
        if deployed_pct >= t.min_deployed_pct:
            return t.drop_multiplier
    return 1.0


def _drop_for_rung(rung: int, cfg: StrategyConfig, deployed_pct: float | None = None) -> float:
    """The % drop required to trigger `rung` (1-indexed; rung 1 has no drop), optionally
    scaled by account deployment when deployment_scaling is enabled."""
    base = cfg.ladder_drops[-1].drop_pct
    for d in cfg.ladder_drops:
        if rung <= d.up_to_rung:
            base = d.drop_pct
            break
    return base * deployment_drop_multiplier(deployed_pct, cfg)


def next_buy_price(prev_buy_price: float, next_rung: int, cfg: StrategyConfig,
                   deployed_pct: float | None = None) -> float:
    """Trigger price for `next_rung` given the previous rung's buy price."""
    return prev_buy_price * (1.0 - _drop_for_rung(next_rung, cfg, deployed_pct))


def lilo_pct(current_price: float, last_buy_price: float) -> float:
    """How far current price sits above the NEWEST (last-in) lot's buy price, the lot a
    LIFO sale retires first (e.g. 0.12 = +12%, -0.08 = 8% below the last buy)."""
    if last_buy_price <= 0:
        return 0.0
    return (current_price / last_buy_price) - 1.0


def basis_per_share(total_invested: float, total_shares: float) -> float:
    return total_invested / total_shares if total_shares else 0.0


def is_buy_mark(current_price: float, next_buy_sug: float) -> bool:
    return current_price < next_buy_sug


def sell_target_price(
    buy_price: float,
    shares: float,
    cfg: StrategyConfig,
    mode: str | None = None,
) -> float:
    """Target sell PRICE for a lot, in either dollar-gain or pct-above mode."""
    mode = mode or cfg.sell.default_mode
    if mode == "dollar_gain":
        if shares <= 0:
            return buy_price
        return buy_price + (cfg.sell.dollar_gain / shares)
    if mode == "pct_above":
        return buy_price * (1.0 + cfg.sell.pct_above)
    raise ValueError(f"unknown sell mode: {mode!r}")


def is_sell_mark(current_price: float, sell_target: float) -> bool:
    """SELL when price clears the NEWEST lot's target. Sells are LIFO, so that lot is the
    one a sale actually books against; an older lot hitting its own (lower) target would
    signal a sale that realizes a loss on the newest lot."""
    return sell_target > 0 and current_price > sell_target
