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
