/**
 * Pure performance-curve helpers — no server dependencies, safe to import
 * anywhere including tests and client components.
 */

/** A dated cash flow in USD. Negative = money in (buy), positive = money out. */
export interface CashFlow {
  date: Date;
  amount: number;
}

export interface CurvePoint {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** USD value on that date. */
  value: number;
}

const DAY_MS = 86_400_000;
const MAX_POINTS = 180;

const isoDay = (d: Date): string => d.toLocaleDateString("en-CA");

const startOfDay = (d: Date): Date => {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
};

/** Thin a point list to at most maxPoints, always keeping the last point. */
export function downsamplePoints<T>(points: T[], maxPoints = MAX_POINTS): T[] {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const slim = points.filter((_, i) => i % stride === 0);
  const last = points[points.length - 1]!;
  if (slim[slim.length - 1] !== last) slim.push(last);
  return slim;
}

/**
 * Daily "money over time" series from the trade log — the curve the
 * Performance section falls back to when daily snapshots don't exist yet.
 *
 * value(day) = net USD invested up to that day (cumulative buys minus
 * sells). The final point is replaced with today's live portfolio value, so
 * the last segment shows the true gain/loss since the money went in.
 *
 * Returns [] when there are no flows. Downsampled to MAX_POINTS so a
 * multi-year log stays cheap to render.
 */
export function buildInvestedCurve(
  flows: CashFlow[],
  currentValueUsd: number,
  opts?: { startDaysAgo?: number; maxPoints?: number },
): CurvePoint[] {
  const fs = flows
    .filter((f) => Number.isFinite(f.amount) && f.amount !== 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (fs.length === 0) return [];

  const today = new Date();
  let start = startOfDay(fs[0]!.date);
  if (opts?.startDaysAgo != null && opts.startDaysAgo > 0) {
    const cutoff = startOfDay(new Date(Date.now() - opts.startDaysAgo * DAY_MS));
    if (cutoff.getTime() > start.getTime()) start = cutoff;
  }

  // Walk local calendar days from start to today (DST-safe: dedupe the
  // ISO labels in case a 23h/25h day repeats or skips one).
  const days: string[] = [];
  const seen = new Set<string>();
  let t = start.getTime();
  const endT = startOfDay(today).getTime();
  let guard = 0;
  while (t <= endT && guard++ < 5000) {
    const iso = isoDay(new Date(t));
    if (!seen.has(iso)) {
      seen.add(iso);
      days.push(iso);
    }
    t += DAY_MS;
  }

  // Sweep the sorted flows once; flows dated before the window still count
  // toward the invested figure on the first visible day.
  const points: CurvePoint[] = [];
  let fi = 0;
  let invested = 0;
  for (const iso of days) {
    while (fi < fs.length && isoDay(fs[fi]!.date) <= iso) {
      invested -= fs[fi]!.amount; // buys are negative amounts → invested grows
      fi++;
    }
    points.push({ date: iso, value: invested });
  }
  // Endpoint: today's live value replaces the invested figure.
  if (points.length > 0) points[points.length - 1]!.value = currentValueUsd;

  return downsamplePoints(points, opts?.maxPoints ?? MAX_POINTS);
}
