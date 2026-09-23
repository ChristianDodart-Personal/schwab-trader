import type { DashboardRow } from "./types";

// Pure derivations off a DashboardRow (and a couple of value helpers), in one place so the
// dashboard table, the account band, the at-a-glance strip, the Top-10 view, and the signal
// rules all read the same math instead of each re-deriving it (and drifting). Money-COLOR
// stays in moneyColor (LedgerUI); this module is the value math.

// Gain on the last position as a percent of its cost basis. Null unless there's a profit
// figure AND a positive cost (a zero/negative cost can't yield a meaningful percent). This
// is the canonical guard — it also drives the sell-side signal metric, so it stays strict.
export function lastPosGainPct(r: DashboardRow): number | null {
  return r.last_pos_profit != null && r.last_pos_cost && r.last_pos_cost > 0
    ? (r.last_pos_profit / r.last_pos_cost) * 100
    : null;
}

// Today's move as a fraction of the START-of-day value: change / (value − change). Applies
// to the whole account (account value) or a single position (its market value). Null unless
// both are known and the start value is positive. Consume with pct() for display.
export function dayPct(change: number | null | undefined, value: number | null | undefined): number | null {
  if (change == null || value == null) return null;
  const start = value - change;
  return start > 0 ? change / start : null;
}
