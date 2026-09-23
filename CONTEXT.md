# CONTEXT — schwab-trader domain glossary

A living glossary of the domain terms this codebase uses, so names in code, reviews, and
architecture work stay consistent. Add a term when a module is named after a concept that
isn't here yet; sharpen a definition when a conversation clarifies it.

## Glossary

**Order intent** — a proposed order described in plain domain terms (symbol, side,
quantity, order type, limit/stop price), with no broker types or I/O. What the pre-trade
guards judge before anything is sent. See `backend/app/order_guards.py::OrderIntent`.

**Pre-trade guards** — the money-path safety rails evaluated against an order intent before
placement: *stop-direction* (a stop must sit on the correct side of the market),
*fat-finger* (a limit absurdly far from the last price is likely a typo — confirm),
*notional* (an oversized BUY is likely a quantity typo — confirm), and *held-shares* (a
SELL may never exceed shares held — fail closed). One pure module,
`backend/app/order_guards.py`; its interface is the test surface. A guard returns a
**verdict**: `ok`, `confirm` (soft — the user may override), or `reject` (hard).

**Trusted last price** — the last price used to validate a real order, taken only from a
schwab-sourced quote; a demo/synthetic quote reads as "no reference" so the guards fail
closed. `backend/app/orders.py::trusted_last_price`.

**Order status classification** — the single taxonomy over a broker order status, in
`backend/app/order_status.py`, read by the nav badge, the cancel/edit guards, and the
ticket's fill poll: *working* (live — cancelable/editable, allowlist), *cancelable* (cancel
unless known-terminal — a denylist, robust to Schwab adding new live statuses), *settled*
(a truly-final state — stop polling). The client never re-derives these; the order payload
carries `working` (per row) and `settled` (on the single-order lookup).

**Single-order placement** — the `place_order` / `replace_order` path: one order at a time,
sharing the pre-trade guards and their thresholds (20% fat-finger band, $10k notional).

**Bulk placement** — the `bulk.py` path: many orders reviewed together, with its own
per-item guard model (reject/skip, wider 25% / $25k thresholds) that then routes each item
through `place_order`. Deliberately separate from the single-order guards; reconciling the
two is an open decision, not a settled one.

**Order eligibility** — which order settings may go together, split into two concerns.
*Combo validity* is broker law: the `(order type, session, duration)` tuples Schwab will
accept, time-independent — an extended-hours session (AM/PM/SEAMLESS) takes a plain LIMIT
only, and never a good-till-canceled. It lives in one pure module,
`backend/app/order_eligibility.py::combo_error` (returns a plain-English reason or None),
enforced server-side inside `orders.py::_build_order` — the single authoritative gate every
path (single ticket, replace, bulk) builds through, so an invalid combo fails fast with a
clear reason before Schwab ever sees it. The frontend mirrors it in
`frontend/src/orderEligibility.ts::comboError`, wired into the ticket's *can-place* check so
a reachable bad combo (e.g. STOP_LIMIT or GTC in an extended session) blocks with the same
message instead of round-tripping to a broker rejection. *Clock affordance* is the separate,
time-dependent UX rule — `offerableTypes(marketSession, menu)` — for which order types a
ticket should OFFER given the detected market clock: the full menu only in confirmed regular
hours, a price-protected LIMIT otherwise (extended/closed/unknown), and the full menu while
the clock is still loading (`null`). Both the single Order Ticket and the Bulk review read
this one function, so they can no longer disagree (the single ticket now also restricts its
closed/unknown case to LIMIT, matching Bulk).

**Deployment %** — the one canonical "how much of my capital is in the market" figure:
long market value ÷ your own equity, as a percent. ~100% when fully invested; deliberately
**uncapped and over 100% when you're on margin** (the "am I stretched?" signal — it does not
count margin buying power as capacity). Defined once in the pure
`backend/app/accounts.py::deployment_pct(lmv, equity)` (None when a balance is missing or
equity is zero — read as "unknown", never a misleading number), surfaced as
`margin_summary::deployed_pct`, and read by exactly three consumers so they can't disagree:
the account-band meter (`AccountBand.tsx` renders `margin.deployed_pct` — its 0–100 bar caps
at 100% but the label shows the true % and flags "· on margin" past 100), the glossary live
figures, and ladder deployment-scaling. Distinct from a cost-basis "dry powder" ratio (which
the meter used to compute locally, off `total_invested`); that second definition was retired
to end the two-numbers-on-one-screen drift.

**Dashboard read-model** — the App shell's live data layer, extracted into one hook
`frontend/src/useDashboardData.ts::useDashboardData(acctKey, view, live)` so `App` is
layout + routing and this owns the reads. Four independent reads plus one derived flag: the
WebSocket dashboard stream (`data` + `connected`), the `/account/margin` poll (`cash` +
`margin` — the full summary the glossary reads), the `/orders/working-count` poll (`working`
= `{count, bySym}`), and `pricesStale` (from the pure `pricesAreStale(mode, live)` — stale
only when a real feed's Schwab liveness reads explicitly `false`, never for a demo feed or an
unknown liveness). READ-ONLY: it never selects an account or touches UI state. Account
*selection* — and the bulk/selection resets a switch performs — stay in the shell; the hook
only reacts to the resulting `acctKey`/`view`, and blanks `data` on a real switch (not the
initial resolve from `""`) so one account's holdings never render under another.

**DashboardRow contract** — the wide per-symbol row the backend builds and the frontend
renders. Held and watch rows share one builder base (`dashboard.py::_base_row`, the ~14
identical quote/reference fields); `_summary_row` and `_watch_row` add their specifics on
top, so the two can't drift and every field the type promises is present on both kinds
(watch rows set the held-only fields to zero/None rather than omitting them).

**Row derivations** — the money-math computed off a `DashboardRow`, in one pure module
`frontend/src/rowDerived.ts`, so the table, account band, at-a-glance strip, Top-10 view,
and signal rules all read the same values instead of re-deriving (and drifting): *last
position gain %* (`lastPosGainPct`, guarded on a positive cost — also the sell-signal
metric), *today's % move* (`dayPct(change, value)` — change over start-of-day value, used at
account and position level). (The 5% single-stock cap was removed 2026-09; Portfolio % is
informational.) Money→color is the separate `moneyColor` (positive green, negative
red, exactly zero neutral) — the one money-color function.
