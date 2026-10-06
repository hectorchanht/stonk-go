import { TRPCError } from "@trpc/server";

import type { AppDb } from "~/server/db";

/**
 * Merging IBKR-synced trades into the manual transaction log.
 *
 * Before this module, IBKR Flex data lived in separate snapshot tables
 * (BrokerPosition / BrokerTrade) and was only *displayed* next to the manual
 * log — sells in the brokerage never touched holdings or cost basis.
 *
 * Now every ibkr.sync merges the Flex Trades section into the Transaction
 * log as source="ibkr" rows, so holdings, cost basis and P/L are computed
 * from one unified history:
 *
 * - Idempotent: each trade gets a stable externalId ("ibkr:<transactionID>");
 *   re-syncing never duplicates rows.
 * - Manual entries are never modified. A trade the user already logged by
 *   hand (same day/type/qty/price) is skipped as a duplicate.
 * - Oversell-safe: candidates are simulated in the exact order
 *   recomputeHolding uses; a sell whose matching buy sits outside the Flex
 *   query's date range is skipped (and reported) instead of corrupting the
 *   log.
 * - Manual rows keep externalId NULL, so they sort before "ibkr:…" keys on
 *   same-timestamp ties — deterministically, in JS and in SQL alike.
 */

export interface IbkrTradeInput {
  symbol: string;
  /** YYYYMMDD as IBKR reports it. */
  tradeDate: string;
  /** Signed: >0 is a buy, <0 is a sell. */
  quantity: number;
  tradePrice: number | null;
  commission: number | null;
  /** IBKR's per-execution id; null when the query omits the column. */
  transactionId: string | null;
}

export interface ImportStats {
  imported: number;
  /** Skipped: externalId already in the log (re-sync). */
  alreadyImported: number;
  /** Skipped: the user already logged this trade by hand. */
  duplicatesSkipped: number;
  /** Skipped: sell exceeds the logged holding (buy outside query range). */
  oversellSkipped: number;
  /** Skipped: bad date, missing price, or empty symbol. */
  unusableSkipped: number;
  symbols: string[];
}

/** Recompute a holding from its full transaction history. */
export async function recomputeHolding(tx: AppDb, symbol: string) {
  const txns = await tx.transaction.findMany({
    where: { symbol },
    orderBy: [{ executedAt: "asc" }, { externalId: "asc" }, { id: "asc" }],
  });

  let quantity = 0;
  let costBasis = 0;
  for (const t of txns) {
    if (t.type === "BUY") {
      costBasis += t.quantity * t.price + t.fees;
      quantity += t.quantity;
    } else {
      if (t.quantity > quantity + 1e-9) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot sell ${t.quantity} ${symbol}: only ${quantity} held`,
        });
      }
      const ratio = quantity > 0 ? t.quantity / quantity : 0;
      costBasis -= costBasis * ratio;
      quantity -= t.quantity;
    }
  }

  if (quantity <= 1e-9) {
    await tx.holding.deleteMany({ where: { symbol } });
  } else {
    await tx.holding.upsert({
      where: { symbol },
      update: { quantity, avgCost: costBasis / quantity },
      create: { symbol, quantity, avgCost: costBasis / quantity },
    });
  }
}

/** Stable dedup key for one IBKR trade. */
export function ibkrTradeKey(t: {
  transactionId: string | null;
  symbol: string;
  tradeDate: string;
  quantity: number;
  tradePrice: number | null;
}): string {
  if (t.transactionId) return `ibkr:${t.transactionId}`;
  // Fallback when the Flex query omits the transactionID column. Less
  // collision-proof, but still prevents a duplicate on every re-sync.
  return `ibkr:x:${t.symbol}|${t.tradeDate}|${t.quantity}|${t.tradePrice ?? ""}`;
}

function parseTradeDate(yyyymmdd: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

const normSymbol = (s: string) => s.toUpperCase().replace(/\s+/g, "");

/** YYYYMMDD of a Date, in UTC (imported trades are parked at noon UTC). */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Byte-order string compare — matches SQLite BINARY collation for ASCII. */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const EPS = 1e-9;

interface Candidate {
  key: string;
  type: "BUY" | "SELL";
  quantity: number;
  price: number;
  fees: number;
  executedAt: Date;
}

/**
 * Upsert IBKR trades into the Transaction log and recompute affected
 * holdings. Safe to call on every sync — already-imported trades are
 * skipped via externalId.
 */
export async function importIbkrTrades(
  db: AppDb,
  trades: IbkrTradeInput[],
): Promise<ImportStats> {
  const stats: ImportStats = {
    imported: 0,
    alreadyImported: 0,
    duplicatesSkipped: 0,
    oversellSkipped: 0,
    unusableSkipped: 0,
    symbols: [],
  };

  const bySymbol = new Map<string, IbkrTradeInput[]>();
  for (const t of trades) {
    const symbol = normSymbol(t.symbol ?? "");
    if (!symbol || t.quantity === 0) continue;
    const arr = bySymbol.get(symbol);
    if (arr) arr.push(t);
    else bySymbol.set(symbol, [t]);
  }

  for (const [symbol, list] of bySymbol) {
    const existing = await db.transaction.findMany({
      where: { symbol },
      orderBy: [{ executedAt: "asc" }, { externalId: "asc" }, { id: "asc" }],
    });
    const seenKeys = new Set(
      existing.map((e) => e.externalId).filter((k): k is string => !!k),
    );
    const manual = existing.filter((e) => !e.externalId);

    const cands: Candidate[] = [];
    for (const t of list) {
      const key = ibkrTradeKey({ ...t, symbol });
      if (seenKeys.has(key)) {
        stats.alreadyImported++;
        continue;
      }
      const executedAt = parseTradeDate(t.tradeDate);
      if (!executedAt || t.tradePrice == null) {
        stats.unusableSkipped++;
        continue;
      }
      const type = t.quantity > 0 ? "BUY" : "SELL";
      const quantity = Math.abs(t.quantity);
      // The user may have logged this trade by hand already — same day,
      // side, quantity and ~same price means "don't double-count".
      const dup = manual.some(
        (m) =>
          m.type === type &&
          Math.abs(m.quantity - quantity) <= EPS &&
          m.price > 0 &&
          Math.abs(m.price - t.tradePrice!) / m.price < 0.005 &&
          ymd(m.executedAt) === t.tradeDate,
      );
      if (dup) {
        stats.duplicatesSkipped++;
        continue;
      }
      cands.push({
        key,
        type,
        quantity,
        price: t.tradePrice,
        fees: Math.abs(t.commission ?? 0),
        executedAt,
      });
    }
    if (cands.length === 0) continue;

    // Simulate the merged history in the exact order recomputeHolding walks,
    // so an imported sell can never push the log into an oversell state.
    interface Sim {
      type: string;
      quantity: number;
      executedAt: Date;
      externalId: string | null;
      id: string;
      cand: Candidate | null;
    }
    const sims: Sim[] = [
      ...existing.map((e) => ({
        type: e.type,
        quantity: e.quantity,
        executedAt: e.executedAt,
        externalId: e.externalId,
        id: e.id,
        cand: null,
      })),
      ...cands.map((c, i) => ({
        type: c.type,
        quantity: c.quantity,
        executedAt: c.executedAt,
        externalId: c.key,
        id: `new-${i}`,
        cand: c,
      })),
    ];
    sims.sort(
      (a, b) =>
        a.executedAt.getTime() - b.executedAt.getTime() ||
        cmpStr(a.externalId ?? "", b.externalId ?? "") ||
        cmpStr(a.id, b.id),
    );

    let qty = 0;
    const toInsert: Candidate[] = [];
    for (const s of sims) {
      if (s.type === "BUY") {
        qty += s.quantity;
      } else {
        if (s.quantity > qty + EPS) {
          // The matching buy is outside the Flex query's date range (or was
          // never logged). Skip the sell rather than corrupting the log —
          // it stays visible in the IBKR snapshot/analytics.
          if (s.cand) stats.oversellSkipped++;
          continue;
        }
        qty -= s.quantity;
      }
      if (s.cand) toInsert.push(s.cand);
    }

    for (const c of toInsert) {
      await db.transaction.create({
        data: {
          symbol,
          type: c.type,
          quantity: c.quantity,
          price: c.price,
          fees: c.fees,
          executedAt: c.executedAt,
          note: null,
          source: "ibkr",
          externalId: c.key,
        },
      });
      stats.imported++;
    }
    if (toInsert.length > 0) {
      // Cannot throw: the simulation above validated the same order.
      await recomputeHolding(db, symbol);
      stats.symbols.push(symbol);
    }
  }

  return stats;
}
