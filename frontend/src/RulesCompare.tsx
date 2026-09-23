import { useCallback, useEffect, useState } from "react";
import { usd } from "./format";
import { API } from "./api";
import { useToast } from "./Toast";

// Rules side-by-side: every account's strategy in one place, so you can see where two
// accounts' rules differ at a glance and copy one account's playbook onto another. Rules
// live in the local DB, so accounts of non-active profiles compare too (their live
// account NAME needs a reconnect; the settings are already here). Columns are accounts,
// rows are the key rule values, and a row is flagged when the accounts don't all agree.

type Col = { hash: string; label: string; live: boolean };
type OvAccount = { hash: string; label: string; live: boolean };
type OvProfile = { name: string; accounts: OvAccount[] };
// The strategy shape we compare (a subset of the full config).
type Cfg = {
  strategy_is_default?: boolean;
  strategy?: {
    sizing_tiers?: { dollars: number }[];
    buy_ladder?: { drops?: { drop_pct: number }[] };
    sell?: { default_mode?: string; dollar_gain?: number; pct_above?: number };
    deployment_scaling?: { enabled?: boolean };
    guardrails?: Record<string, unknown>;
  };
};

const ROWS = [
  "Sell target", "Buy-ladder drops", "Sizing ($ / next buy)",
  "Deployment scaling", "Rules source",
] as const;

function summarize(cfg: Cfg | undefined): Record<string, string> {
  if (!cfg) return {};
  const s = cfg.strategy ?? {};
  const sell = s.sell?.default_mode === "pct_above"
    ? `+${((s.sell?.pct_above ?? 0) * 100).toFixed(1)}% above cost`
    : `+$${s.sell?.dollar_gain ?? "—"} per lot`;
  return {
    "Sell target": sell,
    "Buy-ladder drops": (s.buy_ladder?.drops ?? []).map((d) => `${d.drop_pct}%`).join(" / ") || "—",
    "Sizing ($ / next buy)": (s.sizing_tiers ?? []).map((t) => usd(t.dollars)).join(" / ") || "—",
    "Deployment scaling": s.deployment_scaling?.enabled ? "on" : "off",
    "Rules source": cfg.strategy_is_default ? "defaults (unset)" : "customized",
  };
}

export function RulesCompare() {
  const [cols, setCols] = useState<Col[]>([]);
  const [cfgs, setCfgs] = useState<Record<string, Cfg>>({});
  const [loading, setLoading] = useState(true);
  const [copyFrom, setCopyFrom] = useState<string | null>(null);
  const toast = useToast();

  const loadCfg = useCallback(async (hash: string) => {
    try {
      const c = await fetch(`${API}/config?account_hash=${encodeURIComponent(hash)}`).then((r) => r.json());
      setCfgs((cur) => ({ ...cur, [hash]: c }));
    } catch { /* ignore */ }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetch(`${API}/accounts-overview`).then((r) => r.json());
      const c: Col[] = [];
      for (const pr of (d.profiles ?? []) as OvProfile[]) {
        for (const a of pr.accounts) c.push({ hash: a.hash, label: `${pr.name} · ${a.label}`, live: a.live });
      }
      setCols(c);
      await Promise.all(c.map((col) => loadCfg(col.hash)));
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [loadCfg]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const copyTo = async (target: string) => {
    if (!copyFrom || target === copyFrom) { setCopyFrom(null); return; }
    const src = cfgs[copyFrom]?.strategy;
    if (!src) { setCopyFrom(null); return; }
    try {
      await fetch(`${API}/config`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_hash: target, strategy: src }) });
      await loadCfg(target);
      const from = cols.find((c) => c.hash === copyFrom)?.label ?? "source";
      const to = cols.find((c) => c.hash === target)?.label ?? "target";
      toast(`Copied rules from ${from} to ${to}`, "success");
    } catch { toast("Couldn't copy rules", "error"); }
    setCopyFrom(null);
  };

  if (loading) return <p style={S.note}>Loading every account's rules…</p>;
  if (cols.length === 0) return <p style={S.note}>No accounts to compare yet. Connect a profile and pick its account.</p>;

  const summaries = Object.fromEntries(cols.map((c) => [c.hash, summarize(cfgs[c.hash])]));
  const differs = (row: string) => {
    const vals = cols.map((c) => summaries[c.hash]?.[row]).filter((v) => v !== undefined);
    return vals.length > 1 && new Set(vals).size > 1;
  };

  return (
    <div>
      <p style={S.note}>
        Every account's rules side by side. A <span style={S.diffDot} /> marks a row where accounts differ.
        Edit an account's rules on the "This account" view (switch to that account); here you can compare and copy
        one account's whole playbook onto another.
      </p>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 240 + cols.length * 150 }}>
          <div style={{ ...S.row, ...S.headRow }}>
            <div style={S.rowLabel} />
            {cols.map((c) => (
              <div key={c.hash} style={S.colHead}>
                <div style={c.live ? undefined : S.stale} title={c.live ? c.label : `${c.label} — reconnect this profile for the account name`}>{c.label}</div>
                <select style={S.copySel} value=""
                  onChange={(e) => { setCopyFrom(c.hash); copyTo(e.target.value); }}
                  aria-label={`Copy ${c.label} rules to another account`}>
                  <option value="">Copy to…</option>
                  {cols.filter((o) => o.hash !== c.hash).map((o) => (
                    <option key={o.hash} value={o.hash}>{o.label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {ROWS.map((row) => (
            <div key={row} style={S.row}>
              <div style={S.rowLabel}>
                {differs(row) && <span style={S.diffDot} />}
                <span style={{ color: "var(--text-muted)" }}>{row}</span>
              </div>
              {cols.map((c) => (
                <div key={c.hash} style={{ ...S.cell, ...(differs(row) ? S.cellDiff : null) }}>
                  {summaries[c.hash]?.[row] ?? "—"}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  note: { color: "var(--text-dim)", fontSize: "var(--fs-sm)", lineHeight: 1.5, margin: "4px 0 12px" },
  row: { display: "flex", alignItems: "stretch", borderTop: "1px solid var(--border-hairline)" },
  headRow: { borderTop: "none", alignItems: "flex-end" },
  rowLabel: { width: 220, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "8px 10px 8px 0", fontSize: "var(--fs-sm)" },
  colHead: { width: 150, flexShrink: 0, padding: "6px 8px", fontSize: "var(--fs-2xs)", fontWeight: 700, color: "var(--text-muted)" },
  stale: { color: "var(--text-faint)", fontStyle: "italic" },
  copySel: { marginTop: 4, width: "100%", height: 26, fontSize: "var(--fs-2xs)" },
  cell: { width: 150, flexShrink: 0, padding: "8px", fontSize: "var(--fs-sm)", fontVariantNumeric: "tabular-nums" },
  cellDiff: { background: "var(--warn-bg)" },
  diffDot: { display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "var(--warn)", flexShrink: 0 },
};
