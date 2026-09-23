import { usd, pct } from "./format";
import { moneyColor } from "./LedgerUI";
import { dayPct } from "./rowDerived";
import type { Dashboard, DashboardRow } from "./types";

// Bottom "at a glance" strip beneath the dashboard table: three cards, each a RANKING or
// EXTREME derived from the rows — insights you can't read off the account band's totals or
// by scanning the table. Momentum (today's movers), risk (concentration), and position
// health (how many holdings are green). Every color is a theme token so themes recolor it.

// One "TICK +$X · +Y%" mover line, colored by direction.
function MoverLine({ r }: { r: DashboardRow }) {
  const dc = r.day_change ?? 0;
  const dp = dayPct(r.day_change, r.current_value);   // this position's % move today
  return (
    <div style={S.moverLine}>
      <span aria-hidden="true" style={{ color: moneyColor(dc) }}>{dc >= 0 ? "▲" : "▼"}</span>
      <span style={S.moverSym}>{r.symbol}</span>
      <span style={{ ...S.moverVal, color: moneyColor(dc) }}>
        {dc >= 0 ? "+" : "−"}{usd(Math.abs(dc))}{dp != null ? ` · ${dc >= 0 ? "+" : "−"}${pct(Math.abs(dp))}` : ""}
      </span>
    </div>
  );
}

export function DashboardStrip({ data }: { data: Dashboard }) {
  const held = (data.rows ?? []).filter((r) => !r.is_watch);

  // --- Card 1: today's movers (best + worst by $ day change) ---
  const priced = held.filter((r) => r.day_change != null);
  let best: DashboardRow | null = null;
  let worst: DashboardRow | null = null;
  if (priced.length) {
    best = priced.reduce((m, r) => ((r.day_change as number) > (m.day_change as number) ? r : m));
    worst = priced.reduce((m, r) => ((r.day_change as number) < (m.day_change as number) ? r : m));
  }
  const showWorst = worst && best && worst.symbol !== best.symbol;

  // --- Card 2: concentration (largest position by cost; informational, no cap) ---
  const withPct = held.filter((r) => r.portfolio_pct != null);
  const largest = withPct.length
    ? withPct.reduce((m, r) => ((r.portfolio_pct as number) > (m.portfolio_pct as number) ? r : m))
    : null;

  // --- Card 3: open positions (how many are green right now + total open P/L) ---
  const withPL = held.filter((r) => r.unrealized != null);
  const inProfit = withPL.filter((r) => (r.unrealized as number) > 0).length;
  const totalOpen = data.total_unrealized ?? (withPL.length
    ? withPL.reduce((s, r) => s + (r.unrealized as number), 0)
    : null);
  const greenFrac = withPL.length ? inProfit / withPL.length : 0;

  return (
    <div style={S.grid}>
      {/* Today's movers */}
      <div style={S.card}>
        <div style={S.label}>Today's movers</div>
        {best ? (
          <div style={S.moverStack}>
            <MoverLine r={best} />
            {showWorst && worst ? <MoverLine r={worst} /> : null}
          </div>
        ) : (
          <div style={S.calm}>{held.length ? "No moves yet today" : "No holdings"}</div>
        )}
      </div>

      {/* Concentration */}
      <div style={S.card}>
        <div style={S.label}>Concentration</div>
        {largest ? (
          <>
            <div style={S.big}>
              {largest.symbol} <span style={S.bigTail}>{pct(largest.portfolio_pct as number)} of invested</span>
            </div>
            <div style={{ ...S.sub, color: "var(--text-dim)" }}>
              Your largest position by cost, across {withPct.length} holding{withPct.length === 1 ? "" : "s"}
            </div>
          </>
        ) : (
          <div style={S.calm}>No holdings</div>
        )}
      </div>

      {/* Open positions */}
      <div style={S.card}>
        <div style={S.label}>Open positions</div>
        {withPL.length ? (
          <>
            <div style={S.big}>
              {inProfit} of {withPL.length} <span style={S.bigTail}>in profit</span>
            </div>
            <div style={S.sub}>
              Total open P/L{" "}
              <span style={{ color: moneyColor(totalOpen), fontWeight: 600 }}>
                {totalOpen != null ? `${totalOpen >= 0 ? "+" : "−"}${usd(Math.abs(totalOpen))}` : "—"}
              </span>
            </div>
            <div style={S.track}>
              <div style={{ ...S.fill, width: `${Math.round(greenFrac * 100)}%`, background: "var(--pos)" }} />
            </div>
          </>
        ) : (
          <div style={S.calm}>No holdings</div>
        )}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 },
  card: {
    display: "flex", flexDirection: "column", gap: 6,
    background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)",
    padding: "14px 16px",
  },
  label: { fontSize: "var(--fs-2xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-faint)" },
  big: { fontSize: "var(--fs-xl)", fontWeight: 700, color: "var(--text)", fontVariantNumeric: "tabular-nums", lineHeight: 1.15 },
  bigTail: { fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--text-dim)" },
  sub: { fontSize: "var(--fs-sm)", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" },
  track: { height: 8, borderRadius: "var(--r-sm)", background: "var(--panel-2)", overflow: "hidden", width: "100%", marginTop: 2 },
  fill: { height: "100%", borderRadius: "var(--r-sm)" },
  calm: { fontSize: "var(--fs-md)", color: "var(--text-dim)" },
  // movers
  moverStack: { display: "flex", flexDirection: "column", gap: 4, marginTop: 2 },
  moverLine: { display: "flex", alignItems: "baseline", gap: 7, fontVariantNumeric: "tabular-nums" },
  moverSym: { fontSize: "var(--fs-lg)", fontWeight: 700, color: "var(--text)" },
  moverVal: { fontSize: "var(--fs-md)", fontWeight: 600, whiteSpace: "nowrap" },
};
