/**
 * D1 read-through cache for Yahoo daily bars (the true value curve's price
 * history).
 *
 * Strategy per symbol over [fromISO, toISO]:
 * - Cold (nothing cached): one Yahoo fetch for the whole range, persist it.
 * - Warm: re-fetch the most recent ~10 calendar days (≈5 trading days —
 *   Yahoo revises recent bars), backfill any uncached prefix, persist both,
 *   then merge with the older cached bars.
 * - Table missing (migration 20261006183500 not applied yet — Cloudflare
 *   git integration does not auto-run migrations): direct Yahoo fetch with
 *   no caching and no crash. Write failures are best-effort under the same
 *   rule; the curve always renders from whatever bars are available.
 */

import { isMissingTableError, type AppDb } from "~/server/d1db";
import { getDailyCloses, type DailyBar } from "~/server/yahoo";

const DAY_MS = 86_400_000;

const shiftISO = (iso: string, days: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

const isoToDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

/** D1 row → DailyBar; drops rows whose close isn't a finite number. */
function rowToBar(row: {
  date: string;
  close: string;
  adjclose: string | null;
}): DailyBar | null {
  const close = Number(row.close);
  if (!Number.isFinite(close)) return null;
  const adj =
    row.adjclose == null || row.adjclose === "" ? null : Number(row.adjclose);
  return {
    date: row.date,
    close,
    adjclose: adj != null && Number.isFinite(adj) ? adj : null,
  };
}

function mergeBars(cached: DailyBar[], fresh: DailyBar[]): DailyBar[] {
  const byDate = new Map<string, DailyBar>();
  for (const b of cached) byDate.set(b.date, b);
  for (const b of fresh) byDate.set(b.date, b); // fresh wins on overlap
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface PriceHistory {
  bars: DailyBar[];
  /** False when the D1 table doesn't exist yet (direct Yahoo, uncached). */
  cached: boolean;
}

/**
 * Daily bars for a symbol over [fromISO, toISO] (inclusive), D1 first.
 * `symbol` is the uppercase raw symbol ("2225", "AAPL", "HKD=X").
 * Throws only when Yahoo itself fails — the caller falls back to older
 * curve sources then.
 */
export async function getPriceHistory(
  db: AppDb,
  symbol: string,
  fromISO: string,
  toISO: string,
): Promise<PriceHistory> {
  const key = symbol.toUpperCase();

  // 1. Try the D1 cache.
  let rows: Array<{ date: string; close: string; adjclose: string | null }>;
  try {
    rows = await db.yahooDailyBar.findMany({
      where: { symbol: key, date: { gte: fromISO, lte: toISO } },
      orderBy: [{ date: "asc" }],
    });
  } catch (e) {
    if (!isMissingTableError(e)) throw e;
    // Table not migrated yet → straight from Yahoo, nothing persisted.
    return { bars: await getDailyCloses(key, isoToDate(fromISO), isoToDate(toISO)), cached: false };
  }
  const cached: DailyBar[] = [];
  for (const r of rows) {
    const b = rowToBar(r);
    if (b) cached.push(b);
  }

  // 2. Fetch what's missing: cold = whole range; warm = recent window + prefix gap.
  const refreshFrom =
    shiftISO(toISO, -10) > fromISO ? shiftISO(toISO, -10) : fromISO;
  let fresh: DailyBar[];
  let backfill: DailyBar[] = [];
  if (cached.length === 0) {
    fresh = await getDailyCloses(key, isoToDate(fromISO), isoToDate(toISO));
  } else {
    fresh = await getDailyCloses(key, isoToDate(refreshFrom), isoToDate(toISO));
    const earliest = cached[0]!.date;
    if (earliest > fromISO) {
      const backTo = shiftISO(earliest, -1);
      if (backTo >= fromISO) {
        backfill = await getDailyCloses(key, isoToDate(fromISO), isoToDate(backTo));
      }
    }
  }

  // 3. Persist (best-effort — a missing table here must not break the curve).
  const toStore = [...backfill, ...fresh];
  if (toStore.length > 0) {
    try {
      const lo = toStore[0]!.date;
      const hi = toStore[toStore.length - 1]!.date;
      await db.yahooDailyBar.deleteMany({
        where: { symbol: key, date: { gte: lo, lte: hi } },
      });
      await db.yahooDailyBar.createMany({
        data: toStore.map((b) => ({
          symbol: key,
          date: b.date,
          close: String(b.close),
          adjclose: b.adjclose == null ? null : String(b.adjclose),
        })),
      });
    } catch (e) {
      if (!isMissingTableError(e)) throw e;
    }
  }

  return { bars: mergeBars(cached, toStore), cached: true };
}
