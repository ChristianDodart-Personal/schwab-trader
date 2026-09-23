"""Price-hit alerts & the notification feed.

A user sets a rule ("notify when AAPL is above 200"); a background watcher taps
the live quote hub and fires a notification when a quote crosses the threshold.
Fired notifications persist (DB) and are pushed to the browser over a websocket.

Design notes
------------
- Alerts are GLOBAL, not account-scoped — a price is a price regardless of which
  account is selected in the UI.
- One-shot alerts (the default) fire once when the condition is met, then
  deactivate. If the price is already on the far side when the alert is created,
  it fires on the next tick (we warn about this at creation time).
- `repeat` alerts use edge detection: they fire only on a fresh crossing (the
  previous tick was on the opposite side), so they don't spam every tick while
  the price sits past the threshold.
- A small in-memory cache of active alerts keyed by symbol means the per-tick
  check never hits the DB; the DB is touched only on create/delete and on fire.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select, update

from . import phone
from .db import SessionLocal, dialect_insert as pg_insert
from .db.models import AppSetting, AuditEvent, Notification, PriceAlert
from .schwab import hub, subscribe
from .schwab.auth import get_client

log = logging.getLogger(__name__)

# ---------- notification preferences (the Notifications tab writes these) ----------
# One global blob governs delivery of the three user-facing categories across the
# three channels. "system" notifications (re-auth nudges) are never gated. Muting is
# non-destructive: a muted item is still recorded (marked read, so it never badges),
# it just doesn't interrupt — matching how Slack/iOS muting behaves.
_PREFS_KEY = "notif_prefs"
_CATEGORIES = ("alert", "trigger", "fill")
# "sound" = an in-app chime played by the renderer when the note arrives. Default OFF
# everywhere so an auto-update never suddenly makes noise; the user opts in per category.
_CHANNELS = ("bell", "desktop", "phone", "sound")
_DEFAULT_PREFS: dict = {
    "muted": False,
    "categories": {
        "alert":   {"bell": True, "desktop": True, "phone": True, "sound": False},
        "trigger": {"bell": True, "desktop": True, "phone": True, "sound": False},
        # Fills are frequent and low-urgency — no desktop pop-up by default.
        "fill":    {"bell": True, "desktop": False, "phone": True, "sound": False},
    },
    "muted_symbols": [],
}
# Prefs are per-ACCOUNT (v0.62): stored under key "a:{account_hash}:notif_prefs", cached
# per account. account_hash=None means the legacy GLOBAL blob ("notif_prefs"), which also
# seeds a brand-new account's prefs so existing global choices carry over on first read.
_prefs_cache: dict[str | None, dict] = {}


def _prefs_key(account_hash: str | None) -> str:
    return f"a:{account_hash}:{_PREFS_KEY}" if account_hash else _PREFS_KEY


def _merge_prefs(stored: dict | None) -> dict:
    """Overlay stored values on the defaults so a partial/older blob is always complete."""
    p = copy.deepcopy(_DEFAULT_PREFS)
    if isinstance(stored, dict):
        p["muted"] = bool(stored.get("muted", p["muted"]))
        p["muted_symbols"] = [str(s).upper() for s in stored.get("muted_symbols", []) if s]
        for cat in _CATEGORIES:
            sc = (stored.get("categories") or {}).get(cat, {})
            if isinstance(sc, dict):
                for ch in _CHANNELS:
                    if ch in sc:
                        p["categories"][cat][ch] = bool(sc[ch])
    return p


async def get_notif_prefs(account_hash: str | None = None) -> dict:
    if account_hash in _prefs_cache:
        return _prefs_cache[account_hash]
    async with SessionLocal() as s:
        row = await s.get(AppSetting, _prefs_key(account_hash))
        raw = row.value if row else None
        # A brand-new account inherits the old global blob so nothing feels reset.
        if raw is None and account_hash is not None:
            g = await s.get(AppSetting, _PREFS_KEY)
            raw = g.value if g else None
    try:
        prefs = _merge_prefs(json.loads(raw) if raw else None)
    except (ValueError, TypeError):
        prefs = _merge_prefs(None)
    _prefs_cache[account_hash] = prefs
    return prefs


async def set_notif_prefs(patch: dict, account_hash: str | None = None) -> dict:
    merged = _merge_prefs({**(await get_notif_prefs(account_hash)), **(patch or {})})
    payload = json.dumps(merged)
    key = _prefs_key(account_hash)
    async with SessionLocal() as s:
        await s.execute(
            pg_insert(AppSetting).values(key=key, value=payload)
            .on_conflict_do_update(index_elements=[AppSetting.key], set_={"value": payload})
        )
        await s.commit()
    _prefs_cache[account_hash] = merged
    return merged


def _gate(prefs: dict, category: str, symbol: str | None) -> dict:
    """Resolve one notification's delivery: whether it lands read (no badge), and
    whether desktop/phone copies go out.
      - "system"  Schwab reconnect reminders: ALWAYS delivered, even when muted (the app
                  silently stops working without them).
      - "notice"  app notices (e.g. a detected stock split): delivered everywhere but
                  honor Mute all and muted tickers; no per-category row in the grid.
      - alert | trigger | fill: the per-category, per-channel grid."""
    if category == "system":
        return {"read": False, "desktop": True, "phone": True, "sound": False}
    active = (not prefs.get("muted")) and ((symbol or "").upper() not in set(prefs.get("muted_symbols", [])))
    if category == "notice":
        return {"read": not active, "desktop": active, "phone": active, "sound": False}
    cat = (prefs.get("categories") or {}).get(category, {})
    bell = cat.get("bell", True)
    return {
        "read": not (active and bell),                 # muted/off → recorded as already-read
        "desktop": bool(active and cat.get("desktop", True)),
        "phone": bool(active and cat.get("phone", True)),
        "sound": bool(active and cat.get("sound", False)),  # in-app chime (default off)
    }

# Audit-log retention: the table grows forever otherwise. Prune rows that are BOTH
# older than this AND beyond the newest N (so we always keep at least N regardless of age).
AUDIT_RETENTION_DAYS = 180
AUDIT_MIN_ROWS = 5000


async def prune_audit_log(retention_days: int = AUDIT_RETENTION_DAYS,
                          min_rows: int = AUDIT_MIN_ROWS) -> int:
    """Delete audit rows older than `retention_days` AND outside the newest `min_rows`.
    Both conditions must hold — a busy stretch keeps its history, a quiet one still
    keeps a floor of rows. Returns the number pruned."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    async with SessionLocal() as s:
        # id of the min_rows-th newest row; ids below it are 'beyond the newest N'.
        floor_id = (
            await s.execute(
                select(AuditEvent.id).order_by(AuditEvent.id.desc()).limit(1).offset(min_rows - 1)
            )
        ).scalar()
        if floor_id is None:
            return 0  # fewer than min_rows rows exist → keep everything
        res = await s.execute(
            delete(AuditEvent).where(AuditEvent.id < floor_id, AuditEvent.created_at < cutoff)
        )
        await s.commit()
        return res.rowcount or 0


# Notification-feed retention: same both-conditions shape as the audit log, with a
# smaller floor — the bell feed is a working set, not an archive (the audit log is).
NOTIF_RETENTION_DAYS = 180
NOTIF_MIN_ROWS = 2000


async def prune_notifications(retention_days: int = NOTIF_RETENTION_DAYS,
                              min_rows: int = NOTIF_MIN_ROWS) -> int:
    """Delete notifications older than `retention_days` AND beyond the newest
    `min_rows`. Returns the number pruned."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    async with SessionLocal() as s:
        floor_id = (
            await s.execute(
                select(Notification.id).order_by(Notification.id.desc()).limit(1).offset(min_rows - 1)
            )
        ).scalar()
        if floor_id is None:
            return 0
        res = await s.execute(
            delete(Notification).where(Notification.id < floor_id, Notification.created_at < cutoff)
        )
        await s.commit()
        return res.rowcount or 0

_VALID_DIR = {"above", "below"}

# symbol -> list of lightweight active-alert dicts {id, direction, threshold, repeat, note}
_cache: dict[str, list[dict]] = {}
# symbol -> last observed price (for edge detection on repeat alerts)
_last_price: dict[str, float] = {}
# browser websocket fan-out
_subscribers: set[asyncio.Queue] = set()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso() -> str:
    return _now().isoformat()


def _utc_iso(dt):
    """Serialize a stored timestamp as OFFSET-AWARE ISO. DB timestamps are naive UTC
    (SQLite CURRENT_TIMESTAMP / func.now()); without the +00:00 the browser parses
    them as LOCAL time and shows them hours off (and disagreeing with the live push)."""
    if dt is None:
        return None
    return (dt if getattr(dt, "tzinfo", None) else dt.replace(tzinfo=timezone.utc)).isoformat()


def get_client_safe():
    """Schwab client or None (get_client raises when there's no token yet)."""
    try:
        return get_client()
    except Exception:
        return None


def _hub_last(symbol: str) -> float | None:
    q = hub.latest.get(symbol)
    last = q.get("last") if q else None
    return float(last) if isinstance(last, (int, float)) else None


def _condition_met(direction: str, threshold: float, px: float) -> bool:
    return px >= threshold if direction == "above" else px <= threshold


def _symbol_known(client, symbol: str) -> bool:
    """Best-effort check that a symbol exists (so we don't create a dead alert).
    Returns True when we can't tell (no client / API hiccup) — fail open."""
    try:
        data = client.get_quotes([symbol]).json() or {}
    except Exception:
        return True  # don't block alert creation on a transient API error
    return bool(data.get(symbol))


def _sym(direction: str) -> str:
    return "≥" if direction == "above" else "≤"


# ---------- websocket fan-out ----------

def subscribe_feed() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers.add(q)
    return q


def unsubscribe_feed(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


def _push(note: dict) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(note)
        except asyncio.QueueFull:
            pass  # slow client; it'll catch up via GET /api/notifications


# ---------- alert cache ----------

async def _reload_cache() -> None:
    cache: dict[str, list[dict]] = {}
    async with SessionLocal() as s:
        rows = (
            await s.execute(select(PriceAlert).where(PriceAlert.active.is_(True)))
        ).scalars().all()
        for a in rows:
            cache.setdefault(a.symbol, []).append({
                "id": a.id, "symbol": a.symbol, "direction": a.direction,
                "threshold": float(a.threshold), "repeat": a.repeat, "note": a.note,
                "account_hash": a.account_hash,
            })
    _cache.clear()
    _cache.update(cache)


# ---------- the watcher ----------

async def _fire(a: dict, symbol: str, px: float) -> None:
    msg = f"{symbol} {_sym(a['direction'])} {a['threshold']:g} (now {px:g})"
    if a.get("note"):
        msg += f" — {a['note']}"
    g = _gate(await get_notif_prefs(a.get("account_hash")), "alert", symbol)
    async with SessionLocal() as s:
        n = Notification(alert_id=a["id"], symbol=symbol, message=msg, price=px, read=g["read"], kind="alert")
        s.add(n)
        await s.flush()  # assign n.id
        nid = n.id
        alert = await s.get(PriceAlert, a["id"])
        if alert is not None:
            alert.last_fired_at = _now()
            if not alert.repeat:
                alert.active = False
        await s.commit()

    if not a.get("repeat"):
        lst = _cache.get(symbol)
        if lst and a in lst:
            lst.remove(a)

    _push({
        "id": nid, "alert_id": a["id"], "symbol": symbol, "message": msg,
        "price": px, "read": g["read"], "created_at": _iso(), "kind": "alert",
        "desktop": g["desktop"], "sound": g["sound"],
    })
    if g["phone"]:
        phone.dispatch(f"{symbol} alert", msg)  # unified prefs already decided phone
    # ASCII-only log line (Windows console is cp1252 and chokes on ≥/≤)
    log.info(f"[alerts] fired #{a['id']}: {symbol} {a['direction']} "
             f"{a['threshold']:g} @ {px:g}")


async def post_system_notification(symbol: str | None, message: str, price: float | None = None,
                                   category: str = "trigger", account_hash: str | None = None) -> int:
    """Post a non-price-alert notification to the bell feed + live push. `category` is
    one of alert|trigger|fill (gated by the user's notification prefs) or "system"
    (re-auth nudges — always delivered). `account_hash` picks whose prefs gate it (the
    account the trigger fired for); None → the global defaults. alert_id is NULL.
    Returns the id."""
    g = _gate(await get_notif_prefs(account_hash), category, symbol)
    async with SessionLocal() as s:
        n = Notification(alert_id=None, symbol=symbol, message=message, price=price, read=g["read"], kind=category)
        s.add(n)
        await s.flush()
        nid = n.id
        await s.commit()
    _push({"id": nid, "alert_id": None, "symbol": symbol, "message": message,
           "price": price, "read": g["read"], "created_at": _iso(), "kind": category,
           "desktop": g["desktop"], "sound": g["sound"]})
    if g["phone"]:
        phone.dispatch(symbol or "Schwab Trader", message)
    return nid


async def _on_quote(symbol: str, px: float) -> None:
    prev = _last_price.get(symbol)
    _last_price[symbol] = px
    alerts = _cache.get(symbol)
    if not alerts:
        return
    for a in list(alerts):
        if not _condition_met(a["direction"], a["threshold"], px):
            continue
        if a["repeat"]:
            # fire only on a fresh crossing: the previous tick must have been on
            # the opposite side (or unknown). Otherwise we're still in the zone.
            if prev is not None and _condition_met(a["direction"], a["threshold"], prev):
                continue
        await _fire(a, symbol, px)


# ---------- fill notifications ----------
async def _emit(symbol: str | None, message: str, price: float | None, alert_id=None,
                account_hash: str | None = None) -> None:
    g = _gate(await get_notif_prefs(account_hash), "fill", symbol)
    async with SessionLocal() as s:
        n = Notification(alert_id=alert_id, symbol=symbol, message=message, price=price, read=g["read"], kind="fill")
        s.add(n)
        await s.flush()
        nid = n.id
        await s.commit()
    _push({"id": nid, "alert_id": alert_id, "symbol": symbol, "message": message,
           "price": price, "read": g["read"], "created_at": _iso(), "kind": "fill",
           "desktop": g["desktop"], "sound": g["sound"]})
    if g["phone"]:
        phone.dispatch(symbol or "Fill", message)


def _naive_utc(dt):
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if getattr(dt, "tzinfo", None) else dt


# A fill is "fresh" (worth a live notification) only if it executed within this
# window — keeps the FIRST audit backfill of months-old history from spamming the
# bell, while still alerting on genuinely-recent resting fills.
_NOTIFY_RECENCY = timedelta(minutes=15)


def _fill_key(account_hash: str, f) -> str:
    return f"{account_hash}|{f.order_id}|{_naive_utc(f.at)}|{float(f.price)}|{float(f.shares)}|{str(f.side).upper()}"


async def _audit_fill(account_hash: str, f) -> bool:
    """Idempotent insert of a fill into the audit log (insert-or-ignore on a
    deterministic fill_key). Returns True only if this fill was NEWLY recorded —
    so a fill is audited exactly once across retries / 2-pass resyncs / restarts,
    and notifications can fire exactly once off the new insert."""
    ot = (f.order_type or "").upper()
    verb = "bought" if str(f.side).upper() == "BUY" else "sold"
    msg = (f"{f.symbol} {verb} {f.shares:g} @ ${float(f.price):.2f} "
           f"({ot.replace('_', ' ').title() if ot else 'order'} filled)")
    async with SessionLocal() as s:
        # RETURNING the id reliably tells insert-vs-conflict (rowcount is unreliable
        # for ON CONFLICT DO NOTHING): a row comes back only if it was newly inserted.
        res = await s.execute(
            pg_insert(AuditEvent).values(
                account_hash=account_hash, kind="fill", symbol=f.symbol,
                side=str(f.side).upper(), shares=float(f.shares), price=float(f.price),
                order_type=ot or None, message=msg, at=_naive_utc(f.at),
                fill_key=_fill_key(account_hash, f),
            ).on_conflict_do_nothing(index_elements=[AuditEvent.fill_key])
            .returning(AuditEvent.id)
        )
        await s.commit()
    return res.scalar() is not None


async def notify_fills(account_hash: str, fills) -> None:
    """Record executed fills idempotently. EVERY fill is logged to the audit trail
    (exactly once, by fill identity — no in-memory baseline, so it's safe across
    retries, the 2-pass resync, and restarts). A RESTING (non-MARKET) fill that is
    both newly-recorded AND recent also fires a loud notification — a market fill is
    instant/guaranteed (audit-only), and old backfilled history never notifies."""
    if not account_hash or not fills:
        return
    now = datetime.now(timezone.utc)
    for f in sorted(fills, key=lambda x: x.at):
        ot = (f.order_type or "").upper()
        try:
            newly = await _audit_fill(account_hash, f)
            if not newly:
                continue  # already in the audit log → already handled
            at = f.at if getattr(f.at, "tzinfo", None) else f.at.replace(tzinfo=timezone.utc)
            recent = (now - at) < _NOTIFY_RECENCY
            if ot and ot != "MARKET" and recent:
                verb = "bought" if str(f.side).upper() == "BUY" else "sold"
                base = f"{f.symbol} {verb} {f.shares:g} @ ${float(f.price):.2f}"
                await _emit(f.symbol, f"{base} — {ot.replace('_', ' ').title()} order filled", float(f.price),
                            account_hash=account_hash)
                log.info(f"resting fill: {base} ({ot})")
            else:
                log.info(f"[audit] fill recorded ({ot or 'order'}): {f.symbol} {f.shares:g} @ {f.price}")
        except Exception as e:  # next resync retries (idempotent), nothing is lost
            log.warning(f"fill handling failed: {e!r}")


async def list_audit(limit: int = 100) -> dict:
    limit = max(1, min(int(limit or 100), 500))
    async with SessionLocal() as s:
        rows = (
            await s.execute(select(AuditEvent).order_by(AuditEvent.id.desc()).limit(limit))
        ).scalars().all()
        events = [{
            "id": e.id, "kind": e.kind, "symbol": e.symbol, "side": e.side,
            "shares": float(e.shares) if e.shares is not None else None,
            "price": float(e.price) if e.price is not None else None,
            "order_type": e.order_type, "message": e.message,
            # `at` is stored naive-UTC — emit it tz-aware so the browser renders local time correctly
            "at": _utc_iso(e.at),
            "created_at": _utc_iso(e.created_at),
        } for e in rows]
    return {"events": events}


async def run_alert_watcher() -> None:
    """Background task (started on app startup): consume the quote hub and fire
    alerts as prices cross their thresholds."""
    await _reload_cache()
    q = hub.subscribe()
    try:
        while True:
            quote = await q.get()
            symbol = quote.get("symbol")
            last = quote.get("last")
            if symbol and isinstance(last, (int, float)):
                try:
                    await _on_quote(symbol, float(last))
                except Exception as e:  # never let one bad tick kill the watcher
                    log.warning(f"[alerts] check failed for {symbol}: {e!r}")
    finally:
        hub.unsubscribe(q)


# ---------- CRUD (used by the API) ----------

async def create_alert(symbol: str, direction: str, threshold, note=None,
                       repeat: bool = False, account_hash: str | None = None) -> dict:
    symbol = (symbol or "").strip().upper()
    direction = (direction or "").strip().lower()
    if not symbol:
        return {"ok": False, "error": "symbol required"}
    if direction not in _VALID_DIR:
        return {"ok": False, "error": "direction must be 'above' or 'below'"}
    try:
        threshold = float(threshold)
    except (TypeError, ValueError):
        return {"ok": False, "error": "threshold must be a number"}
    if threshold <= 0:
        return {"ok": False, "error": "threshold must be positive"}

    # Reject obviously-unknown symbols so we don't create an alert that can
    # never fire (best-effort: skipped in demo mode / on API errors).
    client = get_client_safe()
    if client is not None and not await asyncio.to_thread(_symbol_known, client, symbol):
        return {"ok": False, "error": f"unknown symbol '{symbol}'"}

    async with SessionLocal() as s:
        a = PriceAlert(symbol=symbol, direction=direction, threshold=threshold,
                       note=(note or None), repeat=bool(repeat), active=True,
                       account_hash=account_hash or None)
        s.add(a)
        await s.flush()
        aid = a.id
        await s.commit()
    await _reload_cache()

    # Make sure this symbol is actually streaming, else the alert never fires.
    await subscribe(symbol)

    warning = None
    cur = _last_price.get(symbol)
    if cur is None:
        cur = _hub_last(symbol)
    if cur is not None and _condition_met(direction, threshold, cur):
        warning = (f"{symbol} is already {_sym(direction)} {threshold:g} "
                   f"(now {cur:g}) — this will fire right away.")
    return {"ok": True, "id": aid, "warning": warning}


async def delete_alert(alert_id: int) -> dict:
    async with SessionLocal() as s:
        a = await s.get(PriceAlert, alert_id)
        if a is not None:
            await s.delete(a)
            await s.commit()
    await _reload_cache()
    return {"ok": True}


async def list_alerts() -> dict:
    async with SessionLocal() as s:
        rows = (
            await s.execute(
                select(PriceAlert).order_by(
                    PriceAlert.active.desc(), PriceAlert.id.desc()
                )
            )
        ).scalars().all()
        alerts = [{
            "id": a.id, "symbol": a.symbol, "direction": a.direction,
            "threshold": float(a.threshold), "note": a.note,
            "repeat": a.repeat, "active": a.active,
            "last_fired_at": _utc_iso(a.last_fired_at),
            "created_at": _utc_iso(a.created_at),
        } for a in rows]
    return {"alerts": alerts}


async def list_notifications(limit: int = 50) -> dict:
    limit = max(1, min(int(limit or 50), 200))
    async with SessionLocal() as s:
        rows = (
            await s.execute(
                select(Notification).order_by(Notification.id.desc()).limit(limit)
            )
        ).scalars().all()
        unread = (
            await s.execute(
                select(func.count()).select_from(Notification).where(
                    Notification.read.is_(False)
                )
            )
        ).scalar() or 0
        # Unread count per category, for the Notifications tab's per-type pills. NULL
        # kind (legacy rows) buckets under "other" so nothing is silently dropped.
        by_kind_rows = (
            await s.execute(
                select(Notification.kind, func.count())
                .where(Notification.read.is_(False))
                .group_by(Notification.kind)
            )
        ).all()
        unread_by_kind: dict[str, int] = {}
        for kind, cnt in by_kind_rows:
            unread_by_kind[kind or "other"] = unread_by_kind.get(kind or "other", 0) + int(cnt)
        items = [{
            "id": n.id, "alert_id": n.alert_id, "symbol": n.symbol,
            "message": n.message,
            "price": float(n.price) if n.price is not None else None,
            "read": n.read, "kind": n.kind,
            "created_at": _utc_iso(n.created_at),
        } for n in rows]
    return {"notifications": items, "unread": int(unread), "unread_by_kind": unread_by_kind}


async def mark_read(note_id: int) -> dict:
    async with SessionLocal() as s:
        n = await s.get(Notification, note_id)
        if n is not None:
            n.read = True
            await s.commit()
    return {"ok": True}


async def mark_all_read() -> dict:
    async with SessionLocal() as s:
        await s.execute(
            update(Notification).where(Notification.read.is_(False)).values(read=True)
        )
        await s.commit()
    return {"ok": True}
