"""Read an account's CURRENT holdings from Schwab (the `get_account` positions
endpoint) as {symbol: (shares, avg_price)}. This is the authoritative current
quantity Schwab reports; `rebuild.resync_account` reconciles the fill-reconstructed
ladder against it (backfilling holdings whose buys predate the fill window, and
fully populating a managed account that exposes no fills).

Only SHARE-based instruments are returned (equities/ETFs/funds); options/futures/
forex are skipped (see fills._SKIP_ASSET_TYPES).
"""
from __future__ import annotations

import logging

from .fills import _SKIP_ASSET_TYPES
from .symbols import resolve_symbol
from .util import _f

log = logging.getLogger(__name__)


def _fetch_positions_sync(client, account_hash):
    """Sync (call inside asyncio.to_thread). Returns list[(symbol, shares, avg_price)]
    for share-based long positions, or None if the account isn't readable."""
    r = client.get_account(account_hash, fields=client.Account.Fields.POSITIONS)
    if r.status_code != 200:
        return None  # restricted / transient → caller treats as "don't reconcile"
    body = r.json()
    sa = body.get("securitiesAccount") if isinstance(body, dict) else None
    if not isinstance(sa, dict):
        # 200 but no account object (degraded / shape-changed / list payload) → NOT a
        # trustworthy 'you hold nothing'; signal unavailable so we don't reconcile.
        log.warning(f"{account_hash[-4:]}: 200 but no securitiesAccount — treating as unavailable")
        return None
    out = []
    for p in sa.get("positions", []) or []:
        instr = p.get("instrument", {}) or {}
        if instr.get("assetType") in _SKIP_ASSET_TYPES:  # skip options/futures/forex
            continue
        # NET quantity: long minus short. A SHORT position comes through NEGATIVE —
        # explicit information, not omission: the reconcile drops long lots for a
        # symbol Schwab says isn't held long (actual <= 0 → drop), and the health
        # report labels the short instead of misreading it as missing data. The
        # ladder itself stays long-only.
        qty = _f(p.get("longQuantity")) - _f(p.get("shortQuantity"))
        avg = _f(p.get("averagePrice"))
        if abs(qty) <= 1e-9:
            continue
        # Ticker, not whatever string Schwab put in `symbol`. During a fund reorg or a
        # data hiccup Schwab reports a holding under its CUSIP (RCAX arrived as
        # 88636W718, 2026-09-08); the resolver maps that back via the Instruments API.
        sym = resolve_symbol(client, instr)
        if not sym:
            # An unidentified holding means this snapshot is NOT a trustworthy "you hold
            # exactly these symbols". Reconciling against it would drop the real ticker's
            # lots as sold out AND backfill a phantom "prior" lot under the CUSIP. Fail
            # closed like every other untrustworthy read: report unavailable so rebuild
            # skips reconcile this pass and the fill-built ladder stands. The health
            # report still surfaces the share-count gap so it isn't invisible.
            raw = instr.get("symbol") or instr.get("cusip")
            log.warning(f"{account_hash[-4:]}: holding {raw!r} ({qty:g} sh) could not be "
                        f"identified as a ticker — positions snapshot treated as unavailable")
            return None
        out.append((sym, qty, avg))
    return out
