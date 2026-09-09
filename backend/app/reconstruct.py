"""Reconstruct open lots (rungs) + completed trades from a chronological list of
fills — LIFO (sells retire the most-recently-bought lots first, matching the
strategy). Source-agnostic: feed it Schwab order/transaction fills (…719 once
funded) or any other source. Pure logic; no I/O.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from itertools import groupby

_EPS = 1e-9


@dataclass
class Fill:
    symbol: str
    side: str          # "BUY" | "SELL" | "SPLT" (split adjustment)
    shares: float      # SPLT paired: NEW total shares; SPLT delta: RECEIVED shares
    price: float       # SPLT paired: OLD total shares; SPLT delta: 0 (ratio from held)
    at: date | datetime
    order_type: str = ""   # "MARKET" | "LIMIT" | ... (for audit/notify classification; unused by LIFO)
    order_id: str = ""     # Schwab order id (for a stable audit identity; unused by LIFO)


@dataclass
class OpenLot:
    symbol: str
    shares: float
    price: float
    at: date | datetime
    rung: int = 0
    source: str = "fill"   # "fill" = from a real buy fill; "position" = backfilled from Schwab's aggregate
    order_id: str = ""     # Schwab order id of the buy (used to merge one order's many execution legs)


@dataclass
class ClosedTrade:
    symbol: str
    shares: float
    buy_price: float
    sell_price: float
    opened_at: date | datetime
    completed_at: date | datetime
    order_id: str = ""   # the SELL fill's Schwab order id (blank for CSV-sourced sells)

    @property
    def cost(self) -> float:
        return self.buy_price * self.shares

    @property
    def profit(self) -> float:
        return (self.sell_price - self.buy_price) * self.shares


_SIDE_ORDER = {"SPLT": -1, "BUY": 0}  # splits first (rescale before the day's trades), then buys, then sells


def _sort_key(f: Fill):
    # chronological; on ties a SPLIT precedes a BUY precedes a SELL
    return (f.at, _SIDE_ORDER.get(f.side.upper(), 1))


def _day(at) -> date:
    return at.date() if isinstance(at, datetime) else at


def _ordered_for_lifo(fills: list[Fill]) -> list[Fill]:
    """Chronological order, with a repair for unreliable intra-day sequencing.

    Schwab's export isn't always execution-ordered WITHIN a day, so a same-day round
    trip can arrive sell-before-buy. Left as-is the SELL oversells — it either retires
    an OLDER lot (wrong cost basis) or, from a flat position, flags a phantom oversell
    and strands the covering BUY as a fake open holding. A long-only fill stream can't
    legitimately go negative (real shorts are separate SSEL fills, already excluded), so
    any (symbol, day) whose sequence drives inventory below zero had a bad order —
    canonicalize just that day to SPLT -> BUY -> SELL. Days that never go negative keep
    their real order, preserving genuine same-day buy/sell/buy LIFO attribution
    (see test_csv_preserves_real_intraday_order). Symbols are independent; cross-symbol
    order is irrelevant to per-symbol LIFO."""
    ordered = sorted(fills, key=_sort_key)
    by_sym: dict[str, list[Fill]] = {}
    for f in ordered:
        by_sym.setdefault(f.symbol, []).append(f)

    out: list[Fill] = []
    for _sym, fs in by_sym.items():
        inv = 0.0
        trusted = True  # a SPLT rescales inventory in ways we don't track here → stop repairing after one
        for _d, grp in groupby(fs, key=lambda x: _day(x.at)):
            g = list(grp)
            if trusted and not any(x.side.upper() == "SPLT" for x in g):
                sim, bad = inv, False
                for x in g:
                    s = x.side.upper()
                    if s == "BUY":
                        sim += x.shares
                    elif s == "SELL":
                        sim -= x.shares
                        if sim < -_EPS:
                            bad = True
                if bad:  # impossible order for a long-only stream → buys before sells
                    g = sorted(g, key=lambda x: _SIDE_ORDER.get(x.side.upper(), 1))
                for x in g:
                    s = x.side.upper()
                    if s == "BUY":
                        inv += x.shares
                    elif s == "SELL":
                        inv -= x.shares
                inv = max(inv, 0.0)  # clamp so an unfixable day can't poison later days
            else:
                trusted = False
            out.extend(g)
    return out


def _can_merge(lot: OpenLot, f: Fill) -> bool:
    """Should this BUY fill fold into the lot on top of the stack instead of opening
    a new rung? A market (or large) order routinely fills across several
    counterparties, so Schwab reports it as multiple consecutive BUY executions —
    same order, ~same second, same or near price. Reconstructed one-lot-per-fill,
    that shows as several tiny positions at one price and, worse, lets a sell realize
    only a FRAGMENT of the rung's gain. Collapsing them restores one true rung.

    Only ever merges into `stack[-1]` (the adjacent, most-recent lot), so an
    intervening SELL — which pops lots — always breaks a merge chain and same-day
    buy/sell/buy LIFO attribution is untouched. Merge when either:
      - same Schwab order id (one order, many execution legs — the exact fragmentation), or
      - same price on the SAME day (distinct orders that are plainly one rung; the
        ladder never places two rungs at a single price, and same-price-same-day is
        LIFO-identical anyway). Different days at one price stay separate rungs.
    Never merges a synthetic position-backfill lot (source != "fill")."""
    if lot.source != "fill":
        return False
    if lot.order_id and f.order_id and lot.order_id == f.order_id:
        return True
    return abs(lot.price - f.price) < _EPS and _day(lot.at) == _day(f.at)


def _merge_into(lot: OpenLot, f: Fill) -> None:
    """Fold a BUY fill into an existing lot: sum shares, share-weight the cost (so a
    market order's slightly-varying leg prices collapse to the real average), and keep
    the earliest timestamp. Adopts the fill's order id if the lot lacked one."""
    total = lot.shares + f.shares
    if total > _EPS:
        lot.price = (lot.shares * lot.price + f.shares * f.price) / total
    lot.shares = total
    if isinstance(f.at, datetime) and isinstance(lot.at, datetime):
        lot.at = min(lot.at, f.at)
    lot.order_id = lot.order_id or f.order_id


def reconstruct(fills: list[Fill]) -> dict:
    """Returns {open_lots: {symbol: [OpenLot...]}, closed: [ClosedTrade...],
    oversold: [(symbol, shares, sell_price, at)]}."""
    stacks: dict[str, list[OpenLot]] = {}
    closed: list[ClosedTrade] = []
    oversold: list[tuple] = []

    for f in _ordered_for_lifo(fills):
        side = f.side.upper()
        stack = stacks.setdefault(f.symbol, [])
        if side == "SPLT":
            # Rescale the open stack by the split ratio r. Cost basis is PRESERVED
            # exactly (shares x price invariant per lot) and no P/L is realized — the
            # position just changes denomination. Two encodings (see _pair_splits):
            #   price > 0  -> PAIRED: shares=new_total, price=old_total, r=new/old
            #                 (reverse split r<1, forward split r>1).
            #   price <= 0 -> DELTA: shares=RECEIVED shares from a single-row forward
            #                 split; r=(held+received)/held from the current stack.
            # Fractional remainders (broker pays cash-in-lieu) are left as-is; the
            # positions reconcile step aligns the final total to Schwab's actual count.
            old_total = f.price
            if old_total > _EPS and f.shares > _EPS:
                r = f.shares / old_total
            elif old_total <= _EPS and f.shares > _EPS:
                held = sum(l.shares for l in stack)
                r = (held + f.shares) / held if held > _EPS else 0.0
            else:
                r = 0.0
            if r > _EPS:
                for lot in stack:
                    lot.shares *= r
                    lot.price /= r
            continue
        if side == "BUY":
            if stack and _can_merge(stack[-1], f):
                _merge_into(stack[-1], f)
            else:
                stack.append(OpenLot(f.symbol, f.shares, f.price, f.at, order_id=f.order_id))
        else:  # SELL retires the most recent lots first (LIFO)
            remaining = f.shares
            while remaining > _EPS and stack:
                lot = stack[-1]
                take = min(remaining, lot.shares)
                closed.append(ClosedTrade(f.symbol, take, lot.price, f.price,
                                          lot.at, f.at, order_id=f.order_id or ""))
                lot.shares -= take
                remaining -= take
                if lot.shares <= _EPS:
                    stack.pop()
            if remaining > _EPS:  # sold more than held (short/data gap)
                oversold.append((f.symbol, remaining, f.price, f.at))

    open_lots: dict[str, list[OpenLot]] = {}
    for sym, lots in stacks.items():
        live = [l for l in lots if l.shares > _EPS]
        for i, lot in enumerate(live, start=1):  # oldest = rung 1
            lot.rung = i
        if live:
            open_lots[sym] = live
    return {"open_lots": open_lots, "closed": closed, "oversold": oversold}


def split_factor(recon_shares: float, actual_shares: float,
                 our_avg: float, schwab_avg: float) -> tuple[int, str] | None:
    """Decide whether Schwab's CURRENT holding is the fill-built holding after a stock
    split. Returns (k, "reverse"|"forward") or None.

    Two independent signals must agree, which is what separates a split from a sale:
      - SHARES: actual ≈ recon / k (reverse) or recon × k (forward), within one share
        (a reverse split drops the fractional remainder as cash-in-lieu).
      - COST:   Schwab restates the position's average price by the same factor
        (× k reverse, ÷ k forward). Schwab's average comes from THEIR tax-lot method
        while ours is LIFO, so the two can legitimately differ by 10–20% even with no
        split (the IREN case in Data health). The test is therefore not "within 5% of
        k" but "closer to k than to 1": the cost ratio must exceed √k and sit inside
        k/1.5 … k×1.5. RCAX 1:5: our LIFO avg $3.39 vs Schwab $15.10 → ratio 4.45,
        √5 = 2.24, band 3.33…7.5 → split. A partial sale leaves Schwab's average where
        it was, ratio ≈ 1 (±20%), never above √k for any k ≥ 2 → not a split.
    k is searched 2..100."""
    if recon_shares <= _EPS or actual_shares <= _EPS or our_avg <= _EPS or schwab_avg <= _EPS:
        return None

    def cost_moved_by(k: int, ratio: float) -> bool:
        return ratio > k ** 0.5 and (k / 1.5) <= ratio <= (k * 1.5)

    for k in range(2, 101):
        if abs(actual_shares - recon_shares / k) < 1.0 and cost_moved_by(k, schwab_avg / our_avg):
            return k, "reverse"
        if abs(actual_shares - recon_shares * k) < 1.0 and cost_moved_by(k, our_avg / schwab_avg):
            return k, "forward"
    return None


def infer_splits(open_by_symbol: dict[str, list[OpenLot]],
                 positions: dict[str, tuple[float, float]], at) -> list[Fill]:
    """Detect splits the fill stream never recorded, from the positions snapshot.

    The live API path only ingests TRADE transactions, so a split that happens between
    CSV imports is invisible to the ledger: the fill-built lots keep pre-split shares
    and prices while Schwab holds the post-split count. Reconcile would then read the
    shortfall as a missed SELL and trim lots at the OLD per-share cost (RCAX 1:5
    reverse split, 2026-09-09: 729 sh @ $3.39 became 145 sh, shown as +345% and a
    $1,709 "harvestable" gain that did not exist).

    For every symbol that is purely fill-built AND present in `positions`, apply
    `split_factor`. A match yields a PAIRED `SPLT` fill (shares = new total, price =
    old total), the same encoding the CSV importer emits, stamped `at`; reconstruct
    rescales the lots (shares × r, price ÷ r) with cost basis preserved and no P/L.
    Position-backfilled symbols are skipped: their lots already carry Schwab's
    post-split figures."""
    out: list[Fill] = []
    for sym, lots in open_by_symbol.items():
        if sym not in positions or not lots or any(l.source != "fill" for l in lots):
            continue
        recon = sum(l.shares for l in lots)
        cost = sum(l.shares * l.price for l in lots)
        actual, schwab_avg = positions[sym]
        if recon <= _EPS or actual is None or actual <= _EPS:
            continue
        hit = split_factor(recon, actual, cost / recon, float(schwab_avg or 0.0))
        if hit is None:
            continue
        out.append(Fill(sym, "SPLT", shares=round(actual, 4), price=round(recon, 4), at=at,
                        order_type="INFERRED", order_id=""))
    return out


def split_stamp(fills: list[Fill], today: date):
    """A timestamp for an inferred SPLT that sorts correctly against the existing
    fills: midnight of `today`, matching their type (tz-aware / naive datetime, or a
    plain date when the stream is date-only). Mixing date and datetime would make the
    chronological sort raise. SPLT already sorts ahead of same-day BUY/SELL."""
    sample = next((f.at for f in fills if isinstance(f.at, datetime)), None)
    if sample is None:
        return today
    return datetime(today.year, today.month, today.day, tzinfo=sample.tzinfo)


def reconcile_open_lots(open_by_symbol: dict[str, list[OpenLot]],
                        positions: dict[str, tuple[float, float]],
                        horizon_at,
                        drop_absent: bool = False) -> dict[str, list[OpenLot]]:
    """Reconcile fill-reconstructed open lots against Schwab's CURRENT positions
    (the authoritative current holding). Guarantees each symbol's open-lot total
    equals Schwab's held shares — recovering shares whose BUYS fall outside the
    fill window (or aren't exposed at all, e.g. a managed account) by backfilling
    a synthetic 'prior holdings' lot at the best-known cost. `positions` maps
    symbol -> (shares, average_price). `horizon_at` stamps the synthetic lot.

    - shortfall (Schwab holds more than we reconstructed): prepend a `source=position`
      lot for the missing shares (it's the oldest → rung 1), priced so the symbol's
      total cost basis matches Schwab's (falls back to the average price).
    - overage (we reconstructed more than Schwab holds — a missed sell): trim
      newest-first down to the held quantity.
    - EXPLICITLY held-none (symbol present in `positions` with ~0 shares): drop it.
    - ABSENT from `positions` (symbol reconstructed from fills but not reported by
      the read): depends on `drop_absent`. Default (False) KEEPS the fill lots
      untouched — a partial/degraded read omits symbols it can't report, and treating
      omission as 'sold everything' would silently delete a real holding. When True,
      the caller is asserting `positions` is a VERIFIED, non-empty snapshot (an
      empty/partial read is coerced to None upstream and skips reconcile entirely), so
      an absent symbol is genuinely sold out and is DROPPED instead of left as a
      phantom holding.
    Rungs are renumbered oldest-first afterward.
    """
    result: dict[str, list[OpenLot]] = {}
    for sym in set(open_by_symbol) | set(positions):
        lots = list(open_by_symbol.get(sym, []))
        recon = sum(l.shares for l in lots)
        if sym not in positions:
            # Reconstructed from fills but ABSENT from the positions snapshot.
            if drop_absent:
                # Caller vouches for a VERIFIED, non-empty snapshot (an empty/partial
                # read is coerced to None upstream and skips reconcile). A symbol Schwab
                # doesn't report is therefore genuinely sold out → drop it rather than
                # leave a phantom holding the dashboard would show.
                continue
            # Conservative default: never delete by omission (a partial read would
            # otherwise wipe a real holding).
            if lots:
                for i, lot in enumerate(lots, start=1):
                    lot.rung = i
                result[sym] = lots
            continue
        actual, avg = positions[sym]
        if actual <= _EPS:
            continue  # positions EXPLICITLY reports ~0 → genuinely sold out → drop
        diff = actual - recon
        if diff > _EPS:
            recon_cost = sum(l.shares * l.price for l in lots)
            resid = actual * avg - recon_cost           # cost attributable to the missing shares
            price = resid / diff if resid > 0 else avg  # else fall back to the position average
            lots = [OpenLot(sym, round(diff, 4), round(price, 4), horizon_at, source="position")] + lots
        elif diff < -_EPS:
            over = -diff
            while over > _EPS and lots:                 # trim newest (end) first
                last = lots[-1]
                if last.shares <= over + _EPS:
                    over -= last.shares
                    lots.pop()
                else:
                    last.shares = round(last.shares - over, 4)
                    over = 0.0
        for i, lot in enumerate(lots, start=1):
            lot.rung = i
        if lots:
            result[sym] = lots
    return result
