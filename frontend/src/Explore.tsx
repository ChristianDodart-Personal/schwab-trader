import { useEffect, useMemo, useState } from "react";
import { API } from "./api";
import { flattenPaths } from "./explorePaths";
import { useToast } from "./Toast";

// ============================================================================
// Explore tab (experimental) — every READ-ONLY call the Schwab Trader API offers, runnable
// against the selected account, with the raw payload and a field inventory. For planning
// features: see what Schwab actually returns before building on it. Nothing here can
// place, change or cancel an order (the backend only dispatches get_* calls).
// ============================================================================

type Param = { name: string; kind: "int" | "text" | "bool" | "select"; default: unknown; label: string; options: string[] | null };
type Endpoint = { id: string; group: string; label: string; what: string; used_for: string | null; params: Param[] };
type Recipe = { question: string; id: string; params: Record<string, unknown> };
type Result = { ok: boolean; http?: number | null; ms?: number; bytes?: number; data?: unknown; text?: string; truncated?: boolean; error?: string };

const defaults = (e: Endpoint) => Object.fromEntries(e.params.map((p) => [p.name, p.default]));
const kb = (n?: number) => (n == null ? "" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

export function Explore() {
  const toast = useToast();
  const [eps, setEps] = useState<Endpoint[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [selId, setSelId] = useState<string>("transactions");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"fields" | "raw">("fields");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch(`${API}/explore/catalog`).then((r) => r.json()).then((d) => {
      setEps(d.endpoints ?? []);
      setRecipes(d.recipes ?? []);
      const first = (d.endpoints ?? []).find((e: Endpoint) => e.id === "transactions") ?? d.endpoints?.[0];
      if (first) { setSelId(first.id); setParams(defaults(first)); }
    }).catch(() => toast("Could not load the API catalog", "error"));
  }, [toast]);

  const sel = eps.find((e) => e.id === selId);
  const groups = useMemo(() => {
    const m = new Map<string, Endpoint[]>();
    eps.forEach((e) => m.set(e.group, [...(m.get(e.group) ?? []), e]));
    return [...m.entries()];
  }, [eps]);

  const pick = (e: Endpoint, p?: Record<string, unknown>) => {
    setSelId(e.id); setParams({ ...defaults(e), ...(p ?? {}) }); setRes(null); setFilter("");
  };

  const run = async (id = selId, p = params) => {
    setBusy(true); setRes(null);
    try {
      const r = await fetch(`${API}/explore/run`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, params: p }) }).then((x) => x.json());
      setRes(r);
    } catch (e) {
      setRes({ ok: false, error: String(e) });
    } finally { setBusy(false); }
  };

  const fields = useMemo(() => (res?.data !== undefined ? flattenPaths(res.data) : []), [res]);
  const shownFields = filter
    ? fields.filter((f) => (f.path + " " + f.samples.join(" ")).toLowerCase().includes(filter.toLowerCase()))
    : fields;
  const raw = useMemo(() => (res?.data !== undefined ? JSON.stringify(res.data, null, 2) : res?.text ?? ""), [res]);
  const count = Array.isArray(res?.data) ? (res!.data as unknown[]).length : null;

  const copy = async () => {
    try { await navigator.clipboard.writeText(raw); toast("Copied the raw JSON", "success"); }
    catch { toast("Copy failed", "error"); }
  };

  return (
    <div style={{ maxWidth: 1200 }}>
      <h2 className="page-title" style={{ marginTop: 4 }}>
        Explore <span className="tag" style={S.exp}>experimental</span>
      </h2>
      <p style={S.lede}>
        Every read-only call the Schwab API offers, run live against the selected account. Use it to see what data
        exists before planning a feature. It can't place, change or cancel orders.
      </p>

      {recipes.length > 0 && (
        <div style={S.recipes}>
          <span style={S.recipesLabel}>Start with a question</span>
          {recipes.map((r) => {
            const e = eps.find((x) => x.id === r.id);
            return e ? (
              <button key={r.question} className="btn btn-ghost btn-sm" onClick={() => { pick(e, r.params); run(e.id, { ...defaults(e), ...r.params }); }}>
                {r.question}
              </button>
            ) : null;
          })}
        </div>
      )}

      <div style={S.layout}>
        <nav className="panel" style={S.list} aria-label="API endpoints">
          {groups.map(([g, list]) => (
            <div key={g}>
              <div style={S.groupHead}>{g}</div>
              {list.map((e) => (
                <button key={e.id} style={S.item(e.id === selId)} onClick={() => pick(e)} aria-current={e.id === selId ? "true" : undefined}>
                  <span>{e.label}</span>
                  <span style={S.use(!!e.used_for)}>{e.used_for ? "in use" : "unused"}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <section style={{ minWidth: 0 }}>
          {sel && (
            <div className="panel" style={S.card}>
              <h3 style={S.h}>{sel.label}</h3>
              <p style={S.what}>{sel.what}</p>
              <p style={S.usedFor}>
                <b>In the app today:</b> {sel.used_for ?? "not used yet."}
              </p>
              <form style={S.form} onSubmit={(ev) => { ev.preventDefault(); run(); }}>
                {sel.params.map((p) => (
                  <label key={p.name} style={S.param}>
                    <span style={S.paramLabel}>{p.label}</span>
                    {p.kind === "bool" ? (
                      <input type="checkbox" checked={!!params[p.name]}
                        onChange={(e) => setParams({ ...params, [p.name]: e.target.checked })} />
                    ) : p.kind === "select" ? (
                      <select className="field" value={String(params[p.name] ?? "")}
                        onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}>
                        {(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input className="field" style={{ width: p.kind === "int" ? 90 : 180 }}
                        inputMode={p.kind === "int" ? "numeric" : undefined}
                        value={String(params[p.name] ?? "")}
                        onChange={(e) => setParams({ ...params, [p.name]: p.kind === "int" ? e.target.value.replace(/[^\d]/g, "") : e.target.value })} />
                    )}
                  </label>
                ))}
                <button type="submit" className={`btn btn-primary${busy ? " btn-pending" : ""}`} disabled={busy}>
                  {busy ? "Running…" : "Run"}
                </button>
              </form>
            </div>
          )}

          {res && (
            <div className="panel" style={{ ...S.card, marginTop: 12 }}>
              {res.error ? (
                <p style={{ color: "var(--neg)", margin: 0 }}>{res.error}</p>
              ) : (
                <>
                  <div style={S.statusRow}>
                    <span style={{ color: res.ok ? "var(--pos)" : "var(--neg)", fontWeight: 700 }}>
                      {res.http != null ? `HTTP ${res.http}` : "In memory"}
                    </span>
                    {res.ms != null && res.http != null && <span style={S.dim}>{res.ms} ms</span>}
                    <span style={S.dim}>{kb(res.bytes)}</span>
                    {count != null && <span style={S.dim}>{count} item{count === 1 ? "" : "s"}</span>}
                    {res.truncated && <span style={{ color: "var(--warn)" }}>Truncated (too large to parse here)</span>}
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      {res.data !== undefined && (["fields", "raw"] as const).map((v) => (
                        <button key={v} className={`btn btn-sm ${view === v ? "btn-secondary" : "btn-ghost"}`}
                          aria-pressed={view === v} onClick={() => setView(v)}>
                          {v === "fields" ? `Fields (${fields.length})` : "Raw JSON"}
                        </button>
                      ))}
                      <button className="btn btn-ghost btn-sm" onClick={copy} disabled={!raw}>Copy</button>
                    </span>
                  </div>
                  {view === "fields" && res.data !== undefined ? (
                    <>
                      <input className="field" style={{ width: "100%", boxSizing: "border-box", margin: "10px 0 8px" }} value={filter}
                        onChange={(e) => setFilter(e.target.value)} placeholder="Filter fields or values (e.g. split, cusip, averagePrice)"
                        aria-label="Filter fields" />
                      {shownFields.length === 0 ? (
                        <p style={S.dim}>{fields.length === 0 ? "Empty response." : `No fields match "${filter}".`}</p>
                      ) : (
                        <div style={S.scroll}>
                          <table className="tbl" style={{ fontSize: "var(--fs-xs)" }}>
                            <thead><tr><th className="left">Field</th><th className="left">Type</th><th>Seen</th><th className="left">Sample values</th></tr></thead>
                            <tbody>
                              {shownFields.map((f) => (
                                <tr key={f.path}>
                                  <td style={S.mono}>{f.path}</td>
                                  <td style={S.dim}>{f.type}</td>
                                  <td>{f.count}</td>
                                  <td style={{ ...S.mono, whiteSpace: "normal" }}>{f.samples.join("  ·  ")}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  ) : (
                    <pre style={S.raw}>{raw || "(empty body)"}</pre>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const S = {
  exp: { background: "var(--warn-bg)", color: "var(--warn)", marginLeft: 8, verticalAlign: "middle" } as React.CSSProperties,
  lede: { color: "var(--text-dim)", fontSize: "var(--fs-sm)", margin: "0 0 12px", maxWidth: 760 } as React.CSSProperties,
  recipes: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 14 } as React.CSSProperties,
  recipesLabel: { fontSize: "var(--fs-xs)", color: "var(--text-faint)", marginRight: 4 } as React.CSSProperties,
  layout: { display: "grid", gridTemplateColumns: "minmax(200px, 250px) minmax(0, 1fr)", gap: 16, alignItems: "start" } as React.CSSProperties,
  list: { padding: "6px 0", position: "sticky", top: 8 } as React.CSSProperties,
  groupHead: { fontSize: "var(--fs-2xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
    color: "var(--text-faint)", padding: "10px 14px 4px" } as React.CSSProperties,
  item: (on: boolean): React.CSSProperties => ({
    display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", gap: 8,
    background: on ? "var(--panel-2)" : "transparent", border: "none", borderLeft: `2px solid ${on ? "var(--accent)" : "transparent"}`,
    color: on ? "var(--text)" : "var(--text-muted)", padding: "6px 12px", fontSize: "var(--fs-sm)", cursor: "pointer", textAlign: "left",
  }),
  use: (used: boolean): React.CSSProperties => ({ fontSize: "var(--fs-2xs)", color: used ? "var(--text-faint)" : "var(--accent)", whiteSpace: "nowrap" }),
  card: { padding: "14px 16px" } as React.CSSProperties,
  h: { margin: "0 0 6px", fontSize: "var(--fs-md)", fontWeight: 700 } as React.CSSProperties,
  what: { margin: "0 0 6px", fontSize: "var(--fs-sm)", color: "var(--text-muted)", lineHeight: 1.5 } as React.CSSProperties,
  usedFor: { margin: "0 0 12px", fontSize: "var(--fs-xs)", color: "var(--text-dim)", lineHeight: 1.5 } as React.CSSProperties,
  form: { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" } as React.CSSProperties,
  param: { display: "flex", flexDirection: "column", gap: 4 } as React.CSSProperties,
  paramLabel: { fontSize: "var(--fs-2xs)", color: "var(--text-dim)" } as React.CSSProperties,
  statusRow: { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", fontSize: "var(--fs-sm)" } as React.CSSProperties,
  dim: { color: "var(--text-dim)", fontSize: "var(--fs-xs)" } as React.CSSProperties,
  scroll: { maxHeight: 560, overflow: "auto", border: "1px solid var(--border-hairline)", borderRadius: "var(--r-md)" } as React.CSSProperties,
  mono: { fontFamily: "var(--font-mono)" } as React.CSSProperties,
  raw: { maxHeight: 560, overflow: "auto", margin: "10px 0 0", padding: 12, background: "var(--panel-2)",
    borderRadius: "var(--r-md)", fontSize: "var(--fs-xs)", lineHeight: 1.45, whiteSpace: "pre" } as React.CSSProperties,
};
