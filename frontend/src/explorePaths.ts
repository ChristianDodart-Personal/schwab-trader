// Flatten an API payload into its distinct field paths, the "what data is in here" view of
// the Explore tab. Array items collapse into one `[]` segment, so 40 positions produce one
// row per field (with how many times it appeared and a few distinct sample values), not 40.

export type FieldPath = {
  path: string;        // e.g. securitiesAccount.positions[].averagePrice
  type: string;        // number | string | boolean | null | object | array (mixed → "a | b")
  count: number;       // how many values sat at this path
  samples: string[];   // up to 3 distinct values, shown as text
};

const MAX_SAMPLES = 3;
const MAX_SAMPLE_LEN = 60;

// Map keys that are data, not field names (quotes are keyed by symbol, orders' maps by
// date, account-number maps by number), collapse to `{key}` when the object is wide and
// its values all share a shape. Keeps 40 quote symbols from becoming 40 × fields rows.
function looksLikeDataKeys(o: Record<string, unknown>): boolean {
  const keys = Object.keys(o);
  if (keys.length < 4) return false;
  const vals = Object.values(o);
  if (!vals.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) return false;
  const shape = (v: unknown) => Object.keys(v as object).sort().join(",");
  const first = shape(vals[0]);
  return vals.filter((v) => shape(v) === first).length >= vals.length * 0.6;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function flattenPaths(data: unknown): FieldPath[] {
  const acc = new Map<string, { types: Set<string>; count: number; samples: string[] }>();
  const note = (path: string, v: unknown) => {
    let e = acc.get(path);
    if (!e) { e = { types: new Set(), count: 0, samples: [] }; acc.set(path, e); }
    e.types.add(typeOf(v));
    e.count += 1;
    if (v === null || typeof v !== "object") {
      const s = String(v).slice(0, MAX_SAMPLE_LEN);
      if (e.samples.length < MAX_SAMPLES && !e.samples.includes(s)) e.samples.push(s);
    }
  };
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      if (path) note(path, v);
      v.forEach((item) => walk(item, `${path}[]`));
    } else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (path) note(path, v);
      const dataKeys = looksLikeDataKeys(o);
      for (const [k, child] of Object.entries(o)) {
        const seg = dataKeys ? "{key}" : k;
        walk(child, path ? `${path}.${seg}` : seg);
      }
    } else {
      note(path || "(value)", v);
    }
  };
  walk(data, "");
  return [...acc.entries()].map(([path, e]) => ({
    path, type: [...e.types].join(" | "), count: e.count, samples: e.samples,
  }));
}
