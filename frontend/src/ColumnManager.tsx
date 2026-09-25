import { useRef, useState } from "react";
import type { ColumnPrefs, FoldPrefs } from "./columns";
import { MIN_CELL_PX, MAX_CELL_PX, DEFAULT_CELL_PX, type CellDensity } from "./density";
import { IconSettings, IconClose, IconGrip, IconArrowUp, IconArrowDown, IconChevronRight } from "./Icon";

/** A "⚙ Columns" button + popover to reorder, remove, add, and reset the columns
 * for one view. Generic over any ColumnPrefs + a label lookup. When `fold` is
 * supplied, each column also gets a toggle to fold it behind the table's chevron.
 * When `density` is supplied, a column-spacing slider is shown at the top. */
export function ColumnManager({
  prefs,
  labelOf,
  align = "left",
  onReset,
  fold,
  density,
}: {
  prefs: ColumnPrefs;
  labelOf: (id: string) => string;
  align?: "left" | "right";
  onReset?: () => void;   // extra side-effect when Reset is pressed (e.g. re-collapse folds)
  fold?: FoldPrefs;       // when set, each column shows a fold-behind-chevron toggle
  density?: CellDensity;  // when set, a "Column spacing" slider adjusts global cell padding
}) {
  const [open, setOpen] = useState(false);
  const [toAdd, setToAdd] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Closing via ✕ or Escape puts keyboard focus back on the "⚙ Columns" trigger
  // (otherwise it falls to <body> when the popover unmounts).
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Grouped columns (e.g. "Ladder read") get their own <optgroup> and an "Add all" button.
  const groups: [string, { id: string; label: string }[]][] = [];
  for (const c of prefs.available) {
    if (!c.group) continue;
    const g = groups.find(([k]) => k === c.group);
    if (g) g[1].push(c); else groups.push([c.group, [c]]);
  }

  const doAdd = () => {
    if (toAdd) {
      prefs.add(toAdd);
      setToAdd("");
    }
  };

  return (
    <span style={S.wrap}>
      <button ref={triggerRef} className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}
        title="customize columns" aria-expanded={open}>
        <IconSettings /> Columns
      </button>
      {open && (
        <div style={{ ...S.pop, left: align === "left" ? 0 : undefined, right: align === "right" ? 0 : undefined }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
          <div style={S.head}>
            <span style={S.title}>Columns</span>
            <button className="btn btn-ghost btn-sm" style={S.reset} onClick={() => { prefs.reset(); onReset?.(); }} title="restore default layout">Reset</button>
            <button className="btn btn-ghost btn-sm" style={S.close} onClick={close} aria-label="close column manager"><IconClose /></button>
          </div>

          {density && (
            <div style={S.densityRow}>
              <span style={S.densityLabel}>Column spacing</span>
              <input type="range" min={MIN_CELL_PX} max={MAX_CELL_PX} step={1} value={density.px}
                onChange={(e) => density.setPx(Number(e.target.value))}
                aria-label="Column spacing" title="Horizontal space inside every table cell" style={S.densitySlider} />
              {density.px !== DEFAULT_CELL_PX ? (
                <button className="btn btn-ghost btn-sm" style={S.densityVal} onClick={density.reset}
                  title="reset to default spacing">{density.px}px</button>
              ) : (
                <span style={{ ...S.densityVal, color: "var(--text-faint)" }}>{density.px}px</span>
              )}
            </div>
          )}

          {fold && (
            <div style={S.hint}>
              <IconChevronRight /> folds a column behind the table’s chevron (still there, just tucked away).
            </div>
          )}
          <div style={S.list}>
            {prefs.ids.map((id, i) => {
              const isFolded = fold?.isFolded(id) ?? false;
              return (
              <div
                key={id}
                style={{ ...S.item, ...(overId === id && dragId && dragId !== id ? S.itemOver : null),
                  opacity: dragId === id ? 0.4 : isFolded ? 0.6 : 1 }}
                draggable
                onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { e.preventDefault(); if (dragId && dragId !== id) setOverId(id); }}
                onDragLeave={() => setOverId((o) => (o === id ? null : o))}
                onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== id) prefs.reorder(dragId, i); setDragId(null); setOverId(null); }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
              >
                <span style={S.grip} title="drag to reorder"><IconGrip /></span>
                <span style={S.itemLabel}>{labelOf(id)}</span>
                {fold && (
                  <button className="btn btn-ghost btn-sm" style={{ ...S.mv, ...(isFolded ? S.foldOn : null) }}
                    aria-pressed={isFolded} onClick={() => fold.toggle(id)}
                    title={isFolded ? "Folded behind the chevron — click to always show" : "Shown — click to fold behind the chevron"}
                    aria-label={`${isFolded ? "unfold" : "fold"} ${labelOf(id)}`}><IconChevronRight /></button>
                )}
                <button className="btn btn-ghost btn-sm" style={S.mv} disabled={i === 0} onClick={() => prefs.move(id, -1)} title="move up" aria-label={`move ${labelOf(id)} up`}><IconArrowUp /></button>
                <button className="btn btn-ghost btn-sm" style={S.mv} disabled={i === prefs.ids.length - 1} onClick={() => prefs.move(id, 1)} title="move down" aria-label={`move ${labelOf(id)} down`}><IconArrowDown /></button>
                <button className="btn btn-ghost btn-sm" style={S.rm} onClick={() => prefs.remove(id)} title="remove" aria-label={`remove ${labelOf(id)}`}><IconClose /></button>
              </div>
              );
            })}
            {prefs.ids.length === 0 && <div style={S.empty}>No columns — add one below.</div>}
          </div>

          <div style={S.addRow}>
            <select className="field" style={S.select} value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
              <option value="">Add a column…</option>
              {prefs.available.filter((c) => !c.group).map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
              {groups.map(([g, cols]) => (
                <optgroup key={g} label={g}>
                  {cols.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </optgroup>
              ))}
            </select>
            <button className="btn btn-primary btn-sm" onClick={doAdd} disabled={!toAdd}>Add</button>
          </div>
          {groups.filter(([, cols]) => cols.length > 1).map(([g, cols]) => (
            <button key={g} className="btn btn-ghost btn-sm" style={{ marginTop: 6 }}
              onClick={() => cols.forEach((c) => prefs.add(c.id))}
              title={`Add ${cols.map((c) => c.label).join(", ")}`}>
              Add all {g} columns ({cols.length})
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { position: "relative", display: "inline-block" },
  pop: { position: "absolute", top: "calc(100% + 6px)", width: 300, background: "var(--pop)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-pop)", zIndex: "var(--z-popover)", padding: 10 },
  head: { display: "flex", alignItems: "center", gap: 8, paddingBottom: 8, borderBottom: "1px solid var(--border-hairline)" },
  title: { fontSize: "var(--fs-sm)", fontWeight: 700, flex: 1, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)" },
  reset: { color: "var(--accent-quiet)" },
  close: { color: "var(--text-faint)" },
  densityRow: { display: "flex", alignItems: "center", gap: 8, padding: "10px 2px 4px" },
  densityLabel: { fontSize: "var(--fs-xs)", color: "var(--text-muted)", whiteSpace: "nowrap" },
  densitySlider: { flex: 1, minWidth: 0, accentColor: "var(--accent)" },
  densityVal: { fontSize: "var(--fs-2xs)", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", padding: "1px 5px", minWidth: 40, textAlign: "right" },
  hint: { display: "flex", alignItems: "center", gap: 5, fontSize: "var(--fs-2xs)", color: "var(--text-dim)", padding: "8px 2px 2px", lineHeight: 1.4 },
  list: { maxHeight: 320, overflowY: "auto", padding: "6px 0" },
  item: { display: "flex", alignItems: "center", gap: 3, padding: "3px 2px", borderRadius: "var(--r-sm)", cursor: "grab" },
  itemOver: { boxShadow: "inset 0 2px 0 var(--accent)", background: "var(--panel-2)" },
  grip: { color: "var(--text-faint)", fontSize: 13, cursor: "grab", userSelect: "none" },
  itemLabel: { flex: 1, fontSize: "var(--fs-sm)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  mv: { padding: "1px 5px", lineHeight: 1.4 },
  foldOn: { color: "var(--on-accent)", background: "var(--accent-fill)", borderColor: "var(--accent-fill)" },
  rm: { color: "var(--neg-strong)", borderColor: "var(--neg-border)", padding: "1px 6px" },
  empty: { color: "var(--text-faint)", fontSize: "var(--fs-xs)", padding: "6px 2px" },
  addRow: { display: "flex", gap: 6, paddingTop: 8, borderTop: "1px solid var(--border-hairline)" },
  select: { flex: 1, minWidth: 0 },
};
