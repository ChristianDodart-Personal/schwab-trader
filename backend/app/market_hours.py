"""Is the US equity market in its pre, regular, or post session, or closed?

  market_hours() -> {session: pre|regular|post|closed|unknown, is_open, extended_open,
                     date, next_change}

Read-only Schwab market-data call. The raw payload is cached (Schwab throttles bursts)
but the session is recomputed from "now" on every call, so a cached day still flips
sessions at the right minute. Drives the header badge, the order ticket's and bulk
review's order-type/session defaults, and the nightly snapshot scheduler.
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

from .schwab.auth import get_client

_TTL_S = 600
_cache: dict[str, dict] = {}  # "hours" -> {"at": ts, "payload": {...}}


def _client_or_none():
    try:
        return get_client()
    except Exception:
        return None


def _parse(iso: str) -> datetime | None:
    try:
        return datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return None


def _session_now(session_hours: dict, now: datetime) -> tuple[str, str | None]:
    """Return (session, next_change_iso). session ∈ pre|regular|post|closed."""
    label_for = {"preMarket": "pre", "regularMarket": "regular", "postMarket": "post"}
    boundaries: list[datetime] = []
    current = "closed"
    for api_key, label in label_for.items():
        for w in session_hours.get(api_key, []) or []:
            start, end = _parse(w.get("start")), _parse(w.get("end"))
            if start:
                boundaries.append(start)
            if end:
                boundaries.append(end)
            if start and end and start <= now < end:
                current = label
    future = sorted(b for b in boundaries if b > now)
    next_change = future[0].isoformat() if future else None
    return current, next_change


async def market_hours() -> dict:
    c = _cache.get("hours")
    raw = c["payload"]["_raw"] if c and (time.time() - c["at"]) < _TTL_S else None
    if raw is None:
        client = _client_or_none()
        if client is None:
            return {"session": "unknown", "is_open": False, "error": "no Schwab token"}

        from schwab.client.base import BaseClient as C

        def fetch():
            return client.get_market_hours([C.MarketHours.Market.EQUITY])

        try:
            resp = await asyncio.to_thread(fetch)
            raw = resp.json() if resp.status_code == 200 else None
        except Exception as e:
            return {"session": "unknown", "is_open": False, "error": repr(e)}
        if raw is None:
            return {"session": "unknown", "is_open": False, "error": "market-hours unavailable"}

    eq = raw.get("equity") or {}
    prod = next(iter(eq.values()), {}) if isinstance(eq, dict) else {}
    now = datetime.now(timezone.utc)
    session, next_change = _session_now(prod.get("sessionHours") or {}, now)
    payload = {
        "session": session,                 # pre | regular | post | closed
        "is_open": session == "regular",
        "extended_open": session in ("pre", "post"),
        "date": prod.get("date"),
        "next_change": next_change,
        "_raw": raw,                         # kept only to drive the cache
    }
    _cache["hours"] = {"at": time.time(), "payload": payload}
    return {k: v for k, v in payload.items() if k != "_raw"}
