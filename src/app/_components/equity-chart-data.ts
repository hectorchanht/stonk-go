/**
 * Pure data-mapping helpers for the interactive equity chart.
 *
 * This module has NO chart-library imports (the day shape is structural),
 * so it stays unit-testable in node. The chart component consumes these.
 */

export interface EquityPoint {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** USD value on that date. */
  value: number;
}

/**
 * Calendar-day time. Structurally identical to the chart library's
 * BusinessDay — the library renders it as a timezone-free day, which is
 * exactly what our local-calendar YYYY-MM-DD dates mean.
 */
export interface ChartDay {
  year: number;
  month: number;
  day: number;
}

export interface AreaDatum {
  time: ChartDay;
  value: number;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-10-06" -> { year: 2026, month: 10, day: 6 }; null when malformed. */
export function isoToChartDay(date: string): ChartDay | null {
  const m = ISO_DAY.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** Inverse of isoToChartDay. */
export function chartDayToIso(d: ChartDay): string {
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}

/** Map curve points to chart data, dropping malformed points. */
export function toAreaData(points: EquityPoint[]): AreaDatum[] {
  const out: AreaDatum[] = [];
  for (const p of points) {
    const time = isoToChartDay(p.date);
    if (time === null || !Number.isFinite(p.value)) continue;
    out.push({ time, value: p.value });
  }
  return out;
}

/** Curve line color: emerald when the period is up, rose when down. */
export function curveColor(points: EquityPoint[]): string {
  if (points.length < 2) return "#34d399";
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return last.value >= first.value ? "#34d399" : "#fb7185";
}

export interface InvestedPoint extends EquityPoint {
  /** Net USD invested up to this date (true-curve points carry it). */
  invested?: number | null;
}

/**
 * Return on invested capital: pct_t = (value_t − invested_t) / invested_t × 100.
 *
 * The honest formulation when deposits/withdrawals exist: each day's gain is
 * measured against the capital actually deployed up to that day. Simple —
 * NOT time-weighted (TWR needs daily valuations net of flows, which we
 * don't have). The UI must label it exactly this way and never claim TWR.
 * Days with non-positive invested are skipped (nothing deployed → no return).
 */
export function toReturnOnInvested(points: InvestedPoint[]): EquityPoint[] {
  const out: EquityPoint[] = [];
  for (const p of points) {
    const inv = p.invested;
    if (inv == null || !(inv > 0) || !Number.isFinite(p.value)) continue;
    out.push({ date: p.date, value: ((p.value - inv) / inv) * 100 });
  }
  return out;
}

/**
 * Cumulative simple % return series from dated values:
 * pct_i = (value_i − value_0) / value_0 × 100.
 *
 * This is a SIMPLE cumulative return, NOT time-weighted (TWR): interim
 * deposits/withdrawals shift it, so the UI must label it as such and must
 * never present it as IBKR-style TWR. Returns [] when the base value isn't
 * positive (dividing by it wouldn't be honest) or there are < 2 points.
 */
export function toPercentSeries(points: EquityPoint[]): EquityPoint[] {
  if (points.length < 2) return [];
  const base = points[0]!.value;
  if (!(base > 0)) return [];
  return points.map((p) => ({
    date: p.date,
    value: ((p.value - base) / base) * 100,
  }));
}

/* ---------------- By Source view ---------------- */

/** One trade-origin series for the stacked By Source chart. */
export interface SourceLayer {
  /** Raw source key, e.g. "ibkr". */
  key: string;
  label: string;
  color: string;
  points: EquityPoint[];
}

const SOURCE_META: Record<string, { label: string; color: string }> = {
  ibkr: { label: "IBKR", color: "#f87171" },
  manual: { label: "Manual", color: "#60a5fa" },
  questrade: { label: "Questrade", color: "#34d399" },
  binance: { label: "Binance", color: "#fbbf24" },
  coinbase: { label: "Coinbase", color: "#818cf8" },
};
const FALLBACK_COLORS = [
  "#c084fc",
  "#f472b6",
  "#2dd4bf",
  "#facc15",
  "#a3e635",
  "#fb923c",
];

/** Display name + dark-theme color for a trade source key. */
export function sourceMeta(
  key: string,
  index: number,
): { label: string; color: string } {
  const k = key.trim().toLowerCase();
  const known = SOURCE_META[k];
  if (known) return known;
  const trimmed = key.trim();
  const label =
    trimmed === ""
      ? "Unknown"
      : trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return {
    label,
    color: FALLBACK_COLORS[index % FALLBACK_COLORS.length]!,
  };
}

/**
 * Build ordered, labeled layers from a per-source map. Sorted by latest
 * value descending (largest at the bottom of the stack). Layers with no
 * usable points are dropped.
 */
export function toSourceLayers(
  perSource: Record<string, EquityPoint[]>,
): SourceLayer[] {
  const layers: SourceLayer[] = [];
  let i = 0;
  for (const [key, pts] of Object.entries(perSource)) {
    const clean = (pts ?? []).filter(
      (p) => p != null && Number.isFinite(p.value) && p.value >= 0,
    );
    if (clean.length === 0) continue;
    const meta = sourceMeta(key, i);
    layers.push({ key, label: meta.label, color: meta.color, points: clean });
    i++;
  }
  layers.sort((a, b) => {
    const av = a.points[a.points.length - 1]!.value;
    const bv = b.points[b.points.length - 1]!.value;
    return bv - av;
  });
  return layers;
}

export interface StackedLayer {
  key: string;
  label: string;
  color: string;
  /** Cumulative top-edge values (what the area series renders). */
  cumulative: AreaDatum[];
  /** This layer's own values, for the tooltip. */
  own: AreaDatum[];
}

/**
 * Stack layers bottom-to-top for area rendering. Dates are unioned across
 * layers and each layer forward-fills its latest known value (0 before its
 * first point). cumulative[i] = Σ own values of layers[0..i].
 */
export function stackLayers(layers: SourceLayer[]): StackedLayer[] {
  if (layers.length === 0) return [];
  const dates = [
    ...new Set(layers.flatMap((l) => l.points.map((p) => p.date))),
  ].sort();
  const byDate = layers.map((l) => {
    const m = new Map<string, number>();
    for (const p of l.points) {
      const t = isoToChartDay(p.date);
      if (t !== null) m.set(p.date, p.value);
    }
    return m;
  });
  // Forward-fill per layer; 0 before the first known point.
  const filled: number[][] = layers.map(() => []);
  layers.forEach((_l, li) => {
    let last = 0;
    let seen = false;
    for (const d of dates) {
      const v = byDate[li]!.get(d);
      if (v !== undefined) {
        last = v;
        seen = true;
      }
      filled[li]!.push(seen ? last : 0);
    }
  });
  return layers.map((l, li) => {
    const cumulative: AreaDatum[] = [];
    const own: AreaDatum[] = [];
    dates.forEach((d, di) => {
      const t = isoToChartDay(d)!;
      let cum = 0;
      for (let j = 0; j <= li; j++) cum += filled[j]![di]!;
      cumulative.push({ time: t, value: cum });
      own.push({ time: t, value: filled[li]![di]! });
    });
    return { key: l.key, label: l.label, color: l.color, cumulative, own };
  });
}
