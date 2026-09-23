# Data Integrity Plan

Goal: **complete, accurate, self-healing data — never manual-first.** A new user
with 3+ years and thousands of trades gets to a fully reconstructed account with
one login and one file upload. This doc is the inventory of every datum the app
uses: where it comes from, how it's stored, and how it heals.

## Source priority (applies to everything)

1. **Schwab API** — richest and freshest (timestamps, order ids, live truth).
   Always first. But its history is bounded (below).
2. **Schwab Transactions CSV export** — the *complete* history (back to account
   opening). Date-level granularity, no order ids. The bulk-intake vector.
3. **Manual entry** — last resort, for the rare row neither source has
   (e.g. a transfer older than the CSV export the user pulled).

The app must always be usable with sources 1 alone; source 2 upgrades depth;
source 3 patches holes. Re-running any source is **idempotent** — importing the
same CSV twice, or overlapping the API window, never double-counts.

## Known source limits (why each layer exists)

| Source | Covers | Limits |
|---|---|---|
| API: orders (fills) | ~1 yr reliably (we page 60-day windows, configurable to ~5 yr) | ephemeral responses; older orders silently absent |
| API: transactions (transfers) | ~60 days | hard Schwab cap |
| API: positions | live now | quantities + avg cost only — no history |
| API: balances | live now | snapshot only; we accrue our own daily series |
| CSV: Transactions export | **account inception → today** | date-only timestamps, no order ids, same-day order ambiguity |

## The core fix: a persistent fill ledger (`fill_record`)

Previously fills were **ephemeral** — refetched from the API on every resync and
never stored, so the reconstruction could never know more than the API window.

Now every fill ever seen, from any source, is stored append-only in
`fill_record` (account, symbol, side, shares, price, at, order_id, source,
unique fill_key). Open lots (`lot`) and closed trades (`completed_trade`) become
a **pure projection** of this ledger: reconstruct (LIFO) → reconcile against
live positions → write. The projection can be wiped and rebuilt at any time
without losing anything, because the source of truth is durable.

Identity & dedup (rules corrected in v0.22.1 after live findings):
- **API fill**: key = order_id + execution time + price + shares + side. Exact.
  trade_date is the EASTERN calendar date of the execution — Schwab's ledger day.
  (Deriving it from UTC put after-hours fills on the next day and broke pairing.)
- **CSV fill**: key = trade_date + symbol + side + shares + price + occurrence#
  (occurrence# distinguishes two identical trades the same day).
- **Cross-source — the TOTALS rule**: within a (day, symbol, side) group where both
  sources have rows, the source accounting for MORE shares wins the group; the
  other's rows are evicted (tie → API, for leg-level timestamps). Why totals, not
  presence: the API queries orders by ENTERED time, so its first-sync boundary day
  is only partially covered, and a long-resting GTC order entered before the window
  is invisible — "API touched the group ⇒ API owns it" deleted real CSV fills in
  exactly those cases (found live). The CSV is complete per day by construction;
  comparing totals resolves both directions. Pure function, unit-tested.
- **heal_ledger** runs on every resync/projection: re-stamps any UTC-dated API rows
  to Eastern and re-resolves every conflicted group by the totals rule. Idempotent
  self-repair — a damaged ledger converges after (at most) one CSV re-import.

Same-day ordering (upgraded v0.23.1): the export is newest-first WITHIN a day
too, so reversed file order is the TRUE chronology — the parser preserves it by
encoding each row's intra-day sequence into its timestamp. On MIXED days (a kept
CSV fill sharing a day with API fills — e.g. a resting sell the API missed), the
fill is re-timed to sort after the API-owned rows that precede it in the day's
sequence, so LIFO retires the same lots it did in reality. Re-importing a CSV
also repairs the ordering of previously imported rows.

## Data inventory

| Datum | Primary source | Fallback | Stored in | Heals by |
|---|---|---|---|---|
| Fills (every buy/sell) | API orders (paged) | **CSV import** → manual | `fill_record` (append-only) | idempotent upsert on every resync; CSV backfills the deep past |
| Open lots / ladder | projection of fills | positions backfill (`source=position` lot) | `lot` (wipe+reproject) | every resync re-projects; reconcile guarantees totals match Schwab's live positions |
| Closed trades (realized P/L) | projection of fills | — (only as deep as the fill ledger) | `completed_trade` (wipe+reproject) | re-projection; deepens automatically when older fills arrive via CSV |
| Current positions (truth) | API positions | — | not stored (live), reconciled against | authoritative check on every resync; omission ≠ sold (never deletes by omission) |
| Cash transfers (deposits/withdrawals) | API transactions (60d, deduped by txn id) | CSV import (±4-day effective/posted window match) → manual | `cash_flow` | auto-pull on ledger view; CSV/manual merge idempotently |
| Dividends / interest | CSV import | manual refresh from API where exposed | app_setting JSON log (deduped day+amount+symbol) | re-import safe; per-symbol totals recompute |
| Daily balance series | nightly snapshot scheduler | — (accrues going forward only) | `daily_balance` | idempotent daily upsert; gaps are visible, not faked |
| Quotes / 52wk levels | API stream + price history | — | in-memory + `ticker` cache | demo-mode fallback is clearly labeled; money paths refuse untrusted quotes |
| Ticker classification (sector, leveraged-ETF link) | user edit in the drill-down | name-based leveraged-ETF detection | `ticker` | edits apply immediately |
| Strategy config / prefs / rules | user | defaults | YAML + `app_setting` | versioned defaults; validation endpoint |
| Audit log (fills as events) | API fills | — | `audit_event` (unique fill_key) | insert-or-ignore on every resync |

## Onboarding a massive account (the "dad" flow)

1. **Connect Schwab** (in-app OAuth). Immediately: live positions, balances,
   quotes — the dashboard is fully usable with position-backfilled lots.
2. **Automatic API backfill**: first resync pulls the full available order
   history into `fill_record` — recent ladder + recent realized trades appear.
3. **One CSV upload** (Export from Schwab → Transaction History → CSV):
   the app routes *one file* three ways — Buy/Sell → fill ledger,
   transfers → deposit log, dividends/interest → income log — and re-projects.
   Years of ladder history, realized P/L, deposits and dividends land at once.
   Anything it skipped (unknown actions) is reported, never silently dropped.
4. **Data health panel** (Settings) shows coverage: earliest fill per source,
   per-symbol reconstructed-vs-live share diffs, how many lots are synthetic
   backfills, and exactly what to do about any gap ("import a CSV covering
   dates before X").

No manual entry unless the user *wants* to patch a hole older than their export.

## Corporate actions & shorts (hardened v0.22.0, validated on a real 1,554-row export)

- **Reverse splits**: Schwab exports a row PAIR on the effective date (new count under
  the ticker, old count removed under a CUSIP). The importer pairs them into a SPLT
  ledger record; reconstruction rescales the open stack by new/old — cost basis is
  preserved exactly, zero P/L is realized, and the split applies before that day's
  trades. Fractional remainders match the broker's cash-in-lieu; the positions
  reconcile aligns the final count. Unmatched split rows are REPORTED, never guessed.
- **Short sales**: the ladder is long-only, and Schwab labels a covering purchase a
  plain "Buy" — so buys are NETTED against the open short balance chronologically per
  symbol (canonical same-day order: shorts, buys, sells; you can't be long and short
  the same equity simultaneously). Only the portion beyond covering becomes a long
  fill. Shorts excluded and covers netted are reported on import; realized P/L from
  shorting is intentionally absent (out of scope for the ladder).
- A mis-ordered same-day edge self-flags as `oversold` at reconstruction (which
  refuses to commit) rather than silently corrupting.

## Validation against Schwab (three independent cross-checks)

1. **Share counts** (exact): reconstructed open shares per symbol vs live positions.
2. **Cost basis** (exact-ish): our open-lot cost vs Schwab's shares x average price,
   flagged over max($50, 2%) — catches a wrong-priced backfill even when counts agree.
3. **Cash identity** (advisory): cash ~= net deposits + (sells - buys) + recorded
   income. A large unexplained residual points at missing deposits or trades. Known
   blind spots are listed with the number: fees/commissions, margin & credit interest,
   unimported income types, short-sale activity.

## Self-healing invariants

- **Wipes only ever touch projections** (`lot`, `completed_trade`). Source
  ledgers (`fill_record`, `cash_flow`, dividends, audit) are append-only.
- A rebuild only commits from **trustworthy inputs**: fetch errors are no-ops;
  an empty read never deletes fill-derived history; positions omission never
  deletes a holding; every projection ends reconciled to Schwab's live totals.
- Every ingest path is **idempotent** — re-run anything, any time, safely.
- Degradation is **visible**: synthetic lots are tagged `source=position` in the
  UI, stale quotes are flagged, and the health panel names gaps instead of
  papering over them.
