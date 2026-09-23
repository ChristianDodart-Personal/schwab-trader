"""Ticker risk classification — a coarse "how dangerous is this instrument" band used to
color-code the symbol across the app (blue = safer, red = riskier).

Pure + dependency-free (unit-tested). Heuristic, from data we already store on the Ticker
(name, industry, market cap) — no extra fetch, no schema change:
  - low       broad ETF/fund, or large-cap stock (>= $10B)          → blue
  - medium    mid-cap stock ($2B–$10B), or unknown                  → neutral
  - elevated  small-cap ($300M–$2B)                                 → amber
  - high      leveraged/inverse ETF, or micro-cap (< $300M)         → red
"""
from __future__ import annotations

# Strong leverage/inverse tokens — dangerous regardless of anything else.
_STRONG_LEV = ("leverag", "inverse", "ultrapro", " 2x", "2x ", " 3x", "3x ", "-1x")
# Weaker hints — only count as leveraged when the name also looks like a fund/ETF, so a
# normal stock named "Daily Journal" or "Bear Creek Mining" isn't misflagged.
_WEAK_LEV = ("bear", "short ", "ultra ", "daily ")
_ETF_HINTS = ("etf", "fund", "trust", "exchange traded", "shares", "proshares",
              "direxion", "ishares", "invesco", "spdr")

LEVELS = ("low", "medium", "elevated", "high")


def _looks_etf(blob: str) -> bool:
    return any(h in blob for h in _ETF_HINTS)


def classify(name: str | None, industry: str | None, market_cap: float | None,
             is_etf: bool | None = None) -> str:
    """Return a risk level in LEVELS. Unknown/none-data → 'medium' (neutral). `is_etf`, when
    known (a stored industry tag), is authoritative; else ETF-ness is inferred from
    the name/industry."""
    blob = f"{name or ''} {industry or ''}".lower()
    etf = is_etf if is_etf is not None else _looks_etf(blob)
    if any(t in blob for t in _STRONG_LEV) or (etf and any(t in blob for t in _WEAK_LEV)):
        return "high"          # leveraged / inverse product — the most dangerous
    if etf:
        return "low"           # broad/diversified fund — safest
    # Individual stock (or unknown type): band by market cap.
    if market_cap is None or market_cap <= 0:
        return "medium"
    if market_cap >= 10_000_000_000:
        return "low"
    if market_cap >= 2_000_000_000:
        return "medium"
    if market_cap >= 300_000_000:
        return "elevated"
    return "high"  # micro-cap
