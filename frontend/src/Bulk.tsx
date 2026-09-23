import { useEffect, useState } from "react";
import { usd } from "./format";
import { Modal } from "./Modal";
import type { BulkUI } from "./DashboardTable";
import type { BulkResult, BuyCandidate, DashboardRow, SellCandidate } from "./types";

import { API } from "./api";
import { IconClose, IconWarning } from "./Icon";
import { offerableTypes } from "./orderEligibility";
import { defaultTiming, describeTiming } from "./orderTiming";
type Kind = "sell" | "buy";
type AnyCandidate = SellCandidate | BuyCandidate;
const PLAN_PATH: Record<Kind, string> = { sell: "sell-plan", buy: "buy-plan" };
type Push = (msg: string, kind?: "error" | "success" | "info") => void;
// An editable row in the review modal (shares + limit price are user-adjustable).
type EditRow = { symbol: string; lot_id?: number; is_new?: boolean; shares: number; price: number; buy_price?: number; limit_price: number };

// Orchestrates the bulk flow. SELECTION-FIRST: the user enters bulk mode, picks any
// holdings, then chooses Buy or Sell — at which point we fetch that action's plan,
// keep only the picked symbols it can act on, and open the review.
export function useBulk(rows: DashboardRow[] | undefined, mode: string | undefined, toast: Push) {
  const [active, setActive] = useState(false);          // in bulk selection mode
  const [kind, setKind] = useState<Kind | null>(null);  // set only once an action runs
  const [plan, setPlan] = useState<AnyCandidate[]>([]); // the picked, actionable candidates
  const [checked, setChecked] = useState<Set<string>>(new Set()); // the user's picks (symbols)
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [buyingPower, setBuyingPower] = useState<number | null>(null); // advisory (buy plan only)

  // Selection universe = your holdings (watch rows aren't bulk-actionable).
  const held = (rows || []).filter((r) => !r.is_watch);
  const universe = held.map((r) => r.symbol);
  const holdingsCount = held.length;

  // Leave bulk mode entirely (Escape, view/account switch, or after a placement).
  const escape = () => { setActive(false); setKind(null); setPlan([]); setChecked(new Set()); setReview(false); setResult(null); setLoading(false); };
  const cancel = escape; // alias for existing call sites (view/account switch)

  // Enter bulk mode with an empty selection — the user picks holdings first.
  const enter = () => { setActive(true); setKind(null); setPlan([]); setChecked(new Set()); setReview(false); setResult(null); setBuyingPower(null); };

  const toggle = (sym: string) =>
    setChecked((s) => { const n = new Set(s); n.has(sym) ? n.delete(sym) : n.add(sym); return n; });
  const allChecked = universe.length > 0 && universe.every((s) => checked.has(s));
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(universe));

  // Run a chosen action on the CURRENT picks: fetch that plan, keep only the picked
  // symbols it can act on, then open review directly. Picks the plan can't act on are
  // dropped with a note; if none survive, stay in selection mode.
  const run = (k: Kind) => {
    if (!checked.size) { toast("Pick at least one holding first.", "info"); return; }
    setLoading(true); setKind(k); setResult(null); setReview(false); setBuyingPower(null);
    fetch(`${API}/bulk/${PLAN_PATH[k]}`)
      .then((r) => r.json())
      .then((d) => {
        setBuyingPower(typeof d.buying_power === "number" ? d.buying_power : null);
        const cands: AnyCandidate[] = d.candidates || [];
        const picked = cands.filter((c) => checked.has(c.symbol));
        if (!picked.length) {
          setKind(null); setLoading(false);
          toast(k === "sell" ? "None of your picks have a position to sell right now." : "None of your picks are buyable right now.", "info");
          return;
        }
        const dropped = checked.size - picked.length;
        if (dropped > 0) toast(`${dropped} pick${dropped > 1 ? "s" : ""} skipped — not ${k === "sell" ? "sellable" : "buyable"} right now.`, "info");
        setPlan(picked);
        setReview(true);
        setLoading(false);
      })
      .catch(() => { setKind(null); setLoading(false); toast(`Couldn't load the ${k} plan — network error`); });
  };

  // Close review: after a placement leave bulk mode; otherwise drop back to selection
  // (picks intact) so the user can re-pick or choose the other action.
  const closeReview = () => {
    if (result) escape();
    else { setReview(false); setKind(null); setPlan([]); }
  };

  const selected = plan; // plan is already limited to the picked, actionable symbols

  // `session` = what the single Order Ticket would use right now (pre→AM, post→PM,
  // closed→SEAMLESS, regular→NORMAL), so an extended-hours bulk limit really is an
  // extended-hours order instead of silently queuing for the next open.
  const confirm = (orderType: string, items: EditRow[], session: string) => {
    if (!kind || !items.length) return;
    setPlacing(true);
    const body = kind === "sell"
      ? { items: items.map((i) => ({ lot_id: i.lot_id, symbol: i.symbol, shares: i.shares, limit_price: i.limit_price })), order_type: orderType, session, confirm: true }
      : { items: items.map((i) => ({ symbol: i.symbol, shares: i.shares, limit_price: i.limit_price })), order_type: orderType, session, confirm: true };
    fetch(`${API}/bulk/${kind}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((res: BulkResult) => {
        setResult(res);
        const okN = res.placed ?? 0;
        if (okN) { toast(`Placed ${okN} ${kind} order${okN > 1 ? "s" : ""}`, "success"); fetch(`${API}/account/sync`, { method: "POST" }).catch(() => {}); }
        if (okN < (res.count ?? 0)) toast(`${(res.count ?? 0) - okN} order(s) didn't place — see the summary`, "error");
      })
      .catch(() => toast("Bulk placement failed — network error"))
      .finally(() => setPlacing(false));
  };

  // In bulk mode every holding is selectable (checkbox column); the picker set drives
  // which action's plan we later run. No `kind` here — the action isn't chosen yet.
  const bulkUI: BulkUI | null = active
    ? { candidates: new Set(universe), checked, onToggle: toggle, allChecked, onToggleAll: toggleAll }
    : null;

  return { active, kind, loading, enter, run, escape, cancel, closeReview, bulkUI, holdingsCount, checkedCount: checked.size, allChecked, toggleAll, selected, review, confirm, placing, result, mode, buyingPower };
}

export function BulkReviewModal({
  kind, items, mode, placing, result, onConfirm, onClose, buyingPower,
}: {
  kind: Kind;
  items: AnyCandidate[];
  mode?: string;
  placing: boolean;
  result: BulkResult | null;
  onConfirm: (orderType: string, rows: EditRow[], session: string) => void;
  onClose: () => void;
  buyingPower?: number | null; // advisory: flag when selected buy total exceeds it
}) {
  const isDemo = mode === "demo";
  const isSell = kind === "sell";
  const [orderType, setOrderType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [session, setSession] = useState<string | null>(null);
  const [rows, setRows] = useState<EditRow[]>(() =>
    items.map((c) => ({
      symbol: c.symbol, lot_id: (c as SellCandidate).lot_id, is_new: (c as BuyCandidate).is_new,
      shares: c.shares, price: (c as SellCandidate).price ?? c.limit_price,
      buy_price: (c as SellCandidate).buy_price, limit_price: c.limit_price,
    })),
  );

  // Extended-hours: Schwab allows limit only. On a fetch failure default to
  // "unknown" (→ market allowed but the user is warned by the estimate note).
  useEffect(() => {
    let alive = true;
    fetch(`${API}/market-hours`).then((r) => r.json())
      .then((s) => alive && setSession(s.session ?? "unknown")).catch(() => alive && setSession("unknown"));
    return () => { alive = false; };
  }, []);
  // Market only during REGULAR hours — outside them (extended, closed, or unknown)
  // a market order fills at an unknown gap/open price, so force the price-protected
  // LIMIT. One shared rule with the single Order Ticket (orderEligibility.offerableTypes).
  const marketDisabled = !offerableTypes(session, ["LIMIT", "MARKET"]).includes("MARKET");
  useEffect(() => { if (marketDisabled && orderType === "MARKET") setOrderType("LIMIT"); }, [marketDisabled, orderType]);

  const isLimit = orderType === "LIMIT";
  // The session this batch goes out with: the same default the single ticket would pick
  // for the current market session (null while that's still loading → NORMAL).
  const orderSession = isLimit ? (defaultTiming(session, "DAY")?.session ?? "NORMAL") : "NORMAL";
  const effPrice = (r: EditRow) => (isLimit ? r.limit_price : r.price);
  const update = (i: number, patch: Partial<EditRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));
  const totalCost = rows.reduce((s, r) => s + r.shares * effPrice(r), 0);
  const totalProceeds = totalCost;
  const totalProfit = rows.reduce((s, r) => s + (effPrice(r) - (r.buy_price ?? 0)) * r.shares, 0);
  const typeDesc = isLimit
    ? isSell
      ? "Limit — sells at your price or better; a sudden drop rests instead of filling at a loss (cancel anytime in Orders)."
      : "Limit — buys at your price or better; rests if the market is above it."
    : "Market — fills immediately at whatever the market gives; no price guarantee.";
  const modalTitle = isSell ? "Sell last positions" : "Buy";
  const innerTitle = isSell ? "Sell each pick's newest position (LIFO sells it first)" : "Bulk buy — review and adjust";

  return (
    <Modal key={result ? "result" : "form"} title={modalTitle} onClose={onClose} width={520}>
      {isDemo && <div style={S.demoStrip}>Not connected to Schwab — orders won’t place. Reconnect in Settings.</div>}
      <div style={{ padding: 16 }}>
        {!result ? (
          <>
            <div style={S.title}>{innerTitle}</div>
            {(
              <div style={S.typeRow}>
                <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>Order type</span>
                <span role="group" aria-label="Order type" style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm" style={seg(isLimit)} aria-pressed={isLimit}
                    title={isSell ? "Sells at your price or better; rests if the market moves away" : "Buys at your price or better; rests if the market is above it"}
                    onClick={() => setOrderType("LIMIT")}>Limit</button>
                  <button className="btn btn-sm" style={seg(!isLimit)} aria-pressed={!isLimit} disabled={marketDisabled}
                    title={marketDisabled ? "Market is only available during regular market hours" : "Fills immediately at the current price; no price guarantee"}
                    onClick={() => setOrderType("MARKET")}>Market</button>
                </span>
              </div>
            )}
            <p style={S.typeDesc}>
              {`${typeDesc}${marketDisabled ? " Market is available only during regular market hours." : ""}`}
              {isLimit && session != null && <> {describeTiming(orderSession, "DAY")}</>}
            </p>
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col" className="left">Symbol</th>
                    <th scope="col">Shares</th>
                    <th scope="col">{isLimit ? "Limit" : "~ Price"}</th>
                    <th scope="col">{isSell ? "Est. proceeds" : "Est. cost"}</th>
                    {isSell && <th scope="col">Est. profit</th>}
                    <th scope="col" aria-label="remove"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    // Same ±25% band the server enforces on edited bulk limits, buys AND sells.
                    const bandWarn = isLimit && r.price > 0 && Math.abs(r.limit_price / r.price - 1) > 0.25;
                    const profit = (effPrice(r) - (r.buy_price ?? 0)) * r.shares;
                    // A sale at or below the newest lot's cost is refused (Market: skipped).
                    const belowCost = isSell && r.buy_price != null && effPrice(r) <= r.buy_price;
                    return (
                      <tr key={r.lot_id ?? r.symbol}>
                        <td className="left"><b>{r.symbol}</b>{r.is_new && <span style={S.newTag}>new</span>}
                          {belowCost && (
                            <div style={S.rowWarn}>
                              <IconWarning size={11} /> {isLimit
                                ? `below cost; raise the limit above ${usd(r.buy_price as number)} or it will be refused`
                                : "below cost; a market sell would be skipped"}
                            </div>
                          )}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <input className="field" type="number" min={1} step={1} value={r.shares}
                            aria-label={`${r.symbol} shares`} style={S.numIn}
                            onChange={(e) => update(i, { shares: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {isLimit ? (
                            <input className="field" type="number" min={0.01} step="0.01" value={r.limit_price}
                              aria-label={`${r.symbol} limit price`}
                              title={bandWarn ? "More than 25% from the market — will be rejected" : undefined}
                              style={{ ...S.numIn, ...(bandWarn ? { borderColor: "var(--warn)", color: "var(--warn)" } : null) }}
                              onChange={(e) => update(i, { limit_price: Number(e.target.value) || 0 })} />
                          ) : (
                            <span style={{ color: "var(--text-dim)" }}>~ {usd(r.price)}</span>
                          )}
                        </td>
                        <td style={{ textAlign: "right" }}>{usd(r.shares * effPrice(r))}</td>
                        {isSell && (
                          <td style={{ textAlign: "right", color: profit >= 0 ? "var(--pos)" : "var(--neg)" }}>
                            {profit >= 0 ? "+" : ""}{usd(profit)}
                          </td>
                        )}
                        <td style={{ textAlign: "right" }}>
                          <button className="btn btn-ghost btn-sm" aria-label={`Remove ${r.symbol}`} title="Remove" onClick={() => removeRow(i)}><IconClose /></button>
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length && (
                    <tr><td colSpan={isSell ? 6 : 5} style={{ textAlign: "center", color: "var(--text-dim)", padding: "12px 0" }}>All rows removed — nothing to place.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={S.totals}>
              {isSell
                ? <>Total proceeds <b>{usd(totalProceeds)}</b> · profit <b style={{ color: totalProfit >= 0 ? "var(--pos)" : "var(--neg)" }}>{totalProfit >= 0 ? "+" : ""}{usd(totalProfit)}</b></>
                : <>Total cost <b>{usd(totalCost)}</b>{buyingPower != null && <> · available to trade <b>{usd(buyingPower)}</b></>}</>}
            </div>
            {/* Advisory only — never blocks; the broker enforces margin/settlement. */}
            {!isSell && buyingPower != null && totalCost > buyingPower && (
              <p style={S.warnNote}>
                <IconWarning /> Selected total exceeds what you can trade with ({usd(buyingPower)}) — advisory only; the
                broker enforces margin.
              </p>
            )}
            <p style={S.note}>
              {isSell
                ? "Edit shares or price per row, or remove any. A limit sells at your price or better — a sudden drop rests instead of filling at a loss. Check the Orders tab after placing."
                : "Edit shares or price per row, or remove any. Check the Orders tab after placing."}
            </p>
            <div style={S.actions}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Back</button>
              <button
                className={`btn ${isDemo ? "btn-secondary" : isSell ? "btn-danger" : "btn-buy"}${placing ? " btn-pending" : ""}`}
                style={{ flex: 2 }}
                disabled={placing || !rows.length || rows.some((r) => r.shares < 1 || (isLimit && !(r.limit_price > 0)))}
                onClick={() => onConfirm(orderType, rows, orderSession)}
              >
                {(() => {
                  const verb = isSell ? "sell" : "buy";
                  const n = rows.length;
                  const plural = n !== 1 ? "s" : "";
                  if (placing) return "Placing…";
                  const act = isDemo ? "Simulate" : "Place";
                  return `${act} ${n} ${verb}${plural}`;
                })()}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={S.title}>Placed {result.placed} of {result.count}.</div>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              {result.results.map((r, i) => (
                <div key={i} style={S.resultRow}>
                  <b style={{ minWidth: 56 }}>{r.symbol ?? `#${r.lot_id}`}</b>
                  {r.ok
                    ? <span style={{ color: "var(--pos)" }}>✓ sent{r.order_id ? ` · #${r.order_id}` : ""}</span>
                    : <span style={{ color: "var(--neg)" }}>{r.error || "failed"}</span>}
                </div>
              ))}
            </div>
            <div style={S.actions}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// Segmented toggle: active = accent (a control), never the profit-green.
const seg = (active: boolean): React.CSSProperties => ({
  background: active ? "var(--accent-fill)" : "var(--panel-2)",
  color: active ? "var(--on-accent)" : "var(--text-muted)",
  borderColor: active ? "var(--accent-fill)" : "var(--border-strong)",
});

const S: Record<string, React.CSSProperties> = {
  liveStrip: { background: "var(--danger-bg)", borderBottom: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "var(--fs-xs)", fontWeight: 700, letterSpacing: "0.03em", padding: "8px 16px", borderTopLeftRadius: "var(--r-lg)", borderTopRightRadius: "var(--r-lg)" },
  typeRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 12 },
  typeDesc: { fontSize: "var(--fs-xs)", color: "var(--text-dim)", margin: "6px 0 0", lineHeight: 1.45 },
  numIn: { width: 78, textAlign: "right", padding: "3px 6px", fontSize: "var(--fs-sm)" },
  newTag: { fontSize: 10, textTransform: "uppercase", color: "var(--accent-quiet)", border: "1px solid var(--border-strong)", borderRadius: "var(--r-sm)", padding: "0 5px", marginLeft: 6 },
  demoStrip: { background: "var(--panel-2)", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: "var(--fs-xs)", fontWeight: 600, padding: "8px 16px", borderTopLeftRadius: "var(--r-lg)", borderTopRightRadius: "var(--r-lg)" },
  title: { fontSize: "var(--fs-md)", fontWeight: 600 },
  totals: { marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)", fontSize: "var(--fs-sm)", color: "var(--text-muted)" },
  note: { fontSize: "var(--fs-xs)", color: "var(--text-dim)", margin: "10px 0 0", lineHeight: 1.45 },
  warnNote: { fontSize: "var(--fs-xs)", color: "var(--warn)", margin: "8px 0 0", lineHeight: 1.45 },
  rowWarn: { fontSize: "var(--fs-2xs)", color: "var(--warn)", fontWeight: 400, marginTop: 2, whiteSpace: "normal", maxWidth: 220 },
  actions: { display: "flex", gap: 10, marginTop: 16 },
  resultRow: { display: "flex", gap: 10, alignItems: "center", fontSize: "var(--fs-sm)" },
};
