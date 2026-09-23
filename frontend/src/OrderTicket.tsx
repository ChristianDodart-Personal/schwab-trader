import { useEffect, useRef, useState } from "react";
import { usd } from "./format";
import type { Suggestion } from "./types";

import { API } from "./api";
import { IconWarning } from "./Icon";
import { comboError, offerableTypes } from "./orderEligibility";
import { defaultTiming, describeTiming } from "./orderTiming";

type Acct = { hash: string; mask: string; type: string | null };

const ORDER_TYPES = ["LIMIT", "MARKET", "STOP", "STOP_LIMIT", "TRAILING_STOP"];
const DURATIONS = ["DAY", "GOOD_TILL_CANCEL", "FILL_OR_KILL", "IMMEDIATE_OR_CANCEL"];

// Remember the last-used duration for the session (a preference, not a price/qty — safe to
// carry). Order TYPE is deliberately NOT remembered: its default is session-aware (never a
// MARKET order when the market's closed), a safety choice we don't want a stale value to defeat.
const DUR_KEY = "orderticket.duration.v1";
const rememberedDuration = (): string => {
  try { const d = sessionStorage.getItem(DUR_KEY); return d && DURATIONS.includes(d) ? d : "DAY"; }
  catch { return "DAY"; }
};
const SESSIONS = ["NORMAL", "AM", "PM", "SEAMLESS"];
const label = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export function OrderTicket({
  suggestion,
  onClose,
  onPlaced,
  mode,
}: {
  suggestion: Suggestion;
  onClose: () => void;
  onPlaced?: () => void;
  mode?: string; // "schwab" (real money) | "demo". Undefined → treated as LIVE (fail safe).
}) {
  const [qty, setQty] = useState(suggestion.quantity);
  const [orderType, setOrderType] = useState<string>(suggestion.order_type || "LIMIT");
  const [price, setPrice] = useState(suggestion.limit_price);
  const [stopPrice, setStopPrice] = useState(suggestion.limit_price);
  const [trailingOffset, setTrailingOffset] = useState(5);
  const [trailingType, setTrailingType] = useState("PERCENT");
  const [duration, setDuration] = useState(rememberedDuration);
  const [session, setSession] = useState("NORMAL");
  const [marketSession, setMarketSession] = useState<string | null>(null); // pre|regular|post|closed|unknown
  const [livePrice, setLivePrice] = useState<number | null>(suggestion.limit_price || null);
  const [mkt, setMkt] = useState<{ bid?: number; ask?: number }>({}); // live bid/ask for the limit default
  const priceTouched = useRef(false);   // user edited the limit → stop auto-defaulting it
  const priceDefaulted = useRef(false); // the bid/ask default has been applied once
  // Safety: a SELL's share count is LOCKED by default (a fat-finger sells the wrong size);
  // click Edit to change it. A BUY is always editable.
  const [qtyLocked, setQtyLocked] = useState(suggestion.side !== "BUY");
  const defaultsApplied = useRef(false);
  const userTouched = useRef(false); // user changed type/session/duration before defaults loaded
  const [acct, setAcct] = useState<Acct | null>(null);
  const [acctLoaded, setAcctLoaded] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState<{ ok?: boolean; error?: string; detail?: string; http?: number; order_id?: string; needs_verify?: boolean; needs_confirm?: boolean; warning?: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const modalRef = useRef<HTMLDivElement>(null);
  const downOnOverlay = useRef(false);   // only close when a click starts+ends on the overlay
  const typeRef = useRef<HTMLSelectElement>(null);

  const isLive = mode !== "demo"; // fail safe: only an explicit demo feed is treated as non-live

  useEffect(() => {
    let alive = true;
    fetch(`${API}/accounts/trading`)
      .then((r) => r.json())
      .then((t) =>
        fetch(`${API}/accounts`).then((r) => r.json()).then((list) => {
          if (!alive) return;
          setAcct((list.accounts || []).find((x: Acct) => x.hash === t.trading_hash) ?? null);
          setAcctLoaded(true);
        }),
      )
      .catch(() => alive && setAcctLoaded(true));
    return () => {
      alive = false;
      timers.current.forEach(clearTimeout);
    };
  }, []);

  // Focus the order-type select on open (NOT the confirm button, so a stray Enter
  // can't fire a blind order). Escape closes; Tab is trapped within the modal.
  useEffect(() => {
    typeRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "Tab" && modalRef.current) {
      const nodes = modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])',
      );
      const list = Array.from(nodes);
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  // Current market session → drives the defaults (market vs limit, AM/PM session).
  // On failure default to "unknown" (→ LIMIT), NEVER "regular": a failed read must
  // not pre-select a MARKET order that would fill at an unknown price.
  useEffect(() => {
    let alive = true;
    fetch(`${API}/market-hours`)
      .then((r) => r.json())
      .then((s) => alive && setMarketSession(s.session ?? "unknown"))
      .catch(() => alive && setMarketSession("unknown"));
    return () => { alive = false; };
  }, []);

  // Live price for the estimate (near-accurate beats nothing for a MARKET order).
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API}/quotes`)
        .then((r) => r.json())
        .then((d) => {
          const q = d.quotes?.[suggestion.symbol];
          if (!alive || !q) return;
          if (typeof q.last === "number") setLivePrice(q.last);
          const bid = typeof q.bid === "number" && q.bid > 0 ? q.bid : undefined;
          const ask = typeof q.ask === "number" && q.ask > 0 ? q.ask : undefined;
          setMkt({ bid, ask });
          // Default the limit to the resting side of the spread: SELL → ask (the high),
          // BUY → bid (the low). Applied once, and never after the user edits the price.
          if (!priceDefaulted.current && !priceTouched.current) {
            const side = suggestion.side === "BUY" ? bid : ask;
            if (side && side > 0) { setPrice(side); priceDefaulted.current = true; }
          }
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [suggestion.symbol]);

  const extended = marketSession === "pre" || marketSession === "post";
  const closed = marketSession === "closed" || marketSession === "unknown";
  // Which order types to offer for the detected clock — one shared rule with the Bulk
  // review (orderEligibility): the market-fill types show only in confirmed regular hours;
  // extended/closed/unknown restrict to a price-protected LIMIT.
  const availableTypes = offerableTypes(marketSession, ORDER_TYPES);

  // If the offerable set narrows (the clock resolves to a non-regular session) AFTER the
  // user picked a now-disallowed type, clamp back to LIMIT so we never submit — or show
  // blank — a type the session forbids (the defaults effect is suppressed once userTouched).
  useEffect(() => {
    if (!offerableTypes(marketSession, ORDER_TYPES).includes(orderType)) setOrderType("LIMIT");
  }, [marketSession]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching to a market-type order forces the session back to NORMAL (AM/PM +
  // MARKET is an invalid Schwab combo). LIMIT/STOP_LIMIT are unaffected.
  useEffect(() => {
    const mkt = orderType !== "LIMIT" && orderType !== "STOP_LIMIT";
    if (mkt && session !== "NORMAL") setSession("NORMAL");
  }, [orderType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply session-aware defaults once the session is known (unless the user already
  // touched the controls). See defaultTiming(): regular → MARKET/NORMAL; pre/post →
  // LIMIT in the matching extended session; closed/unknown → LIMIT + SEAMLESS so a
  // stale/failed market-hours read can't strand an after-hours limit in a
  // regular-hours-only order that never fills in extended hours.
  useEffect(() => {
    if (marketSession == null || defaultsApplied.current || userTouched.current) return;
    defaultsApplied.current = true;
    const t = defaultTiming(marketSession, rememberedDuration());
    if (t) { setOrderType(t.orderType); setSession(t.session); setDuration(t.duration); }
  }, [marketSession]);

  const isBuy = suggestion.side === "BUY";
  const sideColor = isBuy ? "var(--pos)" : "var(--neg)";
  const needsLimit = orderType === "LIMIT" || orderType === "STOP_LIMIT";
  const needsStop = orderType === "STOP" || orderType === "STOP_LIMIT";
  const needsTrailing = orderType === "TRAILING_STOP";
  // A market-type order (MARKET, or a triggered STOP/TRAILING_STOP that fills at market)
  // can only run in the NORMAL session — Schwab rejects MARKET in AM/PM. LIMIT/STOP_LIMIT
  // keep all sessions. Gate the dropdown to match so an invalid combo can't be built.
  const marketType = !needsLimit;
  const sessionOptions = marketType ? ["NORMAL"] : SESSIONS;
  // LIMIT estimates at the limit; MARKET/STOP/TRAILING estimate at the live price.
  const estRef = needsLimit ? price : livePrice;
  const est = estRef && estRef > 0 && qty > 0 ? qty * estRef : null;
  const priceValid =
    (!needsLimit || price > 0) && (!needsStop || stopPrice > 0) && (!needsTrailing || trailingOffset > 0);
  // Broker combo rule (mirror of the server's order_eligibility gate): catches the combos
  // the type/session dropdowns can still reach — e.g. STOP_LIMIT or GTC in an extended
  // session — so an invalid order fails here with a clear reason instead of at Schwab.
  const comboErr = comboError(orderType, session, duration);
  const canPlace = !!acct && qty > 0 && priceValid && availableTypes.includes(orderType) && !comboErr && !placing;

  // Poll the broker for this order's status. A freshly placed order can take a few
  // seconds to become queryable, so we poll over a ~20s window and keep going until the
  // status settles (FILLED/REJECTED/etc.) — a market order may read WORKING/PENDING for a
  // moment before it fills. If nothing ever comes back, land on a calm "working" note (the
  // order WAS accepted) rather than a scary "unknown".
  const pollStatus = (orderId: string, hash: string, delays = [800, 1500, 2500, 4000, 6000, 8000]) => {
    if (!delays.length) { setStatus((s) => s ?? "working — see the Orders tab"); return; }
    const [d, ...rest] = delays;
    timers.current.push(setTimeout(() => {
      fetch(`${API}/orders/${orderId}?account_hash=${hash}`)
        .then((r) => r.json())
        .then((o) => {
          const st = o && o.status ? String(o.status) : null;
          if (st) setStatus(st);
          // Keep polling until the backend marks the order settled — it owns the status taxonomy.
          if (!o || !o.settled) pollStatus(orderId, hash, rest);
        })
        .catch(() => pollStatus(orderId, hash, rest));
    }, d));
  };

  const place = (confirm = false) => {
    if (!acct) return;
    setPlacing(true);
    fetch(`${API}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: suggestion.symbol, side: suggestion.side, quantity: qty,
        order_type: orderType, duration, session, account_hash: acct.hash,
        limit_price: needsLimit ? price : null,
        stop_price: needsStop ? stopPrice : null,
        trailing_offset: needsTrailing ? trailingOffset : null,
        trailing_type: trailingType, confirm,
      }),
    })
      .then((r) => r.json())
      .then((res) => {
        setResult(res); setPlacing(false);
        if (res.ok) {
          onPlaced?.();
          // Force an immediate holdings rebuild so the dashboard reflects this trade fast
          // (the backend also self-pokes a resync as a guaranteed follow-up).
          fetch(`${API}/account/sync`, { method: "POST" }).catch(() => {});
        }
        if (res.ok && res.order_id) pollStatus(res.order_id, acct.hash);
      })
      .catch(() => { setResult({ ok: false, error: "network error" }); setPlacing(false); });
  };

  const confirmLabel = placing
    ? "Placing…"
    : isLive
      ? `Place ${suggestion.side}`
      : `Simulate ${suggestion.side} (demo)`;
  // Side-semantic color (green buy / pink sell) — no "LIVE" theatrics; live is default.
  const confirmCls = `btn ${!isLive ? "btn-secondary" : isBuy ? "btn-buy" : "btn-danger"}`;

  return (
    <div className="modal-overlay"
      onMouseDown={(e) => { downOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnOverlay.current) onClose(); }}>
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${suggestion.side} ${suggestion.symbol} order`}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={{ padding: 0 }}
      >
        {/* Live is the default — announce only the exception (not connected). */}
        {!isLive && (
          <div style={S.demoStrip}>Not connected to Schwab — orders won’t place. Reconnect in Settings.</div>
        )}

        <div style={S.body}>
          <div style={S.title}>
            <span style={{ color: sideColor, fontWeight: 700 }}>{suggestion.side}</span>{" "}
            {suggestion.symbol}
            {suggestion.rung ? <span style={S.titleSub}> · position {suggestion.rung}</span> : null}
          </div>
          {suggestion.note && <p style={S.warnNote}><IconWarning /> {suggestion.note}</p>}

          {extended && (
            <p style={S.note}>
              {marketSession === "pre" ? "Pre-market" : "After-hours"} session — limit orders only.
            </p>
          )}
          {closed && (
            <p style={S.note}>
              Market hours couldn't be confirmed right now — this limit defaults to the Seamless session so it stays
              eligible in regular or extended hours. Check the timing below before placing.
            </p>
          )}

          <label style={S.label}>Order type
            <select ref={typeRef} className="field" style={S.field} value={orderType}
              onChange={(e) => { userTouched.current = true; setOrderType(e.target.value); }}>
              {availableTypes.map((t) => <option key={t} value={t}>{label(t)}</option>)}
            </select>
          </label>
          <label style={S.label}>Shares
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {qtyLocked && (
                <button type="button" className="btn btn-secondary" style={S.lockBtn}
                  title="Sell quantity is locked for safety — click to edit"
                  onClick={() => setQtyLocked(false)}>Locked · Edit</button>
              )}
              <input type="number" value={qty} min={1} readOnly={qtyLocked}
                className="field" style={{ ...S.field, ...(qtyLocked ? S.fieldLocked : {}) }}
                onChange={(e) => setQty(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
            </span>
          </label>
          {needsLimit && (
            <>
              <label style={S.label}>Limit price
                <input type="number" value={price} step="0.01" min={0.01} className="field" style={S.field}
                  onChange={(e) => { priceTouched.current = true; setPrice(Number(e.target.value)); }} />
              </label>
              {(mkt.bid || mkt.ask || suggestion.limit_price > 0) && (
                <div style={S.spreadRow}>
                  <button type="button" style={S.spreadBtn} disabled={!mkt.bid}
                    onClick={() => { if (mkt.bid) { priceTouched.current = true; setPrice(mkt.bid); } }}>
                    Bid {mkt.bid ? usd(mkt.bid) : "—"}
                  </button>
                  <button type="button" style={S.spreadBtn} disabled={!mkt.ask}
                    onClick={() => { if (mkt.ask) { priceTouched.current = true; setPrice(mkt.ask); } }}>
                    Ask {mkt.ask ? usd(mkt.ask) : "—"}
                  </button>
                  {suggestion.limit_price > 0 && (
                    <button type="button" style={S.spreadBtn}
                      onClick={() => { priceTouched.current = true; setPrice(suggestion.limit_price); }}>
                      {suggestion.price_label ?? "Target"} {usd(suggestion.limit_price)}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {needsStop && (
            <label style={S.label}>Stop price
              <input type="number" value={stopPrice} step="0.01" min={0.01} className="field" style={S.field}
                onChange={(e) => setStopPrice(Number(e.target.value))} />
            </label>
          )}
          {needsTrailing && (
            <label style={S.label}>Trailing
              <span style={{ display: "flex", gap: 6 }}>
                <input type="number" value={trailingOffset} step="0.1" min={0.1} className="field" style={{ ...S.field, width: 70 }}
                  onChange={(e) => setTrailingOffset(Number(e.target.value))} />
                <select className="field" style={{ width: 74 }} value={trailingType} onChange={(e) => setTrailingType(e.target.value)}>
                  <option value="PERCENT">%</option>
                  <option value="VALUE">$</option>
                </select>
              </span>
            </label>
          )}
          <label style={S.label}>Duration
            <select className="field" style={S.field} value={duration}
              onChange={(e) => { userTouched.current = true; setDuration(e.target.value); try { sessionStorage.setItem(DUR_KEY, e.target.value); } catch { /* private mode */ } }}>
              {DURATIONS.map((d) => <option key={d} value={d}>{label(d)}</option>)}
            </select>
          </label>
          <label style={S.label}>Session
            <select className="field" style={S.field} value={session} disabled={marketType}
              title={marketType ? "Market orders run in the normal session only" : undefined}
              onChange={(e) => { userTouched.current = true; setSession(e.target.value); }}>
              {sessionOptions.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          </label>

          <div style={S.estRow}>
            <span>{isBuy ? "Est. cost" : "Est. proceeds"}</span>
            <b>{est != null ? (needsLimit ? usd(est) : `~ ${usd(est)}`) : "—"}</b>
          </div>
          {/* Plain-English timing so what will actually be sent to Schwab is never hidden.
              Warn when a limit is set to regular-hours-only while the market isn't confirmed
              in the regular session — the exact shape of the silent "Day after-hours" bug. */}
          {needsLimit && (() => {
            const timingWarn = session === "NORMAL" && marketSession != null && marketSession !== "regular";
            return (
              <p style={timingWarn ? S.warnNote : S.note}>
                {timingWarn && <IconWarning />} {describeTiming(session, duration)}
              </p>
            );
          })()}
          {/* Advisory only — the broker enforces margin/settlement. Never blocks placing. */}
          {isBuy && suggestion.buying_power != null && est != null && est > suggestion.buying_power && (
            <p style={S.warnNote}>
              <IconWarning /> Exceeds what you can trade with ({usd(suggestion.buying_power)}) — advisory only; the broker
              enforces margin.
            </p>
          )}
          {!needsLimit && (
            <p style={S.note}>
              {orderType === "MARKET" ? "Market order" : "Fills at market"} — estimated at the current
              price {livePrice ? usd(livePrice) : "(loading…)"}; the actual fill price may differ.
            </p>
          )}
          {!needsLimit && suggestion.limit_price > 0 && !suggestion.price_label && (
            <p style={S.note}>
              Strategy {isBuy ? "position" : "target"} price is {usd(suggestion.limit_price)} — switch to
              Limit to place the ladder order instead of a market fill.
            </p>
          )}

          {comboErr && <p style={S.warnNote}><IconWarning /> {comboErr}</p>}

          <div style={S.acct}>
            {!acctLoaded ? "Resolving trading account…"
              : acct ? <>Trading on <b>{acct.mask} · {acct.type}</b></>
              : <span style={S.warn}><IconWarning /> No trading account selected.</span>}
          </div>

          {!result ? (
            <div style={S.actions}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
              <button className={`${confirmCls}${placing ? " btn-pending" : ""}`} style={{ flex: 2 }} disabled={!canPlace} onClick={() => place()}>
                {confirmLabel}
              </button>
            </div>
          ) : result.needs_confirm ? (
            <div style={S.resultBox}>
              <p style={S.warnNote}><IconWarning /> {result.warning}</p>
              <div style={S.actions}>
                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setResult(null)}>Back</button>
                <button className={`${confirmCls}${placing ? " btn-pending" : ""}`} style={{ flex: 2 }} disabled={placing} onClick={() => place(true)}>
                  {placing ? "Placing…" : isLive ? "Place anyway" : "Simulate anyway"}
                </button>
              </div>
            </div>
          ) : (
            <div style={S.resultBox}>
              {result.ok ? (
                result.order_id ? (
                  <div>Sent ✓ order <code>#{result.order_id}</code>
                    <div style={S.statusLine}>Broker status: <b>{status ?? "checking…"}</b>
                      {status === "REJECTED" && <span style={S.muted}> (expected on an unfunded account)</span>}
                    </div>
                  </div>
                ) : <div>Submitted ✓ — order id not returned. <b>Verify it in the Orders tab.</b></div>
              ) : (
                <div style={{ color: "var(--neg)" }}>Failed: {result.error || result.detail || `order failed (HTTP ${result.http ?? "?"})`}</div>
              )}
              {result.warning && <div style={S.muted}>{result.warning}</div>}
              <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={onClose}>Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  liveStrip: { background: "var(--danger-bg)", borderBottom: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "var(--fs-xs)", fontWeight: 700, letterSpacing: "0.03em", padding: "8px 20px", borderTopLeftRadius: "var(--r-lg)", borderTopRightRadius: "var(--r-lg)" },
  demoStrip: { background: "var(--panel-2)", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: "var(--fs-xs)", fontWeight: 600, padding: "8px 20px", borderTopLeftRadius: "var(--r-lg)", borderTopRightRadius: "var(--r-lg)" },
  body: { padding: 20 },
  title: { fontSize: "var(--fs-lg)", fontWeight: 600, marginBottom: 4 },
  titleSub: { color: "var(--text-dim)", fontWeight: 400 },
  note: { fontSize: "var(--fs-xs)", color: "var(--text-dim)", margin: "8px 0 0", lineHeight: 1.45 },
  warnNote: { fontSize: "var(--fs-xs)", color: "var(--warn)", margin: "8px 0 0", lineHeight: 1.45 },
  label: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginTop: 10 },
  field: { width: 150, textAlign: "right" },
  fieldLocked: { opacity: 0.6, cursor: "not-allowed" },
  lockBtn: { fontSize: "var(--fs-2xs)", padding: "2px 8px", whiteSpace: "nowrap" },
  spreadRow: { display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 6 },
  spreadBtn: { fontSize: "var(--fs-2xs)", padding: "3px 8px", borderRadius: "var(--r-sm)", border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text-muted)", cursor: "pointer" },
  estRow: { display: "flex", justifyContent: "space-between", fontSize: "var(--fs-md)", marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" },
  acct: { fontSize: "var(--fs-xs)", color: "var(--text-dim)", marginTop: 12 },
  warn: { color: "var(--warn)", fontSize: "var(--fs-2xs)", lineHeight: 1.4 },
  actions: { display: "flex", gap: 10, marginTop: 18 },
  resultBox: { marginTop: 16, fontSize: "var(--fs-sm)" },
  statusLine: { marginTop: 8, color: "var(--text-muted)" },
  muted: { color: "var(--text-faint)", marginTop: 6, fontSize: "var(--fs-xs)" },
};
