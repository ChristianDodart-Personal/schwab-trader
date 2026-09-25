import { useEffect, useRef, useState } from "react";
import { usd, pct } from "./format";
import type { DashboardRow, Lot } from "./types";
import { matchesRule, type SignalRule } from "./signals";
import { moneyColor } from "./LedgerUI";

import { API } from "./api";
import { IconWarning } from "./Icon";
import { bounceLine, chopLine, decayLine, dipLine, whyLine, needsIcon, STATUS_TEXT, TONE_COLOR, type ReadLine } from "./ladderRead";
import { Tip } from "./Tip";

// ============================================================================
// Customizable columns. Each view (dashboard, ticker drill-down) has its own
// registry of available columns and its own saved layout (order + which are
// shown). The "available" list is sourced straight from these registries — i.e.
// the values we actually have. Layouts persist in localStorage.
// ============================================================================

export type ColAlign = "left" | "right";

// Provenance: "schwab" = a raw number straight from Schwab's API (price, day P/L, held
// shares, 52wk hi/lo); "text" = a non-numeric/config field (sector, dates, mode).
// Undefined = APP-CALCULATED — we derived it, even if from Schwab inputs. Computed
// columns get a dotted-underline header + tooltip so it's clear what's ours vs Schwab's.
export type Provenance = "schwab" | "text";
export type DashCol = {
  id: string;
  label: string;
  align: ColAlign;
  prov?: Provenance;
  term?: string;                           // glossary id — header becomes a hoverable <Term>
  watchNA?: boolean;                       // render "—" on watch rows (no position)
  group?: string;                          // picker section (e.g. "Ladder read"); ungrouped = main list
  render: (r: DashboardRow) => React.ReactNode;
};
export type DetailCol = {
  id: string;
  label: string;
  align: ColAlign;
  prov?: Provenance;
  term?: string;                           // glossary id — header becomes a hoverable <Term>
  render: (l: Lot) => React.ReactNode;
};

// Provenance ("is this from Schwab or computed?") now lives in each glossary term's
// "Source" line — the old superscript ƒ mark + its legend were retired in v0.59 in
// favor of hover-to-define terms.

// Colored money/percent with a redundant +/- sign so gain vs loss reads without relying on
// color alone (colorblind-safe). `v` is the pre-formatted string (usd/pct already render "-"
// for negatives); we prepend "+" for positives. Color comes from moneyColor — the one
// money→color function (positive green, negative red, exactly zero neutral).
const Colored = ({ v, n }: { v: string; n: number | null | undefined }) => {
  if (n == null) return <Dash />;
  return <span style={{ color: moneyColor(n) }}>{n > 0 ? "+" : ""}{v}</span>;
};
const num = (n: number | null | undefined) =>
  n == null ? "" : n.toLocaleString("en-US");
// Empty values render empty (no "—" placeholder).
const Dash = () => null;
// Null-safe money/percent for dashboard cells: empty instead of the global "—".
const usd0 = (n: number | null | undefined) => (n == null ? null : usd(n));
const pct0 = (n: number | null | undefined) => (n == null ? null : pct(n));
// Compact market-cap: $1.23T / $45.6B / $780M.
const capFmt = (n: number | null | undefined) =>
  n == null ? null
    : n >= 1e12 ? `$${(n / 1e12).toFixed(2)}T`
    : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B`
    : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M`
    : usd(n);

// A faint "13w" tag on the avg/median/high/low cells of a leveraged/inverse ETF — those
// use a 13-week window instead of 52 (daily-rebalancing decay makes a full year stale),
// so the figure is never silently mislabeled against a "52wk" header. Absent (52wk) rows
// show nothing.
const WinTag = ({ r }: { r: DashboardRow }) =>
  r.ref_window_weeks === 13 ? (
    <span style={{ color: "var(--text-faint)", fontSize: "var(--fs-2xs)", marginLeft: 4 }}
      title="Leveraged/inverse ETF — a 13-week (one-quarter) window; a full-year figure is skewed by daily-rebalancing decay">13w</span>
  ) : null;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
// A compact 52-week range bar: a clear accent fill from the year low up to where the
// live price sits, capped by a bright price marker — so "how high in the 52-week range"
// reads at a glance (a near-full bar = near the high). The median stays in the hover
// title as a spike-robust "typical" reference, off the bar so it can't be mistaken for
// the price. Null when we lack the endpoints (no history) or the range is degenerate.
const RangeBar = ({ r }: { r: DashboardRow }) => {
  const low = r.year_low, high = r.year_high, price = r.price, med = r.median_52wk;
  if (low == null || high == null || price == null || high <= low) return null;
  const pos = clamp01((price - low) / (high - low));
  const title = `low ${usd(low)} · ${med != null ? `med ${usd(med)} · ` : ""}high ${usd(high)} — ${Math.round(pos * 100)}% up the range`;
  return (
    <>
      <span style={{ display: "inline-block", width: 120, verticalAlign: "middle" }} title={title}>
        {/* track (the full year low→high span) */}
        <span style={{ position: "relative", display: "block", width: "100%", height: 6, marginTop: 3,
          borderRadius: "var(--r-sm)", background: "var(--panel-2)" }}>
          {/* fill: year low → current price (clearly visible so the position is unmistakable) */}
          <span style={{ position: "absolute", left: 0, top: 0, height: 6, width: `${pos * 100}%`,
            borderRadius: "var(--r-sm)", background: "color-mix(in srgb, var(--accent) 55%, transparent)" }} />
          {/* current-price marker at the fill's leading edge — bordered so it reads on the track */}
          <span aria-hidden="true" style={{ position: "absolute", left: `${pos * 100}%`, top: "50%",
            width: 10, height: 10, marginLeft: -5, marginTop: -5, borderRadius: "var(--r-pill)",
            background: "var(--text)", border: "2px solid var(--panel)", boxSizing: "border-box" }} />
        </span>
        {/* low / high endpoints, tiny + subtle */}
        <span style={{ display: "flex", justifyContent: "space-between", marginTop: 1,
          fontSize: "var(--fs-2xs)", color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
          <span>{`$${Math.round(low)}`}</span>
          <span>{`$${Math.round(high)}`}</span>
        </span>
      </span>
      <WinTag r={r} />
    </>
  );
};

// Multi-horizon trend: one ▲/▼ cell per horizon (1M, 3M, 6M, 12M; blank when history is
// too short) plus the net score. Reference only; no signal or order reads it.
const TREND_KEYS = ["1M", "3M", "6M", "12M"] as const;
const Trend = ({ r }: { r: DashboardRow }) => {
  if (r.trend_score == null || !r.trend) return <Dash />;
  const t = r.trend;
  const tip = TREND_KEYS.map((k) => `${k} ${t[k] == null ? "n/a" : pct(t[k])}`).join(" · ");
  const net = r.trend_score;
  return (
    <span title={tip} aria-label={`Trend ${net > 0 ? "+" : ""}${net} of ${r.trend_n}: ${tip}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      <span aria-hidden="true" style={{ display: "inline-flex", gap: 2 }}>
        {TREND_KEYS.map((k) => {
          const v = t[k];
          const color = v == null ? "var(--text-faint)" : v > 0 ? "var(--pos)" : v < 0 ? "var(--neg)" : "var(--text-dim)";
          return <span key={k} style={{ color, fontSize: "var(--fs-2xs)", width: 9, textAlign: "center" }}>
            {v == null ? "·" : v > 0 ? "▲" : v < 0 ? "▼" : "–"}</span>;
        })}
      </span>
      <b style={{ color: net > 0 ? "var(--pos)" : net < 0 ? "var(--neg)" : "var(--text-dim)", minWidth: 18, textAlign: "right" }}>
        {net > 0 ? `+${net}` : net}
      </b>
    </span>
  );
};

// Ladder-read cells: the short chip (colored by tone, with a warning glyph when it's a
// caution so it never rests on color alone) and the full sentence in a hover tip. While
// the 5-year history loads: a faint "…"; if the fetch failed: a faint "n/a".
const ReadCell = ({ r, line, chip, sub }: { r: DashboardRow; line: ReadLine | null; chip?: string; sub?: string }) => {
  if (!r.ladder) {
    if (r.ladder_status === "unavailable")
      return <Tip text={STATUS_TEXT.unavailable} focusable={false}><span style={{ color: "var(--text-faint)" }}>n/a</span></Tip>;
    if (r.ladder_status === "short")
      return <Tip text={STATUS_TEXT.short} focusable={false}><span style={{ color: "var(--text-faint)" }}>new</span></Tip>;
    if (r.ladder_status === "loading")
      return <Tip text={STATUS_TEXT.loading} focusable={false}><span style={{ color: "var(--text-faint)" }}>…</span></Tip>;
    return <Dash />;
  }
  if (line == null) return <Dash />;
  return (
    <Tip text={`${line.title}. ${line.detail}`} focusable={false} style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: TONE_COLOR[line.tone], fontWeight: line.tone === "neutral" ? 500 : 600, display: "inline-flex", alignItems: "center", gap: 3 }}>
        {needsIcon(line.tone) && <IconWarning size={11} />}{chip ?? line.chip}
      </span>
      {sub && <span style={{ color: "var(--text-faint)", fontSize: "var(--fs-2xs)", marginLeft: 6 }}>{sub}</span>}
    </Tip>
  );
};
const BounceCell = ({ r }: { r: DashboardRow }) => {
  const line = r.ladder ? bounceLine(r.ladder) : null;
  const b = r.ladder?.bounce;
  const sub = b && b.rate != null
    ? `${b.recovered}/${b.dips}${b.worst_rung && b.worst_rung > 2 ? ` · worst rung ${b.worst_rung}` : ""}`
    : undefined;
  return <ReadCell r={r} line={line} chip={b?.rate != null ? `${Math.round(b.rate * 100)}%` : undefined} sub={sub} />;
};
const DipCell = ({ r }: { r: DashboardRow }) => {
  const line = r.ladder ? dipLine(r.ladder) : null;
  const d = r.ladder?.dip;
  const sub = line && d && d.norm != null && d.norm <= -0.25 ? `${Math.abs(d.norm).toFixed(1)}× · ${d.days}d` : undefined;
  return <ReadCell r={r} line={line} sub={sub} />;
};

// This position's share of your invested cost (cash excluded). Informational only:
// the old 5% single-stock cap was removed (it only mattered for very large accounts).
const PortfolioPct = ({ r }: { r: DashboardRow }) =>
  r.portfolio_pct == null ? <Dash /> : <span>{pct(r.portfolio_pct)}</span>;
// BUY/SELL signal chip — the ▲/▼ glyph keeps it separable in grayscale.
const Chip = ({ children, kind }: { children: React.ReactNode; kind: "buy" | "sell" }) => (
  <span className={`chip chip-${kind}`} style={{ marginLeft: 4 }}>
    <span aria-hidden="true">{kind === "buy" ? "▲" : "▼"}</span>{children}
  </span>
);

// Ticker color by risk band (blue = safer → red = riskier). Neutral (undefined) for
// medium/unknown so the symbol reads normally. Shared by the dashboard and the detail view.
export function tickerRiskColor(risk: string | null | undefined): string | undefined {
  switch (risk) {
    case "low": return "var(--accent-quiet)"; // muted blue — safer (broad ETF / large cap)
    case "elevated": return "var(--warn)";     // amber — small cap
    case "high": return "var(--neg)";          // red — leveraged/inverse or micro cap
    default: return undefined;                  // medium/unknown → normal text
  }
}
export const RISK_LABEL: Record<string, string> = {
  low: "Lower risk (broad fund / large cap)", medium: "Mid cap / unclassified",
  elevated: "Small cap — higher risk", high: "Leveraged/inverse or micro cap — highest risk",
};

// A custom-rule chip in the rule's own color (▲ buy / ▼ sell for grayscale separability).
const CustomChip = ({ rule }: { rule: SignalRule }) => (
  <span className="chip" style={{ marginLeft: 4, background: rule.color, color: "#0b0e13", fontWeight: 700 }}
    title={`Your ${rule.side} rule matched`}>
    <span aria-hidden="true">{rule.side === "buy" ? "▲" : "▼"}</span>{rule.label || rule.side.toUpperCase()}
  </span>
);

// The BUY/SELL chips for a row: the built-in strategy marks (default rule, red/green) PLUS
// any user signal rules that match (each in its own color). Rendered at the ticker cell.
export function rowSignalChips(r: DashboardRow, rules: SignalRule[] = []): React.ReactNode {
  if (r.is_watch) return null;
  const matched = rules.filter((rule) => matchesRule(rule, r));
  if (!r.buy_mark && !r.sell_mark && matched.length === 0 && !r.cost_unknown) return null;
  return (
    <>
      {r.cost_unknown && (
        <span className="chip" style={{ marginLeft: 4, color: "var(--warn)", border: "1px solid var(--warn-border)", background: "var(--warn-bg)" }}
          title="Part of this position has no known cost (usually a backfilled lot Schwab gave no average for). Those shares are left out of cost, P/L and signals. Import a Schwab transactions CSV covering the buy, or review it by hand.">
          <IconWarning size={11} /> review
        </span>
      )}
      {r.buy_mark && <Chip kind="buy">BUY</Chip>}
      {r.sell_mark && <Chip kind="sell">SELL</Chip>}
      {matched.map((rule) => <CustomChip key={rule.id} rule={rule} />)}
    </>
  );
}

// ---- dashboard columns (operate on a summary row) ----
// Order here = the order columns are offered in the "add" dropdown.
export const DASH_COLUMN_LIST: DashCol[] = [
  // The two most ACTIONABLE numbers — current price + profit on the last position.
  // Now ordinary registry columns (movable/foldable); only Ticker is mandatory. They
  // lead the default layout, so the resting table looks exactly as before.
  { id: "price", label: "Price", align: "left", prov: "schwab", render: (r) => {
      // A faint "sold $X" trailing the live price: for watch rows it's the price you
      // sold out at (watching for re-entry); for held rows it's your most recent trim.
      const soldAt = r.is_watch ? r.last_held : r.last_sold;
      const soldTip = r.is_watch
        ? "The price you last sold this at — watching for a re-entry below it"
        : "The price you last sold a lot of this at — your most recent trim";
      return soldAt != null
        ? <span style={{ whiteSpace: "nowrap" }}><b>{usd0(r.price)}</b>
            <span style={{ color: "var(--text-faint)", fontSize: "var(--fs-2xs)", marginLeft: 6 }}
              title={soldTip}>sold {usd(soldAt)}</span>
          </span>
        : <b>{usd0(r.price)}</b>;
    } },
  { id: "last_pos_profit", label: "Last Pos P/L", align: "left", term: "last_position", watchNA: true, render: (r) => <b><Colored v={usd(r.last_pos_profit)} n={r.last_pos_profit} /></b> },
  // Mean of the daily closes over the past year — "where the stock spends most of
  // its time." Compare against the pinned Price: below = historical discount
  // (lean buy), above = rich (lean sell). Dim vs. the price so it reads as a
  // reference line, not a live number.
  { id: "avg_52wk", label: "52wk Avg", align: "right", render: (r) => <span style={{ color: "var(--text-muted)" }}>{usd0(r.avg_52wk)}<WinTag r={r} /></span> },
  // Median daily close over the past year — the middle price, unmoved by outlier
  // spikes (often the truer "typical" level for a choppy name). Same dim reference
  // treatment as the average.
  { id: "median_52wk", label: "52wk Med", align: "right", render: (r) => <span style={{ color: "var(--text-muted)" }}>{usd0(r.median_52wk)}<WinTag r={r} /></span> },
  { id: "pct_of_high", label: "% of 52wk High", align: "right", term: "52wk_high_pct", render: (r) => r.pct_of_high == null ? null : <span>{pct0(r.pct_of_high)}<WinTag r={r} /></span> },
  { id: "pct_of_low", label: "% above 52wk Low", align: "right", term: "52wk_low_pct", render: (r) => r.pct_of_low == null ? null : <span>{pct0(r.pct_of_low)}<WinTag r={r} /></span> },
  // Where today's price sits across the past year at a glance: a mini bar with the low
  // and high as endpoints, a median tick, and a price dot. Combines pct_of_high/low +
  // median into one scannable visual.
  { id: "range", label: "52-week range", align: "left", term: "52wk_low_pct", render: (r) => <RangeBar r={r} /> },
  { id: "trend_score", label: "Trend", align: "left", term: "trend_score", render: (r) => <Trend r={r} /> },
  // Ladder read: the id is the flat sortable field (DashboardTable sorts by row[id]; the
  // first click is descending, and each field is oriented so that puts the most
  // ladder-relevant rows first).
  { id: "bounce_rate", label: "Bounce rate", align: "left", term: "bounce_rate", group: "Ladder read", render: (r) => <BounceCell r={r} /> },
  { id: "chop_score", label: "Chop", align: "left", term: "chop", group: "Ladder read", render: (r) => <ReadCell r={r} line={r.ladder ? chopLine(r.ladder) : null} /> },
  { id: "dip_depth", label: "Dip size", align: "left", term: "dip_size", group: "Ladder read", render: (r) => <DipCell r={r} /> },
  { id: "why_market_share", label: "Why down", align: "left", term: "why_down", group: "Ladder read", render: (r) => <ReadCell r={r} line={r.ladder ? whyLine(r.ladder) : null} /> },
  { id: "decay_month", label: "Decay", align: "left", term: "rebalance_decay", group: "Ladder read", render: (r) => <ReadCell r={r} line={r.ladder ? decayLine(r.ladder) : null} /> },
  { id: "lilo_pct", label: "LILO %", align: "right", term: "lilo_pct", watchNA: true, render: (r) => <Colored v={pct(r.lilo_pct)} n={r.lilo_pct} /> },
  { id: "last_pos_cost", label: "Last Pos Cost", align: "right", term: "cost_basis", watchNA: true, render: (r) => usd(r.last_pos_cost) },
  { id: "invested", label: "Invested", align: "right", term: "invested", watchNA: true, render: (r) => usd(r.invested) },
  { id: "year_profit", label: "Profit (YTD)", align: "right", term: "realized_pl", watchNA: true, render: (r) => <Colored v={usd(r.year_profit)} n={r.year_profit} /> },
  { id: "avg_monthly", label: "Avg Monthly", align: "right", term: "avg_monthly", watchNA: true, render: (r) => <Colored v={usd(r.avg_monthly)} n={r.avg_monthly} /> },
  { id: "year_trades", label: "Trades (YTD)", align: "right", watchNA: true, render: (r) => num(r.year_trades) },
  { id: "portfolio_pct", label: "Portfolio %", align: "right", term: "portfolio_pct", watchNA: true, render: (r) => <PortfolioPct r={r} /> },
  { id: "sector", label: "Sector", align: "left", prov: "text", render: (r) => r.sector ? <span style={{ color: "var(--text-muted)" }}>{r.sector}</span> : <Dash /> },
  { id: "market_cap", label: "Market Cap", align: "right", render: (r) => <span style={{ color: "var(--text-muted)" }}>{capFmt(r.market_cap)}</span> },
  // additional available columns (not in the default layout)
  { id: "positions", label: "Positions", align: "right", watchNA: true, render: (r) => num(r.positions) },
  { id: "shares", label: "Shares", align: "right", prov: "schwab", watchNA: true, render: (r) => num(r.shares) },
  { id: "current_value", label: "Market Value", align: "right", term: "market_value", watchNA: true, render: (r) => usd(r.current_value) },
  { id: "unrealized", label: "Unrealized P/L", align: "right", term: "unrealized_pl", watchNA: true, render: (r) => <Colored v={usd(r.unrealized)} n={r.unrealized} /> },
  { id: "day_change", label: "Day P/L", align: "right", prov: "schwab", term: "position_day_change", watchNA: true, render: (r) => <Colored v={usd(r.day_change)} n={r.day_change} /> },
  { id: "basis_per_share", label: "Basis / Share", align: "right", term: "cost_basis", watchNA: true, render: (r) => usd(r.basis_per_share) },
  { id: "log_profit", label: "Profit (all-time)", align: "right", term: "realized_pl", watchNA: true, render: (r) => <Colored v={usd(r.log_profit)} n={r.log_profit} /> },
  { id: "dividends", label: "Dividends", align: "right", watchNA: true, render: (r) => (r.dividends ? <span style={{ color: "var(--pos)" }}>{usd(r.dividends)}</span> : <Dash />) },
  { id: "total_return", label: "Total Return", align: "right", watchNA: true, render: (r) => <Colored v={usd(r.total_return)} n={r.total_return} /> },
  { id: "trades", label: "Trades (all-time)", align: "right", watchNA: true, render: (r) => num(r.trades) },
  { id: "next_buy_price", label: "Next Buy Trigger", align: "right", term: "buy_dip", watchNA: true, render: (r) => usd(r.next_buy_price) },
  { id: "year_high", label: "52wk High", align: "right", prov: "schwab", render: (r) => r.year_high == null ? null : <span>{usd0(r.year_high)}<WinTag r={r} /></span> },
  { id: "year_low", label: "52wk Low", align: "right", prov: "schwab", render: (r) => r.year_low == null ? null : <span>{usd0(r.year_low)}<WinTag r={r} /></span> },
];
export const DASH_COLUMNS: Record<string, DashCol> = Object.fromEntries(
  DASH_COLUMN_LIST.map((c) => [c.id, c]),
);
// The only mandatory column is Ticker (rendered by the table itself, not in this
// registry). Every column below — including Price and Last Pos P/L — is movable,
// removable, and foldable.
//
// Default layout (order + which columns show). Ticker renders first; these follow.
export const DEFAULT_DASH_COLS = [
  "price", "last_pos_profit", "lilo_pct", "range",             // shown by default
  "current_value", "unrealized", "day_change", "invested",     // folded by default (below)
  "basis_per_share", "portfolio_pct", "avg_52wk",
  "last_pos_cost", "year_profit", "avg_monthly", "year_trades",
];
// Which of the default columns start FOLDED (behind the chevron). Everything after the
// first four essentials. The user can change this per-column in the Columns manager.
export const DEFAULT_DASH_FOLDED = [
  "current_value", "unrealized", "day_change", "invested",
  "basis_per_share", "portfolio_pct", "avg_52wk",
  "last_pos_cost", "year_profit", "avg_monthly", "year_trades",
];
// Simple view: holdings-only, a compact fixed set (no folding, no ƒ marks).
export const SIMPLE_DASH_COLS = ["price", "unrealized", "current_value"];

// ---- ticker drill-down columns (operate on a lot) ----
export const DETAIL_COLUMN_LIST: DetailCol[] = [
  { id: "buy_date", label: "Buy Date", align: "left", prov: "text", render: (l) => l.buy_date ?? "—" },
  { id: "age_days", label: "Age", align: "right", term: "lot_age", render: (l) => (l.age_days == null ? "—" : `${l.age_days}d`) },
  { id: "shares", label: "Shares", align: "right", render: (l) => num(l.shares) },
  { id: "buy_price", label: "Buy", align: "right", render: (l) => usd(l.buy_price) },
  { id: "amount", label: "Amount", align: "right", render: (l) => usd(l.amount) },
  { id: "pct_down_from_prev", label: "% Down", align: "right", term: "ladder_rung", render: (l) => {
      // "% Down" is the dip depth vs the previous rung. A rung bought at/above the prior
      // isn't a dip (e.g. averaging up, or an old cheap "prior" backfill lot below a
      // recent buy) — showing a huge negative "down" reads as broken, so show "—".
      const v = l.pct_down_from_prev;
      if (v == null || v <= 0)
        return <span title={v != null ? "Added at or above the previous position — not a dip down" : undefined}
          style={{ color: "var(--text-faint)" }}>—</span>;
      return pct(v);
    } },
  { id: "sell_target", label: "Sell Target", align: "right", term: "sell_target", render: (l) => usd(l.sell_target) },
  { id: "sell_mode", label: "Sell Mode", align: "left", prov: "text", render: (l) => l.sell_mode },
  { id: "proj_profit", label: "Proj. Profit", align: "right", render: (l) => <Colored v={usd(l.proj_profit)} n={l.proj_profit} /> },
  { id: "pl_now", label: "P/L Now", align: "right", term: "unrealized_pl", render: (l) => <Colored v={usd(l.pl_now)} n={l.pl_now} /> },
  { id: "next_buy_sug", label: "Next Buy Sug", align: "right", term: "buy_dip", render: (l) => <span style={{ color: "var(--accent-quiet)" }}>{usd(l.next_buy_sug)}</span> },
];
export const DETAIL_COLUMNS: Record<string, DetailCol> = Object.fromEntries(
  DETAIL_COLUMN_LIST.map((c) => [c.id, c]),
);
// Default drill-down layout (rung is pinned first, the Sell action is pinned last).
export const DEFAULT_DETAIL_COLS = [
  "buy_date", "age_days", "shares", "buy_price", "amount", "pct_down_from_prev",
  "sell_target", "proj_profit", "pl_now", "next_buy_sug",
];

// Keep only known column ids, de-duped (order preserved). An explicitly-empty array is
// honored (user removed all columns); null = no/corrupt save → caller falls back to defaults.
export function sanitizeColumnIds(arr: unknown, valid: Set<string> | string[]): string[] | null {
  const validSet = valid instanceof Set ? valid : new Set(valid);
  if (!Array.isArray(arr)) return null;
  const seen = new Set<string>();
  const kept = arr.filter(
    (id): id is string => typeof id === "string" && validSet.has(id) && !seen.has(id) && (seen.add(id), true),
  );
  return kept.length || arr.length === 0 ? kept : null;
}

// ---- the persisted-layout hook ----
export type ColumnPrefs = {
  ids: string[];
  add: (id: string) => void;
  remove: (id: string) => void;
  move: (id: string, dir: -1 | 1) => void;
  reorder: (id: string, toIndex: number) => void;
  reset: () => void;
  available: { id: string; label: string; group?: string }[];
};

export function useColumnPrefs(
  storageKey: string,
  defaultIds: string[],
  registryList: { id: string; label: string }[],
  migrate?: (ids: string[]) => string[], // one-time fixups to a loaded layout (e.g. adopt new registry columns)
): ColumnPrefs {
  const valid = new Set(registryList.map((c) => c.id));
  const load = (arr: unknown): string[] | null => {
    const s = sanitizeColumnIds(arr, valid);
    return s && migrate ? migrate(s) : s;
  };
  const sanitize = load;

  const [ids, setIds] = useState<string[]>(() => {
    try {
      const local = load(JSON.parse(localStorage.getItem(storageKey) || "null"));
      if (local) return local;
    } catch {
      /* ignore corrupt prefs */
    }
    return defaultIds;
  });
  const idsRef = useRef(ids);
  idsRef.current = ids;          // always-current snapshot for the mutators
  const dirty = useRef(false);   // has the user edited this session?

  const persist = (next: string[]) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* storage full / disabled */
    }
    fetch(`${API}/prefs/${storageKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: next }),
    }).catch(() => {});
  };

  // Every user edit persists immediately (no save-effect race) and flips `dirty`.
  const update = (fn: (prev: string[]) => string[]) => {
    const next = fn(idsRef.current);
    dirty.current = true;
    idsRef.current = next;
    setIds(next);
    persist(next);
  };

  // The DB is the source of truth across sessions/browsers (localStorage gave the
  // instant first paint). Adopt the DB layout ONLY if the user hasn't already
  // edited this session — otherwise an in-flight load would clobber a fresh edit.
  useEffect(() => {
    let alive = true;
    fetch(`${API}/prefs/${storageKey}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive || dirty.current) return;
        const remote = sanitize(d?.value);
        if (remote) {
          idsRef.current = remote;
          setIds(remote);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [storageKey]);

  const add = (id: string) => update((p) => (p.includes(id) || !valid.has(id) ? p : [...p, id]));
  const remove = (id: string) => update((p) => p.filter((x) => x !== id));
  const move = (id: string, dir: -1 | 1) =>
    update((p) => {
      const i = p.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const reorder = (id: string, toIndex: number) =>
    update((p) => {
      const from = p.indexOf(id);
      if (from < 0) return p;
      const next = [...p];
      next.splice(from, 1);
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, id);
      return next;
    });
  const reset = () => update(() => defaultIds);
  const order = new Map(registryList.map((c, i) => [c.id, i]));
  const available = registryList
    .filter((c) => !ids.includes(c.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return { ids, add, remove, move, reorder, reset, available };
}

// ---- fold membership: which columns hide behind the table's chevron ----
// A separate persisted set (localStorage + DB, same pattern as useColumnPrefs), so the
// column ORDER and its FOLD state are independent. Stale ids (a removed column) are
// harmless — the table only folds columns that are actually shown.
export type FoldPrefs = {
  folded: Set<string>;
  isFolded: (id: string) => boolean;
  toggle: (id: string) => void;
  reset: () => void;
};

export function useFoldPrefs(storageKey: string, defaultFolded: string[]): FoldPrefs {
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
    } catch { /* ignore corrupt prefs */ }
    return defaultFolded;
  });
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const dirty = useRef(false);

  const persist = (next: string[]) => {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* storage disabled */ }
    fetch(`${API}/prefs/${storageKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: next }),
    }).catch(() => {});
  };
  const update = (fn: (prev: string[]) => string[]) => {
    const next = fn(idsRef.current);
    dirty.current = true; idsRef.current = next; setIds(next); persist(next);
  };

  useEffect(() => {
    let alive = true;
    fetch(`${API}/prefs/${storageKey}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive || dirty.current) return;
        if (Array.isArray(d?.value)) {
          const v = d.value.filter((x: unknown): x is string => typeof x === "string");
          idsRef.current = v; setIds(v);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [storageKey]);

  const folded = new Set(ids);
  return {
    folded,
    isFolded: (id) => folded.has(id),
    toggle: (id) => update((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
    reset: () => update(() => defaultFolded),
  };
}
