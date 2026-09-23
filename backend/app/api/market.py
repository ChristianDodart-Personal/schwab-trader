"""Market & monitoring endpoints: quotes, price history, watchlist tickers,
price alerts + notifications, discovery/screening, and the dashboard views."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from .. import ledger as ledger_svc
from .. import market_data as market_svc
from .. import notifications as notifications_svc
from .. import market_hours as market_hours_svc
from .. import watchlist as watchlist_svc
from ..dashboard import build_dashboard, build_position_detail, invalidate_dashboard_cache
from ._shared import _selected
from ..schwab import hub

router = APIRouter()


@router.get("/api/quotes")
async def latest_quotes() -> dict:
    return {"mode": hub.mode, "quotes": hub.latest}


@router.get("/api/positions/{symbol}/note")
async def get_position_note(symbol: str) -> dict:
    """The free-text journal note for a symbol on the selected account."""
    return {"symbol": symbol.upper(), "note": await ledger_svc.get_note(await _selected(), symbol)}


class NoteBody(BaseModel):
    text: str


@router.put("/api/positions/{symbol}/note")
async def set_position_note(symbol: str, body: NoteBody) -> dict:
    """Save (or clear, when blank) the journal note for a symbol."""
    return await ledger_svc.set_note(await _selected(), symbol, body.text)


@router.get("/api/price-history/{symbol}")
async def price_history(symbol: str, range: str = "6M") -> dict:
    return await market_svc.price_history(symbol, range)


class AddTickerBody(BaseModel):
    symbol: str


@router.post("/api/tickers")
async def add_ticker(body: AddTickerBody) -> dict:
    return await watchlist_svc.add_ticker(body.symbol)


@router.delete("/api/tickers/{symbol}")
async def remove_ticker(symbol: str) -> dict:
    return await watchlist_svc.remove_ticker(symbol)


class SectorBody(BaseModel):
    sector: str | None = None


@router.put("/api/tickers/{symbol}/sector")
async def set_ticker_sector(symbol: str, body: SectorBody) -> dict:
    """Tag a ticker's sector (user-maintained — Schwab omits it)."""
    res = await watchlist_svc.set_sector(symbol, body.sector)
    invalidate_dashboard_cache()  # sector shows on the dashboard + drives concentration
    return res


# ---------- price-hit alerts & notifications ----------

class AlertBody(BaseModel):
    symbol: str
    direction: str            # above | below
    threshold: float
    note: str | None = None
    repeat: bool = False


@router.get("/api/alerts")
async def list_alerts() -> dict:
    return await notifications_svc.list_alerts()


@router.post("/api/alerts")
async def create_alert(body: AlertBody) -> dict:
    # Stamp the alert with the selected account so its notification follows that
    # account's prefs (None in demo / no selection → gated by the global defaults).
    return await notifications_svc.create_alert(
        body.symbol, body.direction, body.threshold, body.note, body.repeat,
        account_hash=(await _selected()) or None,
    )


@router.delete("/api/alerts/{alert_id}")
async def delete_alert(alert_id: int) -> dict:
    return await notifications_svc.delete_alert(alert_id)


@router.get("/api/notifications")
async def list_notifications(limit: int = 50) -> dict:
    return await notifications_svc.list_notifications(limit)


@router.get("/api/audit")
async def list_audit(limit: int = 100) -> dict:
    """The quiet activity log — every fill (incl. market), reviewed on demand."""
    return await notifications_svc.list_audit(limit)


@router.post("/api/notifications/read-all")
async def read_all_notifications() -> dict:
    return await notifications_svc.mark_all_read()


@router.post("/api/notifications/{note_id}/read")
async def read_notification(note_id: int) -> dict:
    return await notifications_svc.mark_read(note_id)


# ---------- market discovery & screening ----------

@router.get("/api/market-hours")
async def market_hours() -> dict:
    return await market_hours_svc.market_hours()


@router.get("/api/dashboard")
async def dashboard() -> dict:
    """Stock Data view (selected account): one computed summary row per held ticker."""
    return await build_dashboard(await _selected())


@router.get("/api/positions/{symbol}")
async def position_detail(symbol: str):
    """Longs view: the ladder detail for one ticker on the selected account."""
    detail = await build_position_detail(symbol, await _selected())
    return detail or {"error": f"no position for {symbol.upper()}"}
