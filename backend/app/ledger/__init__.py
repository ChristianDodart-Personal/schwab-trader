"""Ledger service — the "Bal. Info" port.

Built from the verified spec (scratchpad/bal_info_spec.md) and validated against
the real DB. Realized P&L comes from completed_trade; open exposure from lot.

The original sheet has several bugs (a tax cascade that collapses to a flat 12%,
month buckets that straddle calendar boundaries, a "Gross Sales" column that is
really cost basis, an annualization anchored 13 months before any trade). We
compute the CORRECT values and also surface the sheet-parity numbers so the
user can see both. Anything needing a real account-balance series (daily
balance, total gain/loss, "reg trading") is flagged blocked until daily_balance
snapshots accrue.

This package is a drop-in replacement for the old single-module app/ledger.py:
every name that module exposed is re-exported here, so `from app import ledger`
and `from app.ledger import X` keep working unchanged.
"""
from ._shared import (
    _GRAINS,
    MARKET_TZ,
    _f,
    _parse_csv_date,
    _parse_date,
    _parse_money,
    _period_key,
    _today,
)
from .analytics import (
    _FED_BRACKETS,
    FED_FLAT_RATE,
    SHEET_ANCHOR,
    START_BALANCE_2025,
    _best_worst_periods,
    _progressive_federal,
    _tax,
    _weekdays,
    build_activity,
    build_cap_gains,
    build_historic,
    build_positions,
    build_projection,
    build_summary,
    build_tax,
    build_trades,
    capital_summary,
    compute_drawdown,
    compute_streaks,
)
from .income import (
    _CSV_DEDUP_WINDOW_DAYS,
    _CSV_TRANSFER_KEYS,
    _DIV_KEY,
    _OTHER_CASH_KEY,
    _OTHER_CASH_MAX_ROWS,
    _OTHER_CASH_SKIP,
    _cf_row,
    add_cashflow,
    deep_resync_activity,
    delete_cashflow,
    get_dividends,
    get_other_cash,
    import_cashflows_csv,
    import_dividends_csv,
    import_other_cash_csv,
    list_cashflows,
    refresh_cashflows_from_schwab,
    refresh_dividends,
    sync_activity,
)
from .settings_store import (
    _ETF_LINKS_KEY,
    _LASTHELD_KEY,
    _NOTES_KEY,
    _NOTES_MAX_SYMBOLS,
    _SIGNAL_RULES_KEY,
    get_etf_links,
    get_last_held,
    get_note,
    get_notes,
    get_signal_rules,
    set_etf_link,
    set_last_held,
    set_note,
    set_signal_rules,
)
from .snapshots import (
    _snapshot_all_accounts,
    latest_balance,
    run_snapshot_scheduler,
    write_snapshot,
)
