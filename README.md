# Schwab Trader

A local, always-on desktop day-trading app for the Charles Schwab API — the
successor to the "Stock Trading for 2026" Google Sheet. Live quotes over
websockets, a full ledger, a malleable strategy engine (LIFO progressive
ladder), and human-in-the-loop trading: the app does all the API/DB work and
surfaces what's actionable; **you approve every order**.

Ships as a Windows desktop app (Electron shell + bundled backend) that
**auto-updates** from GitHub Releases — no terminal needed for day-to-day use.

## What it does

- **Dashboard** — one row per holding with live price, last-position P/L, LILO %,
  52-week levels, portfolio weight and the strategy's buy/sell signal.
  - **Customizable signals** — the built-in BUY/SELL flags plus your own OR rules
    (e.g. sell when a lot is +$50, or a set % over cost), each with its own color.
  - **Risk coloring** — every ticker is tinted by how dangerous the instrument is
    (blue = broad fund / large cap … red = leveraged/inverse or micro-cap).
  - **ETF grouping** — single-stock leveraged ETFs nest directly under the stock
    they track (auto-detected from the fund name, override per ticker), and show
    the underlying's % of 52-week high so you read direction from the parent.
  - **Sub-tabs** — *All*, *To-Do* (only names meeting a buy/sell signal), and
    *Top 10* (biggest dips to buy / biggest gainers to sell).
  - **Cash & buying power** in the header; a sector-exposure bar with an optional
    concentration alert.
- **Bulk actions** (review-then-confirm, one order at a time through the guarded
  order path):
  - **Bulk Buy** — the next ladder position on dips, or fresh entries you select.
  - **Bulk Sell** — harvest each holding's profitable last position.
- **Ladder read** — per stock, from 5 years of prices and your own rules: how often past dips reached your sell target (and how deep they went), whether it's swinging or trending, how unusual the current dip is, whether the market explains it, and a leveraged fund's rebalancing decay. Reference only.
- **Position detail** — the buy ladder, projected positions, price chart with ladder
  and 52-week overlays, per-symbol realized/unrealized/dividend split, notes, and
  one-click price alerts.
- **Ledger** — *Historic* (balances, realized gains, deposits, equity curve,
  margin/deployment), *Activity* ($ bought/sold/net by day/
  week/month/year), *Trades* (closed round-trips + win rate/profit factor), and
  *Predictive* (goal pacing, year-end projection, estimated progressive tax).
- **Notifications** — price alerts, strategy triggers and fills to the in-app bell
  and desktop, with optional phone reach (ntfy / email) and per-category controls.
- **Explore** (experimental) — run any read-only Schwab API call against the selected
  account and see the raw payload plus a field inventory, with a note on what the app
  uses each endpoint for. For planning features against real data.
- **Multi-account / multi-profile**, automatic SQLite backups, and an in-app
  "what's new" viewer.

## Architecture

```
Charles Schwab API (REST + streamer WS)
        │  OAuth · quotes · orders
        ▼
FastAPI backend ── token mgr · streamer · strategy engine · order mgr · ledger
        │                         │
        ▼                         ▼
   SQLite (per-user)       React dashboard (Electron)  ──▶  you (one click)
```

- **Backend:** Python 3.14 + FastAPI + async SQLAlchemy + [schwab-py]. Runs on
  **SQLite** (the shipped default, per-user data dir) or **Postgres** (dev/server)
  — chosen by connection string; the code is dialect-agnostic.
- **Frontend:** React 19 + Vite + TypeScript.
- **Desktop:** Electron shell launches the backend as a **PyInstaller** sidecar;
  **electron-updater** pulls new GitHub Releases and installs on restart.

## Install (end users)

Grab the latest build for your OS from the
[Releases](https://github.com/ChristianDodart/schwab-trader/releases) page:

- **Windows** — `Schwab Trader Setup x.y.z.exe`. Auto-updates on launch (installs on the
  next restart; your data and settings are preserved). Unsigned, so the first run shows a
  SmartScreen prompt — click *More info -> Run anyway*.
- **Linux** — `Schwab Trader-x.y.z.AppImage`. Mark it executable and run it. Auto-updates.
- **macOS** — `Schwab Trader-x.y.z-arm64.dmg` (Apple Silicon). The build is **unsigned**,
  so macOS Gatekeeper blocks it on first open: right-click the app -> Open, or allow it
  under System Settings -> Privacy & Security. macOS builds **do not auto-update** (Apple
  requires a signed app for that) — to upgrade, download the newer `.dmg` from Releases
  and reinstall. Your data and settings are preserved.

## Develop

### Prerequisites
- Python 3.14+ and Node 18+
- (Optional) Docker Desktop, only if you want to run against Postgres instead of SQLite

### Backend
```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
python run.py                   # serves on http://localhost:8000
```
> Start with `python run.py` (not bare `uvicorn`) — it sets up the event loop the
> async drivers need. Data (SQLite DB, tokens, backups) lives under the per-user
> app data dir, or set `SCHWAB_DATA_DIR` / `DATABASE_URL` to override.
- Until you authorize Schwab, the quote feed runs in **DEMO mode** (synthetic
  prices) so the UI can be exercised end-to-end.

### Authorize Schwab (one-time, then auto-refresh)
```bash
cd backend
.venv\Scripts\activate
python -m app.schwab.authorize   # browser login, paste the redirect URL back
```
Thereafter re-authorization is handled **in-app** (Settings → Schwab connection)
when the refresh token lapses.

### Frontend
```bash
cd frontend
npm install
npm run dev                     # http://localhost:5173  (proxies to :8000)
```

### Tests
```bash
cd backend  && .venv\Scripts\python.exe -m pytest -q
cd frontend && npx tsc -b && npx vitest run && npm run build
```

## Build & release

**Cross-platform release (Windows + macOS + Linux)** — the normal path. Bump
`backend/app/version.py` + `desktop/package.json`, add a `CHANGELOG.md` section, then
push a version tag. GitHub Actions (`.github/workflows/release.yml`) builds all three
OSes on their own runners and publishes them to one GitHub Release; the workflow reads
the CHANGELOG section for the notes.
```bash
git tag v0.60.0 && git push origin v0.60.0
```
(PyInstaller can't cross-compile, so each OS builds its own backend sidecar in CI. A
manual "Run workflow" from the Actions tab does a dry build that publishes nothing.)

**Local Windows-only build** — a fast fallback when you just need a Windows installer:
```powershell
.\build-installer.ps1            # build the installer locally
.\build-installer.ps1 -Publish   # build + publish a Windows-only GitHub Release
```

## Strategy config
All strategy numbers live in **`backend/app/strategy/default_strategy.yaml`**
(sizing tiers, buy-ladder %s, sell rules, guardrails). The engine in `rules.py`
reads them — edit the YAML, restart, done. No plumbing code changes.

## Secrets
`backend/.env` holds your Schwab client ID/secret (gitignored); the Schwab token
and app secrets are stored encrypted per-install. Rotate the Schwab secret
periodically on developer.schwab.com.

[schwab-py]: https://github.com/alexgolec/schwab-py
