"""Trading endpoints: order CRUD (incl. native cancel-and-replace), buy/sell
suggestions, and the bulk harvest/dip/exit tools."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from .. import bulk as bulk_svc
from .. import orders as orders_svc
from ._shared import _selected

router = APIRouter()


# ---------- Phase 5: trading ----------

class PlaceOrderBody(BaseModel):
    symbol: str
    side: str                       # BUY | SELL
    quantity: int
    order_type: str = "LIMIT"       # MARKET | LIMIT | STOP | STOP_LIMIT | TRAILING_STOP
    limit_price: float | None = None
    stop_price: float | None = None
    trailing_offset: float | None = None
    trailing_type: str = "PERCENT"  # PERCENT | VALUE
    duration: str = "DAY"           # DAY | GOOD_TILL_CANCEL | FILL_OR_KILL | IMMEDIATE_OR_CANCEL
    session: str = "NORMAL"         # NORMAL | AM | PM | SEAMLESS
    account_hash: str | None = None
    confirm: bool = False           # override the fat-finger (limit-far-from-market) guard


@router.get("/api/orders")
async def list_orders(days: int = 7, account_hash: str | None = None) -> dict:
    return {"orders": await orders_svc.list_orders(days, account_hash)}


@router.get("/api/orders/working-count")
async def orders_working_count() -> dict:
    """Working orders on the selected account: total (nav badge) + per-symbol
    breakdown (dashboard row markers)."""
    return await orders_svc.working_summary()


@router.get("/api/orders/{order_id}")
async def get_order(order_id: str, account_hash: str | None = None) -> dict:
    return await orders_svc.get_order(order_id, account_hash)


@router.post("/api/orders")
async def place_order(body: PlaceOrderBody) -> dict:
    return await orders_svc.place_order(
        body.symbol, body.side, body.quantity, body.order_type,
        limit_price=body.limit_price, stop_price=body.stop_price,
        trailing_offset=body.trailing_offset, trailing_type=body.trailing_type,
        duration=body.duration, session=body.session,
        account_hash=body.account_hash, confirm=body.confirm,
    )


@router.delete("/api/orders/{order_id}")
async def cancel_order(order_id: str, account_hash: str | None = None) -> dict:
    return await orders_svc.cancel_order(order_id, account_hash)


class ReplaceOrderBody(BaseModel):
    quantity: int | None = None       # omit → keep the original
    limit_price: float | None = None  # omit → keep the original
    account_hash: str | None = None
    confirm: bool = False             # acknowledge soft-rail warnings


@router.put("/api/orders/{order_id}")
async def replace_order(order_id: str, body: ReplaceOrderBody) -> dict:
    """Modify a working LIMIT order via Schwab's native cancel-and-replace."""
    return await orders_svc.replace_order(
        order_id, new_quantity=body.quantity, new_limit_price=body.limit_price,
        account_hash=body.account_hash, confirm=body.confirm,
    )


@router.get("/api/suggest/buy/{symbol}")
async def suggest_buy(symbol: str) -> dict:
    return await orders_svc.suggest_buy(symbol, await _selected())


@router.get("/api/suggest/sell/{lot_id}")
async def suggest_sell(lot_id: int) -> dict:
    return await orders_svc.suggest_sell(lot_id, await _selected())


# ---- bulk actions (sell picked holdings' last positions / buy) ----
class BulkSellItem(BaseModel):
    lot_id: int
    symbol: str          # identity check: must match the lot the id resolves to
    shares: int
    limit_price: float | None = None


class BulkBuyItem(BaseModel):
    symbol: str
    shares: int
    limit_price: float | None = None


class BulkSellBody(BaseModel):
    items: list[BulkSellItem]
    order_type: str = "LIMIT"   # LIMIT (at the reviewed price) | MARKET
    session: str | None = None  # NORMAL | AM | PM | SEAMLESS — the ticket's current-session default
    confirm: bool = False


class BulkBuyBody(BaseModel):
    items: list[BulkBuyItem]
    order_type: str = "LIMIT"   # LIMIT (at the reviewed price) | MARKET
    session: str | None = None  # NORMAL | AM | PM | SEAMLESS — the ticket's current-session default
    confirm: bool = False


@router.get("/api/bulk/sell-plan")
async def bulk_sell_plan() -> dict:
    """Read-only: every held last position (the lot a LIFO sale retires)."""
    return await bulk_svc.sell_plan(await _selected())


@router.get("/api/bulk/buy-plan")
async def bulk_buy_plan() -> dict:
    """Read-only: every buyable symbol (holdings + watchlist), sized to the next tier."""
    return await bulk_svc.buy_plan(await _selected())


@router.post("/api/bulk/sell")
async def bulk_sell(body: BulkSellBody) -> dict:
    """Place a sell for each item — only if its lot is the LAST lot for its symbol."""
    items = [{"lot_id": i.lot_id, "symbol": i.symbol, "shares": i.shares, "limit_price": i.limit_price} for i in body.items]
    return await bulk_svc.bulk_sell(await _selected(), items, order_type=body.order_type,
                                    confirm=body.confirm, session=body.session)


@router.post("/api/bulk/buy")
async def bulk_buy(body: BulkBuyBody) -> dict:
    """Buy each given item at the reviewed shares/price."""
    items = [{"symbol": i.symbol, "shares": i.shares, "limit_price": i.limit_price} for i in body.items]
    return await bulk_svc.bulk_buy(await _selected(), items, order_type=body.order_type,
                                   confirm=body.confirm, session=body.session)
