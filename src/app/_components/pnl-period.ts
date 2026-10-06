/**
 * Pure helpers for the selectable P/L comparison period on the
 * Portfolio Overview card. No React — unit-testable in node.
 *
 * The P/L for a period is computed from the true historical value
 * series (daily portfolio values, ascending YYYY-MM-DD, forward-filled
 * so weekends/holidays carry the last trading day's value):
 *   P/L = currentValue − valueNDaysAgo
 */

export const PNL_PERIODS = [
  { key: "1D", days: 1 },
  { key: "1W", days: 7 },
  { key: "2W", days: 14 },
  { key: "1M", days: 30 },
] as const;

export type PnlPeriodKey = (typeof PNL_PERIODS)[number]["key"];

/** localStorage key for the persisted comparison period. */
export const PNL_PERIOD_KEY = "holdr.pnl.period";

export function parsePnlPeriodKey(raw: unknown): PnlPeriodKey {
  return PNL_PERIODS.some((p) => p.key === raw) ? (raw as PnlPeriodKey) : "1D";
}

export function pnlPeriodDays(key: PnlPeriodKey): number {
  return PNL_PERIODS.find((p) => p.key === key)?.days ?? 1;
}

export interface PnlPoint {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Portfolio value on that date (any consistent unit — USD here). */
  value: number;
}

export interface PnlPeriodResult {
  /** currentValue − valueNDaysAgo, in the same units as the inputs. */
  pnl: number;
  /** Actual comparison date used (YYYY-MM-DD). */
  compareDate: string;
  /** True when N days back predates the series start (clamped to earliest). */
  clamped: boolean;
}

/** Split "YYYY-MM-DD" into calendar parts (defaults keep types narrow). */
function parseIsoDate(iso: string): { y: number; m: number; d: number } {
  const [y = 1970, m = 1, d = 1] = iso.split("-").map(Number);
  return { y, m, d };
}

function addDaysIso(iso: string, delta: number): string {
  const { y, m, d } = parseIsoDate(iso);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/**
 * Look up the portfolio value N days ago and compute P/L vs the current
 * value. Uses the nearest point ON OR BEFORE the target date (the series
 * is forward-filled, so a weekend target lands on Friday's value).
 *
 * When the target predates the series (young account), clamps to the
 * earliest available point and reports clamped: true so the UI can
 * label honestly ("vs {date}").
 *
 * Returns null when the series is empty or the current value is not
 * finite — the caller should fall back to the previous-close dayPL.
 */
export function pnlForPeriod(
  points: PnlPoint[],
  currentValue: number,
  daysAgo: number,
  todayIso?: string,
): PnlPeriodResult | null {
  if (points.length === 0 || !Number.isFinite(currentValue)) return null;
  const today = todayIso ?? new Date().toLocaleDateString("en-CA");
  const target = addDaysIso(today, -daysAgo);
  // Points are ascending; find the last point with date <= target.
  let idx = -1;
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.date <= target) idx = i;
    else break;
  }
  if (idx === -1) {
    const first = points[0]!;
    return {
      pnl: currentValue - first.value,
      compareDate: first.date,
      clamped: true,
    };
  }
  const at = points[idx]!;
  return { pnl: currentValue - at.value, compareDate: at.date, clamped: false };
}

/** "2026-08-05" → "Aug 5". Timezone-safe: parses as a calendar date. */
export function shortDate(iso: string): string {
  const { y, m, d } = parseIsoDate(iso);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
