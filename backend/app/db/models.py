"""ORM models — the relational version of the spreadsheet tabs.

  Ticker          ~ one watched stock (Stock Data row + Longs block header)
  Lot             ~ one rung in a ticker's ladder (Longs rows 9-18)
  CompletedTrade  ~ one closed round-trip (Long Log row)
  DailyBalance    ~ one day of P&L (Bal. Info daily row)

Phase 1 defines the schema; later phases populate it from Schwab + your actions.
"""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import ForeignKey, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Ticker(Base):
    __tablename__ = "ticker"

    symbol: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(128))
    watch: Mapped[bool] = mapped_column(default=False)  # user-added watchlist ticker
    # Last-seen quote snapshot (updated by the streamer)
    last_price: Mapped[float | None] = mapped_column(Numeric(14, 4))
    day_high: Mapped[float | None] = mapped_column(Numeric(14, 4))
    day_low: Mapped[float | None] = mapped_column(Numeric(14, 4))
    year_high: Mapped[float | None] = mapped_column(Numeric(14, 4))
    year_low: Mapped[float | None] = mapped_column(Numeric(14, 4))
    market_cap: Mapped[float | None] = mapped_column(Numeric(20, 2))
    quote_at: Mapped[datetime | None] = mapped_column()
    # Classification (Schwab omits it): user-tagged. Drives the dashboard sector column
    # and the diversification view; country is legacy and no longer set anywhere
    # exclusion guardrails.
    sector: Mapped[str | None] = mapped_column(String(48))
    industry: Mapped[str | None] = mapped_column(String(64))
    country: Mapped[str | None] = mapped_column(String(8))

    lots: Mapped[list["Lot"]] = relationship(back_populates="ticker_ref")


class Lot(Base):
    """An open buy lot (a filled rung in the ladder)."""

    __tablename__ = "lot"
    # Monotonic ids on SQLite (AUTOINCREMENT): lots are wiped-and-reinserted on every
    # resync, and plain rowids get REUSED — a stale lot_id from a pre-resync plan
    # could then alias a different lot. bulk_sell also identity-checks by symbol;
    # this removes the aliasing at the source for fresh (desktop) databases.
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(primary_key=True)
    account_hash: Mapped[str] = mapped_column(String(64), index=True, default="")
    symbol: Mapped[str] = mapped_column(ForeignKey("ticker.symbol"), index=True)
    rung: Mapped[int] = mapped_column()                 # 1-based position in the ladder
    buy_date: Mapped[date] = mapped_column()
    shares: Mapped[float] = mapped_column(Numeric(14, 4))
    buy_price: Mapped[float] = mapped_column(Numeric(14, 4))
    # Sell target for THIS lot: mode + value (dollar_gain or pct_above)
    sell_mode: Mapped[str | None] = mapped_column(String(16))
    sell_target_price: Mapped[float | None] = mapped_column(Numeric(14, 4))
    schwab_order_id: Mapped[str | None] = mapped_column(String(32))
    # "fill" = reconstructed from a real buy fill; "position" = backfilled from
    # Schwab's aggregate position (a holding whose buy is outside our fill window).
    source: Mapped[str] = mapped_column(String(12), server_default="fill")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    ticker_ref: Mapped[Ticker] = relationship(back_populates="lots")


class CompletedTrade(Base):
    """A closed round-trip, mirroring a Long Log row."""

    __tablename__ = "completed_trade"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_hash: Mapped[str] = mapped_column(String(64), index=True, default="")
    symbol: Mapped[str] = mapped_column(String(16), index=True)
    shares: Mapped[float] = mapped_column(Numeric(14, 4))
    buy_price: Mapped[float] = mapped_column(Numeric(14, 4))
    sell_price: Mapped[float] = mapped_column(Numeric(14, 4))
    cost: Mapped[float] = mapped_column(Numeric(16, 4))
    profit: Mapped[float] = mapped_column(Numeric(16, 4))
    opened_at: Mapped[date | None] = mapped_column()
    completed_at: Mapped[date] = mapped_column()
    schwab_order_id: Mapped[str | None] = mapped_column(String(32))


class DailyBalance(Base):
    """One day of account stats, mirroring a Bal. Info daily row."""

    __tablename__ = "daily_balance"

    account_hash: Mapped[str] = mapped_column(String(64), primary_key=True, default="")
    day: Mapped[date] = mapped_column(primary_key=True)
    balance: Mapped[float | None] = mapped_column(Numeric(16, 2))
    capital_gains: Mapped[float | None] = mapped_column(Numeric(16, 2))
    gross_sales: Mapped[float | None] = mapped_column(Numeric(16, 2))


class CashFlow(Base):
    """Outside money moving IN/OUT of an account (deposits, wires, withdrawals) —
    the "capital contributed" the account value must be netted against for a true
    profit/ROI figure.

    Two sources coexist (see the ledger's deposit log):
      - source="schwab": auto-pulled from the transactions endpoint (last 60 days
        only — Schwab's hard limit). Deduped by `schwab_txn_id` so re-pulling is
        idempotent.
      - source="manual": user-entered, for transfers OLDER than 60 days or to
        correct a miscategorized/missing one.
    `amount` is signed: deposits positive, withdrawals negative. `kind` mirrors the
    sign for display.
    """

    __tablename__ = "cash_flow"
    # Dedup identity is PER ACCOUNT: Schwab's activityId/transactionId is only unique
    # WITHIN an account, so a global unique on schwab_txn_id could drop or reject a
    # different account's transfer that happens to share an id. NULLs (manual entries)
    # are distinct in Postgres, so multiple manual rows per account are fine.
    __table_args__ = (
        UniqueConstraint("account_hash", "schwab_txn_id", name="uq_cash_flow_account_txn"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    account_hash: Mapped[str] = mapped_column(String(64), index=True)
    day: Mapped[date] = mapped_column()
    amount: Mapped[float] = mapped_column(Numeric(16, 2))       # + deposit, - withdrawal
    kind: Mapped[str] = mapped_column(String(16))               # "deposit" | "withdrawal"
    source: Mapped[str] = mapped_column(String(12))             # "schwab" | "manual"
    memo: Mapped[str | None] = mapped_column(String(256))
    # Schwab's transaction identity — present only for source="schwab"; part of the
    # per-account unique constraint above so a re-pull is idempotent. NULL for manual.
    schwab_txn_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Profile(Base):
    """A separate Schwab login the operator can switch between (e.g. Christian,
    Dave). Each profile owns its own OAuth token (stored ENCRYPTED off-DB, keyed by
    profile id) and its own profile-scoped app_settings (selected account, UI
    layouts, bulk thresholds). Account-level data (lots/trades/config) is already
    namespaced by Schwab account_hash, which differs per login, so it never bleeds
    across profiles."""

    __tablename__ = "profile"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)   # uuid4 hex-ish
    name: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class AppSetting(Base):
    """Simple key/value app settings. Profile-scoped keys are prefixed `p:{id}:`
    (see profiles.pkey); global keys (e.g. active_profile_id) are unprefixed."""

    __tablename__ = "app_setting"

    key: Mapped[str] = mapped_column(String(96), primary_key=True)
    value: Mapped[str | None] = mapped_column(Text)  # JSON UI prefs can exceed 256


class AccountConfig(Base):
    """Per-account configuration: strategy overrides + tax settings.

    strategy_json holds a full strategy config as JSON; NULL means "use the
    YAML defaults".
    """

    __tablename__ = "account_config"

    account_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    # Retained for schema compatibility only — the trading gate was removed (orders
    # always route to the selected account); this column is no longer read.
    trading_enabled: Mapped[bool] = mapped_column(default=False)
    strategy_json: Mapped[str | None] = mapped_column()
    tax_filing: Mapped[str] = mapped_column(String(16), default="single")
    tax_state_rate: Mapped[float] = mapped_column(Numeric(6, 4), default=0.045)
    # Ledger PREDICTIVE inputs (user-set, per account). year_end_goal = target
    # realized capital gains for the calendar year (drives "sell/day to hit goal").
    # other_annual_income = the user's OTHER taxable income (e.g. salary); short-term
    # trading gains stack on top of it so the progressive brackets land correctly.
    # Both NULL = unset (goal hidden; tax computed on gains alone).
    year_end_goal: Mapped[float | None] = mapped_column(Numeric(16, 2))
    other_annual_income: Mapped[float | None] = mapped_column(Numeric(16, 2))


class PriceAlert(Base):
    """A user-set price-hit rule: notify when SYMBOL crosses THRESHOLD.

    A price is the same regardless of account, but the notification it raises is
    gated by ONE account's prefs (v0.62): `account_hash` records which account owns
    the alert — the account selected when it was created — so its bell/desktop/phone/
    sound routing follows that account's notification settings. NULL = legacy/global
    (gated by the global defaults). One-shot by default (deactivates on fire);
    `repeat` re-arms it so it fires again on each fresh crossing.
    """

    __tablename__ = "price_alert"

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(16), index=True)
    direction: Mapped[str] = mapped_column(String(8))          # "above" | "below"
    threshold: Mapped[float] = mapped_column(Numeric(14, 4))
    note: Mapped[str | None] = mapped_column(String(256))
    repeat: Mapped[bool] = mapped_column(default=False)
    active: Mapped[bool] = mapped_column(default=True)
    account_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)  # owning account (NULL = legacy/global)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_fired_at: Mapped[datetime | None] = mapped_column()


class Notification(Base):
    """An ATTENTION item (price alert hit, a resting limit/stop fill) — the loud
    bell feed + desktop push. Distinct from AuditEvent (the quiet full record)."""

    __tablename__ = "notification"

    id: Mapped[int] = mapped_column(primary_key=True)
    alert_id: Mapped[int | None] = mapped_column(index=True)
    symbol: Mapped[str | None] = mapped_column(String(16), index=True)
    message: Mapped[str] = mapped_column(String(256))
    price: Mapped[float | None] = mapped_column(Numeric(14, 4))
    read: Mapped[bool] = mapped_column(default=False)
    # Category for the per-type unread pills: alert | trigger | fill | system.
    # NULL on legacy rows (pre-migration) — bucketed as "other" in the count.
    kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class FillRecord(Base):
    """The persistent fill ledger — every executed buy/sell ever seen, from any
    source. APPEND-ONLY: open lots + completed trades are a pure PROJECTION of
    this table (reconstruct → reconcile → write), so projections can be wiped and
    rebuilt at will without losing history. This is what lets a 3-year account
    outlive the Schwab API's ~1-year order window.

    Sources: "api" (orders endpoint — exact timestamps + order ids) and "csv"
    (Transactions export — date-level; upgraded in place when the matching API
    fill later appears). fill_key is the deterministic identity used for
    idempotent ingest (see fill_store)."""

    __tablename__ = "fill_record"
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(primary_key=True)
    account_hash: Mapped[str] = mapped_column(String(64), index=True)
    symbol: Mapped[str] = mapped_column(String(16), index=True)
    side: Mapped[str] = mapped_column(String(4))                # "BUY" | "SELL"
    shares: Mapped[float] = mapped_column(Numeric(14, 4))
    price: Mapped[float] = mapped_column(Numeric(14, 4))
    at: Mapped[datetime] = mapped_column()                      # naive UTC (CSV rows: midnight of trade date)
    trade_date: Mapped[date] = mapped_column(index=True)        # day-level key for cross-source dedup
    order_type: Mapped[str | None] = mapped_column(String(16))
    order_id: Mapped[str | None] = mapped_column(String(32))
    source: Mapped[str] = mapped_column(String(8))              # "api" | "csv" | "manual"
    fill_key: Mapped[str] = mapped_column(String(180), unique=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class AuditEvent(Base):
    """The quiet activity log — a record of what happened (every fill, incl. the
    guaranteed/instant market fills). NOT pushed; reviewed on demand. Notifications
    are the loud SUBSET of these worth interrupting the user for."""

    __tablename__ = "audit_event"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(24))               # "fill" (room to grow)
    symbol: Mapped[str | None] = mapped_column(String(16), index=True)
    side: Mapped[str | None] = mapped_column(String(8))
    shares: Mapped[float | None] = mapped_column(Numeric(14, 4))
    price: Mapped[float | None] = mapped_column(Numeric(14, 4))
    order_type: Mapped[str | None] = mapped_column(String(16))
    message: Mapped[str] = mapped_column(String(256))
    at: Mapped[datetime | None] = mapped_column()               # when the event occurred (UTC)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    # Deterministic identity for idempotent logging (insert-or-ignore on every
    # resync) so a fill is recorded exactly once regardless of timing/retries.
    fill_key: Mapped[str | None] = mapped_column(String(160), unique=True)
