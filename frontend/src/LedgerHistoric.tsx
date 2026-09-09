import { useCallback, useEffect, useRef, useState } from "react";
import { usd } from "./format";
import { EquityCurve } from "./EquityCurve";
import { EarningsCurve } from "./EarningsCurve";
import { SkeletonCards, SkeletonPanel } from "./Skeleton";
import { useToast } from "./Toast";
import {
  AccountStamp, ALL_TIME, Card, Panel, PeriodSelector, Row, S, moneyColor, type Period,
} from "./LedgerUI";
import { IconUpload, IconDownload, IconRefresh, IconClose } from "./Icon";
import { Term, useGlossaryFigures } from "./GlossaryUI";
import type { CashFlowRow, LedgerHistoric as Historic, MarginSummary } from "./types";

import { API } from "./api";
type CapGains = { rows: { period: string; cap_gains: number; trade_count: number }[]; total_cap_gains: number };
type DivRow = { day: string; amount: number; symbol: string | null; type?: string; schwab_txn_id?: string | null };
type Dividends = { rows: DivRow[]; summary: { total: number; ytd: number | null; year: number | null; count: number } };
type HealthReport = {
  ok: boolean;
  positions_checked: boolean;
  positions_total: number | null;
  position_diffs: { symbol: string }[];
  basis_diffs: { symbol: string; count_matches: boolean }[];
  cash_check: { residual: number; residual_pct_of_flow: number; expected_cash: number } | null;
  fill_ledger?: { total: number };
};

const pillBtn = (active: boolean): React.CSSProperties => ({
  background: active ? "var(--accent-fill)" : "transparent",
  color: active ? "var(--on-accent)" : "var(--text-muted)",
  border: `1px solid ${active ? "var(--accent-fill)" : "var(--border)"}`,
});

const qs = (p: Period) => {
  const q = new URLSearchParams();
  if (p.from) q.set("start", p.from);
  if (p.to) q.set("end", p.to);
  const s = q.toString();
  return s ? `?${s}` : "";
};

export function LedgerHistoric() {
  const year = new Date().getFullYear();
  const [scope, setScope] = useState<Period>(ALL_TIME);
  const [h, setH] = useState<Historic | null>(null);
  const [cg, setCg] = useState<CapGains | null>(null);
  const [div, setDiv] = useState<Dividends | null>(null);
  const [margin, setMargin] = useState<MarginSummary | null>(null);
  const [cgGrain, setCgGrain] = useState<"month" | "week">("month");
  // Capital-gains panel span: All vs this calendar year. Remembered like the equity range.
  const [cgYtd, setCgYtd] = useState<boolean>(() => { try { return localStorage.getItem("cg.ytd.v1") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("cg.ytd.v1", cgYtd ? "1" : "0"); } catch { /* private mode */ } }, [cgYtd]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const seqRef = useRef(0);
  const load = useCallback(() => {
    const q = qs(scope);
    const my = ++seqRef.current; // ignore responses from a superseded scope/refresh
    fetch(`${API}/ledger/historic${q}`)
      .then((r) => r.json())
      .then((j) => { if (seqRef.current === my) (j && !j.error && j.now ? (setH(j), setErr(null)) : setErr(j?.error || "Couldn't load the ledger.")); })
      .catch(() => { if (seqRef.current === my) setErr("Couldn't load the ledger — network error."); });
    fetch(`${API}/ledger/cap-gains?grain=${cgGrain}${q ? "&" + q.slice(1) : ""}`)
      .then((r) => r.json())
      .then((j) => { if (seqRef.current === my && j && !j.error && Array.isArray(j.rows)) setCg(j); })
      .catch(() => {});
    // Capital & margin is account-level "right now" (not period-scoped), but reload it
    // with the ledger so a refresh/account switch keeps it in sync.
    fetch(`${API}/account/margin`)
      .then((r) => r.json())
      .then((j) => { if (seqRef.current === my && j) setMargin(j); })
      .catch(() => {});
    // Dividends are account-level all-time (not scope-dependent); reload with the ledger.
    fetch(`${API}/ledger/dividends`)
      .then((r) => r.json())
      .then((j) => { if (seqRef.current === my && j) setDiv(j); })
      .catch(() => {});
  }, [scope, cgGrain]);

  const importDividendsCsv = (file: File) => {
    setBusy(true);
    file.text()
      .then((csv) => fetch(`${API}/ledger/dividends/import`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv }),
      }).then((r) => r.json()))
      .then((j) => {
        if (!j?.ok) { toast(j?.error || "Couldn't import that file.", "error"); return; }
        toast(j.added ? `Imported ${j.added} dividend${j.added === 1 ? "" : "s"}.` : (j.note || "No dividend rows found in that file."), j.added ? "success" : "info");
        if (j.added) load();
      })
      .catch(() => toast("Couldn't read that file.", "error"))
      .finally(() => setBusy(false));
  };

  const refreshDividends = () => {
    setBusy(true);
    fetch(`${API}/ledger/dividends/refresh`, { method: "POST" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) toast(j.added ? `Pulled ${j.added} dividend${j.added === 1 ? "" : "s"} from Schwab.` : "No new dividends in the last 60 days.", "info");
        else toast(j?.error || "Couldn't reach Schwab for dividends.", "error");
        load();
      })
      .catch(() => toast("Couldn't reach Schwab for dividends.", "error"))
      .finally(() => setBusy(false));
  };

  useEffect(() => { load(); }, [load]);

  // Feed this account's ledger figures to the glossary so every definition can show its
  // formula worked out on real numbers. Merged with the dashboard's feed, not replacing it.
  const setGlossFigures = useGlossaryFigures();
  useEffect(() => {
    if (!h) return;
    setGlossFigures({
      accountValue: h.now.account_value ?? null,
      depositedAllTime: h.deposited_all_time,
      withdrawnAllTime: h.withdrawn_all_time,
      peakCapital: h.capital?.peak ?? h.peak_net_contributed ?? null,
      capitalAtWork: h.capital?.at_work ?? null,
      principalReturned: h.capital?.principal_returned ?? null,
      profitWithdrawn: h.capital?.profit_withdrawn ?? null,
      gainOnCapitalAtWork: h.capital?.gain_on_capital_at_work ?? null,
      totalProfit: h.gain_vs_contributed,
      roiPct: h.roi_pct,
      thisYear: h.this_year?.year ?? null,
      realizedYtd: h.this_year?.realized ?? null,
      taxReserve: h.this_year?.tax_reserve ?? null,
      afterTaxRealized: h.this_year?.after_tax_realized ?? null,
    });
  }, [h, setGlossFigures]);

  const refreshDeposits = () => {
    setBusy(true);
    fetch(`${API}/ledger/cashflows/refresh`, { method: "POST" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) toast(j.added ? `Pulled ${j.added} transfer${j.added === 1 ? "" : "s"} from Schwab.` : "No new transfers in the last 60 days.", "info");
        else toast(j?.error || "Couldn't reach Schwab for transfers.", "error");
        load();
      })
      .catch(() => toast("Couldn't reach Schwab for transfers.", "error"))
      .finally(() => setBusy(false));
  };

  const deepResync = () => {
    setBusy(true);
    fetch(`${API}/ledger/cashflows/deep-resync`, { method: "POST" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) toast(`Re-pulled full history from Schwab${j.windows ? ` (${j.windows} window${j.windows === 1 ? "" : "s"})` : ""} — any mis-synced transfers are now corrected.`, "success");
        else toast(j?.error || "Couldn't reach Schwab for a full re-pull.", "error");
        load();
      })
      .catch(() => toast("Couldn't reach Schwab for a full re-pull.", "error"))
      .finally(() => setBusy(false));
  };

  const importCsv = (file: File) => {
    setBusy(true);
    file.text()
      .then((csv) =>
        fetch(`${API}/ledger/cashflows/import`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv }),
        }).then((r) => r.json()))
      .then((j) => {
        if (!j?.ok) { toast(j?.error || "Couldn't import that file.", "error"); return; }
        const parts = [`Imported ${j.added} transfer${j.added === 1 ? "" : "s"}`];
        if (j.skipped_existing) parts.push(`${j.skipped_existing} already logged`);
        toast(j.added || j.skipped_existing ? parts.join(" · ") : (j.note || "No transfer rows found in that file."),
          j.added ? "success" : "info");
        if (j.added) load();
      })
      .catch(() => toast("Couldn't read that file.", "error"))
      .finally(() => setBusy(false));
  };

  const addManual = (day: string, amount: number, memo: string) => {
    setBusy(true);
    fetch(`${API}/ledger/cashflows`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, amount, memo: memo || null }),
    })
      .then((r) => r.json())
      .then((j) => { if (j?.ok) { toast("Entry added.", "success"); load(); } else toast(j?.error || "Couldn't add entry.", "error"); })
      .catch(() => toast("Couldn't add entry.", "error"))
      .finally(() => setBusy(false));
  };

  const delRow = (id: number) => {
    fetch(`${API}/ledger/cashflows/${id}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((j) => { if (j?.ok) load(); else toast("Couldn't delete entry.", "error"); })
      .catch(() => toast("Couldn't delete entry.", "error"));
  };

  if (err) return <p style={S.note}>{err}</p>;
  if (!h) return <div><SkeletonCards n={4} /><SkeletonPanel /></div>;

  const now = h.now;
  const r = h.realized;
  const scoped = !!(scope.from || scope.to);
  // Capital split + this-year tax axis (absent only against a backend predating them).
  const cap = h.capital;
  const peak = cap?.peak ?? h.peak_net_contributed ?? h.deposited_all_time;
  const ty = h.this_year;
  // Capital-gains panel view. The YTD filter is a year-prefix match, which works for both
  // "YYYY-MM" month keys and "YYYY-MM-DD" Monday week keys. Ascending feeds the chart's
  // running total; the bar list shows newest first.
  const cgAsc = (cg?.rows ?? [])
    .filter((r) => !cgYtd || r.period.startsWith(String(year)))
    .slice().sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  const cgDesc = cgAsc.slice().reverse();
  const cgTotal = cgAsc.reduce((sum, r) => sum + r.cap_gains, 0);
  const cgTrades = cgAsc.reduce((sum, r) => sum + r.trade_count, 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => window.print()}
          title="Print a one-page summary or save it as a PDF">Print / Save PDF</button>
      </div>

      {/* ---- Printable one-pager (hidden on screen; only the .print-only block prints) ---- */}
      <PrintSummary h={h} div={div} />

      <ReconciliationCard />

      {/* ---- Right now (live, point-in-time) ---- */}
      <div style={S.panelHead}>
        <h3 className="section-title" style={{ margin: "6px 0 0" }}>Right now</h3>
        <span style={S.periodShow}>
          {now.source === "live" ? "live from Schwab"
            : now.source === "snapshot" ? `last snapshot ${now.as_of_snapshot ?? ""}`
            : "unavailable"}
        </span>
      </div>
      <div style={S.cards}>
        <Card label="Account value" value={usd(now.account_value)} big term="account_value" />
        <Card label="Invested" value={usd(now.invested_market)} term="invested"
          sub={`cost ${usd(now.invested_cost)} · unreal ${usd(now.unrealized_pl)}`} />
        <Card label="Cash" value={usd(now.cash)} term="cash" />
        <Card label="Available to trade" value={usd(now.tradable_funds)} term="available_to_trade" />
      </div>
      {now.source !== "live" && (
        <p style={S.warn}>Live balances unavailable{now.note ? ` (${now.note})` : ""} — showing the last saved snapshot. Reconnect under Settings → Schwab connection.</p>
      )}

      {/* ---- Since inception: the three answers to "how am I doing", in reading order.
           The base your money is measured against, the dollars it has made, the rate. ---- */}
      {h.contributions_recorded > 0 && h.gain_vs_contributed != null && (
        <>
          <div style={S.panelHead}>
            <h3 className="section-title" style={{ margin: "14px 0 0" }}>Since inception</h3>
            <span style={S.periodShow}>hover a label for what it measures and why</span>
          </div>
          <div style={S.cards}>
            <Card label="Peak capital" value={usd(peak)} term="peak_capital"
              sub={cap && Math.abs(cap.at_work - peak) >= 0.005
                ? `${usd(cap.at_work)} of it in the account now`
                : `${usd(h.deposited_all_time)} deposited over time`} />
            <Card label="Total profit" value={usd(h.gain_vs_contributed)} accent={moneyColor(h.gain_vs_contributed)} term="total_profit"
              sub={cap && cap.profit_withdrawn > 0 ? `${usd(cap.profit_withdrawn)} of it already withdrawn` : "all time, in and out of the account"} />
            <Card label="Return on peak capital" term="roi"
              value={h.roi_pct == null ? "—" : `${h.roi_pct > 0 ? "+" : ""}${h.roi_pct}%`}
              accent={h.roi_pct == null ? undefined : moneyColor(h.roi_pct)}
              sub={`${usd(h.gain_vs_contributed)} ÷ ${usd(peak)}`} />
          </div>
        </>
      )}

      {/* ---- Profit breakdown: where the profit is, and what is actually yours after tax.
           Stack 1 splits total profit into "how the money in now is doing" + "gains already
           cashed out". Stack 2 is the tax axis on this year's LOCKED-IN gains only. ---- */}
      {h.contributions_recorded > 0 && h.gain_vs_contributed != null && cap && (
        <Panel title="Profit breakdown">
          <Row k="Gain on capital at work" v={usd(cap.gain_on_capital_at_work)} term="gain_on_capital_at_work"
            accent={moneyColor(cap.gain_on_capital_at_work ?? 0)}
            sub={`how the ${usd(cap.at_work)} in the account now is doing`} />
          <Row k="Profit already withdrawn" v={usd(cap.profit_withdrawn)} term="profit_withdrawn"
            accent={cap.profit_withdrawn > 0 ? "var(--pos)" : undefined}
            sub={cap.profit_withdrawn > 0 ? "gains you have cashed out; banked, still counts" : "none taken out yet"} />
          <Row k="Total profit, all time" v={usd(h.gain_vs_contributed)} hi accent={moneyColor(h.gain_vs_contributed)} term="total_profit"
            sub={h.roi_pct != null ? `the two above · ${h.roi_pct > 0 ? "+" : ""}${h.roi_pct}% on peak capital` : "the two above"} />
          {ty && (
            <>
              <div style={S2.divider} />
              <Row k="Unrealized (paper)" v={usd(now.unrealized_pl)} term="unrealized_pl"
                accent={moneyColor(now.unrealized_pl ?? 0)}
                sub="on positions still held · not taxed until sold, can still reverse" />
              <Row k={`Realized in ${ty.year}`} v={usd(ty.realized)} term="realized_ytd"
                accent={moneyColor(ty.realized)}
                sub="locked in by selling this year · what tax is owed on" />
              <Row k="Tax reserve" v={usd(ty.tax_reserve)} term="tax_reserve"
                accent={ty.tax_reserve > 0 ? "var(--neg)" : undefined}
                sub={ty.tax_reserve > 0
                  ? `hold back · ${(ty.tax.effective_rate * 100).toFixed(1)}% effective, stacked on your salary · estimate`
                  : "nothing to reserve"} />
              <Row k={`After tax, ${ty.year}`} v={usd(ty.after_tax_realized)} hi term="after_tax_realized"
                accent={moneyColor(ty.after_tax_realized)}
                sub="this year's locked-in profit that is yours to keep" />
            </>
          )}
          <p style={S.fine}>
            Read top to bottom. The first three answer "how much have I made": total profit is the gain
            on the money in now plus what you already took out, so withdrawing profit never makes it
            fall. The rest are the tax axis: only <b>realized</b> gains are taxable, the reserve is the
            estimated tax those add on top of your salary, and "after tax" is what is left of this
            year's locked-in profit. Estimates, not tax advice.
          </p>
        </Panel>
      )}

      {/* ---- Capital & margin (deployment / leverage, live) ---- */}
      {margin && !margin.blocked && <MarginPanel m={margin} />}

      {/* ---- Realized trades, scoped by the period selector. The capital/base figures now
           live in "Since inception" + "Profit breakdown" (all-time by nature). Mixing them
           into this period panel was what made a profit withdrawal read as lost deposits. ---- */}
      <Panel title="Realized trades" right={<PeriodSelector value={scope} onChange={setScope} year={year} />}>
        <Row k={`Realized capital gains${scoped ? "" : " (all time)"}`} v={usd(r.cap_gains)} hi term="realized_pl"
          accent={moneyColor(r.cap_gains)} sub={scope.label} />
        <Row k="Trades" v={String(r.trade_count)} sub={`${r.day_trade_count} day-trades`} />
        <Row k="Gross proceeds" v={usd(r.gross_proceeds)} sub="what the sells brought in" />
        <Row k="Cost basis" v={usd(r.cost_basis)} term="cost_basis" sub="what those shares had cost" />
      </Panel>

      {/* ---- Deposit log ---- */}
      <Panel
        collapsible defaultOpen={false}
        title="Outside money (deposits & withdrawals)"
        right={
          <span style={{ display: "flex", gap: 6 }}>
            <label className="btn btn-secondary btn-sm" style={{ cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
              title="Import a Schwab transactions CSV export (full history)">
              <IconUpload /> Import CSV
              <input type="file" accept=".csv,text/csv" disabled={busy} style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = ""; }} />
            </label>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={refreshDeposits}><IconRefresh /> Pull from Schwab (60d)</button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={deepResync}
              title="Re-pull your ENTIRE transfer history from Schwab and rewrite each row from the current logic. Use this to fix an old mis-synced transfer (e.g. a withdrawal that showed up as a deposit). Heavier than the 60-day pull; safe to repeat.">Re-pull all history</button>
            {h.contributions.rows.length > 0 && (
              <button className="btn btn-secondary btn-sm" title="Download these deposits as CSV"
                onClick={() => { const a = document.createElement("a"); a.href = `${API}/ledger/cashflows.csv${qs(scope)}`; a.rel = "noopener"; a.click(); }}><IconDownload /> CSV</button>
            )}
          </span>
        }
      >
        <div style={S2.cfSummary}>
          <span>Deposits <b style={{ color: "var(--pos)" }}>{usd(h.contributions.deposits)}</b></span>
          <span>Withdrawals <b style={{ color: h.contributions.withdrawals < 0 ? "var(--neg)" : "var(--text)" }}>{usd(h.contributions.withdrawals)}</b></span>
          <span><Term id="net_deposits">Net</Term> <b>{usd(h.contributions.net)}</b></span>
          <span style={{ color: "var(--text-faint)" }}>{scope.label}</span>
        </div>
        {cap && cap.profit_withdrawn > 0 && (
          <p style={{ ...S.fine, marginTop: -4 }}>
            All time, the {usd(-h.withdrawn_all_time)} withdrawn was{" "}
            <Term id="principal_returned">{usd(cap.principal_returned)} of your own money back</Term> plus{" "}
            <Term id="profit_withdrawn">{usd(cap.profit_withdrawn)} of profit taken out</Term>. Only the first
            part lowers your capital; the profit is banked.
          </p>
        )}
        {h.capital_by_year.length > 0 && (
          <div style={{ overflowX: "auto", marginBottom: 12 }}>
            <table className="tbl">
              <thead>
                <tr><th className="left">Year</th><th>Deposits</th><th>Withdrawals</th><th>Net</th></tr>
              </thead>
              <tbody>
                {h.capital_by_year.map((y) => (
                  <tr key={y.year}>
                    <td className="left">{y.year}</td>
                    <td style={{ textAlign: "right", color: "var(--pos)", fontVariantNumeric: "tabular-nums" }}>{usd(y.deposits)}</td>
                    <td style={{ textAlign: "right", color: y.withdrawals < 0 ? "var(--neg)" : "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>{usd(y.withdrawals)}</td>
                    <td style={{ textAlign: "right", color: moneyColor(y.net), fontVariantNumeric: "tabular-nums" }}>{usd(y.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {h.contributions.rows.length === 0 ? (
          <p style={S.fine}>No transfers recorded in this period. Use "Pull from Schwab" for the last 60 days, or add older ones manually below.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr><th className="left">Date</th><th className="left">Type</th><th>Amount</th><th className="left">Source</th><th></th></tr>
              </thead>
              <tbody>
                {h.contributions.rows.map((cf: CashFlowRow) => (
                  <tr key={cf.id}>
                    <td className="left">{cf.day}</td>
                    <td className="left" style={{ textTransform: "capitalize" }}>{cf.kind}{cf.memo ? ` · ${cf.memo}` : ""}</td>
                    <td style={{ textAlign: "right", color: moneyColor(cf.amount), fontVariantNumeric: "tabular-nums" }}>
                      {cf.amount > 0 ? "+" : ""}{usd(cf.amount)}
                    </td>
                    <td className="left">
                      <span className="tag" style={cf.source === "schwab" ? S2.tagSchwab : S2.tagManual}>
                        {cf.source === "schwab" ? "Schwab" : cf.source === "csv" ? "CSV" : "you"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {cf.source !== "schwab" && (
                        <button className="btn btn-ghost btn-sm" title="Delete entry" aria-label={`Delete ${cf.day} entry`} onClick={() => delRow(cf.id)}><IconClose /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ManualEntry busy={busy} onAdd={addManual} />
        <p style={S.fine}>
          Schwab's live pull only exposes the trailing <b>{h.contributions.schwab_window_days} days</b> of transfers. For the
          full history, export your account's <b>Transactions</b> CSV from Schwab and use <b>Import CSV</b> — only transfer/wire
          rows are taken, and imports are deduped by date + amount, so re-importing (or overlapping the 60-day pull) is safe.
          You can also add older transfers by hand below.
        </p>
      </Panel>

      {/* ---- Dividends / income ---- */}
      <Panel
        collapsible defaultOpen={false}
        title="Dividends & income"
        right={
          <span style={{ display: "flex", gap: 6 }}>
            <label className="btn btn-secondary btn-sm" style={{ cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
              title="Import a Schwab Transactions CSV export (full dividend history)">
              <IconUpload /> Import CSV
              <input type="file" accept=".csv,text/csv" disabled={busy} style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) importDividendsCsv(f); e.target.value = ""; }} />
            </label>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={refreshDividends}><IconRefresh /> Pull from Schwab (60d)</button>
            {div && div.rows.length > 0 && (
              <button className="btn btn-secondary btn-sm" title="Download the income log as CSV"
                onClick={() => { const a = document.createElement("a"); a.href = `${API}/ledger/dividends.csv`; a.rel = "noopener"; a.click(); }}><IconDownload /> CSV</button>
            )}
          </span>
        }
      >
        <div style={S2.cfSummary}>
          <span>All-time <b style={{ color: "var(--pos)" }}>{usd(div?.summary.total ?? 0)}</b></span>
          <span>This year <b style={{ color: "var(--pos)" }}>{usd(div?.summary.ytd ?? 0)}</b></span>
          <span style={{ color: "var(--text-faint)" }}>{div?.summary.count ?? 0} payment{(div?.summary.count ?? 0) === 1 ? "" : "s"}</span>
        </div>
        {div && div.rows.length > 0 && <TopPayers rows={div.rows} />}
        {div && div.rows.length > 0 && <DividendsByYear rows={div.rows} />}
        {div && div.rows.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead><tr><th className="left">Date</th><th className="left">Symbol</th><th>Amount</th></tr></thead>
              <tbody>
                {div.rows.slice(0, 30).map((d, i) => (
                  <tr key={`${d.schwab_txn_id ?? i}-${d.day}`}>
                    <td className="left">{d.day}</td>
                    <td className="left"><b>{d.symbol ?? "—"}</b></td>
                    <td style={{ textAlign: "right", color: "var(--pos)", fontVariantNumeric: "tabular-nums" }}>+{usd(d.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={S.fine}>No dividends recorded yet. Use "Pull from Schwab" for the last 60 days; repeat over time to accumulate history.</p>
        )}
        <p style={S.fine}>
          Dividends are paid as cash into the account, so they're <b>already included</b> in your account value
          and returns above — this view breaks out how much of that came from income. Schwab exposes only the
          trailing 60 days per pull, so pull periodically to build the record.
        </p>
      </Panel>

      {/* ---- Account value over time (nightly snapshots, scoped) ---- */}
      <Panel title="Account value over time">
        <EquityCurve series={h.series} />
      </Panel>

      {/* ---- Capital gains by period: the earnings curve (running total + per-period bars)
           above the list, newest first. All/YTD picks the span; Monthly/Weekly the bucket. ---- */}
      {cg && cg.rows.length > 0 && (
        <Panel title={`Capital gains by ${cgGrain}`}
          right={
            <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span role="group" aria-label="Time span" style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-sm" style={pillBtn(!cgYtd)} aria-pressed={!cgYtd} onClick={() => setCgYtd(false)}>All</button>
                <button className="btn btn-sm" style={pillBtn(cgYtd)} aria-pressed={cgYtd} onClick={() => setCgYtd(true)}>YTD</button>
              </span>
              <span role="group" aria-label="Bucket size" style={{ display: "flex", gap: 6 }}>
                {(["month", "week"] as const).map((g) => (
                  <button key={g} className="btn btn-sm" style={pillBtn(cgGrain === g)}
                    aria-pressed={cgGrain === g} onClick={() => setCgGrain(g)}>
                    {g === "month" ? "Monthly" : "Weekly"}
                  </button>
                ))}
              </span>
            </span>
          }>
          <div style={S2.cfSummary}>
            <span>{cgYtd ? `${year} so far` : "All time"} <b style={{ color: moneyColor(cgTotal) }}>{usd(cgTotal)}</b></span>
            <span style={{ color: "var(--text-faint)" }}>{cgTrades} trades · {cgAsc.length} {cgGrain}{cgAsc.length === 1 ? "" : "s"}</span>
          </div>
          {cgAsc.length === 0 ? (
            <p style={S.fine}>No closed trades in {year} yet.</p>
          ) : (
            <>
              <EarningsCurve rows={cgAsc} />
              <MonthlyBars rows={cgDesc} />
            </>
          )}
        </Panel>
      )}
    </div>
  );
}

// Reconciliation verdict — the "is this accurate?" answer, right where the numbers
// live. Runs the same checks as Settings → Data health (share counts vs Schwab, cost
// basis, the global cash identity) and reduces them to one strip: green when
// everything closes, amber with specifics when it doesn't, quiet when Schwab is
// unreachable. Fetched once per Ledger visit.
function ReconciliationCard() {
  const [h, setH] = useState<HealthReport | null>(null);
  const [failed, setFailed] = useState(false);

  const check = useCallback(() => {
    setH(null); setFailed(false);
    fetch(`${API}/data/health`)
      .then((r) => r.json())
      .then((j) => (j?.ok ? setH(j) : setFailed(true)))
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => { check(); }, [check]);

  if (failed) return null;                     // no report, no noise — Data health still exists
  if (!h) {
    return <div style={RC.strip}><span style={RC.quietDot} /><span style={RC.quietText}>Verifying against Schwab…</span></div>;
  }
  if (!h.positions_checked) {
    return (
      <div style={RC.strip}>
        <span style={RC.quietDot} />
        <span style={RC.quietText}>Couldn't verify against Schwab right now — showing the stored ledger.</span>
      </div>
    );
  }

  const posDiffs = h.position_diffs?.length ?? 0;
  const basisGaps = (h.basis_diffs ?? []).filter((b) => !b.count_matches);
  const cc = h.cash_check;
  // Same materiality rule as the health report's recommendation: a residual matters
  // past $100 or 1% of expected cash, whichever is larger.
  const residualBad = !!cc && Math.abs(cc.residual) > Math.max(100, 0.01 * Math.abs(cc.expected_cash || 0));
  const good = posDiffs === 0 && basisGaps.length === 0 && !residualBad;

  const issues: string[] = [];
  if (posDiffs) issues.push(`${posDiffs} position${posDiffs === 1 ? "" : "s"} differ from Schwab`);
  if (basisGaps.length) issues.push(`cost basis differs on ${basisGaps.map((b) => b.symbol).join(", ")}`);
  if (residualBad && cc) issues.push(`cash identity off by ${usd(Math.abs(cc.residual))}`);

  return (
    <div style={{ ...RC.strip, ...(good ? RC.stripGood : RC.stripWarn) }}>
      <span style={{ ...RC.dot, background: good ? "var(--pos)" : "var(--warn)" }} />
      {good ? (
        <span style={RC.text}>
          <b style={{ color: "var(--text)" }}>Verified against Schwab</b>
          {h.positions_total != null && <> — all {h.positions_total} position{h.positions_total === 1 ? "" : "s"} match share-for-share</>}
          {cc && <> · cash identity closes within {usd(Math.abs(cc.residual))} ({cc.residual_pct_of_flow}% of traded dollars)</>}
        </span>
      ) : (
        <span style={RC.text}>
          <b style={{ color: "var(--text)" }}>Needs attention</b> — {issues.join(" · ")}.
          {" "}Details under Settings → Data health &amp; import.
        </span>
      )}
      <button className="btn btn-ghost btn-sm" onClick={check} title="Re-run the verification against Schwab" style={{ marginLeft: "auto", flexShrink: 0 }}>
        <IconRefresh size={13} />
      </button>
    </div>
  );
}

const RC: Record<string, React.CSSProperties> = {
  strip: {
    display: "flex", alignItems: "center", gap: 9,
    padding: "8px 12px", margin: "0 0 14px",
    background: "var(--panel)", border: "1px solid var(--border)",
    borderRadius: "var(--r-md)", fontSize: "var(--fs-xs)",
  },
  stripGood: { borderColor: "color-mix(in srgb, var(--pos) 35%, var(--border))" },
  stripWarn: { borderColor: "var(--warn-border)", background: "var(--warn-bg)" },
  dot: { width: 8, height: 8, borderRadius: "var(--r-pill)", flexShrink: 0 },
  quietDot: { width: 8, height: 8, borderRadius: "var(--r-pill)", flexShrink: 0, background: "var(--text-faint)" },
  quietText: { color: "var(--text-dim)" },
  text: { color: "var(--text-muted)", lineHeight: 1.45 },
};

// Hidden on screen; the only thing that prints (see .print-only in ui.css). A clean
// one-pager of the since-inception numbers + capital-by-year + dividends for records.
function PrintSummary({ h, div }: { h: Historic; div: Dividends | null }) {
  const now = h.now, r = h.realized, cap = h.capital, ty = h.this_year;
  const peak = cap?.peak ?? h.peak_net_contributed ?? h.deposited_all_time;
  const rowsFig: [string, string][] = [
    ["Account value", usd(now.account_value)],
    ["Peak capital (return base)", usd(peak)],
    ["Deposited (all-time)", usd(h.deposited_all_time)],
    ...(h.withdrawn_all_time < 0 ? [["Withdrawn (all-time)", usd(h.withdrawn_all_time)] as [string, string]] : []),
    ...(cap && cap.profit_withdrawn > 0 ? [["  of which profit taken out", usd(cap.profit_withdrawn)] as [string, string]] : []),
    ...(h.gain_vs_contributed != null ? [["Total profit (all-time)", usd(h.gain_vs_contributed)] as [string, string]] : []),
    ...(h.roi_pct != null ? [["Return on peak capital", `${h.roi_pct}%`] as [string, string]] : []),
    ...(ty ? [
      [`Realized in ${ty.year}`, usd(ty.realized)] as [string, string],
      [`Estimated tax reserve (${ty.year})`, usd(ty.tax_reserve)] as [string, string],
    ] : []),
    ["Realized capital gains (all-time)", usd(r.cap_gains)],
    ["Dividends (all-time)", usd(div?.summary.total ?? 0)],
  ];
  return (
    <div className="print-only">
      <h2 style={{ margin: "0 0 2px" }}>Schwab Trader — Ledger Summary</h2>
      <AccountStamp />
      <p style={{ margin: "0 0 12px", fontSize: 12 }}>As of {h.as_of}</p>
      <table><tbody>
        {rowsFig.map(([k, v]) => (
          <tr key={k}><th>{k}</th><td className="num">{v}</td></tr>
        ))}
      </tbody></table>
      {h.capital_by_year.length > 0 && (
        <>
          <h3 style={{ margin: "16px 0 4px" }}>Capital by year</h3>
          <table>
            <thead><tr><th>Year</th><th>Deposits</th><th>Withdrawals</th><th>Net</th></tr></thead>
            <tbody>
              {h.capital_by_year.map((y) => (
                <tr key={y.year}>
                  <td>{y.year}</td><td className="num">{usd(y.deposits)}</td>
                  <td className="num">{usd(y.withdrawals)}</td><td className="num">{usd(y.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// Dividends totalled by calendar year (newest first) — mirrors capital-by-year.
function DividendsByYear({ rows }: { rows: DivRow[] }) {
  const byYear = new Map<string, number>();
  for (const d of rows) {
    const y = (d.day || "").slice(0, 4);
    if (y) byYear.set(y, (byYear.get(y) ?? 0) + d.amount);
  }
  const years = [...byYear.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  if (years.length < 2) return null;
  return (
    <div style={{ overflowX: "auto", marginBottom: 12 }}>
      <table className="tbl">
        <thead><tr><th className="left">Year</th><th>Dividends</th></tr></thead>
        <tbody>
          {years.map(([y, v]) => (
            <tr key={y}>
              <td className="left">{y}</td>
              <td style={{ textAlign: "right", color: "var(--pos)", fontVariantNumeric: "tabular-nums" }}>{usd(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Top dividend payers by total received — a quick "who's paying me" glance.
function TopPayers({ rows }: { rows: DivRow[] }) {
  const bySym = new Map<string, number>();
  for (const d of rows) bySym.set(d.symbol || "—", (bySym.get(d.symbol || "—") ?? 0) + d.amount);
  const top = [...bySym.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length < 2) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", margin: "0 0 10px", fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
      <span style={{ color: "var(--text-faint)" }}>Top payers:</span>
      {top.map(([s, v]) => <span key={s}><b style={{ color: "var(--text-muted)" }}>{s}</b> {usd(v)}</span>)}
    </div>
  );
}

function MarginPanel({ m }: { m: MarginSummary }) {
  const pct = (x?: number | null) => (x == null ? "—" : `${x.toFixed(1)}%`);
  const dep = m.deployed_pct ?? null;
  // Deployed = long market value ÷ your own equity (margin buying power deliberately
  // excluded). So ~100% = fully invested with your own cash, and >100% = you're using
  // margin to hold more than you own. Tint: green with dry powder, amber near full, red
  // once past 100% (levered).
  const depColor = dep == null ? "var(--text-faint)" : dep > 100 ? "var(--neg-strong)" : dep >= 85 ? "var(--warn)" : "var(--pos-strong)";
  const cushionLow = m.maint_cushion_pct != null && m.maint_cushion_pct < 25;
  return (
    <Panel title={m.is_margin ? "Capital & margin" : "Capital deployment"}>
      {dep != null && (
        <div style={{ margin: "2px 0 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-sm)", marginBottom: 5 }}>
            <span style={{ color: "var(--text-muted)" }}><Term id="deployed_pct">Deployed — market value vs. your capital</Term>{dep != null && dep > 100 ? " (on margin)" : ""}</span>
            <b style={{ color: depColor, fontVariantNumeric: "tabular-nums" }}>{pct(dep)}</b>
          </div>
          <div style={{ background: "var(--border-hairline)", borderRadius: "var(--r-sm)", height: 10, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(dep, 100)}%`, background: depColor }} />
          </div>
        </div>
      )}
      <Row k="Long market value" v={usd(m.long_market_value)} sub="what's in the market right now" />
      <Row k="Available to trade" v={usd(m.tradable_funds)} term="available_to_trade"
        sub="settled cash + borrowing — what an order can actually use" />
      {m.is_margin && (
        <>
          <Row k="Equity" v={usd(m.equity)} />
          <Row k="Debt" v={usd(m.debt)} accent={m.debt ? "var(--neg)" : undefined} term="margin_debt"
            sub={m.debt ? "margin loan carried against positions" : "no margin loan"} />
          <Row k="Leverage" v={m.leverage == null ? "—" : `${m.leverage.toFixed(2)}×`} term="leverage"
            accent={m.leverage != null && m.leverage > 1.5 ? "var(--warn)" : undefined}
            sub="long exposure ÷ equity (1.0× = unlevered)" />
          <Row k="Maintenance cushion" v={usd(m.maint_cushion)} accent={cushionLow ? "var(--neg)" : undefined} term="maintenance_cushion"
            sub={m.maint_cushion_pct != null ? `${pct(m.maint_cushion_pct)} above the maintenance floor` : "equity above Schwab's maintenance requirement"} />
          {cushionLow && <p style={S.warn}>Maintenance cushion is thin — a further drop could trigger a margin call. Consider trimming leverage.</p>}
        </>
      )}
      <p style={S.fine}>Live from Schwab, point-in-time and mark-to-market. Available-to-trade and margin figures drift intraday with prices.</p>
    </Panel>
  );
}

function ManualEntry({ busy, onAdd }: { busy: boolean; onAdd: (day: string, amount: number, memo: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(today);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const submit = () => {
    const amt = parseFloat(amount);
    if (!day || !Number.isFinite(amt) || amt === 0) return;
    onAdd(day, amt, memo);
    setAmount(""); setMemo(""); setOpen(false);
  };
  if (!open) return <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>+ Add a deposit / withdrawal</button>;
  return (
    <div style={S2.form}>
      <input type="date" className="field" value={day} max={today} onChange={(e) => setDay(e.target.value)} style={{ height: 32 }} aria-label="Date" />
      <input type="number" className="field" placeholder="Amount (+dep / −wd)" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ height: 32, width: 150 }} aria-label="Amount" />
      <input type="text" className="field" placeholder="Memo (optional)" value={memo} onChange={(e) => setMemo(e.target.value)} style={{ height: 32, flex: 1, minWidth: 120 }} aria-label="Memo" />
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={submit}>Add</button>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

function MonthlyBars({ rows }: { rows: { period: string; cap_gains: number; trade_count: number }[] }) {
  const max = Math.max(...rows.map((x) => Math.abs(x.cap_gains)), 1);
  return (
    <div>
      {rows.map((m) => (
        <div key={m.period} style={S2.barRow}>
          <span style={S2.barLabel}>{m.period}</span>
          <div style={S2.barTrack}>
            <div style={{ ...S2.barFill, width: `${(Math.abs(m.cap_gains) / max) * 100}%`, background: m.cap_gains >= 0 ? "var(--pos-strong)" : "var(--neg-strong)" }} />
          </div>
          <span style={{ ...S2.barVal, color: moneyColor(m.cap_gains) }}>{usd(m.cap_gains)}</span>
          <span style={S2.barTrades}>{m.trade_count} trades</span>
        </div>
      ))}
    </div>
  );
}

const S2: Record<string, React.CSSProperties> = {
  form: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12, padding: 12, background: "var(--panel-2)", borderRadius: "var(--r-md)" },
  barRow: { display: "flex", alignItems: "center", gap: 12, padding: "5px 0" },
  barLabel: { width: 64, fontSize: "var(--fs-sm)", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" },
  barTrack: { flex: 1, background: "var(--border-hairline)", borderRadius: "var(--r-sm)", height: 18, overflow: "hidden" },
  barFill: { height: "100%" },
  barVal: { width: 96, textAlign: "right", fontSize: "var(--fs-sm)", fontVariantNumeric: "tabular-nums" },
  barTrades: { width: 70, textAlign: "right", fontSize: "var(--fs-xs)", color: "var(--text-faint)" },
  cfSummary: { display: "flex", gap: 20, flexWrap: "wrap", fontSize: "var(--fs-md)", marginBottom: 10 },
  divider: { borderTop: "1px solid var(--border)", margin: "8px 0" },
  tagSchwab: { color: "var(--accent-quiet)", border: "1px solid var(--border-strong)" },
  tagManual: { color: "var(--text-dim)", border: "1px solid var(--border)" },
};
