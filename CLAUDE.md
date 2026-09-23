# Schwab Trader — Project Notes (living doc)

> **Maintenance rules (read + obey):** This file orients a fresh session FAST. Keep it **refined, not exhaustive**. When something changes, **edit the line and DELETE what's now false** — prefer rewriting over appending. Point-in-time history belongs in git (`git log` has a line per release), not here. If this file is growing into a context hog, tighten it.

## What this is
A local, always-on trading app for the **Schwab Trader API**, replacing a Google Sheet ("Christian - Stock Trading for 2026"). Single user (Christian), plus other Schwab logins as profiles (e.g. his dad Dave). Goals: never depend on Google; never visit Schwab's website; human-in-the-loop one-click trading (the app does the API + DB work, the user approves via buttons). Ships as an Electron desktop app for Windows, macOS and Linux with auto-update.

## Strategy — LIFO progressive ladder (config-driven, NOT fixed)
- Buy in rungs as price drops, **increasing size deeper**; sell **last-in lots first (LIFO)**; aim to ~double the balance per year.
- **Sizing** by rungs already filled: 1–2→$500, 3–7→$1000, 8–10→$1500 (shares = $ ÷ price).
- **Ladder drops**: rung 2 = prior×(1−10%); rungs 3–7 = prior×(1−13%); rungs 8–10 = prior×(1−16%). **Deployment scaling** (on by default) multiplies the drop by tier when much of your own money is invested (≥90% ×1.4, 70–90% ×1.15). Deployed % = long market value ÷ own equity: 100% = fully invested with own money, >100% = margin. Multipliers below 1 are clamped to 1 (scaling only ever demands deeper dips).
- **Sell targets** per lot: flat-$ gain (default: buy + $gain ÷ shares) OR %-above-buy; a target saved on a lot overrides both.
- Personal discipline (NOT enforced by the app): rarely short, diversify, avoid what you don't understand. The old 5% single-stock cap, cash-reserve %, and universe screen (US $1–30B, no China/biotech) were removed 2026-09 — don't reintroduce them as UI.
- All rules live in `backend/app/strategy/default_strategy.yaml` + pure `rules.py`, overridable per account (`config_store.py`) and per ticker (per-ticker overrides only reach the dashboard/drill-down/triggers, not the order tickets or bulk; Christian wants to rethink that system, leave it alone). **Never hardcode strategy in plumbing.**

## Stack / architecture
- Backend: Python 3.14 + FastAPI + `schwab-py` + async SQLAlchemy.
- DB: **SQLite** (`backend/data/schwab_trader.db`, WAL; path from `DATABASE_URL` in `backend/.env`). Dialect-agnostic code; Postgres (Docker, port 5433) kept only as a rollback.
- Frontend: React + Vite + TS; lightweight-charts.
- Desktop: `desktop/` Electron shell spawning the PyInstaller backend (`backend/schwab-backend.spec`) on a free port; the backend serves the built SPA same-origin. Per-user data in the Electron `userData` dir (`%APPDATA%\schwab-trader-desktop`: DB, encrypted tokens, `backend.log`).
- **Design system (use it — don't reintroduce drift):** `src/tokens.css` = the only home for color/type/space/radius/elevation (money pair `--pos`/`--neg` for numbers, `--pos-strong`/`--neg-strong` for fills; `--accent` blue = a control, green = an outcome; text tiers `--text`/`-muted`/`-dim`/`-faint`, all WCAG-AA). `src/ui.css` = primitive classes (`.btn[-primary/secondary/ghost/buy/sell/danger/sm]`, `.field`, `.navtab`, `.tbl`, `.chip[-buy/-sell]`, `.panel`, `.modal-overlay`/`.modal`, `.toast`, `.skeleton`…). Errors go through `useToast()`, never `alert()`. Money modals are `role=dialog` + Escape + focus-trap. Canvas charts read colors via `chartTheme.ts` (canvas can't read `var()`).
- Every displayed figure has a glossary definition (`frontend/src/glossary.ts`, hover a label / hold Alt) that states what it measures, why, and the formula. When you change a computation, update its definition in the same change.
- Live quotes: Schwab streamer → in-memory hub → `/ws/quotes`, `/ws/dashboard`.

## Run it
- Backend: `cd backend && .venv\Scripts\python.exe run.py` → http://localhost:8000 *(NOT bare uvicorn — Windows needs SelectorEventLoop; run.py sets it)*
- Frontend: `cd frontend && npm run dev` → http://localhost:5173 · One-shot: `./start.ps1` / `./stop.ps1`
- `.claude/launch.json` has `frontend` (5173) and `backend` (8000) entries for `preview_start`.
- Tests: `cd backend && .venv\Scripts\python.exe -m pytest tests/` · `cd frontend && npx tsc --noEmit -p . && npx vitest run && npx vite build`.
- **RELEASE (all 3 platforms) = push a `v*` tag → CI does everything.** `.github/workflows/release.yml`: bump `backend/app/version.py` AND `desktop/package.json` `version`, add a `## vX.Y.Z` section to `CHANGELOG.md` (becomes the release notes + in-app update banner), commit, `git push`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. CI builds Windows, macOS (arm64 dmg+zip) and Linux (AppImage) on their own runners, uploads all to ONE release + the electron-updater feed (`latest*.yml`), flips the draft to published. ~8 min. Verify: 10 assets, not draft, Latest.
  - **DO NOT release with `build-installer.ps1 -Publish`.** It builds Windows-only and creates a *published* release out-of-band; CI then refuses to upload mac/linux ("existing type not compatible … existingType=release publishingType=draft") and the run still looks green. `build-installer.ps1` (no flag) is for a LOCAL test installer only.
  - **gh account gotcha:** several accounts are logged in and the active one silently changes; the wrong one has `push: false`, so pushes and release edits 404. Repo owner = **`ChristianDodart-Personal`**. Run `gh auth switch --user ChristianDodart-Personal` in the SAME chained command as the op. **Git credential pin:** `.git/config` `credential.https://github.com.username` must name the same account (local scope), else git falls back to a password prompt that fails with no TTY. **Never pipe `git push` through `tail`** (masks the exit code); print `exit=$?` per step. Prefer `gh run rerun` over re-pushing a tag.
- Re-auth Schwab (token ~7 days): one click in Settings → Schwab connection (desktop captures the OAuth redirect itself). The header "Live" pill reflects a real authenticated probe, not the token's age.
- DB schema is **Alembic-managed**; startup runs `alembic upgrade head`. Change schema: edit `app/db/models.py` → `alembic revision --autogenerate -m "msg"` → review → upgrade. **Migrations must be batch-safe for SQLite** (installs upgrade in place). NEVER drop/recreate.

## Accounts (critical context)
- **…4896 = LLC (managed):** read-only via API (positions + balances); transactions/orders are blocked by Schwab, so there is NO fill history. Its ladder is one aggregate "prior" lot per symbol at Schwab's average cost (no tax-lot endpoint exists). Positions feed is settled, ~T+1 behind intraday.
- **…8719 = personal (margin):** full API access; the trading account. Real fills flow and rebuild the per-lot ladder.
- **There is no trading on/off gate** (removed v0.82): orders go to whichever account is selected, and Schwab itself rejects orders on a read-only account. Don't add a toggle back; if blocking read-only accounts is ever wanted it'll be designed differently.
- **Per-account scoping:** `lot`/`completed_trade`/`daily_balance`/`fill_record` carry `account_hash`; every view follows the **selected** account (per profile). Per-account config: strategy, tax (filing + state rate), salary, goal.
- **Holdings sync is automatic, no button:** backend resync on a ~2-min timer, on account switch, on the ACCT_ACTIVITY stream trigger; frontend pokes `POST /api/account/sync` on window refocus (throttled 45s). To force one: refocus or restart. Never tell the user to click a "Sync from Schwab" button (it's gone).
- Profiles = separate Schwab logins, each with its own Fernet-encrypted token (`tokens/`) and its own Schwab app creds. The desktop app and a dev instance sharing one Schwab app registration supersede each other's refresh token.

## Feature map (what exists now)
- **Dashboard:** held rows + watchlist, customizable/foldable columns (`columns.tsx`), BUY/SELL chips + user signal rules, account band (Invested/Day change/Harvestable/Cash + Deployment meter), at-a-glance strip (movers, largest position by cost, open P/L), inline drill-down drawer (`PositionDetail.tsx`: stats, ladder, projected rungs, chart, per-ticker rules/alerts/notes, "Sell shares" LIFO box). Bulk: pick holdings, then Buy or Sell, review/edit, place.
- **Ledger:** Historic (live balances, since-inception capital/profit, Profit breakdown + tax axis, deposits/withdrawals, dividends, equity curve, capital-gains panel with earnings curve), Activity, Trades (journal + stats), Predictive (pace, goal, tax projection).
- **Orders**, **Rules** (every strategy knob with a worked example + validator), **Method** (advisory risk lenses: exposure by underlying, ladder stress, thesis breaks, Kelly), **Notifications** (price alerts, strategy triggers, fill notices; per-account delivery grid for in-app/desktop/phone/sound; phone via ntfy or email), **Settings** (Schwab creds/connection, taxes, data health + CSV import, backups, appearance, diagnostics, desktop).
- Removed on purpose (don't resurrect without asking): Screen tab/screener/movers/FMP, trading toggle, PDT guard (FINRA dropped the rule 2026-06-04), bulk auto-select gear + prefs, bulk "Get me out" exit, single-stock cap, cash reserve, universe rules, "Sync from Schwab" button.

## Invariants (don't regress)
- **LIFO everywhere a lot is chosen.** The sale retires the newest lot (highest rung, id breaks ties): `reconstruct.py`, `bulk._last_lot`, `orders.suggest_sell` (refuses an older lot), the drill-down (Sell button only on the last row), the SELL chip (`rules.is_sell_mark` on the newest lot's target), LILO % (vs the newest lot's buy price), Last Pos P/L, Harvestable.
- **Unknown-cost lots never invent profit.** A lot with `buy_price <= 0` is excluded from cost, basis, unrealized, total return, targets and P/L; a newest lot with no cost blanks LILO/Last Pos P/L/SELL and the row gets `cost_unknown` (a "review" chip on the ticker); bulk sell skips it.
- **Resync fails closed.** Fills fetch error (None) → no-op; empty fills on an account with fill-derived history → refuse; empty/partial positions → skip reconcile; a symbol absent from positions is kept, only an explicit ~0 is dropped; an unidentified holding makes the positions snapshot unavailable. Per-account lock around fetch+write.
- **Fill ledger is append-only and idempotent** (`fill_record`, `fill_key`); lots and completed trades are a pure projection of it. Market buys that fill in several legs merge into one rung (same order id, or same price same day).
- **Money-path guards (server-side):** SELL fails closed unless Schwab confirms held shares; stop direction checked against a trusted (Schwab, not demo) quote; single ticket soft-confirms limits >20% from market and buys >$10k; bulk refuses limits (buy or sell) >25% from market, buys >$25k, sub-cost sell limits, and market sells at a loss; bulk orders carry the same session the single ticket would use (extended hours = AM/PM/SEAMLESS, DAY only).
- **Notifications:** "system" (Schwab reconnect reminders) always delivers even when muted; "notice" (app notices, e.g. a detected split) honors Mute all; alert/trigger/fill follow the delivery grid.

## Gotchas (don't rediscover)
- **Fills aren't only `assetType == "EQUITY"`** (ETFs can be `COLLECTIVE_INVESTMENT`). Accept all share-based instruments; skip only `OPTION/FUTURE/FOREX` and log the skip.
- **Absolute paths in `backend/.env` break when the repo moves** (`sqlite3.OperationalError: unable to open database file` before any app code runs). Check `.env` paths first.
- **Schwab can report a holding under its CUSIP, not its ticker** (RCAX as `88636W718`, 2026-09-08). `app/symbols.py` `resolve_symbol` is the ONE place an instrument becomes a ticker (CUSIP check digit → `get_instrument_by_cusip`, cached). Used by positions sync, `held_shares`, positions list. Unidentified → snapshot unavailable. The Data-health tell: mirrored counts "X +n, Y −n".
- **A live split is invisible to the API fill path** (TRADE transactions only). `reconstruct.infer_splits` detects one from the positions snapshot when shares ≈ fill total ÷k (or ×k) AND Schwab's average moved "closer to k than to 1" (ratio > √k, within k/1.5…k×1.5; Schwab's average is their tax-lot method, ours LIFO, so they differ 10–20% with no split). Persisted as an `inferred` SPLT; a later CSV split supersedes it. **CSV splits arrive keyed by CUSIP** (both legs) and are re-attached to the ticker on import and in `heal_ledger`. Follow-up: ingest `RECEIVE_AND_DELIVER` from the API.
- Windows + async needs SelectorEventLoop → always launch via `run.py`.
- Schwab market data **throttles bursts** by returning HTTP 200 with EMPTY candles (not 429). Cache, one shared client, don't hammer.
- **One shared schwab client** (`schwab/auth.py: get_client()`); extra client processes rotate the refresh token and break the streamer ("Login Denied"). Don't run ad-hoc client scripts while the server is live.
- Only cancel orders not in a terminal status; canceling REJECTED/FILLED returns HTTP 400.
- Schwab partial level-one ticks omit unchanged fields; `QuoteHub.publish` merges non-None fields (replacing blanked prices to "—").
- A transfer's Schwab date is its POSTED date while the CSV "as of" is the EFFECTIVE date; CSV deposit dedup matches the same amount within ±4 days.
