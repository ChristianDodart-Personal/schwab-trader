"""Resolve what Schwab calls a holding into the ticker the rest of the app keys on.

Schwab's positions feed normally carries `instrument.symbol` = the ticker. During a
fund reorganization, symbol change, or plain data hiccup it instead puts the CUSIP in
the symbol field (real case 2026-09-08: RCAX came through as `88636W718`, 729 shares).
Every downstream table is keyed by ticker, so an unmapped CUSIP is a NEW, unknown
symbol to the reconcile step: it dropped the real ticker's lots as "sold out" and
backfilled a phantom "prior holdings" lot under the CUSIP. This module is the one
place that turns an instrument dict into a trustworthy ticker, or says it can't.

Pure parts (`is_cusip_like`, `_extract_symbol`) are unit-tested; the lookup goes
through the shared schwab client and is cached so a resync never re-asks.
"""
from __future__ import annotations

import logging
import time

log = logging.getLogger(__name__)

# cusip -> (resolved symbol or None, when). A miss is cached too, but only briefly, so
# a transient API failure doesn't pin a holding as unidentified for the whole process.
_cache: dict[str, tuple[str | None, float]] = {}
_MISS_TTL_S = 3600.0


def is_cusip_like(s: str | None) -> bool:
    """True if `s` is a syntactically valid CUSIP: 9 uppercase alphanumerics whose 9th
    character is the Modulus-10 double-add-double check digit. Tickers are 1–5 letters
    (plus an optional class suffix), so nothing a broker would call a ticker passes.
    The check digit keeps a stray 9-char string from being mistaken for one."""
    if not isinstance(s, str) or len(s) != 9:
        return False
    s = s.upper()
    total = 0
    for i, ch in enumerate(s[:8]):
        if ch.isdigit():
            v = int(ch)
        elif "A" <= ch <= "Z":
            v = ord(ch) - ord("A") + 10
        elif ch in "*@#":                     # PPN extensions; never in a ticker
            v = {"*": 36, "@": 37, "#": 38}[ch]
        else:
            return False
        if i % 2 == 1:                        # double every second character
            v *= 2
        total += v // 10 + v % 10
    return s[8].isdigit() and int(s[8]) == (10 - total % 10) % 10


def _extract_symbol(payload) -> str | None:
    """Pull a real ticker out of an Instruments response. Schwab has answered
    `/instruments/{cusip}` both as `{"instruments": [ {...} ]}` and as a bare object,
    and the search form returns a list, so all three are accepted. A symbol that is
    itself CUSIP-shaped is not an answer."""
    obj = payload
    if isinstance(obj, dict) and isinstance(obj.get("instruments"), list):
        obj = obj["instruments"][0] if obj["instruments"] else None
    elif isinstance(obj, list):
        obj = obj[0] if obj else None
    if not isinstance(obj, dict):
        return None
    sym = obj.get("symbol")
    if isinstance(sym, str) and sym.strip() and not is_cusip_like(sym.strip()):
        return sym.strip().upper()
    return None


def resolve_symbol(client, instr: dict | None) -> str | None:
    """The ticker for a Schwab position `instrument` dict, or None if it can't be
    identified. A plain ticker is returned as-is. A CUSIP-shaped (or missing) symbol
    is looked up via the Instruments API by CUSIP, cached per process. Never raises;
    an unresolved holding is logged as a WARNING so it is never silently invisible."""
    instr = instr or {}
    sym = (instr.get("symbol") or "").strip().upper()
    cusip = (instr.get("cusip") or "").strip().upper()
    if sym and not is_cusip_like(sym):
        return sym
    key = cusip or sym
    if not key:
        return None
    now = time.time()
    hit = _cache.get(key)
    if hit is not None and (hit[0] is not None or now - hit[1] < _MISS_TTL_S):
        return hit[0]
    resolved: str | None = None
    try:
        r = client.get_instrument_by_cusip(key)
        if getattr(r, "status_code", 200) == 200:
            resolved = _extract_symbol(r.json())
        else:
            log.warning(f"instruments lookup for CUSIP {key} returned HTTP {r.status_code}")
    except Exception as e:  # network / auth — treated as unresolved, retried after the TTL
        log.warning(f"instruments lookup for CUSIP {key} failed: {e!r}")
    if resolved:
        log.info(f"position reported under CUSIP {key} resolved to {resolved}")
    else:
        log.warning(f"position reported under CUSIP {key} could not be mapped to a ticker "
                    f"— holding left unidentified (reconcile will skip this pass)")
    _cache[key] = (resolved, now)
    return resolved
