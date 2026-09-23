import { useEffect, useState } from "react";
import { usd, pct } from "./format";
import { API } from "./api";
import { IconWarning } from "./Icon";

// ============================================================================
// Method tab — read-only risk lenses over your ladder method and current book.
// ADVISORY ONLY: nothing here places orders or says what to buy/sell. It makes the
// tail the ladder walks into visible (true single-name exposure, downside stress,
// names that have fallen past the plan, and whether the fixed $ tiers fit your edge).
// ============================================================================

type ConcRow = { key: string; symbols: string[]; value: number; pct: number };
type Scenario = { drop: number; value: number; unrealized: number };
type StressPos = { symbol: string; lots_deep: number; over_depth: boolean; invested: number; value_now: number; unrealized_now: number; scenarios: Scenario[] };
type Break = { symbol: string; lots_deep: number; reasons: { code: string; text: string; value: number }[] };
type Kelly = { enough: boolean; trades: number; min_trades?: number; win_rate?: number; payoff_ratio?: number; kelly_fraction?: number; half_kelly_fraction?: number; kelly_dollars?: number; half_kelly_dollars?: number; current_tiers?: number[]; account_value?: number };
type Analysis = {
  as_of: string; held_count: number;
  concentration: { rows: ConcRow[] };
  stress: { drops: number[]; positions: StressPos[]; portfolio: { invested: number; value_now: number; scenarios: Scenario[] } };
  thesis_breaks: Break[];
  kelly: Kelly;
};

const S: Record<string, React.CSSProperties> = {
  wrap: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, alignItems: "start" },
  card: { background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px" },
  h: { margin: "0 0 4px", fontSize: "var(--fs-md)", fontWeight: 700 },
  sub: { margin: "0 0 12px", color: "var(--text-dim)", fontSize: "var(--fs-sm)" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "var(--fs-sm)" },
  th: { textAlign: "right", padding: "4px 8px", color: "var(--text-dim)", fontWeight: 600, borderBottom: "1px solid var(--border)" },
  thL: { textAlign: "left", padding: "4px 8px", color: "var(--text-dim)", fontWeight: 600, borderBottom: "1px solid var(--border)" },
  td: { textAlign: "right", padding: "4px 8px", borderBottom: "1px solid var(--border-faint)" },
  tdL: { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border-faint)" },
  badge: { fontSize: "var(--fs-2xs)", padding: "1px 6px", borderRadius: 6, marginLeft: 6, background: "var(--warn-bg)", color: "var(--warn)" },
  note: { color: "var(--text-faint)", fontSize: "var(--fs-2xs)", marginTop: 10 },
};

const neg = (n: number): React.CSSProperties => ({ color: n < 0 ? "var(--neg)" : n > 0 ? "var(--pos)" : "var(--text-dim)" });
const dropLabel = (d: number) => `−${Math.round(d * 100)}%`;

// ---- Ladder backtest -------------------------------------------------------
type BT = {
  ok: boolean; reason?: string; symbol?: string; range?: string; bars?: number;
  start_cash?: number; ending_equity?: number; total_return?: number;
  buy_hold_equity?: number; buy_hold_return?: number; realized?: number; open_unrealized?: number;
  round_trips?: number; win_rate?: number | null; max_lots_deep?: number; max_deployed?: number;
  max_drawdown?: number; open_lots?: number;
  curve?: { t: string | number; equity: number; hold: number | null }[];
};

function Curve({ pts }: { pts: NonNullable<BT["curve"]> }) {
  const W = 640, H = 120, pad = 4;
  const eq = pts.map((p) => p.equity);
  const hold = pts.map((p) => p.hold).filter((h): h is number => h != null);
  const lo = Math.min(...eq, ...hold), hi = Math.max(...eq, ...hold);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (pts.length - 1 || 1)) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
  const poly = (sel: (p: NonNullable<BT["curve"]>[number]) => number | null) =>
    pts.map((p, i) => { const v = sel(p); return v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`; })
      .filter(Boolean).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 120, display: "block" }} preserveAspectRatio="none" role="img" aria-label="Equity curve: strategy vs buy and hold">
      <polyline points={poly((p) => p.hold)} fill="none" stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      <polyline points={poly((p) => p.equity)} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function BacktestCard({ initialSymbol }: { initialSymbol?: string }) {
  const [symbol, setSymbol] = useState(initialSymbol ?? "");
  useEffect(() => { if (initialSymbol) setSymbol(initialSymbol); }, [initialSymbol]);
  const [cash, setCash] = useState(5000);
  const [rng, setRng] = useState("1Y");
  const [res, setRes] = useState<BT | null>(null);
  const [loading, setLoading] = useState(false);

  const run = () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setLoading(true); setRes(null);
    fetch(`${API}/backtest?symbol=${encodeURIComponent(sym)}&cash=${cash}&range_key=${rng}`)
      .then((r) => r.json()).then((j) => setRes(j as BT))
      .catch(() => setRes({ ok: false, reason: "Request failed." }))
      .finally(() => setLoading(false));
  };

  const beat = res?.ok && (res.ending_equity ?? 0) >= (res.buy_hold_equity ?? 0);
  return (
    <section style={{ ...S.card, gridColumn: "1 / -1" }}>
      <h3 style={S.h}>Ladder backtest</h3>
      <p style={S.sub}>
        Replays your exact ladder rules against a symbol's daily history with a bankroll allocated to that one
        name, vs putting the same money all-in and holding. Fills at the close; no fees/slippage/dividends — a
        clean read on the mechanics, not a promise. Deep dips beyond your cash are skipped (the reserve running dry).
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Symbol"
          onKeyDown={(e) => e.key === "Enter" && run()} style={{ width: 110, textTransform: "uppercase" }} aria-label="Symbol" />
        <select value={rng} onChange={(e) => setRng(e.target.value)} aria-label="History window">
          <option value="1Y">1 year</option>
          <option value="5Y">5 years</option>
        </select>
        <label style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>
          Bankroll $<input type="number" value={cash} min={500} step={500}
            onChange={(e) => setCash(Math.max(500, Number(e.target.value) || 0))}
            style={{ width: 90, marginLeft: 4 }} aria-label="Bankroll dollars" />
        </label>
        <button className="btn btn-buy" disabled={loading || !symbol.trim()} onClick={run}>{loading ? "Running…" : "Run"}</button>
      </div>
      {res && !res.ok && <p style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)", margin: 0 }}>{res.reason}</p>}
      {res && res.ok && (
        <>
          <table style={S.table}>
            <tbody>
              <tr><td style={S.tdL}>Ladder ending value</td><td style={S.td}><b>{usd(res.ending_equity!)}</b> <span style={neg(res.total_return!)}>({pct(res.total_return!)})</span></td></tr>
              <tr><td style={S.tdL}>Buy &amp; hold (same $)</td><td style={S.td}>{usd(res.buy_hold_equity!)} <span style={neg(res.buy_hold_return!)}>({pct(res.buy_hold_return!)})</span></td></tr>
              <tr><td style={S.tdL}>Max drawdown</td><td style={{ ...S.td, color: "var(--neg)" }}>−{pct(res.max_drawdown!)}</td></tr>
              <tr><td style={S.tdL}>Round-trips · win rate</td><td style={S.td}>{res.round_trips} · {res.win_rate == null ? "—" : pct(res.win_rate)}</td></tr>
              <tr><td style={S.tdL}>Deepest ladder · max deployed</td><td style={S.td}>{res.max_lots_deep} lots · {usd(res.max_deployed!)}</td></tr>
              <tr><td style={S.tdL}>Still open at end</td><td style={S.td}>{res.open_lots} lots · {usd(res.open_unrealized!)} unrealized</td></tr>
            </tbody>
          </table>
          {res.curve && res.curve.length > 1 && <div style={{ marginTop: 12 }}><Curve pts={res.curve} /></div>}
          <p style={S.note}>
            <span style={{ color: "var(--accent)" }}>— ladder</span> vs <span style={{ color: "var(--text-faint)" }}>·· buy &amp; hold</span>, over {res.bars} trading days.{" "}
            {beat
              ? "The ladder came out ahead here."
              : "Buy-and-hold came out ahead here — the ladder's aim is smoother equity and a shallower drawdown, not a higher return in a name that mostly went up."}
          </p>
        </>
      )}
    </section>
  );
}

export function Method({ initialBacktest }: { initialBacktest?: string | null } = {}) {
  const [a, setA] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${API}/strategy-analysis`)
      .then((r) => r.json())
      .then((j) => { if (alive) setA(j as Analysis); })
      .catch(() => { if (alive) setErr("Couldn't load method analysis."); });
    return () => { alive = false; };
  }, []);

  if (err) return <p style={{ color: "var(--neg)" }}>{err}</p>;
  if (!a) return <p style={{ color: "var(--text-dim)" }}>Analyzing your book…</p>;
  if (a.held_count === 0)
    return (
      <div className="card-grid">
        <p style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)", margin: 0, gridColumn: "1 / -1" }}>
          No open positions yet — the risk lenses need a live book. You can still backtest the method on any symbol below.
        </p>
        <BacktestCard initialSymbol={initialBacktest ?? undefined} />
      </div>
    );

  return (
    <div className="card-grid">
      <p style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)", margin: 0, gridColumn: "1 / -1" }}>
        Read-only risk lenses on your ladder method and current book, as of {a.as_of}. <b>Advisory only</b> —
        nothing here places an order or tells you what to buy or sell.
      </p>

      {/* 1) Concentration by true underlying */}
      <section style={{ ...S.card, gridColumn: "1 / -1" }}>
        <h3 style={S.h}>Concentration by underlying</h3>
        <p style={S.sub}>
          A stock and any leveraged/inverse ETFs tied to it are one bet. Rolled up, here's your true
          single-name exposure as a share of your book's market value.
        </p>
        <table style={S.table}>
          <thead><tr>
            <th style={S.thL}>Underlying</th><th style={S.thL}>Tickers</th>
            <th style={S.th}>Exposure</th><th style={S.th}>% of book</th>
          </tr></thead>
          <tbody>
            {a.concentration.rows.map((r) => (
              <tr key={r.key}>
                <td style={S.tdL}><b>{r.key}</b></td>
                <td style={S.tdL}>{r.symbols.join(", ")}</td>
                <td style={S.td}>{usd(r.value)}</td>
                <td style={S.td}>{pct(r.pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* 2) Downside / ladder-depth stress */}
      <section style={{ ...S.card, gridColumn: "1 / -1" }}>
        <h3 style={S.h}>Downside stress</h3>
        <p style={S.sub}>
          What a further drop does to the book — the tail the “add more as it falls” ladder walks into.
          Unrealized shown at each drop from today's prices.
        </p>
        <table style={S.table}>
          <thead><tr>
            <th style={S.thL}>Symbol</th><th style={S.th}>Lots</th><th style={S.th}>Value now</th>
            {a.stress.drops.map((d) => <th key={d} style={S.th}>{dropLabel(d)}</th>)}
          </tr></thead>
          <tbody>
            <tr>
              <td style={S.tdL}><b>Whole book</b></td>
              <td style={S.td}>—</td>
              <td style={S.td}><b>{usd(a.stress.portfolio.value_now)}</b></td>
              {a.stress.portfolio.scenarios.map((sc) => (
                <td key={sc.drop} style={{ ...S.td, ...neg(sc.unrealized) }}>{usd(sc.unrealized)}</td>
              ))}
            </tr>
            {a.stress.positions.map((p) => (
              <tr key={p.symbol}>
                <td style={S.tdL}>{p.symbol}</td>
                <td style={{ ...S.td, ...(p.over_depth ? { color: "var(--warn)", fontWeight: 700 } : {}) }}>
                  {p.lots_deep}{p.over_depth && <span style={S.badge}>deep</span>}
                </td>
                <td style={S.td}>{usd(p.value_now)}</td>
                {p.scenarios.map((sc) => (
                  <td key={sc.drop} style={{ ...S.td, ...neg(sc.unrealized) }}>{usd(sc.unrealized)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p style={S.note}>“Lots” is how many rungs deep you are; “deep” flags names past your ~6-lot target.</p>
      </section>

      {/* 3) Thesis-break flags */}
      <section style={S.card}>
        <h3 style={S.h}>Thesis-break watch</h3>
        <p style={S.sub}>
          Names behaving like a broken thesis the ladder would just keep buying. These are warnings to
          <i> look</i>, not sell signals — the method has no stop, so this is where you'd decide to stop adding.
        </p>
        {a.thesis_breaks.length === 0 ? (
          <p style={{ color: "var(--pos)", fontSize: "var(--fs-sm)", margin: 0 }}>Nothing tripping the checks — no name is deep underwater, stale, or past the ladder.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: "var(--fs-sm)" }}>
            {a.thesis_breaks.map((b) => (
              <li key={b.symbol} style={{ marginBottom: 6 }}>
                <b style={{ color: "var(--warn)" }}><IconWarning size={12} /> {b.symbol}</b>
                <span style={{ color: "var(--text-faint)" }}> · {b.lots_deep} lots</span>
                <span style={{ color: "var(--text-dim)" }}> — {b.reasons.map((r) => r.text).join("; ")}.</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4) Sizing sanity check (Kelly reference) */}
      <section style={{ ...S.card, gridColumn: "1 / -1" }}>
        <h3 style={S.h}>Sizing check</h3>
        <p style={S.sub}>
          A reference from your own realized record — not advice. The Kelly criterion turns your win rate and
          average win/loss into a fraction of the book to risk per name. Half-Kelly is the usual practical cap.
        </p>
        {!a.kelly.enough ? (
          <p style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)", margin: 0 }}>
            Need {a.kelly.min_trades} closed trades for a stable read — you have {a.kelly.trades}.
          </p>
        ) : (
          <>
            <table style={S.table}>
              <tbody>
                <tr><td style={S.tdL}>Win rate</td><td style={S.td}>{pct(a.kelly.win_rate!)}</td></tr>
                <tr><td style={S.tdL}>Payoff (avg win ÷ avg loss)</td><td style={S.td}>{a.kelly.payoff_ratio}×</td></tr>
                <tr><td style={S.tdL}>Kelly / half-Kelly per name</td><td style={S.td}>{pct(a.kelly.kelly_fraction!)} / {pct(a.kelly.half_kelly_fraction!)}</td></tr>
                <tr><td style={S.tdL}>Half-Kelly dollars per name</td><td style={S.td}><b>{usd(a.kelly.half_kelly_dollars!)}</b></td></tr>
                <tr><td style={S.tdL}>Your sizing tiers (per lot)</td><td style={S.td}>{(a.kelly.current_tiers ?? []).map((t) => usd(t)).join(" / ")}</td></tr>
              </tbody>
            </table>
            <p style={S.note}>
              {a.kelly.kelly_fraction === 0
                ? "Your realized record shows no positive edge yet, so Kelly implies minimal sizing — treat current sizes as speculative until the record turns."
                : "Compare half-Kelly to what a fully-laddered name commits under your sizing tiers: if a full ladder is well above it, the method can put more into one name than your realized edge supports."}
              {" "}Book value used as the base: {usd(a.kelly.account_value ?? 0)}.
            </p>
          </>
        )}
      </section>

      <BacktestCard initialSymbol={initialBacktest ?? undefined} />
    </div>
  );
}
