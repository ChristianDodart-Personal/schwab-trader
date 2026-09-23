import { useEffect, useState } from "react";
import { usd, pct } from "./format";
import { ColumnManager } from "./ColumnManager";
import { DETAIL_COLUMNS, DETAIL_COLUMN_LIST, DEFAULT_DETAIL_COLS, useColumnPrefs, tickerRiskColor, RISK_LABEL } from "./columns";
import { Term } from "./GlossaryUI";
import { OrderTicket } from "./OrderTicket";
import { PriceChart } from "./PriceChart";
import { SkeletonPanel } from "./Skeleton";
import { useToast } from "./Toast";
import type { PositionDetailData, Suggestion, SymbolRuleOverride } from "./types";

import { API } from "./api";
import { IconClose, IconChildArrow, IconPlus } from "./Icon";

export function PositionDetail({ symbol, mode, onClose, embedded }: { symbol: string; mode?: string; onClose: () => void; embedded?: boolean }) {
  const [d, setD] = useState<PositionDetailData | null>(null);
  const [ticket, setTicket] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState(false);
  // One collapsible tool at a time (Chart / Rules / Alerts / Notes) so the ladder sits
  // right under the stats instead of being pushed down. `showProj` reveals the projected
  // ladder (next 5 only) on demand.
  const [panel, setPanel] = useState<null | "chart" | "rules" | "alerts" | "notes">(null);
  const [showProj, setShowProj] = useState(false);
  const togglePanel = (p: "chart" | "rules" | "alerts" | "notes") => setPanel((cur) => (cur === p ? null : p));
  const cols = useColumnPrefs("detail.cols.v1", DEFAULT_DETAIL_COLS, DETAIL_COLUMN_LIST);
  const toast = useToast();

  const suggest = (url: string) => {
    if (busy) return;
    setBusy(true);
    fetch(url)
      .then((r) => r.json())
      .then((j) => { if (j.error) toast(j.error); else setTicket(j); })
      .catch(() => toast("Couldn't load the order suggestion — try again"))
      .finally(() => setBusy(false));
  };
  const openBuy = () => suggest(`${API}/suggest/buy/${symbol}`);
  const openSell = (lotId: number) => suggest(`${API}/suggest/sell/${lotId}`);
  // Bulk LIFO sell: selling is just a share count — Schwab reduces the position and
  // the app's LIFO reconstruction retires the newest rungs first. No backend call; we
  // hand the order ticket a synthetic SELL suggestion for N shares (its quantity opens
  // locked, its limit defaults to the ask).
  const openLifoSell = (n: number, note: string) => {
    if (!d) return;
    setTicket({ symbol: d.symbol, side: "SELL", order_type: "LIMIT", quantity: n, limit_price: d.price ?? 0, note, price_label: "Last" });
  };

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API}/positions/${symbol}`)
        .then((r) => r.json())
        .then((j) => alive && !j.error && setD(j))
        .catch(() => {});
    load();
    const t = setInterval(load, 2000); // keep price-derived fields fresh
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [symbol]);

  if (!d) return <SkeletonPanel embedded={embedded} />;
  const defs = cols.ids.map((id) => DETAIL_COLUMNS[id]).filter(Boolean);

  return (
    <section className={embedded ? undefined : "panel"} style={embedded ? S.panelEmbedded : S.panel}>
      <div style={S.head}>
        <div>
          <span style={{ ...S.sym, color: tickerRiskColor(d.risk) }} title={d.risk ? RISK_LABEL[d.risk] : undefined}>{d.symbol}</span>
          {d.name && <span style={S.name}>{d.name}</span>}
          <SectorEditor symbol={d.symbol} sector={d.sector} onSaved={(s) => setD((p) => (p ? { ...p, sector: s } : p))} />
          {d.is_leveraged && (
            <EtfLinkEditor symbol={d.symbol} underlying={d.underlying ?? null}
              onSaved={(u) => setD((p) => (p ? { ...p, underlying: u } : p))} />
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <ColumnManager prefs={cols} labelOf={(id) => DETAIL_COLUMNS[id]?.label ?? id} align="right" />
          {!d.is_watch && <button className="btn btn-buy" disabled={busy} onClick={openBuy}>Buy next position</button>}
          <button style={S.close} aria-label="Close position detail" onClick={onClose}><IconClose /></button>
        </div>
      </div>

      {d.is_watch ? (
        <div style={S.stats}>
          <Stat label="Price" value={usd(d.price)} />
          {d.last_held != null && <Stat label="Last held" value={usd(d.last_held)} />}
          {d.realized !== 0 && <Stat label="Realized" value={usd(d.realized)} color={signColor(d.realized)} term="realized_pl" />}
          {d.dividends > 0 && <Stat label="Dividends" value={usd(d.dividends)} color="var(--pos)" />}
        </div>
      ) : (
        <div style={S.stats}>
          <Stat label="Price" value={usd(d.price)} />
          <Stat label="Positions" value={String(d.positions)} />
          <Stat label="Shares" value={d.shares.toLocaleString()} />
          <Stat label="Invested" value={usd(d.invested)} term="invested" />
          <Stat label="Basis / Share" value={usd(d.basis_per_share)} term="cost_basis" />
          <Stat label="LILO %" value={pct(d.lilo_pct)} color={signColor(d.lilo_pct)} term="lilo_pct" />
          <Stat label="Unrealized" value={d.unrealized == null ? "—" : usd(d.unrealized)} color={signColor(d.unrealized)} term="unrealized_pl" />
          <Stat label="Realized" value={usd(d.realized)} color={signColor(d.realized)} term="realized_pl" />
          {d.last_sold != null && <Stat label="Last sold" value={usd(d.last_sold)} />}
          {d.dividends > 0 && <Stat label="Dividends" value={usd(d.dividends)} color="var(--pos)" />}
          <Stat label="Total return" value={usd(d.total_return)} color={signColor(d.total_return)} />
        </div>
      )}

      {!d.is_watch && d.cost_unknown && (
        <p style={{ color: "var(--warn)", fontSize: "var(--fs-sm)", margin: "8px 0 0" }}>
          Part of this position has no known cost (marked “cost unknown” below). Those shares are left out of
          Invested, Basis, P/L, LILO and the sell signal. Import a Schwab transactions CSV covering the buy, or
          review it by hand.
        </p>
      )}
      {d.is_watch && (
        <p style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)", margin: "8px 0 0" }}>
          On your watchlist — no open position{d.last_held != null ? `, last held at ${usd(d.last_held)}` : ""}.
          Use the ticker's Buy button on the dashboard to open a position.
        </p>
      )}

      {/* Compact tool pills — one panel opens at a time so the ladder stays high up. */}
      <div style={S.pills}>
        <Pill on={panel === "chart"} onClick={() => togglePanel("chart")}>Chart</Pill>
        {!d.is_watch && (
          <Pill on={panel === "rules"} onClick={() => togglePanel("rules")} warn={!!d.rules_override}>
            Rules{d.rules_override ? " ●" : ""}
          </Pill>
        )}
        <Pill on={panel === "alerts"} onClick={() => togglePanel("alerts")}>Alerts</Pill>
        <Pill on={panel === "notes"} onClick={() => togglePanel("notes")}>Notes</Pill>
      </div>

      {panel === "chart" && (
        <div style={{ marginTop: 8 }}>
          <PriceChart symbol={d.symbol} rungs={d.projected_ladder.map((p) => p.trigger_price)}
            avg52={d.avg_52wk} median52={d.median_52wk} windowWeeks={d.ref_window_weeks ?? 52} />
        </div>
      )}
      {panel === "rules" && !d.is_watch && (
        <TickerRules symbol={d.symbol} current={d.rules_override ?? null}
          onSaved={(ov) => { setD((p) => (p ? { ...p, rules_override: ov } : p)); toast(ov ? `${d.symbol} now uses its own rules.` : `${d.symbol} back on the global rules.`, "success"); }}
          onError={(m) => toast(m, "error")} />
      )}
      {panel === "alerts" && <AlertTemplates d={d} onSet={(msg, kind) => toast(msg, kind)} />}
      {panel === "notes" && <PositionNote symbol={d.symbol} onSaved={(m) => toast(m, "success")} onError={(m) => toast(m, "error")} />}

      {!d.is_watch && <>
      <h3 className="section-title" style={S.h3}>Positions</h3>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col" className="left">Position</th>
              {defs.map((c) => (
                <th scope="col" key={c.id} className={c.align === "left" ? "left" : ""}>
                  {c.term ? <Term id={c.term}>{c.label}</Term> : c.label}
                </th>
              ))}
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {d.lots.map((l, i) => (
              <tr key={`f${l.rung}`}>
                <td className="left">
                  {l.rung}
                  {l.cost_unknown && (
                    <span style={{ ...S.prior, color: "var(--warn)" }} title="No known cost for this lot: no sell target, profit or P/L is shown for it">
                      cost unknown
                    </span>
                  )}
                  {l.source === "position" && (
                    <span style={S.prior} title="Held from before our fill history — quantity is from Schwab, cost is the position average (not an exact buy fill)">
                      prior
                    </span>
                  )}
                </td>
                {defs.map((c) => (
                  <td key={c.id} style={{ textAlign: c.align }}>{c.render(l)}</td>
                ))}
                <td style={{ textAlign: "right" }}>
                  {/* LIFO: a sale always retires the newest position first, so only the
                      last row can honestly be sold on its own. Deeper rungs are reached
                      by selling more shares via "Sell shares" below. */}
                  {i === d.lots.length - 1 && (
                    <button className="btn btn-sell btn-sm" disabled={busy} onClick={() => openSell(l.id)}
                      title="Sells this position: the newest one, which LIFO sells first">Sell</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <LifoSell d={d} busy={busy} onReview={openLifoSell} />

      {d.projected_ladder.length > 0 && (
        <>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} aria-expanded={showProj}
            onClick={() => setShowProj((v) => !v)}
            title="The next projected buy positions if the price keeps dipping — trigger price, suggested dollars, and shares">
            {showProj ? "▴ Hide projected" : `▾ Show projected (next ${Math.min(5, d.projected_ladder.length)})`}
          </button>
          {showProj && (
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    {["Position", "Trigger Price", "Suggested $", "Suggested Shares"].map((h, i) => (
                      <th scope="col" key={h} className={i === 0 ? "left" : ""}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.projected_ladder.slice(0, 5).map((p) => (
                    <tr key={`p${p.rung}`} style={{ opacity: 0.55 }}>
                      <td className="left">{p.rung}</td>
                      <td style={{ textAlign: "right", color: "var(--accent-quiet)" }}>{usd(p.trigger_price)}</td>
                      <td style={{ textAlign: "right" }}>{usd(p.suggested_dollars)}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {p.suggested_shares == null ? "—" : p.suggested_shares.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      </>}

      {ticket && <OrderTicket suggestion={ticket} mode={mode} onClose={() => setTicket(null)} />}
    </section>
  );
}

// One-click price alerts from live position data — no threshold typing. Uses the same
// /api/alerts create as the manual form; degrades (button hidden) when data is missing.
function AlertTemplates({ d, onSet }: { d: PositionDetailData; onSet: (msg: string, kind?: "success" | "error") => void }) {
  const lastBuy = d.lots.length ? d.lots[d.lots.length - 1].buy_price : null;
  const make = (direction: "above" | "below", threshold: number, note: string) => {
    fetch(`${API}/alerts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: d.symbol, direction, threshold: Number(threshold.toFixed(2)), note, repeat: false }),
    })
      .then((r) => r.json())
      .then((j) => onSet(j?.ok ? (j.warning || `Alert set: ${d.symbol} ${direction} ${usd(threshold)}`) : (j?.error || "Couldn't set alert."), j?.ok ? "success" : "error"))
      .catch(() => onSet("Couldn't set alert — network error.", "error"));
  };
  if (!lastBuy && d.avg_52wk == null) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "10px 0 0" }}>
      <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>Quick alert:</span>
      {lastBuy != null && lastBuy > 0 && (
        <button className="btn btn-ghost btn-sm" onClick={() => make("below", lastBuy * 0.95, "5% below last buy")}
          title={`Notify if ${d.symbol} falls to ${usd(lastBuy * 0.95)}`}>−5% from last buy</button>
      )}
      {d.avg_52wk != null && (
        <button className="btn btn-ghost btn-sm" onClick={() => make("above", d.avg_52wk!, "back above 52wk avg")}
          title={`Notify if ${d.symbol} rises above its 52wk average (${usd(d.avg_52wk)})`}>Above 52wk avg</button>
      )}
      {d.basis_per_share > 0 && (
        <button className="btn btn-ghost btn-sm" onClick={() => make("above", d.basis_per_share, "back above break-even")}
          title={`Notify if ${d.symbol} recovers to your cost basis (${usd(d.basis_per_share)})`}>Above break-even</button>
      )}
    </div>
  );
}

// Free-text journal note per symbol (thesis / reminders). Loads once, autosaves on blur.
function PositionNote({ symbol, onSaved, onError }: { symbol: string; onSaved: (m: string) => void; onError: (m: string) => void }) {
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [flash, setFlash] = useState(false);   // brief inline "Saved" confirmation
  useEffect(() => {
    let alive = true;
    fetch(`${API}/positions/${symbol}/note`)
      .then((r) => r.json())
      .then((j) => { if (alive) { setNote(j.note || ""); setSaved(j.note || ""); setLoaded(true); } })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [symbol]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1800);
    return () => clearTimeout(t);
  }, [flash]);
  const save = () => {
    if (note === saved) return;
    fetch(`${API}/positions/${symbol}/note`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: note }) })
      .then((r) => r.json())
      .then((j) => { if (j?.ok) { setSaved(j.note ?? note); setFlash(true); onSaved("Note saved."); } else onError("Couldn't save note."); })
      .catch(() => onError("Couldn't save note."));
  };
  if (!loaded) return null;
  const dirty = note !== saved;
  return (
    <div style={{ marginTop: 14 }}>
      <label style={{ fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)", display: "inline-flex", alignItems: "center", gap: 8 }}>
        Notes
        <span aria-live="polite">
          {flash && <span style={{ color: "var(--pos)", textTransform: "none", letterSpacing: 0, fontWeight: 600, transition: "opacity .2s" }}>✓ Saved</span>}
          {!flash && dirty && <span style={{ color: "var(--text-faint)", textTransform: "none", letterSpacing: 0 }}>unsaved — click away to save</span>}
        </span>
      </label>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={save}
        placeholder="Your thesis, targets, reminders for this position — saved to this account."
        className="field" style={{ width: "100%", minHeight: 62, marginTop: 4, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} />
    </div>
  );
}

// Small toggle pill for the compact tool row (Chart / Rules / Alerts / Notes).
function Pill({ on, onClick, warn, children }: { on: boolean; onClick: () => void; warn?: boolean; children: React.ReactNode }) {
  return (
    <button className={`btn btn-sm ${on ? "btn-primary" : "btn-ghost"}`} aria-pressed={on} onClick={onClick}
      style={warn && !on ? { color: "var(--warn)", borderColor: "var(--warn-border)" } : undefined}>
      {children}
    </button>
  );
}

// Inline editor for a ticker's sector (user-maintained — Schwab omits it). Click
// the tag to edit; Enter/blur saves, Escape cancels.
function SectorEditor({ symbol, sector, onSaved }: { symbol: string; sector: string | null; onSaved: (s: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(sector ?? "");
  const toast = useToast();
  const save = () => {
    const next = val.trim();
    setEditing(false);
    if (next === (sector ?? "")) return;
    fetch(`${API}/tickers/${symbol}/sector`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sector: next || null }),
    })
      .then((r) => r.json())
      .then((j) => { if (j?.ok) onSaved(j.sector ?? null); else toast("Couldn't save sector.", "error"); })
      .catch(() => toast("Couldn't save sector.", "error"));
  };
  if (editing) {
    return (
      <input className="field" autoFocus value={val} placeholder="Sector (e.g. Defense)"
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setVal(sector ?? ""); setEditing(false); } }}
        style={{ height: 26, width: 150, marginLeft: 10, fontSize: "var(--fs-sm)" }} aria-label="Sector" />
    );
  }
  return (
    <button className="tag" onClick={() => { setVal(sector ?? ""); setEditing(true); }}
      title="Click to edit sector"
      style={{ marginLeft: 10, cursor: "pointer", color: sector ? "var(--accent-quiet)" : "var(--text-faint)", border: "1px solid var(--border)", background: "transparent" }}>
      {sector || "+ sector"}
    </button>
  );
}

// Per-ticker rule overrides: this symbol can use its own sell target and/or dip depth
// instead of the global Rules — e.g. a calm large-cap on tighter percentages than a
// 2x ETF. Buy triggers, sell marks, the ladder and projections all follow immediately.
function TickerRules({ symbol, current, onSaved, onError }: {
  symbol: string;
  current: SymbolRuleOverride | null;
  onSaved: (ov: SymbolRuleOverride | null) => void;
  onError: (msg: string) => void;
}) {
  const [mode, setMode] = useState<string>(current?.sell_mode ?? "");
  const [value, setValue] = useState<string>(
    current?.sell_value != null
      ? String(current.sell_mode === "pct_above" ? +(current.sell_value * 100).toFixed(4) : current.sell_value)
      : "");
  const [dip, setDip] = useState<string>(current?.dip_scale != null ? String(+(current.dip_scale * 100).toFixed(2)) : "");
  const [busy, setBusy] = useState(false);

  const post = (body: Record<string, unknown>, next: SymbolRuleOverride | null) => {
    setBusy(true);
    fetch(`${API}/symbol-rules`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, ...body }),
    })
      .then((r) => r.json())
      .then((j) => { if (j?.ok) { onSaved(next); } else onError(j?.error || "Couldn't save ticker rules."); })
      .catch(() => onError("Couldn't save ticker rules — network error."))
      .finally(() => setBusy(false));
  };

  const save = () => {
    const v = Number(value);
    const dipPct = Number(dip);
    const ov: SymbolRuleOverride = {};
    if (mode && v > 0) {
      ov.sell_mode = mode as SymbolRuleOverride["sell_mode"];
      ov.sell_value = mode === "pct_above" ? v / 100 : v;   // UI edits %, engine stores a fraction
    }
    if (dipPct > 0 && Math.abs(dipPct - 100) > 0.01) ov.dip_scale = dipPct / 100;
    if (!ov.sell_mode && ov.dip_scale == null) { onError("Set a sell target or a dip depth (or Clear)."); return; }
    post({ sell_mode: ov.sell_mode ?? null, sell_value: ov.sell_value ?? null, dip_scale: ov.dip_scale ?? null }, ov);
  };

  const summary = current
    ? [
        current.sell_mode === "dollar_gain" && current.sell_value != null ? `sell at +$${current.sell_value}` : null,
        current.sell_mode === "pct_above" && current.sell_value != null ? `sell at +${(current.sell_value * 100).toFixed(1)}%` : null,
        current.dip_scale != null ? `dips at ${(current.dip_scale * 100).toFixed(0)}% of global depth` : null,
      ].filter(Boolean).join(" · ")
    : null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <h3 className="section-title" style={{ margin: 0 }}>Ticker rules</h3>
        {current
          ? <span className="tag" style={{ color: "var(--warn)", border: "1px solid var(--warn-border)" }}>custom · {summary}</span>
          : <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-xs)" }}>using the global rules</span>}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: 10, background: "var(--panel-2)", borderRadius: "var(--r-md)" }}>
          <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>Sell target</span>
          <select className="field" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Sell target mode" style={{ minWidth: 130, paddingRight: 24 }}>
            <option value="">Global</option>
            <option value="dollar_gain">$ gain per lot</option>
            <option value="pct_above">% above cost</option>
          </select>
          {mode && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <input className="field" type="number" min={0} step={mode === "pct_above" ? "0.5" : "5"} value={value}
                onChange={(e) => setValue(e.target.value)} style={{ width: 90, textAlign: "right" }}
                aria-label="Sell target value" placeholder={mode === "pct_above" ? "11" : "50"} />
              <span style={{ color: "var(--text-dim)" }}>{mode === "pct_above" ? "%" : "$"}</span>
            </span>
          )}
          <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)", marginLeft: 8 }}
            title="Scales every ladder drop for this ticker. 50 = dips trigger at half the global depth (buys sooner); 200 = twice as deep (waits longer).">
            Dip depth
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input className="field" type="number" min={10} max={300} step={5} value={dip}
              onChange={(e) => setDip(e.target.value)} style={{ width: 80, textAlign: "right" }}
              aria-label="Dip depth as percent of global" placeholder="100" />
            <span style={{ color: "var(--text-dim)" }}>% of global</span>
          </span>
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
            {current && (
              <button className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => post({ clear: true }, null)}>Back to global</button>
            )}
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>Save</button>
          </span>
        </div>
    </div>
  );
}


// Inline editor for a leveraged ETF's underlying stock (drives dashboard nesting).
// Auto-detected from the fund name; click to override or clear. Enter/blur saves.
function EtfLinkEditor({ symbol, underlying, onSaved }: { symbol: string; underlying: string | null; onSaved: (u: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(underlying ?? "");
  const toast = useToast();
  const save = () => {
    const next = val.trim().toUpperCase();
    setEditing(false);
    if (next === (underlying ?? "")) return;
    fetch(`${API}/etf-link`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ etf: symbol, underlying: next || null }),
    })
      .then((r) => r.json())
      .then((j) => { if (j?.ok) { onSaved(next || null); toast("Grouping saved — the dashboard will nest it.", "success"); } else toast("Couldn't save grouping.", "error"); })
      .catch(() => toast("Couldn't save grouping.", "error"));
  };
  if (editing) {
    return (
      <input className="field" autoFocus value={val} placeholder="Underlying (e.g. QBTS)"
        onChange={(e) => setVal(e.target.value.toUpperCase())}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setVal(underlying ?? ""); setEditing(false); } }}
        style={{ height: 26, width: 150, marginLeft: 10, fontSize: "var(--fs-sm)" }} aria-label="Underlying ticker" />
    );
  }
  return (
    <button className="tag" onClick={() => { setVal(underlying ?? ""); setEditing(true); }}
      title="Leveraged ETF — click to set the underlying stock it tracks (groups it on the dashboard)"
      style={{ marginLeft: 10, cursor: "pointer", color: underlying ? "var(--neg)" : "var(--text-faint)", border: "1px solid var(--border)", background: "transparent" }}>
      {underlying ? <><IconChildArrow /> tracks {underlying}</> : <><IconPlus /> underlying</>}
    </button>
  );
}

// Which rungs a LIFO sell of `n` shares consumes — newest (highest rung) first.
// Lots arrive oldest→newest (rung ascending), so we walk from the end.
function lifoConsume(lots: { rung: number; shares: number; buy_price: number }[], n: number) {
  const out: { rung: number; take: number; buy_price: number }[] = [];
  let rem = n;
  for (let i = lots.length - 1; i >= 0 && rem > 1e-9; i--) {
    const take = Math.min(rem, lots[i].shares);
    if (take > 1e-9) out.push({ rung: lots[i].rung, take, buy_price: lots[i].buy_price });
    rem -= take;
  }
  return out;
}
const qty = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });

// Sell a share count from a single ticker, LIFO. The only input is how many shares;
// the app shows exactly which rungs get retired (newest first) so the LIFO is obvious.
function LifoSell({ d, busy, onReview }: {
  d: PositionDetailData; busy: boolean; onReview: (n: number, note: string) => void;
}) {
  const [n, setN] = useState<number>(0);
  const total = Math.floor(d.shares);
  const price = d.price ?? 0;
  const consumed = lifoConsume(d.lots as unknown as { rung: number; shares: number; buy_price: number }[], n);
  const cost = consumed.reduce((s, c) => s + c.take * c.buy_price, 0);
  const proceeds = price > 0 ? n * price : 0;
  const estPl = proceeds - cost;
  const valid = n > 0 && n <= total && consumed.length > 0;
  const note = valid
    ? `LIFO sell of ${qty(n)} share${n === 1 ? "" : "s"} — retires the newest ${consumed.length} position${consumed.length === 1 ? "" : "s"} first: ${consumed.map((c) => `#${c.rung}×${qty(c.take)}`).join(", ")}`
    : "";
  if (d.is_watch || total <= 0) return null;
  return (
    <div style={LS.box}>
      <div style={LS.head}>
        <h3 className="section-title" style={{ margin: 0 }}>Sell shares</h3>
        <span style={LS.lifo} title="Sells consume your most recent positions first (last-in, first-out)">
          LIFO — newest positions sold first
        </span>
      </div>
      <div style={LS.row}>
        <input type="number" className="field" style={{ width: 120, textAlign: "right" }} min={0} max={total}
          value={n || ""} placeholder="shares"
          onChange={(e) => setN(Math.max(0, Math.min(total, Math.floor(Number(e.target.value) || 0))))} />
        <button className="btn btn-ghost btn-sm" onClick={() => setN(total)}>All {qty(total)}</button>
        <button className="btn btn-sell" disabled={!valid || busy} style={{ marginLeft: "auto" }}
          onClick={() => onReview(n, note)}>Review sell</button>
      </div>
      {valid && (
        <div style={LS.preview}>
          <div style={LS.chips}>
            {consumed.map((c) => (
              <span key={c.rung} style={LS.chip}>position {c.rung} <b>×{qty(c.take)}</b></span>
            ))}
          </div>
          <div style={LS.est}>
            <span>Est. proceeds <b>{usd(proceeds)}</b> at the last price {usd(price)}</span>
            <span style={LS.computed} title="App-calculated: proceeds minus the LIFO cost basis of the retired positions">
              Est. realized <b style={{ color: estPl >= 0 ? "var(--pos)" : "var(--neg)" }}>{estPl >= 0 ? "+" : ""}{usd(estPl)}</b>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const LS: Record<string, React.CSSProperties> = {
  box: { marginTop: 14, padding: 12, background: "var(--panel-2)", borderRadius: "var(--r-md)", border: "1px solid var(--border)" },
  head: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  lifo: { fontSize: "var(--fs-2xs)", fontWeight: 700, color: "var(--warn)", border: "1px solid var(--warn-border)", borderRadius: "var(--r-sm)", padding: "1px 7px", letterSpacing: "0.02em" },
  row: { display: "flex", gap: 8, alignItems: "center", marginTop: 10 },
  preview: { marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" },
  chips: { display: "flex", gap: 6, flexWrap: "wrap" },
  chip: { fontSize: "var(--fs-2xs)", color: "var(--text-muted)", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "2px 7px" },
  est: { display: "flex", gap: 18, flexWrap: "wrap", marginTop: 8, fontSize: "var(--fs-sm)", color: "var(--text-muted)" },
  computed: { cursor: "help" },
};

const signColor = (n: number | null | undefined) =>
  n == null ? undefined : n >= 0 ? "var(--pos)" : "var(--neg)";

function Stat({ label, value, color, term }: { label: string; value: string; color?: string; term?: string }) {
  return (
    <div style={S.stat}>
      <div style={S.statLabel}>{term ? <Term id={term}>{label}</Term> : label}</div>
      <div style={{ ...S.statValue, color: color ?? "var(--text)" }}>{value}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  panel: { marginTop: 24, padding: 20 },
  panelEmbedded: { padding: 20 }, // inline drawer: the table cell supplies the container (bg + left rail)
  head: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  sym: { fontSize: "var(--fs-xl)", fontWeight: 700, marginRight: 10 },
  name: { color: "var(--text-dim)", fontSize: "var(--fs-md)" },
  close: { background: "none", border: "none", color: "var(--text-dim)", fontSize: 18, cursor: "pointer", padding: "0 4px" },
  stats: { display: "flex", gap: 28, flexWrap: "wrap", margin: "16px 0 8px" },
  pills: { display: "flex", gap: 6, flexWrap: "wrap", margin: "12px 0 4px" },
  stat: {},
  statLabel: { fontSize: "var(--fs-2xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)" },
  statValue: { fontSize: "var(--fs-lg)", fontWeight: 600, marginTop: 2, fontVariantNumeric: "tabular-nums" },
  h3: { margin: "18px 0 8px" },
  prior: { fontSize: 10, color: "var(--warn)", border: "1px solid var(--warn-border)", borderRadius: "var(--r-sm)", padding: "0 5px", marginLeft: 6, textTransform: "uppercase", cursor: "help" },
};
