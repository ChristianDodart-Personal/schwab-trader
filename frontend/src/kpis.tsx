import { useEffect, useRef, useState } from "react";
import { usd } from "./format";
import type { Dashboard } from "./types";
import { IconSettings, IconGrip, IconArrowUp, IconArrowDown, IconClose } from "./Icon";

// Customizable header KPIs (W28-5). The top-right cluster is a set of selectable
// metric boxes drawn from the dashboard payload + the cash summary. Which ones show
// is a per-browser preference (localStorage); the default mirrors the old fixed
// cluster plus a dollar day-change like Schwab's.

export type KpiCash =
  | { cash: number | null; buying_power: number | null; margin_buying_power: number | null; tradable_funds: number | null }
  | null;

type Tone = "plain" | "signed" | "positive";
type KpiDef = {
  id: string;
  label: string;
  hint: string;
  term?: string;  // glossary id — the label becomes a hoverable <Term> when set
  tone: Tone;
  // Raw value, or null/undefined when unavailable → the box is hidden even if selected
  // (e.g. day change before every holding is priced, or cash before the summary loads).
  num: (d: Dashboard, cash: KpiCash) => number | null | undefined;
};

// Canonical display order — selection is a membership set, boxes always render in this order.
export const KPI_CATALOG: KpiDef[] = [
  { id: "invested", term: "invested", label: "Invested", tone: "plain",
    hint: "Cost basis of every open position (what you paid, excludes cash).",
    num: (d) => d.total_invested },
  { id: "day_change", term: "day_change", label: "Day change", tone: "signed",
    hint: "Change in total account value since yesterday's close — matches Schwab's 'Total day change'. Includes trading and any deposits/withdrawals (so moving cash in shows here too).",
    num: (d) => d.total_day_change },
  { id: "harvestable", term: "harvestable", label: "Harvestable", tone: "positive",
    hint: "Profit you could lock in right now by selling every last position that's in the green. Bulk Sell sells whole shares and needs a live Schwab quote, so what it books can be slightly less.",
    num: (d) => d.harvestable },
  { id: "market_value", term: "market_value", label: "Market value", tone: "plain",
    hint: "Current market value of every open position.",
    num: (d) => d.total_value },
  { id: "unrealized", term: "unrealized_pl", label: "Unrealized P/L", tone: "signed",
    hint: "Open positions' market value minus cost basis — the paper gain or loss across everything you hold.",
    num: (d) => d.total_unrealized },
  { id: "cash", term: "cash", label: "Cash", tone: "plain",
    hint: "Settled cash in the account.",
    num: (_d, cash) => cash?.cash },
  { id: "buying_power", term: "available_to_trade", label: "Available to trade", tone: "plain",
    hint: "What you can actually deploy on an order right now — settled cash plus borrowing "
      + "against fully-paid stock (Schwab's 'Settled Funds' / 'Funds Available to Withdraw'). "
      + "This is the real limit; orders above it get rejected.",
    num: (_d, cash) => cash?.tradable_funds },
];

export const DEFAULT_KPIS = ["invested", "day_change", "harvestable", "cash"];
const KEY = "dash_kpis_v1";

export type VisibleKpi = { id: string; label: string; hint: string; term?: string; value: string; raw: number; n?: number; color?: string };

export function useKpiPrefs() {
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (Array.isArray(p)) return p.filter((x) => KPI_CATALOG.some((k) => k.id === x));
      }
    } catch { /* ignore private-mode / bad JSON */ }
    return DEFAULT_KPIS;
  });
  const persist = (next: string[]) => {
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
    setIds(next);
  };
  const add = (id: string) => { if (!ids.includes(id)) persist([...ids, id]); };
  const remove = (id: string) => persist(ids.filter((x) => x !== id));
  const toggle = (id: string) => (ids.includes(id) ? remove(id) : add(id));
  const move = (id: string, dir: -1 | 1) => {
    const i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids]; [next[i], next[j]] = [next[j], next[i]]; persist(next);
  };
  const reorder = (dragId: string, toIndex: number) => {
    const from = ids.indexOf(dragId);
    if (from < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, dragId);
    persist(next);
  };
  const reset = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } setIds(DEFAULT_KPIS); };
  const available = KPI_CATALOG.filter((k) => !ids.includes(k.id));
  return { ids, add, remove, toggle, move, reorder, reset, available };
}
export type KpiPrefs = ReturnType<typeof useKpiPrefs>;

// Resolve the selected ids into renderable boxes, IN THE USER'S CHOSEN ORDER (drag-sorted),
// dropping any whose value isn't available yet.
export function visibleKpis(ids: string[], d: Dashboard, cash: KpiCash): VisibleKpi[] {
  const out: VisibleKpi[] = [];
  for (const id of ids) {
    const k = KPI_CATALOG.find((c) => c.id === id);
    if (!k) continue;
    const n = k.num(d, cash);
    if (n == null) continue;
    out.push({
      id: k.id, label: k.label, hint: k.hint, term: k.term, value: usd(n), raw: n,
      n: k.tone === "signed" ? n : undefined,
      color: k.tone === "positive" && n > 0 ? "var(--pos)" : undefined,
    });
  }
  return out;
}

const labelOf = (id: string) => KPI_CATALOG.find((k) => k.id === id)?.label ?? id;

// Gear button + popover to choose, REORDER (drag or arrows), and remove the header
// widgets — the same customization the dashboard columns have.
export function KpiPicker({ prefs }: { prefs: KpiPrefs }) {
  const [open, setOpen] = useState(false);
  const [toAdd, setToAdd] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => { setOpen(false); btnRef.current?.focus(); };
  const doAdd = () => { if (toAdd) { prefs.add(toAdd); setToAdd(""); } };

  return (
    <div ref={wrapRef} style={S.wrap}>
      <button ref={btnRef} className="btn btn-ghost btn-sm" style={S.gear}
        aria-label="Customize dashboard widgets" aria-expanded={open}
        title="Customize widgets — choose, reorder, remove" onClick={() => setOpen((o) => !o)}>
        <IconSettings />
      </button>
      {open && (
        <div style={S.pop} role="dialog" aria-label="Dashboard widgets"
          onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
          <div style={S.popHead}>Widgets · drag to reorder</div>
          <div style={S.list}>
            {prefs.ids.map((id, i) => (
              <div key={id}
                style={{ ...S.item, ...(overId === id && dragId && dragId !== id ? S.itemOver : null),
                  opacity: dragId === id ? 0.4 : 1 }}
                draggable
                onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { e.preventDefault(); if (dragId && dragId !== id) setOverId(id); }}
                onDragLeave={() => setOverId((o) => (o === id ? null : o))}
                onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== id) prefs.reorder(dragId, i); setDragId(null); setOverId(null); }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}>
                <span style={S.grip} title="drag to reorder"><IconGrip /></span>
                <span style={S.itemLabel} title={KPI_CATALOG.find((k) => k.id === id)?.hint}>{labelOf(id)}</span>
                <button className="btn btn-ghost btn-sm" style={S.mv} disabled={i === 0} onClick={() => prefs.move(id, -1)} aria-label={`move ${labelOf(id)} up`}><IconArrowUp /></button>
                <button className="btn btn-ghost btn-sm" style={S.mv} disabled={i === prefs.ids.length - 1} onClick={() => prefs.move(id, 1)} aria-label={`move ${labelOf(id)} down`}><IconArrowDown /></button>
                <button className="btn btn-ghost btn-sm" style={S.rm} onClick={() => prefs.remove(id)} aria-label={`remove ${labelOf(id)}`}><IconClose /></button>
              </div>
            ))}
            {prefs.ids.length === 0 && <div style={S.empty}>No widgets — add one below.</div>}
          </div>
          <div style={S.addRow}>
            <select className="field" style={S.select} value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
              <option value="">Add a widget…</option>
              {prefs.available.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <button className="btn btn-primary btn-sm" onClick={doAdd} disabled={!toAdd}>Add</button>
          </div>
          <button className="btn btn-ghost btn-sm" style={S.reset} onClick={prefs.reset}>Reset to default</button>
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { position: "relative", display: "flex", alignItems: "center", paddingLeft: 4, paddingRight: 4 },
  gear: { fontSize: "var(--fs-sm)", color: "var(--text-dim)" },
  pop: { position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 50, width: 260,
    background: "var(--pop, var(--panel))", border: "1px solid var(--border-strong)", borderRadius: "var(--r-md)",
    padding: 8, boxShadow: "var(--shadow-pop)", display: "flex", flexDirection: "column", gap: 2 },
  popHead: { fontSize: "var(--fs-2xs)", textTransform: "uppercase", letterSpacing: "0.05em",
    color: "var(--text-faint)", padding: "2px 6px 4px" },
  list: { maxHeight: 300, overflowY: "auto", padding: "2px 0" },
  item: { display: "flex", alignItems: "center", gap: 3, padding: "3px 2px", borderRadius: "var(--r-sm)", cursor: "grab" },
  itemOver: { boxShadow: "inset 0 2px 0 var(--accent)", background: "var(--panel-2)" },
  grip: { color: "var(--text-faint)", fontSize: 13, cursor: "grab", userSelect: "none", display: "inline-flex" },
  itemLabel: { flex: 1, fontSize: "var(--fs-sm)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  mv: { color: "var(--text-dim)", padding: "1px 4px" },
  rm: { color: "var(--text-faint)", padding: "1px 4px" },
  empty: { fontSize: "var(--fs-sm)", color: "var(--text-dim)", padding: "6px 8px" },
  addRow: { display: "flex", gap: 6, marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--border-hairline)" },
  select: { flex: 1, fontSize: "var(--fs-sm)" },
  reset: { marginTop: 6, alignSelf: "flex-start", color: "var(--text-dim)" },
};
