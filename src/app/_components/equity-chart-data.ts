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
