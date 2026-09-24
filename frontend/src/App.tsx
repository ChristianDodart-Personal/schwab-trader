import { useEffect, useRef, useState } from "react";
import { usd, pct } from "./format";
import { ProfileAccountMenu } from "./ProfileAccountMenu";
import { AuthBanner, LiveStatusPill, useLiveness } from "./AuthBanner";
import { ReauthButton } from "./Reauth";
import { UpdateBanner } from "./UpdateBanner";
import { matchesRule, type SignalRule } from "./signals";
import { BulkReviewModal, useBulk } from "./Bulk";
import { ColumnManager } from "./ColumnManager";
import { useCellDensity } from "./density";
import { lastPosGainPct } from "./rowDerived";
import { ConfirmDialog } from "./Modal";
import { DASH_COLUMNS, DASH_COLUMN_LIST, DEFAULT_DASH_COLS, DEFAULT_DASH_FOLDED, SIMPLE_DASH_COLS, useColumnPrefs, useFoldPrefs } from "./columns";
import { KpiPicker, useKpiPrefs, visibleKpis } from "./kpis";
import { useGlossaryFigures } from "./GlossaryUI";
import { useDemoFeed } from "./demo";
import { useDashboardData } from "./useDashboardData";
import { DashboardTable } from "./DashboardTable";
import { AccountBand } from "./AccountBand";
import { DashboardStrip } from "./DashboardStrip";
import { tickerRiskColor } from "./columns";
import { Ledger } from "./Ledger";
import { NotificationsProvider, NotificationsTab } from "./Notifications";
import { useNotifs } from "./notifications/store";
import { KIND_FALLBACK, KIND_ICON } from "./notifications/FeedPanel";
import { Orders } from "./Orders";
import { OrderTicket } from "./OrderTicket";
import { PositionDetail } from "./PositionDetail";
import { MarketHoursBadge } from "./MarketHoursBadge";
import { Settings } from "./Settings";
import { FinancialRules } from "./FinancialRules";
import { Method } from "./Method";
import { Explore } from "./Explore";
import { SkeletonTable } from "./Skeleton";
import { useToast } from "./Toast";
import type { AlertPrefill, DashboardRow, Suggestion } from "./types";

import { API } from "./api";
import { IconWarning, IconClose, IconSearch } from "./Icon";

const NAV: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "ledger", label: "Ledger" },
  { id: "orders", label: "Orders" },
  { id: "rules", label: "Rules" },
  { id: "method", label: "Method" },
  { id: "notifications", label: "Notifications" },
  { id: "explore", label: "Explore" },
  { id: "settings", label: "Settings" },
];
type View = "dashboard" | "ledger" | "orders" | "rules" | "method" | "notifications" | "explore" | "settings";

export function App() {
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [showHelp, setShowHelp] = useState(false);
  const [symQuery, setSymQuery] = useState("");        // Ctrl+F find-bar filter (by ticker)
  const [findOpen, setFindOpen] = useState(false);     // browser-style find bar (hidden until Ctrl+F)
  // Dashboard view pill: All / To-Do / Top 10 / Simple. Persisted so it sticks.
  type DashSub = "all" | "todo" | "top" | "simple";
  const [dashSub, setDashSubRaw] = useState<DashSub>(() => {
    try { const v = localStorage.getItem("dash.sub.v1"); return (v === "todo" || v === "top" || v === "simple") ? v : "all"; }
    catch { return "all"; }
  });
  const setDashSub = (v: DashSub) => {
    setDashSubRaw(v);
    try { localStorage.setItem("dash.sub.v1", v); } catch { /* private mode */ }
  };
  const symInputRef = useRef<HTMLInputElement>(null);
  const gPending = useRef(false); // "g" prefix for vim-style tab jumps (g then d/s/l/o/r)
  const setGlossFigures = useGlossaryFigures();
  const [signalRules, setSignalRules] = useState<SignalRule[]>([]);
  const [acctKey, setAcctKey] = useState("");
  const [addSym, setAddSym] = useState("");
  const [watchTicket, setWatchTicket] = useState<Suggestion | null>(null);
  const [alertPrefill, setAlertPrefill] = useState<AlertPrefill | null>(null);
  // Migrate pre-v0.43 layouts: Price + Last Pos P/L used to be pinned (not in the saved
  // list). If a saved layout has neither, they're a legacy layout — prepend them so those
  // columns don't vanish. New layouts (which include at least one) are left untouched.
  const dashCols = useColumnPrefs(
    "dash.cols.v1", DEFAULT_DASH_COLS, DASH_COLUMN_LIST,
    (ids) => (ids.includes("price") || ids.includes("last_pos_profit")) ? ids : ["price", "last_pos_profit", ...ids],
  );
  // Which columns are folded behind the chevron (membership, persisted + editable in
  // the Columns manager) — independent of column order.
  const dashFold = useFoldPrefs("dash.fold.cols.v1", DEFAULT_DASH_FOLDED);
  // Simple mode is now the "Simple" dashboard pill (holdings only, a compact fixed set).
  const simple = dashSub === "simple";
  // Column-collapse state lives here (not in DashboardTable) so a Columns → Reset can also
  // re-collapse the extra columns — otherwise Reset can leave the chevron scrolled off
  // the right edge of a wide, expanded table.
  const [dashFolded, setDashFolded] = useState<boolean>(() => {
    try { return localStorage.getItem("dash.fold.v1") !== "0"; } catch { return true; }
  });
  const setFold = (v: boolean) => {
    setDashFolded(v);
    try { localStorage.setItem("dash.fold.v1", v ? "1" : "0"); } catch { /* private mode */ }
  };
  const toggleDashFold = () => setFold(!dashFolded);
  const kpiPrefs = useKpiPrefs();
  const toast = useToast();
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const [ordersFilter, setOrdersFilter] = useState<string | null>(null);
  const cellDensity = useCellDensity();
  const live = useLiveness();
  // The dashboard's live read-model (WS feed, cash/margin, working orders, stale flag).
  // Account SELECTION and the UI resets a switch triggers stay here in the shell; the hook
  // only reacts to the resulting acctKey/view.
  const { data, connected, cash: cashInfo, margin, working, pricesStale } = useDashboardData(acctKey, view, live);
  const { count: workingOrders, bySym: workingBySym } = working;
  const bulk = useBulk(data?.rows, data?.mode, toast);
  // Demo/showcase feed: when on, drives the dashboard display with simulated ticks +
  // fills so the themes/motion come alive on a closed market. Display-only, in-memory
  // (a reload turns it off), and it never touches the order path — bulk stays on `data`.
  const demoOn = false;   // demo/showcase mode retired from the UI (Aug 2026) — kept as a
  const shown = useDemoFeed(data, demoOn);   // constant so downstream display logic is unchanged
  // Dashboard table rows after the Ctrl+F ticker filter. Bulk keeps the FULL row set.
  const dashRows = (shown?.rows ?? []).filter((r) =>
    !symQuery || r.symbol.toUpperCase().includes(symQuery));
  // To-Do: held positions meeting a BUY or SELL signal (built-in mark OR a custom rule).
  const todoRows = (shown?.rows ?? []).filter((r) =>
    !r.is_watch && (r.buy_mark || r.sell_mark || signalRules.some((rule) => matchesRule(rule, r))));
  // Simple mode shows real holdings only (no watchlist rows) and a fixed essentials
  // column set. Ticker + Price are always rendered; these are the extra columns.
  const holdingsRows = (shown?.rows ?? []).filter((r) => !r.is_watch);
  const SIMPLE_COLS = SIMPLE_DASH_COLS;

  // One-time "you just updated" toast: compare the running version to the last one we saw.
  // Only fires when it actually changed (not on a fresh install), then records the new one.
  useEffect(() => {
    fetch(`${API}/version`).then((r) => r.json()).then((j) => {
      const v = j?.version;
      if (!v) return;
      const key = "app.lastSeenVersion";
      let prev: string | null = null;
      try { prev = localStorage.getItem(key); } catch { /* private mode */ }
      if (prev && prev !== v) toast(`Updated to v${v} — see what's new under Settings.`, "success");
      try { localStorage.setItem(key, v); } catch { /* private mode */ }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Custom signal rules (per account). Refetch on account switch + whenever we return to the
  // dashboard, so edits made in Settings show up without a full reload.
  useEffect(() => {
    let alive = true;
    fetch(`${API}/signal-rules`).then((r) => r.json())
      .then((j) => { if (alive && Array.isArray(j?.rules)) setSignalRules(j.rules); }).catch(() => {});
    return () => { alive = false; };
  }, [acctKey, view]);

  // Feed the selected account's live figures to the glossary so definitions can show
  // their formula worked out on real numbers ("on this account now").
  useEffect(() => {
    setGlossFigures({
      accountValue: margin?.account_value ?? null,
      cash: margin?.cash ?? null,
      invested: data?.total_invested ?? null,
      marketValue: data?.total_value ?? null,
      unrealized: data?.total_unrealized ?? null,
      longMarketValue: margin?.long_market_value ?? null,
      equity: margin?.equity ?? null,
      deployedPct: margin?.deployed_pct ?? null,
      leverage: margin?.leverage ?? null,
      marginDebt: margin?.debt ?? null,
      maintenance: margin?.maintenance_requirement ?? null,
      maintCushion: margin?.maint_cushion ?? null,
      tradableFunds: margin?.tradable_funds ?? null,
      harvestable: data?.harvestable ?? null,
      dayChange: data?.total_day_change ?? null,
    });
  }, [data, margin, setGlossFigures]);

  // Guard tab/account switches when Settings has unsaved edits → custom confirm.
  const guardedNav = (action: () => void) => {
    if (view === "settings" && settingsDirty) setPendingNav(() => action);
    else action();
  };

  // Keyboard shortcuts: digits 1..N jump to a tab (through the same dirty-settings guard),
  // "?" toggles the help overlay. Ignored while typing in a field or when a modal is open,
  // so it never fights with order tickets, search boxes, or dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Browser-style find: Ctrl/Cmd+F opens the hidden ticker find bar on the dashboard
      // (works from anywhere, even mid-typing, exactly like a browser's find). Handled
      // before the modifier bail-out below so the app owns it instead of the OS.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
        if (view === "dashboard" && !simple && dashSub === "all" && !document.querySelector(".modal-overlay")) {
          e.preventDefault();
          setFindOpen(true);
          setTimeout(() => symInputRef.current?.focus(), 0);
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (e.key === "Escape" && showHelp) { setShowHelp(false); return; }
      if (document.querySelector(".modal-overlay")) return; // don't reach behind a modal
      // vim-style: "g" then a tab's first letter (g d/s/l/o/r). Consume the letter here.
      if (gPending.current) {
        gPending.current = false;
        const t = NAV.find((n) => n.id[0] === e.key.toLowerCase());
        if (t) { e.preventDefault(); guardedNav(() => setView(t.id)); return; }
      }
      if (e.key === "g") { gPending.current = true; setTimeout(() => { gPending.current = false; }, 900); return; }
      if (e.key === "?") { e.preventDefault(); setShowHelp((v) => !v); return; }
      if (/^[1-9]$/.test(e.key)) {
        const t = NAV[Number(e.key) - 1];
        if (t) { e.preventDefault(); guardedNav(() => setView(t.id)); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // re-bound each render so the guard sees current view/settingsDirty

  // Commit an account switch: persist server-side FIRST, then reset views. Awaiting
  // the select avoids a race where the acctKey-keyed child views remount and fetch
  // before the backend's selected-account has actually changed (stale data).
  const commitAccount = (hash: string) => {
    fetch(`${API}/accounts/select`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hash }),
    })
      .then((r) => { if (!r.ok) throw new Error(); setAcctKey(hash); setSelected(null); bulk.cancel(); })
      .catch(() => toast("Couldn't switch account — try again.", "error"));
  };
  // The switch (server select + commit) is deferred through the dirty-Settings
  // guard — so cancelling truly leaves the account (and order routing) unchanged.
  const onAccountChange = (hash: string) => {
    if (hash === acctKey) return;
    guardedNav(() => commitAccount(hash));
  };

  // Account init lives in the shell now (was in AccountPicker): sync acctKey to the
  // server's already-selected account on startup, so the dashboard works even though
  // the account picker itself moved to the Profile tab (mounted only when viewed).
  // This just mirrors state — no /accounts/select POST — so it never disturbs the feed.
  useEffect(() => {
    fetch(`${API}/accounts`).then((r) => r.json())
      .then((j) => { if (j?.selected_hash) setAcctKey(j.selected_hash); })
      .catch(() => {});
  }, []);

  const mode = data?.mode;

  // Bulk selection only makes sense on the dashboard — leaving it cancels.
  useEffect(() => { if (view !== "dashboard") { bulk.cancel(); setFindOpen(false); } }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTicker = () => {
    const sym = addSym.trim().toUpperCase();
    if (!sym) return;
    fetch(`${API}/tickers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: sym }),
    })
      .then((r) => r.json())
      .then((res) => { if (res.ok) setAddSym(""); else toast(res.error || `Couldn't add ${sym}`); })
      .catch(() => toast(`Couldn't add ${sym} — network error`));
  };
  const removeTicker = (sym: string) => {
    fetch(`${API}/tickers/${sym}`, { method: "DELETE" }).catch(() => {});
    toast(`Removed ${sym} from watchlist`, "info", {
      label: "Undo",
      onClick: () =>
        fetch(`${API}/tickers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: sym }),
        }).catch(() => {}),
    });
  };
  const buyWatch = (row: DashboardRow) =>
    // Default the size to a first ladder position (rung-1 dollars ÷ price), not a bare 1 share.
    setWatchTicket({ symbol: row.symbol, side: "BUY", order_type: "LIMIT", quantity: row.first_buy_shares ?? 1, limit_price: row.price ?? 0 });
  const onAlert = (row: DashboardRow) => {
    setAlertPrefill({ symbol: row.symbol, price: row.price });
    setView("notifications");   // the alert form lives on the Notifications tab now
  };
  // Auto-sync the SELECTED account behind the scenes — no button. The backend also
  // resyncs on account-switch and on a steady ~2-min timer (main.py); this fires one
  // more refresh when you refocus the app after being away. Silent + throttled; the WS
  // dashboard repaints automatically when the resync changes anything.
  useEffect(() => {
    let last = 0;
    const trigger = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < 45000) return;   // at most once per 45s
      last = now;
      fetch(`${API}/account/sync`, { method: "POST" }).catch(() => {});
    };
    window.addEventListener("focus", trigger);
    document.addEventListener("visibilitychange", trigger);
    return () => { window.removeEventListener("focus", trigger); document.removeEventListener("visibilitychange", trigger); };
  }, []);

  return (
    <NotificationsProvider acctKey={acctKey}>
    <main className="app-main">
      <div className="app-container">
        <header style={S.header}>
          {/* Left cluster: brand + live status + KPI glance + alerts (moved from the
              right per the layout request). Nav tabs now sit on the right. */}
          <div style={S.brandZone}>
            <div style={S.statusZone}>
              <ConnDot connected={connected} />
              <FeedTag mode={mode} />
              <LiveStatusPill />
              <MarketHoursBadge />
            </div>
            {/* KPI glance moved out of the header into the full-width AccountBand row
                below (rendered under the top bar). The status pills stay here. */}
          </div>

          {/* Right cluster: the profile/account chip sits in the very top-right corner,
              with the primary nav tabs directly beneath it. */}
          <div style={S.headerRight}>
            <ProfileAccountMenu acctKey={acctKey} onSelectAccount={onAccountChange} />
            <nav style={S.nav} aria-label="Primary">
              {NAV.map((t) => (
                <button
                  key={t.id}
                  className="navtab"
                  aria-current={view === t.id ? "page" : undefined}
                  onClick={() => guardedNav(() => { if (t.id === "orders") setOrdersFilter(null); setView(t.id); })}
                >
                  {t.label}
                  {t.id === "orders" && workingOrders > 0 && (
                    <span style={S.navBadge} title={`${workingOrders} working order${workingOrders === 1 ? "" : "s"}`}>{workingOrders}</span>
                  )}
                  {t.id === "notifications" && <NotifNavBadge />}
                </button>
              ))}
            </nav>
          </div>
        </header>

        {/* Full-width account band — its own row beneath the top bar (dashboard only).
            Holds the hero account value + today's change, the customizable KPI widgets
            (with the picker gear), and a right-pushed capital-deployment meter. */}
        {view === "dashboard" && data && (
          <div style={{ marginTop: 14 }}>
            <AccountBand
              accountValue={margin?.account_value ?? ((data.total_value ?? 0) + (cashInfo?.cash ?? 0))}
              dayChange={data.total_day_change ?? null}
              deployedPct={margin?.deployed_pct ?? null}
              kpis={visibleKpis(kpiPrefs.ids, shown ?? data, cashInfo)}
              picker={<KpiPicker prefs={kpiPrefs} />}
            />
          </div>
        )}

        <UpdateBanner />
        <AuthBanner />

        {/* Browser-style find bar: hidden until Ctrl/Cmd+F, floats at the top-right,
            filters the dashboard by ticker, and closes on Esc — just like a browser. */}
        {findOpen && view === "dashboard" && !simple && dashSub === "all" && (
          <div style={S.findBar} role="search" aria-label="Find ticker">
            <span style={{ display: "inline-flex", color: "var(--text-dim)" }} aria-hidden="true"><IconSearch size={15} /></span>
            <input ref={symInputRef} value={symQuery} placeholder="Find ticker…" aria-label="Find ticker"
              style={S.findInput}
              onChange={(e) => setSymQuery(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); setSymQuery(""); setFindOpen(false); }
              }} />
            <span style={S.findCount}>
              {symQuery
                ? `${dashRows.length} match${dashRows.length === 1 ? "" : "es"}`
                : `${shown?.rows.length ?? 0} tickers`}
            </span>
            <button className="btn btn-ghost btn-sm" aria-label="Close find (Esc)" title="Close (Esc)"
              onClick={() => { setSymQuery(""); setFindOpen(false); }}><IconClose /></button>
          </div>
        )}

        {view === "dashboard" && (
        <div style={S.subbar}>
          {(bulk.active ? (
            <span style={S.bulkBar}>
              {bulk.loading ? (
                <span style={S.note}>Loading {bulk.kind === "sell" ? "sell" : "buy"} plan…</span>
              ) : (
                <>
                  <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
                    <b>{bulk.checkedCount}</b> selected
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={bulk.toggleAll}>
                    {bulk.allChecked ? "Select none" : "Select all"}
                  </button>
                  {/* Action buttons appear only in bulk mode: run that action on the picks. */}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                    <button className="btn btn-buy" disabled={!bulk.checkedCount} onClick={() => bulk.run("buy")}>Buy</button>
                    <button className="btn btn-danger" disabled={!bulk.checkedCount} onClick={() => bulk.run("sell")}>Sell</button>
                    <button className="btn btn-secondary" onClick={bulk.escape}>Escape</button>
                  </span>
                </>
              )}
            </span>
          ) : (
            <span style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
              {!simple && (
                <button className="btn btn-secondary" disabled={bulk.holdingsCount === 0}
                  title="Bulk mode: pick your holdings, then Buy or Sell them together"
                  onClick={() => { setSelected(null); bulk.enter(); }}>
                  Bulk
                </button>
              )}
            </span>
          ))}
        </div>
        )}

        {mode === "demo" && (
          <div style={S.demoChip} role="status">
            <span className="tag" style={S.demoTag}>DEMO</span>
            <span style={{ flex: 1 }}>
              The numbers below are synthetic — orders won't place. Connect Schwab to see your real account.
            </span>
            <ReauthButton label="Connect Schwab" style={S.demoBtn} />
          </div>
        )}

        {view === "settings" ? (
          <Settings key={acctKey} onDirtyChange={setSettingsDirty} />
        ) : view === "rules" ? (
          <FinancialRules key={acctKey} onDirtyChange={setSettingsDirty} />
        ) : view === "method" ? (
          <Method key={acctKey} />
        ) : view === "explore" ? (
          <Explore key={acctKey} />
        ) : view === "notifications" ? (
          <NotificationsTab prefill={alertPrefill} onPrefillConsumed={() => setAlertPrefill(null)} />
        ) : view === "ledger" ? (
          <Ledger key={acctKey} />
        ) : view === "orders" ? (
          <Orders key={`${acctKey}:${ordersFilter ?? ""}`} initialFilter={ordersFilter ?? undefined} />
        ) : (
          <>
            {data ? (
              <>
                {pricesStale && (
                  <p style={S.staleNote} role="status">
                    <IconWarning /> Prices may be stale — Schwab isn’t responding to live requests. Reconnect under
                    Settings → Schwab connection.
                  </p>
                )}
                <div style={S.dashSubtabs} role="tablist" aria-label="Dashboard views">
                  {([["all", "All"], ["todo", "To-Do"], ["top", "Top 10"], ["simple", "Simple"]] as const).map(([k, label]) => (
                    <button key={k} role="tab" aria-selected={dashSub === k} className="btn btn-sm"
                      style={dashSub === k ? S.subActive : S.subIdle} onClick={() => setDashSub(k)}>
                      {label}{k === "todo" && todoRows.length ? ` · ${todoRows.length}` : ""}
                    </button>
                  ))}
                </div>
                {dashSub === "top" && !simple ? (
                  <Top10 rows={shown?.rows ?? data.rows} onSelect={(sym) => setSelected(sym === selected ? null : sym)} />
                ) : (
                  <>
                    {!simple && dashSub === "all" && (
                      <div style={S.filterBar}>
                        {symQuery && (
                          <span style={{ color: "var(--text-faint)", fontSize: "var(--fs-xs)" }}>
                            showing {dashRows.length} of {shown?.rows.length ?? 0} · <b style={{ color: "var(--text-muted)" }}>“{symQuery}”</b>
                          </span>
                        )}
                        <span style={{ marginLeft: "auto" }}>
                          {/* align right so the popover opens leftward (never off-screen);
                              Reset also re-collapses the extra columns so the chevron stays visible. */}
                          <ColumnManager prefs={dashCols} labelOf={(id) => DASH_COLUMNS[id]?.label ?? id}
                            align="right" fold={dashFold} density={cellDensity} onReset={() => { setFold(true); dashFold.reset(); }} />
                        </span>
                      </div>
                    )}
                    {!simple && dashSub === "todo" && (
                      <p style={S.note}>
                        {todoRows.length
                          ? `${todoRows.length} position${todoRows.length === 1 ? "" : "s"} meeting a buy or sell signal right now.`
                          : "Nothing meets a buy or sell signal right now — you're all caught up."}
                      </p>
                    )}
                    <div style={pricesStale ? { opacity: 0.55, transition: "opacity .2s" } : undefined}>
                      <DashboardTable
                        rows={simple ? holdingsRows : (dashSub === "todo" ? todoRows : dashRows)}
                        cols={simple ? SIMPLE_COLS : dashCols.ids}
                        simple={simple}
                        foldedCols={dashFold.folded}
                        collapsed={dashFolded}
                        onToggleCollapse={toggleDashFold}
                        tickerAdder={!simple && dashSub === "all" && !bulk.active
                          ? { value: addSym, onChange: setAddSym, onSubmit: addTicker }
                          : undefined}
                        selected={selected}
                        onSelect={(sym) => setSelected(sym === selected ? null : sym)}
                        onRemoveTicker={removeTicker}
                        onBuyWatch={buyWatch}
                        onAlert={onAlert}
                        bulk={bulk.bulkUI}
                        signalRules={signalRules}
                        working={workingBySym}
                        onShowOrders={(sym) => { setOrdersFilter(sym); guardedNav(() => setView("orders")); }}
                        renderDetail={(sym) => (
                          <PositionDetail symbol={sym} mode={mode} onClose={() => setSelected(null)} embedded />
                        )}
                      />
                    </div>
                    {/* Bottom "at a glance" strip — three summary cards below the table.
                        Shown on All / To-Do (this is the non-"top" branch); hidden in the
                        deliberately minimal Simple view. */}
                    {!simple && data && (
                      <div style={{ marginTop: 24 }}>
                        <DashboardStrip data={shown ?? data} />
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <SkeletonTable />
            )}
          </>
        )}

        {watchTicket && <OrderTicket suggestion={watchTicket} mode={mode} onClose={() => setWatchTicket(null)} />}

        {bulk.review && bulk.kind && (
          <BulkReviewModal
            kind={bulk.kind}
            items={bulk.selected}
            mode={mode}
            placing={bulk.placing}
            result={bulk.result}
            buyingPower={bulk.buyingPower}
            onConfirm={bulk.confirm}
            onClose={bulk.closeReview}
          />
        )}

        {pendingNav && (
          <ConfirmDialog
            title="Discard unsaved changes?"
            message="You have unsaved settings changes. Leaving will discard them."
            confirmLabel="Discard"
            cancelLabel="Keep editing"
            danger
            onConfirm={() => { setSettingsDirty(false); const go = pendingNav; setPendingNav(null); go(); }}
            onCancel={() => setPendingNav(null)}
          />
        )}

        {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      </div>
    </main>
    </NotificationsProvider>
  );
}

// Per-type unread pills on the Notifications nav tab — a separate bubble per category
// (order fills, strategy triggers, price alerts, system) so the mix reads at a glance,
// instead of one aggregate count. Same glyph/color language as the feed itself.
const NOTIF_PILL_ORDER = ["fill", "trigger", "alert", "notice", "system"];
function NotifNavBadge() {
  const { unreadByKind } = useNotifs();
  // Known kinds in a fixed order; anything else is summed into one "other" pill.
  const other = Object.entries(unreadByKind)
    .filter(([k]) => !NOTIF_PILL_ORDER.includes(k))
    .reduce((s, [, n]) => s + n, 0);
  const pills = [...NOTIF_PILL_ORDER.map((k) => [k, unreadByKind[k] ?? 0] as const), ["other", other] as const]
    .filter(([, n]) => n > 0);
  if (pills.length === 0) return null;
  return (
    <span style={S.notifPills}>
      {pills.map(([k, n]) => {
        const meta = KIND_ICON[k] ?? KIND_FALLBACK;
        return (
          <span key={k} style={{ ...S.notifPill, color: meta.color, borderColor: meta.color }}
            title={`${n} unread ${meta.label.toLowerCase()}${n === 1 ? "" : "s"}`}>
            <span aria-hidden="true">{meta.glyph}</span>{n}
          </span>
        );
      })}
    </span>
  );
}

// Keyboard-shortcut cheat sheet (toggled with "?"). Reuses the modal overlay styling.
function HelpOverlay({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ...NAV.map((t, i) => [String(i + 1), `Go to ${t.label}`] as [string, string]),
    ["g then d/s/l/o/r", "Jump to a tab (vim-style)"],
    ["Ctrl/Cmd + F", "Find a ticker (dashboard)"],
    ["?", "Show / hide this help"],
    ["Esc", "Close dialogs"],
  ];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()} style={{ padding: 20, maxWidth: 380 }}>
        <div style={{ fontSize: "var(--fs-lg)", fontWeight: 600, marginBottom: 12 }}>Keyboard shortcuts</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map(([k, label]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "var(--fs-sm)" }}>
              <span style={{ color: "var(--text-muted)" }}>{label}</span>
              <kbd style={S.kbd}>{k}</kbd>
            </div>
          ))}
        </div>
        <p style={{ color: "var(--text-faint)", fontSize: "var(--fs-xs)", marginTop: 14 }}>
          Shortcuts are ignored while you're typing in a field or a dialog is open.
        </p>
        <button className="btn btn-secondary" style={{ marginTop: 14, width: "100%" }} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function ConnDot({ connected }: { connected: boolean }) {
  // The browser↔app data socket. It's almost always up, and the meaningful "Live"
  // (Schwab API) is LiveStatusPill — so when connected we show NOTHING (no mystery
  // dot). Only surface the exception: a dropped socket needs the user's attention.
  if (connected) return null;
  return <span className="pill" style={{ background: "var(--warn-bg)", color: "var(--warn)" }}>reconnecting…</span>;
}

function FeedTag({ mode }: { mode?: string }) {
  // Live is the expected default — don't announce it. Flag only the exceptions:
  // demo (profile not connected) and starting (feed connecting/reconnecting —
  // e.g. Schwab's overnight maintenance; it retries and goes live by itself).
  if (mode === "demo") {
    return (
      <span className="pill" style={{ background: "var(--warn-bg)", color: "var(--warn)" }} title="Not connected to Schwab — reconnect in Settings">
        Demo — not live
      </span>
    );
  }
  if (mode === "starting") {
    return (
      <span className="pill" style={{ background: "var(--panel-2)", color: "var(--text-muted)" }} title="Connecting to Schwab's quote stream — retries automatically (prices resume when it connects)">
        Feed connecting…
      </span>
    );
  }
  if (mode === "reauth") {
    return (
      <span className="pill" style={{ background: "var(--warn-bg)", color: "var(--warn)" }} title="Schwab rejected the token — the quote stream can't connect. Reconnect under Settings.">
        Feed offline — reconnect
      </span>
    );
  }
  return null;
}

// Top 10 — quick glance at the day's most actionable names. Two lists from the held rows:
// deepest dips (lowest LILO %, i.e. most below the last buy → buy-worthy) and biggest
// last-position gains (profit ÷ cost → sell-worthy). Both clickable to drill in.
function Top10({ rows, onSelect }: { rows: DashboardRow[]; onSelect: (s: string) => void }) {
  const held = rows.filter((r) => !r.is_watch);
  const dips = held
    .filter((r) => r.lilo_pct != null)
    .sort((a, b) => (a.lilo_pct as number) - (b.lilo_pct as number))
    .slice(0, 10);
  const gainPct = lastPosGainPct;  // one source for last-position gain%
  const gainers = held
    .filter((r) => gainPct(r) != null)
    .sort((a, b) => (gainPct(b) as number) - (gainPct(a) as number))
    .slice(0, 10);

  const Sym = ({ r }: { r: DashboardRow }) => (
    <button className="btn btn-ghost btn-sm" style={{ padding: "0 4px", fontWeight: 700, color: tickerRiskColor(r.risk) }}
      onClick={() => onSelect(r.symbol)}>{r.symbol}</button>
  );

  return (
    <div style={S.top10grid}>
      <section className="panel" style={{ padding: 14 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: "var(--fs-md)" }}>Top dips — buy-worthy</h3>
        {dips.length ? (
          <table className="tbl">
            <thead><tr><th style={{ textAlign: "left" }}>Ticker</th><th style={{ textAlign: "right" }}>Price</th><th style={{ textAlign: "right" }}>LILO</th></tr></thead>
            <tbody>
              {dips.map((r) => (
                <tr key={r.symbol}>
                  <td><Sym r={r} /></td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(r.price)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-muted)" }}>{pct(r.lilo_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p style={S.note}>No priced positions yet.</p>}
      </section>
      <section className="panel" style={{ padding: 14 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: "var(--fs-md)" }}>Top gainers — sell-worthy</h3>
        {gainers.length ? (
          <table className="tbl">
            <thead><tr><th style={{ textAlign: "left" }}>Ticker</th><th style={{ textAlign: "right" }}>Price</th><th style={{ textAlign: "right" }}>Last-pos gain</th></tr></thead>
            <tbody>
              {gainers.map((r) => {
                const g = gainPct(r) as number;
                return (
                  <tr key={r.symbol}>
                    <td><Sym r={r} /></td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(r.price)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: g >= 0 ? "var(--pos)" : "var(--neg)" }}>
                      {g >= 0 ? "+" : ""}{g.toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p style={S.note}>No priced positions yet.</p>}
      </section>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, rowGap: 12, flexWrap: "wrap" },
  // Left zone takes the leftover width and can shrink to nothing (minWidth 0) — its KPI
  // cluster scrolls rather than pushing the nav. The right zone never shrinks, so the tabs
  // keep their room and never wrap mid-row regardless of font size or widget count.
  brandZone: { display: "flex", alignItems: "center", gap: 14, minWidth: 0, flex: "1 1 auto", flexWrap: "wrap", rowGap: 10 },
  h1: { fontSize: "var(--fs-xl)", fontWeight: 700, margin: 0, letterSpacing: "-0.01em", whiteSpace: "nowrap" },
  headerRight: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flex: "0 0 auto", maxWidth: "100%" },
  nav: { display: "flex", gap: 4, flexWrap: "nowrap", justifyContent: "flex-start", maxWidth: "100%", overflowX: "auto", overflowY: "hidden" },
  navBadge: { marginLeft: 6, background: "var(--warn)", color: "var(--on-bright)", fontSize: "var(--fs-2xs)", fontWeight: 700, borderRadius: "var(--r-pill)", padding: "0 6px", lineHeight: 1.6 },
  notifPills: { display: "inline-flex", gap: 3, marginLeft: 6, flexWrap: "nowrap", verticalAlign: "middle" },
  notifPill: { display: "inline-flex", alignItems: "center", gap: 2, fontSize: "var(--fs-2xs)", fontWeight: 700, lineHeight: 1.5, border: "1px solid", borderRadius: "var(--r-pill)", padding: "0 5px", background: "transparent" },
  rightZone: { display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", justifyContent: "flex-end" },
  statusZone: { display: "flex", alignItems: "center", gap: 10 },
  statusItem: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--fs-xs)", color: "var(--text-dim)", whiteSpace: "nowrap" },
  dot: { width: 7, height: 7, borderRadius: "50%", display: "inline-block", flexShrink: 0 },
  kpiZone: { display: "flex", alignItems: "center", gap: 2, minWidth: 0 },
  kpiCluster: { display: "flex", alignItems: "stretch", border: "1px solid var(--border)", borderRadius: "var(--r-md)", minWidth: 0, maxWidth: "100%", overflowX: "auto", overflowY: "hidden" },
  kpi: { padding: "3px 14px", borderLeft: "1px solid var(--border-hairline)" },
  kpiLabel: { fontSize: "var(--fs-2xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)" },
  kpiVal: { fontSize: "var(--fs-lg)", fontWeight: 600, fontVariantNumeric: "tabular-nums", display: "flex", alignItems: "center" },
  kpiHero: { fontSize: "var(--fs-2xl)", fontWeight: 700, fontVariantNumeric: "tabular-nums", display: "flex", alignItems: "center", lineHeight: 1.1 },
  subbar: { display: "flex", alignItems: "center", gap: 16, marginTop: 18, flexWrap: "wrap" },
  // Floating browser-style find bar (Ctrl/Cmd+F). Fixed top-right, above content.
  findBar: { position: "fixed", top: 14, right: 18, zIndex: 60,
    display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 6px 12px",
    background: "var(--pop)", border: "1px solid var(--border-strong)", borderRadius: "var(--r-md)",
    boxShadow: "var(--shadow-pop)" },
  findInput: { border: "none", background: "transparent", color: "var(--text)", font: "inherit",
    fontSize: "var(--fs-sm)", outline: "none", width: 170, height: 26 },
  findCount: { fontSize: "var(--fs-2xs)", color: "var(--text-faint)", whiteSpace: "nowrap", minWidth: 62, textAlign: "right" },
  bulkBar: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  addWrap: { display: "flex", gap: 6, alignItems: "center" },
  note: { color: "var(--text-muted)", fontSize: "var(--fs-md)", marginTop: 16 },
  demoChip: { display: "flex", alignItems: "center", gap: 10, margin: "12px 0 2px", padding: "8px 12px",
    background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: "var(--r-md)",
    color: "var(--text-muted)", fontSize: "var(--fs-sm)" },
  demoTag: { color: "var(--warn)", border: "1px solid var(--warn-border)", fontWeight: 700, letterSpacing: "0.05em" },
  demoBtn: { flexShrink: 0 },
  staleNote: { color: "var(--warn)", fontSize: "var(--fs-sm)", margin: "0 0 10px", lineHeight: 1.45 },
  filterBar: { display: "flex", alignItems: "center", gap: 10, margin: "0 0 10px", flexWrap: "wrap" },
  // Segmented control (All / To-Do / Top 10): a comfortable pill group with a raised
  // active chip, roomy hit targets, and breathing room above the table.
  dashSubtabs: { display: "inline-flex", gap: 3, margin: "4px 0 16px", background: "var(--panel-2)",
    border: "1px solid var(--border)", borderRadius: "var(--r-pill)", padding: 4 },
  subActive: { border: "none", background: "var(--accent-fill)", color: "var(--on-accent)", fontWeight: 700,
    borderRadius: "var(--r-pill)", padding: "6px 18px", minHeight: 32 },
  subIdle: { border: "none", background: "transparent", color: "var(--text-muted)", fontWeight: 600,
    borderRadius: "var(--r-pill)", padding: "6px 18px", minHeight: 32 },
  top10grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 },
  kbd: { fontFamily: "monospace", fontSize: "var(--fs-xs)", background: "var(--panel-2)", border: "1px solid var(--border-strong)", borderRadius: "var(--r-sm)", padding: "1px 8px", color: "var(--text)", minWidth: 22, textAlign: "center" },
};
