import type { AppDb } from "./d1db";
import { fetchFlexWindow, type FlexCashFlow, type FlexTrade } from "./ibkr";
import {
  importIbkrTrades,
  type IbkrPositionInput,
} from "./ibkr-import";

/**
 * IBKR history backfill.
 *
 * IBKR caps every Flex Web Service request at 365 days (their own docs cap
 * the fd/td overrides at 365 days too — a wider range just gets 1018), so
 * full history is fetched one 365-day window per sync, walking backward
 * from the main sync's window. Each sync therefore costs exactly one extra
 * SendRequest, comfortably inside the 1/sec / 10/min per-token limits, and
 * the merge is idempotent so re-runs are safe.
 *
 * State lives in BrokerBackfill (one row per user): oldestCovered is the
 * oldest YYYYMMDD already fetched; emptyStreak counts consecutive windows
 * with zero trades and zero cash flows (3 in a row = reached the account's
 * beginning); doneAt is set at the 2000-01-01 floor or the empty cap.
 */

export const BACKFILL_WINDOW_DAYS = 365;
const BACKFILL_FLOOR = "20000101";
const BACKFILL_EMPTY_CAP = 3;

export interface BackfillProgress {
  done: boolean;
  /** Oldest YYYYMMDD covered after this run (null when nothing ran). */
  oldestCovered: string | null;
  /** The window fetched this run, if any. */
  windowFetched: { fd: string; td: string } | null;
  tradesFetched: number;
  /** Non-fatal: the main sync succeeded but the window fetch failed. */
  error?: string;
}

export function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** Add (or subtract) days on a YYYYMMDD string. */
export function addDaysYmd(yyyymmdd: string, days: number): string {
  const t =
    Date.UTC(
      +yyyymmdd.slice(0, 4),
      +yyyymmdd.slice(4, 6) - 1,
      +yyyymmdd.slice(6, 8),
    ) +
    days * 86400000;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * The next window to fetch given the oldest date covered so far.
 * Returns null when the floor is reached (nothing more to fetch).
 */
export function nextBackfillWindow(oldestCovered: string): {
  fd: string;
  td: string;
} | null {
  const fd = addDaysYmd(oldestCovered, -BACKFILL_WINDOW_DAYS);
  if (fd < BACKFILL_FLOOR) return null;
  return { fd, td: oldestCovered };
}

export interface BackfillDeps {
  fetchWindow?: typeof fetchFlexWindow;
  mergeTrades?: typeof importIbkrTrades;
  today?: () => string;
}

export async function runBackfillWindow(
  db: AppDb,
  opts: {
    userId: string;
    token: string;
    queryId: string;
    positions: IbkrPositionInput[];
  },
  deps: BackfillDeps = {},
): Promise<BackfillProgress> {
  const fetchWindow = deps.fetchWindow ?? fetchFlexWindow;
  const mergeTrades = deps.mergeTrades ?? importIbkrTrades;
  const today = deps.today ?? todayYmd;

  const state = await db.brokerBackfill.findUnique({
    where: { userId: opts.userId },
  });
  if (state?.doneAt) {
    return {
      done: true,
      oldestCovered: state.oldestCovered,
      windowFetched: null,
      tradesFetched: 0,
    };
  }

  // Anchor: the main sync covers roughly the last 365 days, so the first
  // backfill window starts where that leaves off.
  const oldestCovered = state?.oldestCovered ?? addDaysYmd(today(), -BACKFILL_WINDOW_DAYS);
  const window = nextBackfillWindow(oldestCovered);
  if (!window) {
    await db.brokerBackfill.upsert({
      where: { userId: opts.userId },
      update: {
        oldestCovered,
        emptyStreak: state?.emptyStreak ?? 0,
        doneAt: new Date(),
      },
      create: { userId: opts.userId, oldestCovered },
    });
    return { done: true, oldestCovered, windowFetched: null, tradesFetched: 0 };
  }

  let trades: FlexTrade[];
  let cashFlows: FlexCashFlow[];
  try {
    const result = await fetchWindow(opts.token, opts.queryId, window.fd, window.td, {
      pollMs: 8000,
      maxAttempts: 8,
    });
    trades = result.trades;
    cashFlows = result.cashFlows;
  } catch (e) {
    // Best-effort: the main sync already succeeded. Report the failure so
    // the UI can show it; the next sync retries this window.
    const message = e instanceof Error ? e.message : "backfill window failed";
    return {
      done: false,
      oldestCovered: state?.oldestCovered ?? null,
      windowFetched: null,
      tradesFetched: 0,
      error: message,
    };
  }

  const empty = trades.length === 0 && cashFlows.length === 0;
  const emptyStreak = empty ? (state?.emptyStreak ?? 0) + 1 : 0;
  const done = emptyStreak >= BACKFILL_EMPTY_CAP;

  if (trades.length > 0) {
    // Idempotent via externalId — re-fetching a window never duplicates.
    // Positions are period-independent, so the current snapshot anchors.
    await mergeTrades(db, trades, opts.positions);
  }

  await db.brokerBackfill.upsert({
    where: { userId: opts.userId },
    update: {
      oldestCovered: window.fd,
      emptyStreak,
      doneAt: done ? new Date() : null,
    },
    create: { userId: opts.userId, oldestCovered: window.fd },
  });

  return {
    done,
    oldestCovered: window.fd,
    windowFetched: window,
    tradesFetched: trades.length,
  };
}
