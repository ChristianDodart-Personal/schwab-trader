"""Explore tab (experimental): run any READ-ONLY Schwab API call and see the raw payload."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from .. import explore as explore_svc
from ._shared import _selected

router = APIRouter()


@router.get("/api/explore/catalog")
async def explore_catalog() -> dict:
    return explore_svc.catalog()


class ExploreBody(BaseModel):
    id: str
    params: dict = {}


@router.post("/api/explore/run")
async def explore_run(body: ExploreBody) -> dict:
    """Runs against the selected account. Only ids in the catalog dispatch; all are GETs."""
    return await explore_svc.run(body.id, body.params, await _selected())
