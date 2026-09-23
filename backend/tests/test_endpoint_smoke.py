"""First endpoint-level coverage (W27-5): FastAPI TestClient smoke tests.

The client is used WITHOUT the lifespan context, so no background tasks (streams,
probers, snapshots) start — endpoints hit the same dev SQLite the rest of the
suite uses, scoped to a throwaway account hash that is selected for the duration
of the module and restored afterward.
"""
import asyncio

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app import accounts as accounts_svc
from app.db import SessionLocal, init_db
from app.db.models import AppSetting, CashFlow, CompletedTrade, FillRecord, Lot
from app.main import app
from app.version import APP_VERSION

ACCT = "TEST_SMOKE_ACCOUNT"

CSV = '''"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
"07/02/2026","Sell","ZZT","ZZ TEST CO","10","$12.00","$0.01","$119.99"
"07/01/2026","Buy","ZZT","ZZ TEST CO","10","$10.00","","-$100.00"
"06/30/2026","MoneyLink Transfer","","Tfr IN","","","","$500.00"
'''


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(scope="module")
def client():
    async def setup():
        await init_db()
        key = accounts_svc._sel_key()
        prev = await accounts_svc.get_setting(key)
        await accounts_svc.set_setting(key, ACCT)
        return key, prev

    key, prev = _run(setup())
    with_client = TestClient(app, raise_server_exceptions=True)
    yield with_client

    async def teardown():
        # Restore the real selection and remove every trace of the smoke account.
        await accounts_svc.set_setting(key, prev or "")
        async with SessionLocal() as s:
            for model in (FillRecord, CompletedTrade, Lot, CashFlow):
                await s.execute(delete(model).where(model.account_hash == ACCT))
            await s.execute(delete(AppSetting).where(AppSetting.key.like(f"%:{ACCT}")))
            await s.commit()
    _run(teardown())


def test_version(client):
    r = client.get("/api/version")
    assert r.status_code == 200
    assert r.json()["version"] == APP_VERSION


def test_data_health_shape(client):
    r = client.get("/api/data/health")
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is True
    assert "fill_ledger" in j and "projection" in j


def test_import_csv_round_trip(client):
    first = client.post("/api/data/import-csv", json={"csv": CSV}).json()
    assert first["ok"] is True
    assert first["trades"]["added"] == 2
    assert first["cashflows"]["added"] == 1

    again = client.post("/api/data/import-csv", json={"csv": CSV}).json()
    assert again["ok"] is True
    assert again["trades"]["added"] == 0          # idempotent
    assert again["cashflows"]["added"] == 0

    health = client.get("/api/data/health").json()
    assert health["fill_ledger"]["total"] == 2


def test_symbol_rules_round_trip(client):
    r = client.post("/api/symbol-rules", json={
        "symbol": "zzt", "sell_mode": "dollar_gain", "sell_value": 75.0, "dip_scale": 1.5})
    assert r.status_code == 200 and r.json().get("ok")

    rules = client.get("/api/symbol-rules").json()["rules"]
    assert "ZZT" in rules
    assert rules["ZZT"]["sell_value"] == 75.0

    r = client.post("/api/symbol-rules", json={"symbol": "ZZT", "clear": True})
    assert r.status_code == 200
    assert "ZZT" not in client.get("/api/symbol-rules").json()["rules"]


def test_bulk_plans_read_only(client):
    # No positions/quotes for the smoke account → empty plans, but the read-only
    # endpoints must answer 200 with the expected shape (never place anything).
    for kind in ("sell", "buy"):
        r = client.get(f"/api/bulk/{kind}-plan")
        assert r.status_code == 200
        j = r.json()
        assert isinstance(j.get("candidates"), list)
    # The dormant "get me out" exit path and the auto-select prefs were removed.
    assert client.get("/api/bulk/exit-plan").status_code == 404
    assert client.get("/api/bulk/prefs").status_code == 404


def test_strategy_analysis_shape(client):
    # Read-only method analysis must answer 200 with the expected shape even for an
    # account with no open positions (the smoke CSV nets flat) — and never place anything.
    r = client.get("/api/strategy-analysis")
    assert r.status_code == 200
    j = r.json()
    for key in ("concentration", "stress", "thesis_breaks", "kelly", "held_count"):
        assert key in j
    assert isinstance(j["concentration"]["rows"], list)
    assert isinstance(j["thesis_breaks"], list)
    assert j["kelly"]["enough"] is False          # far fewer than min_trades closed


def test_backtest_endpoint_graceful_without_token(client):
    # No Schwab token in the test env → price history is empty; the endpoint must answer
    # 200 with ok:false + a reason (never 500, never place anything).
    r = client.get("/api/backtest", params={"symbol": "ZZT", "cash": 5000})
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is False and "reason" in j


def test_logs_recent_shape(client):
    r = client.get("/api/logs/recent")
    assert r.status_code == 200
    j = r.json()
    assert isinstance(j["entries"], list) and "log_file" in j
