/**
 * Diamond-hands math: pure functions for tenure, dip survival and buy
 * streaks. No I/O — `portfolio.handsStats` calls these with transaction-log
 * and Yahoo price data.
 */

/**
 * Max peak-to-trough decline as a fraction (0.42 = survived a -42% dip
 * without selling). Null when fewer than 2 finite closes.
 */
export function maxDrawdown(closes: number[]): number | null {
  const xs = closes.filter((c) => Number.isFinite(c));
  if (xs.length < 2) return null;
  let peak = xs[0] as number;
  let maxDd = 0;
  for (const c of xs) {
    if (c > peak) peak = c;
    const dd = peak > 0 ? (peak - c) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/**
 * Consecutive months (YYYY-MM) with activity, counting back from `nowISO`
 * (defaults to today). If the current month has no activity yet, the streak
 * starts from the previous month — an unfinished month doesn't break it.
 */
export function countBuyStreak(months: string[] | Set<string>, nowISO?: string): number {
  const set = months instanceof Set ? months : new Set(months);
  const now = nowISO ? new Date(`${nowISO}T12:00:00Z`) : new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth(); // 0-based
  const key = (yy: number, mm: number) => `${yy}-${String(mm + 1).padStart(2, "0")}`;
  // Step back past the unfinished current month when it's empty.
  if (!set.has(key(y, m))) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  let streak = 0;
  for (;;) {
    if (!set.has(key(y, m))) break;
    streak += 1;
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    if (streak > 1200) break; // sanity cap: 100 years
  }
  return streak;
}
