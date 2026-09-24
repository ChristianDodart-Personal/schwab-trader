"""FastAPI app — Phase 1: prove the pipe (OAuth-ready, DB, live quote -> browser).

Now the COMPOSITION ROOT: shared plumbing (lifespan, background tasks, CORS,
_selected/_csv_response, websockets, SPA mount) lives here; the ~110 HTTP
endpoints live in APIRouter modules under app/api/ and are included below.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from . import accounts as accounts_svc
from . import backup as backup_svc
from . import credentials as credentials_svc
from . import ledger as ledger_svc
from . import notifications as notifications_svc
from . import profiles as profiles_svc
from . import rebuild as rebuild_svc
from .config import settings
from .logsetup import setup_logging
from .api._shared import _selected

setup_logging(settings.data_dir)  # before anything logs — file + console + diagnostics ring

from .dashboard import build_dashboard
from .db import init_db
from .schwab import hub, run_activity_resync, run_quote_stream
from .schwab import auth as auth_mod
from .schwab.auth import get_client
from .schwab.auth import probe_live as auth_probe_live
from .schwab.enrich import enrich_tickers
from .strategy import StrategyConfig
from .version import APP_VERSION

log = logging.getLogger(__name__)

strategy = StrategyConfig.load()


async def _enrich_on_startup() -> None:
    try:
        client = get_client()
    except Exception:
        client = None
    if client is None:
        return
    try:
        await enrich_tickers(client)
        log.info("startup ticker enrichment complete")
    except Exception as e:
        log.warning(f"startup ticker enrichment failed: {e!r}")


# Proactive re-auth ladder: the 7-day Schwab refresh token dies silently, and the
# banner only helps if you happen to look. Fire ONE bell/desktop/phone notification
# per stage per token issuance: ~2 days left → day-of → expired. A new token
# (new issued_at) re-arms the ladder. Dedup lives in app_setting "reauth_nudge".
_NUDGE_RANK = {"soon": 1, "today": 2, "expired": 3}


async def _maybe_reauth_nudge() -> None:
    # Resolved through the module at CALL time (not import time): token_status is
    # monkeypatched in tests and can be rebound after a reauth — a from-import here
    # would freeze the stale function.
    st = auth_mod.token_status()
    issued = st.get("issued_at")
    days = st.get("days_left")
    if not issued:
        return
    if st.get("expired"):
        stage = "expired"
    elif days is not None and days <= 1:
        stage = "today"
    elif days is not None and days <= 2:
        stage = "soon"
    else:
        return
    marker = await accounts_svc.get_setting("reauth_nudge")
    prev_rank = 0
    if marker:
        m_issued, _, m_rank = marker.partition("|")
        if m_issued == str(issued):
            try:
                prev_rank = int(m_rank)
            except ValueError:
                prev_rank = 0
    rank = _NUDGE_RANK[stage]
    if rank <= prev_rank:
        return
    msg = {
        "soon": "Schwab connection expires in about 2 days — renew it in one click from "
                "the banner (or Settings) so quotes and orders don't stop.",
        "today": "Schwab connection expires today — one click on the banner renews it.",
        "expired": "Schwab connection has expired — the app is running on stale data. "
                   "Click the banner (or Settings > Schwab connection) to reconnect.",
    }[stage]
    await notifications_svc.post_system_notification(None, msg, category="system")
    await accounts_svc.set_setting("reauth_nudge", f"{issued}|{rank}")


async def _liveness_prober() -> None:
    """Background heartbeat: keep the token-liveness state fresh so the banner is
    accurate even between UI polls. probe_live() no-ops when a recent stream heartbeat
    already proves life, so a healthy stream means ~no extra Schwab calls."""
    while True:
        try:
            await auth_probe_live()
        except Exception:
            pass
        try:
            await _maybe_reauth_nudge()
        except Exception as e:
            log.warning(f"[auth] reauth nudge failed: {e!r}")
        await asyncio.sleep(60)


async def run_selected_resync_scheduler() -> None:
    """Keep the SELECTED account continuously reconciled with Schwab — this is what
    replaced the manual 'Sync from Schwab' button. The trading account is already
    refreshed on every fill/order poke by run_activity_resync; this catch-all also
    covers a selected NON-trading account (e.g. a managed LLC) and backstops any
    missed activity poke. resync_account is idempotent and per-account-locked, and its
    fills fetch is gated by a ~weekly probe, so the steady cost is roughly one
    positions REST call every couple of minutes."""
    await asyncio.sleep(20)  # let startup settle before the first tick
    while True:
        try:
            sel = await _selected()
            if sel:
                await rebuild_svc.resync_account(sel)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning(f"[selected-resync] failed: {e!r}")
        await asyncio.sleep(120)  # ~2 min; the per-account lock serializes overlapping runs


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    # Load/seed profiles FIRST — Schwab creds are now per-profile (scoped to the active
    # profile), and get_client()/the quote stream resolve the active profile's token, so
    # the active pointer must be set before creds or any client is built. A migration
    # hiccup must not brick startup — degrade to no-active-profile (DEMO) and resume next boot.
    try:
        await profiles_svc.ensure_default()
    except Exception as e:
        log.warning(f"[profiles] ensure_default failed ({e!r}); starting without an active profile.")
    # Resolve Schwab API creds (per-profile DB over legacy-global over .env) for the active profile.
    try:
        await credentials_svc.load()
    except Exception as e:
        log.warning(f"[credentials] load failed ({e!r}); using .env defaults.")
    app.state.stream_task = asyncio.create_task(run_quote_stream())
    enrich_task = asyncio.create_task(_enrich_on_startup())
    alert_task = asyncio.create_task(notifications_svc.run_alert_watcher())
    resync_task = asyncio.create_task(run_activity_resync())
    sel_resync_task = asyncio.create_task(run_selected_resync_scheduler())
    snapshot_task = asyncio.create_task(ledger_svc.run_snapshot_scheduler())
    liveness_task = asyncio.create_task(_liveness_prober())
    backup_task = asyncio.create_task(backup_svc.run_backup_scheduler())
    from . import strategy_triggers
    strategy_task = asyncio.create_task(strategy_triggers.run_strategy_trigger_watcher())
    try:
        yield
    finally:
        # Cancel AND await so a task mid-DB-transaction (e.g. resync inside a
        # rebuild) unwinds cleanly before the loop shuts down.
        tasks = [app.state.stream_task, enrich_task, alert_task, resync_task, sel_resync_task,
                 snapshot_task, liveness_task, backup_task, strategy_task]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="Schwab Trader", version=APP_VERSION, lifespan=lifespan)

# CORS only in DEV: Vite (:5173) calls the backend (:8000) cross-origin. In the
# PACKAGED app the backend serves the SPA same-origin (SCHWAB_FRONTEND_DIR set /
# frozen), so no CORS is needed — and NOT enabling it there keeps the unauthenticated
# local trading API from being reachable cross-origin by any web page.
import os as _cors_os  # noqa: E402
import sys as _cors_sys  # noqa: E402

if not (_cors_os.environ.get("SCHWAB_FRONTEND_DIR") or getattr(_cors_sys, "frozen", False)):
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )


def _restart_stream() -> None:
    """Cancel and relaunch the quote stream so it reconnects with the CURRENT
    active-profile token (used after re-auth and after a profile switch)."""
    old = getattr(app.state, "stream_task", None)
    if old is not None:
        old.cancel()
    app.state.stream_task = asyncio.create_task(run_quote_stream())


# --- HTTP endpoint routers (split out of this module; see app/api/__init__.py).
# These imports MUST come after _selected/_csv_response/CsvImportBody/strategy and
# _restart_stream are defined — the router modules import them from here. ---
from .api import accounts as accounts_api  # noqa: E402
from .api import analysis as analysis_api  # noqa: E402
from .api import auth as auth_api  # noqa: E402
from .api import config as config_api  # noqa: E402
from .api import data as data_api  # noqa: E402
from .api import explore as explore_api  # noqa: E402
from .api import ledger as ledger_api  # noqa: E402
from .api import market as market_api  # noqa: E402
from .api import trading as trading_api  # noqa: E402

app.include_router(data_api.router)
app.include_router(config_api.router)
app.include_router(analysis_api.router)
app.include_router(auth_api.router)
app.include_router(accounts_api.router)
app.include_router(ledger_api.router)
app.include_router(market_api.router)
app.include_router(trading_api.router)
app.include_router(explore_api.router)


@app.websocket("/ws/notifications")
async def ws_notifications(ws: WebSocket) -> None:
    """Push each newly-fired notification to the browser as it happens."""
    await ws.accept()
    queue = notifications_svc.subscribe_feed()
    try:
        while True:
            note = await queue.get()
            await ws.send_json(note)
    except WebSocketDisconnect:
        pass
    finally:
        notifications_svc.unsubscribe_feed(queue)


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket) -> None:
    """Push a dashboard snapshot ~1x/sec for the selected account — but only when it
    changed, so an idle/closed market doesn't force a full JSON serialize + React
    table re-render every second."""
    await ws.accept()
    last = None
    try:
        while True:
            # A transient build failure (e.g. a flaky Schwab call inside the day-change
            # fetch) must NOT break the socket — otherwise the client reconnects, rebuilds,
            # fails again, and the reconnect + re-render storms ("rapid clicking" flicker).
            # Skip the bad tick and keep the connection alive.
            try:
                snap = await build_dashboard(await _selected())
            except Exception as e:
                log.warning(f"[dashboard] build failed, skipping tick: {e!r}")
                await asyncio.sleep(1.0)
                continue
            if snap != last:
                await ws.send_json(snap)
                last = snap
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        pass


@app.websocket("/ws/quotes")
async def ws_quotes(ws: WebSocket) -> None:
    await ws.accept()
    queue = hub.subscribe()
    # Send whatever we already have so the UI paints immediately.
    for q in hub.latest.values():
        await ws.send_json(q)
    try:
        while True:
            quote = await queue.get()
            await ws.send_json(quote)
    except WebSocketDisconnect:
        pass
    finally:
        hub.unsubscribe(queue)


# --- packaged desktop: serve the built SPA same-origin (mounted LAST so it never
# shadows the /api or /ws routes above). In dev SCHWAB_FRONTEND_DIR is unset → no
# mount → Vite serves the frontend and CORS handles cross-origin. In the Electron
# bundle, the sidecar sets SCHWAB_FRONTEND_DIR to the packaged frontend dist and the
# window loads http://127.0.0.1:<port>/ — same origin as the API, so no CORS. ---
import os as _os  # noqa: E402
import sys as _spa_sys  # noqa: E402

_frontend_dir = _os.environ.get("SCHWAB_FRONTEND_DIR")
if _frontend_dir and _os.path.isdir(_frontend_dir):
    from fastapi.staticfiles import StaticFiles  # noqa: E402

    app.mount("/", StaticFiles(directory=_frontend_dir, html=True), name="spa")
elif _frontend_dir:
    # SCHWAB_FRONTEND_DIR was set (packaged app) but doesn't exist → a broken bundle.
    # Fail LOUD instead of serving raw JSON 404s at "/" (which is what a stale/missing
    # frontend looked like). Electron's exit-code handler surfaces this.
    log.critical(f"[spa] FATAL: SCHWAB_FRONTEND_DIR={_frontend_dir!r} is not a directory — bundle is broken.")
    _spa_sys.exit(2)
