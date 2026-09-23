import { useEffect, useMemo, useState } from "react";
import { usd } from "./format";
import { SignalRulesEditor } from "./settings/SignalRulesEditor";
import { RulesCompare } from "./RulesCompare";
import { useToast } from "./Toast";
import { IconCheck, IconWarning, IconClose } from "./Icon";

import { API } from "./api";

// ============================================================================
// Financial Rules — the transparent playbook behind every buy/sell SUGGESTION.
// Nothing here places an order; it only shapes what the app recommends. Every
// rule is editable with a plain-language explanation and, where useful, a live
// worked example so you can see exactly what a change does before saving.
// ============================================================================

type SizingTier = { up_to_rungs: number; dollars: number };
type Drop = { up_to_rung: number; drop_pct: number };
type DeployTier = { min_deployed_pct: number; drop_multiplier: number };
type Strategy = {
  sizing_tiers: SizingTier[];
  buy_ladder: { max_rungs: number; drops: Drop[] };
  sell: { default_mode: string; dollar_gain: number; pct_above: number };
  deployment_scaling: { enabled: boolean; tiers: DeployTier[] };
  guardrails: Record<string, unknown>;
};
type Config = { account_hash: string; strategy: Strategy; strategy_is_default: boolean };

// The ladder no longer has a user-set maximum (buy as deep as your dips go). We still
// show a short worked preview of the first few positions so the drop tiers are legible.
const PREVIEW_STEPS = 8;

const gnum = (o: Record<string, unknown>, k: string, d = 0) =>
  typeof o[k] === "number" ? (o[k] as number) : d;

// Recommended starting tiers (seeded when the user first enables scaling on an
// account that has none). Matches the backend default: pickier as you fill up.
const DEFAULT_DEPLOY_TIERS: DeployTier[] = [
  { min_deployed_pct: 90, drop_multiplier: 1.4 },
  { min_deployed_pct: 70, drop_multiplier: 1.15 },
  { min_deployed_pct: 0, drop_multiplier: 1.0 },
];

type Finding = { level: "warn" | "info"; message: string };

export function FinancialRules({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const [c, setC] = useState<Config | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [mode, setMode] = useState<"account" | "compare">("account");
  const toast = useToast();

  const loadFindings = () =>
    fetch(`${API}/strategy/validate`).then((r) => r.json())
      .then((j) => setFindings(Array.isArray(j?.findings) ? j.findings : [])).catch(() => {});

  useEffect(() => { fetch(`${API}/config`).then((r) => r.json()).then(setC).catch(() => {}); loadFindings(); }, []);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Header + mode toggle: "This account" (the full editor) vs "Compare accounts" (the
  // side-by-side matrix). Compare doesn't need the loaded config, so it renders even
  // while `c` is loading.
  const header = (
    <>
      <h2 className="page-title" style={{ marginTop: 4, gridColumn: "1 / -1" }}>Financial Rules</h2>
      <div style={{ ...S.modeToggle, gridColumn: "1 / -1" }} role="tablist" aria-label="Rules view">
        {(["account", "compare"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            style={{ ...S.modeBtn, ...(mode === m ? S.modeBtnActive : null) }}>
            {m === "account" ? "This account" : "Compare accounts"}
          </button>
        ))}
      </div>
    </>
  );
  if (mode === "compare") return <div style={S.wrapWide}>{header}<RulesCompare /></div>;
  if (!c) return <div className="card-grid" style={{ paddingBottom: 60 }}>{header}<p style={S.note}>Loading your rules…</p></div>;
  const st = c.strategy;
  const setStrat = (patch: Partial<Strategy>) => {
    setC({ ...c, strategy: { ...st, ...patch } }); setSaved(false); setDirty(true);
  };

  // ---- sizing ----
  const addTier = () => {
    const last = st.sizing_tiers[st.sizing_tiers.length - 1];
    setStrat({ sizing_tiers: [...st.sizing_tiers, { up_to_rungs: (last?.up_to_rungs ?? 0) + 1, dollars: last?.dollars ?? 500 }] });
  };
  const updTier = (i: number, f: keyof SizingTier, v: number) =>
    setStrat({ sizing_tiers: st.sizing_tiers.map((t, j) => (j === i ? { ...t, [f]: v } : t)) });
  const rmTier = (i: number) => setStrat({ sizing_tiers: st.sizing_tiers.filter((_, j) => j !== i) });

  // ---- ladder drops ----
  const addDrop = () => {
    const last = st.buy_ladder.drops[st.buy_ladder.drops.length - 1];
    setStrat({ buy_ladder: { ...st.buy_ladder, drops: [...st.buy_ladder.drops, { up_to_rung: (last?.up_to_rung ?? 0) + 1, drop_pct: last?.drop_pct ?? 0.1 }] } });
  };
  const updDrop = (i: number, f: keyof Drop, v: number) =>
    setStrat({ buy_ladder: { ...st.buy_ladder, drops: st.buy_ladder.drops.map((d, j) => (j === i ? { ...d, [f]: v } : d)) } });
  const rmDrop = (i: number) =>
    setStrat({ buy_ladder: { ...st.buy_ladder, drops: st.buy_ladder.drops.filter((_, j) => j !== i) } });

  // ---- deployment tiers ----
  const ds = st.deployment_scaling ?? { enabled: false, tiers: [] };
  const setDs = (patch: Partial<Strategy["deployment_scaling"]>) => setStrat({ deployment_scaling: { ...ds, ...patch } });
  // Turning it on with no tiers yet seeds the recommended set so it does something
  // immediately (and the user can then tune it).
  const toggleDeploy = (on: boolean) =>
    setDs(on && ds.tiers.length === 0 ? { enabled: true, tiers: DEFAULT_DEPLOY_TIERS } : { enabled: on });
  const addDeploy = () => setDs({ tiers: [...ds.tiers, { min_deployed_pct: 0, drop_multiplier: 1.0 }] });
  const updDeploy = (i: number, f: keyof DeployTier, v: number) =>
    setDs({ tiers: ds.tiers.map((t, j) => (j === i ? { ...t, [f]: v } : t)) });
  const rmDeploy = (i: number) => setDs({ tiers: ds.tiers.filter((_, j) => j !== i) });

  // ---- guardrails (edit known keys, preserve the rest) ----
  const setGuard = (k: string, v: number) => setStrat({ guardrails: { ...st.guardrails, [k]: v } });

  const save = () => {
    const strategy: Strategy = {
      ...st,
      sizing_tiers: [...st.sizing_tiers].sort((a, b) => a.up_to_rungs - b.up_to_rungs),
      buy_ladder: { ...st.buy_ladder, drops: [...st.buy_ladder.drops].sort((a, b) => a.up_to_rung - b.up_to_rung) },
      deployment_scaling: { ...ds, tiers: [...ds.tiers].sort((a, b) => b.min_deployed_pct - a.min_deployed_pct) },
    };
    fetch(`${API}/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy }),
    })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((j) => { if (!j || !j.strategy) throw new Error(); setC(j); setSaved(true); setDirty(false); toast("Rules saved.", "success"); loadFindings(); })
      .catch(() => toast("Couldn't save — check the values and try again.", "error"));
  };

  return (
    <div className="card-grid" style={{ paddingBottom: 60 }}>
      {header}
      <p style={{ ...S.intro, gridColumn: "1 / -1" }}>
        This is the playbook behind every <b>buy</b> and <b>sell</b> suggestion. Changing a rule changes what the app
        recommends — it <b>never places an order on its own</b>; you always review and confirm each one.
        {" "}Rules apply to the <b>selected account</b> and are currently <b>{c.strategy_is_default ? "the defaults" : "customized"}</b>.
      </p>

      {findings && (
        <div style={{ ...(findings.length ? S.healthWarn : S.healthOk), gridColumn: "1 / -1" }}>
          {findings.length === 0 ? (
            <span><IconCheck /> Rules look consistent.</span>
          ) : (
            <>
              <div style={{ fontWeight: 600, marginBottom: 4 }}><IconWarning /> {findings.length} thing{findings.length === 1 ? "" : "s"} worth a look (you can still save):</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {findings.map((f, i) => <li key={i} style={{ color: f.level === "warn" ? "var(--warn)" : "var(--text-muted)" }}>{f.message}</li>)}
              </ul>
            </>
          )}
        </div>
      )}

      {/* ---------------- BUY LADDER ---------------- */}
      <Rule title="Buy ladder — how far it must fall before you add"
        desc="Your core move: after the first buy, if the price keeps dropping you buy more at lower prices (each a new “position”), improving your average cost. Each position needs the price to fall a set amount below the previous buy before it triggers. Deeper positions usually demand bigger drops. There's no cap on how many you can add — the ladder is as deep as your dips.">
        <Grid cols="1fr 1fr auto">
          <Head>Through position</Head><Head>Drop below previous buy</Head><span />
          {st.buy_ladder.drops.map((d, i) => (
            <Row key={i}>
              <NumInput value={d.up_to_rung} min={1} onChange={(v) => updDrop(i, "up_to_rung", v)} />
              <PctInput value={d.drop_pct} onChange={(v) => updDrop(i, "drop_pct", v)} />
              <RmBtn onClick={() => rmDrop(i)} />
            </Row>
          ))}
        </Grid>
        <button className="btn btn-secondary btn-sm" onClick={addDrop}>+ Add position tier</button>
        <LadderPreview drops={st.buy_ladder.drops} maxRungs={PREVIEW_STEPS} />
      </Rule>

      {/* ---------------- POSITION SIZING ---------------- */}
      <Rule title="Position sizing — how much to spend on each buy"
        desc="How many dollars to deploy on the next buy, based on how many positions you’ve already filled in that ticker. Shares = dollars ÷ price. Add tiers to spend more (or less) as a holding gets deeper.">
        <Grid cols="1fr 1fr auto">
          <Head>Through position</Head><Head>Dollars per buy</Head><span />
          {st.sizing_tiers.map((t, i) => (
            <Row key={i}>
              <NumInput value={t.up_to_rungs} min={1} onChange={(v) => updTier(i, "up_to_rungs", v)} />
              <MoneyInput value={t.dollars} onChange={(v) => updTier(i, "dollars", v)} />
              <RmBtn onClick={() => rmTier(i)} />
            </Row>
          ))}
        </Grid>
        <button className="btn btn-secondary btn-sm" onClick={addTier}>+ Add sizing tier</button>
        <Example>{sizingSentence(st.sizing_tiers)}</Example>
      </Rule>

      {/* ---------------- DEPLOYMENT SCALING (the formerly-hidden rule) ---------------- */}
      <Rule title="Deployment scaling — get pickier as you get fully invested"
        desc="Optional. When most of your own money is already in the market, this makes the ladder demand DEEPER dips before adding more, so you conserve cash for real bargains when you’re stretched. It only ever requires bigger drops, never smaller (a multiplier below 1× is treated as 1×), so it can’t make you buy more aggressively.">
        <label style={S.toggle}>
          <input type="checkbox" checked={!!ds.enabled} onChange={(e) => toggleDeploy(e.target.checked)} />
          <span><b>{ds.enabled ? "On" : "Off"}</b> — adapt buy triggers to how invested the account is</span>
        </label>
        {ds.enabled && (
          <>
            <p style={S.subtle}>“Deployed %” = money in the market ÷ your own equity (the dashboard’s Deployment meter). 100% = fully invested with your own money; above 100% = using margin. Each tier applies when you’re at or above its deployed level; the multiplier scales the ladder drop above.</p>
            <Grid cols="1fr 1fr auto">
              <Head>When deployed ≥</Head><Head>Require dips this much deeper</Head><span />
              {ds.tiers.map((t, i) => (
                <Row key={i}>
                  <PctPointInput value={t.min_deployed_pct} onChange={(v) => updDeploy(i, "min_deployed_pct", v)} />
                  <MultInput value={t.drop_multiplier} onChange={(v) => updDeploy(i, "drop_multiplier", v)} />
                  <RmBtn onClick={() => rmDeploy(i)} />
                </Row>
              ))}
            </Grid>
            <button className="btn btn-secondary btn-sm" onClick={addDeploy}>+ Add deployment tier</button>
            <DeployPreview tiers={ds.tiers} shallowDrop={st.buy_ladder.drops[0]?.drop_pct ?? 0.1} />
          </>
        )}
      </Rule>

      {/* ---------------- SELL TARGETS ---------------- */}
      <Rule title="Sell targets — when to take profit on a lot"
        desc="The default profit target the app suggests for selling a lot: either a flat dollar gain on that lot, or a fixed percentage above what you paid. You can still override per sell.">
        <Field label="Default target type">
          <select className="field" style={S.select} value={st.sell.default_mode}
            onChange={(e) => setStrat({ sell: { ...st.sell, default_mode: e.target.value } })}>
            <option value="dollar_gain">Flat dollar gain</option>
            <option value="pct_above">% above buy price</option>
          </select>
        </Field>
        <Field label="Dollar gain per lot">
          <MoneyInput value={st.sell.dollar_gain} onChange={(v) => setStrat({ sell: { ...st.sell, dollar_gain: v } })} />
        </Field>
        <Field label="% above buy price">
          <PctInput value={st.sell.pct_above} onChange={(v) => setStrat({ sell: { ...st.sell, pct_above: v } })} />
        </Field>
        <Example>
          {st.sell.default_mode === "dollar_gain"
            ? `A lot bought at $10 × 5 shares suggests selling once it’s worth ${usd(10 * 5 + st.sell.dollar_gain)} (a ${usd(st.sell.dollar_gain)} gain).`
            : `A lot bought at $10 suggests selling at ${usd(10 * (1 + st.sell.pct_above))} (${(st.sell.pct_above * 100).toFixed(1)}% up).`}
        </Example>
      </Rule>

      {/* ---------------- LADDER DEPTH (Method-tab stress reference) ---------------- */}
      <Rule title="Ladder depth — how deep you plan to be able to go"
        desc="A planning number, not a limit: nothing stops a buy at this depth. The Method tab uses it to stress-test how much a fully-laddered name would commit.">
        <Field label="Target positions deep (average)"
          hint="Roughly how many positions deep you aim to be able to support per stock.">
          <NumInput value={gnum(st.guardrails, "target_lots_deep", 6)} min={1}
            onChange={(v) => setGuard("target_lots_deep", v)} />
        </Field>
      </Rule>

      <div style={{ ...S.saveBar, gridColumn: "1 / -1" }}>
        <button className="btn btn-primary" onClick={save}>Save rules</button>
        <span aria-live="polite">
          {dirty ? <span style={S.dirty}>● Unsaved changes</span>
            : saved ? <span style={S.savedMsg}>✓ Saved — new suggestions use these immediately</span> : null}
        </span>
      </div>

      {/* Signals moved here from Settings — they're the dashboard flags derived from
          these same rules, so they belong with the rules. Saves independently. */}
      <Rule title="Dashboard signals"
        desc="The buy/sell flags shown on each dashboard row. The built-in default flags the next ladder position and the sell target set above; add your own rules with custom colors — a ticker flags when the default OR any enabled rule matches.">
        <SignalRulesEditor />
      </Rule>
    </div>
  );
}

// ---- live examples ----
// Pure: projected trigger prices from a $100 first buy, capped at 6 rows shown.
export function ladderPreviewRows(drops: Drop[], maxRungs: number): { rung: number; price: number; drop: number }[] {
  const sorted = [...drops].sort((a, b) => a.up_to_rung - b.up_to_rung);
  const dropFor = (rung: number) => {
    for (const d of sorted) if (rung <= d.up_to_rung) return d.drop_pct;
    return sorted.length ? sorted[sorted.length - 1].drop_pct : 0;
  };
  const out: { rung: number; price: number; drop: number }[] = [{ rung: 1, price: 100, drop: 0 }];
  for (let r = 2; r <= Math.min(maxRungs || 1, 6); r++) {
    const drop = dropFor(r);
    out.push({ rung: r, price: out[out.length - 1].price * (1 - drop), drop });
  }
  return out;
}

function LadderPreview({ drops, maxRungs }: { drops: Drop[]; maxRungs: number }) {
  const rows = useMemo(() => ladderPreviewRows(drops, maxRungs), [drops, maxRungs]);
  return (
    <Example>
      <div style={{ marginBottom: 4 }}>Starting from a first buy at <b>$100</b>, the next buys would trigger at <span style={{ color: "var(--text-dim)" }}>(before deployment scaling, which can make each drop deeper)</span>:</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {rows.map((r) => (
          <span key={r.rung} style={S.chip}>
            #{r.rung} <b>{usd(r.price)}</b>{r.drop ? <span style={{ color: "var(--text-faint)" }}> (−{(r.drop * 100).toFixed(0)}%)</span> : null}
          </span>
        ))}
        {maxRungs > 6 && <span style={{ color: "var(--text-faint)", alignSelf: "center" }}>… and deeper as it keeps dipping</span>}
      </div>
    </Example>
  );
}

function DeployPreview({ tiers, shallowDrop }: { tiers: DeployTier[]; shallowDrop: number }) {
  const sorted = [...tiers].sort((a, b) => b.min_deployed_pct - a.min_deployed_pct);
  return (
    <Example>
      <div style={{ marginBottom: 4 }}>With these tiers, a normally <b>{(shallowDrop * 100).toFixed(0)}%</b> position-2 dip becomes:</div>
      {sorted.map((t, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", maxWidth: 320, padding: "1px 0" }}>
          <span style={{ color: "var(--text-muted)" }}>deployed ≥ {t.min_deployed_pct}%</span>
          <b style={{ color: t.drop_multiplier > 1 ? "var(--warn)" : "var(--text)" }}>
            {(shallowDrop * t.drop_multiplier * 100).toFixed(1)}% dip required{t.drop_multiplier > 1 ? ` (×${t.drop_multiplier})` : ""}
          </b>
        </div>
      ))}
    </Example>
  );
}

export function sizingSentence(tiers: SizingTier[]): string {
  const s = [...tiers].sort((a, b) => a.up_to_rungs - b.up_to_rungs);
  if (!s.length) return "";
  const parts: string[] = [];
  let prev = 0;
  for (const t of s) {
    const range = prev + 1 === t.up_to_rungs ? `position ${t.up_to_rungs}` : `positions ${prev + 1}–${t.up_to_rungs}`;
    parts.push(`${range}: ${usd(t.dollars)} each`);
    prev = t.up_to_rungs;
  }
  return "Example: " + parts.join(" · ") + ".";
}

// ---- small building blocks ----
function Rule({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section style={S.rule}>
      <h3 className="section-title" style={S.ruleTitle}>{title}</h3>
      <p style={S.ruleDesc}>{desc}</p>
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={S.field}>
      <span style={S.fieldLabel}>{label}{hint && <span style={S.hint} title={hint}> (i)</span>}</span>
      {children}
    </div>
  );
}
function Grid({ cols, children }: { cols: string; children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: cols, gap: 8, alignItems: "center", marginBottom: 8 }}>{children}</div>;
}
const Row = ({ children }: { children: React.ReactNode }) => <>{children}</>;
const Head = ({ children }: { children: React.ReactNode }) => <span style={S.colHead}>{children}</span>;
const Example = ({ children }: { children: React.ReactNode }) => <div style={S.example}>{children}</div>;
const RmBtn = ({ onClick }: { onClick: () => void }) => (
  <button className="btn btn-ghost btn-sm" title="remove" aria-label="remove" onClick={onClick}><IconClose /></button>
);

// numeric inputs — canonical value stays in backend units; % inputs show ×100.
function NumInput({ value, min, onChange }: { value: number; min?: number; onChange: (v: number) => void }) {
  return <input className="field" style={S.num} type="number" min={min} value={value}
    onChange={(e) => onChange(Number(e.target.value))} />;
}
function MoneyInput({ value, onChange, wide }: { value: number; onChange: (v: number) => void; wide?: boolean }) {
  return <input className="field" style={{ ...S.num, width: wide ? 180 : undefined }} type="number" value={value}
    onChange={(e) => onChange(Number(e.target.value))} />;
}
function PctInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  // stored as a fraction (0.10); shown as a percent (10). Suffix makes the unit obvious.
  return (
    <span style={S.suffixWrap}>
      <input className="field" style={S.num} type="number" step="0.5" value={+(value * 100).toFixed(4)}
        onChange={(e) => onChange(Number(e.target.value) / 100)} />
      <span style={S.suffix}>%</span>
    </span>
  );
}
function PctPointInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  // already a percent point (e.g. 90); no ×100.
  return (
    <span style={S.suffixWrap}>
      <input className="field" style={S.num} type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span style={S.suffix}>%</span>
    </span>
  );
}
function MultInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span style={S.suffixWrap}>
      <span style={{ ...S.suffix, marginRight: 4 }}>×</span>
      <input className="field" style={S.num} type="number" step="0.05" min={1} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
    </span>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { marginTop: 12, paddingBottom: 60, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, alignItems: "start" },
  wrapWide: { marginTop: 12, maxWidth: 1100, paddingBottom: 60 },
  modeToggle: { display: "inline-flex", gap: 2, padding: 3, background: "var(--panel-2)",
    border: "1px solid var(--border)", borderRadius: "var(--r-md)", margin: "6px 0 14px" },
  modeBtn: { border: "none", background: "transparent", color: "var(--text-muted)",
    padding: "6px 16px", borderRadius: "var(--r-sm)", cursor: "pointer", fontSize: "var(--fs-sm)", fontWeight: 600 },
  modeBtnActive: { background: "var(--pop)", color: "var(--text)", boxShadow: "var(--elev-1)" },
  intro: { color: "var(--text-muted)", fontSize: "var(--fs-md)", lineHeight: 1.55, margin: "4px 0 4px", padding: "12px 14px", background: "var(--panel-2)", borderRadius: "var(--r-md)", border: "1px solid var(--border-hairline)" },
  healthOk: { color: "var(--pos)", fontSize: "var(--fs-sm)", margin: "8px 0", padding: "8px 12px", background: "var(--pos-bg)", borderRadius: "var(--r-md)" },
  healthWarn: { fontSize: "var(--fs-sm)", lineHeight: 1.5, margin: "8px 0", padding: "10px 12px", background: "var(--warn-bg)", border: "1px solid var(--warn-border)", borderRadius: "var(--r-md)", color: "var(--text-muted)" },
  rule: { background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 18, marginTop: 14 },
  ruleTitle: { margin: 0, fontSize: "var(--fs-lg)" },
  ruleDesc: { margin: "6px 0 0", color: "var(--text-muted)", fontSize: "var(--fs-sm)", lineHeight: 1.5 },
  colHead: { fontSize: "var(--fs-2xs)", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.04em" },
  field: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "6px 0", fontSize: "var(--fs-md)" },
  fieldLabel: { color: "var(--text-muted)" },
  hint: { color: "var(--accent-quiet)", cursor: "help", fontSize: "var(--fs-2xs)" },
  num: { width: 100, textAlign: "right" },
  select: { width: 180 },
  suffixWrap: { display: "inline-flex", alignItems: "center", gap: 3 },
  suffix: { color: "var(--text-faint)", fontSize: "var(--fs-sm)" },
  toggle: { display: "flex", gap: 10, alignItems: "center", fontSize: "var(--fs-md)", color: "var(--text-muted)", cursor: "pointer" },
  subtle: { color: "var(--text-faint)", fontSize: "var(--fs-sm)", lineHeight: 1.5, margin: "10px 0 6px" },
  example: { marginTop: 12, padding: "10px 12px", background: "var(--panel-2)", borderRadius: "var(--r-md)", fontSize: "var(--fs-sm)", color: "var(--text-muted)", lineHeight: 1.5 },
  chip: { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--r-pill)", padding: "2px 10px", fontVariantNumeric: "tabular-nums" },
  saveBar: { display: "flex", alignItems: "center", gap: 14, marginTop: 18, position: "sticky", bottom: 0, background: "var(--bg)", padding: "12px 0" },
  savedMsg: { color: "var(--pos)", fontSize: "var(--fs-md)" },
  dirty: { color: "var(--warn)", fontSize: "var(--fs-sm)", fontWeight: 600 },
  note: { color: "var(--text-faint)", fontSize: "var(--fs-sm)", marginTop: 16 },
};
