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
 * - Split-aware: IBKR's Flex trade history is NOT split-adjusted, while
 *   positions and live prices are. Candidates are reconciled against IBKR's
 *   current position (quantity + cost basis price). When the dollars agree
 *   but the share count doesn't, it's a stock split — trades are scaled
 *   (qty ÷ r, price × r) into split-adjusted units. When they can't be
 *   reconciled, the symbol is skipped (and any previously imported bad rows
 *   are repaired) so the IBKR snapshot — always right about the current
 *   position — stays the display.
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

export interface IbkrPositionInput {
  symbol: string;
  quantity: number;
  /** Per-share cost basis; null when the Flex query lacks the column. */
  costBasisPrice: number | null;
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
  /** Trades auto-scaled for a detected stock split (qty ÷ r, price × r). */
  splitAdjusted: number;
  splitSymbols: string[];
  /** Trades skipped: couldn't reconcile with IBKR's current position. */
  mismatchSkipped: number;
  /** Symbols whose bad ibkr rows were removed and re-imported. */
  repairedSymbols: string[];
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
/** Quantity mismatch tolerance vs IBKR's position (fraction). */
const QTY_TOL = 0.01;
/** Dollar mismatch tolerance vs IBKR's cost basis (fraction). */
const DOLLAR_TOL = 0.08;

/**
 * Standard split ratios, as Q_before / Q_after (1:40 reverse → 40,
 * 4:1 forward → 0.25). Fallback split signal when the Flex query lacks
 * the Cost Basis Price column.
 */
const STANDARD_SPLITS = [
  0.01, 0.02, 0.04, 0.05, 0.1, 0.2, 0.25, 0.5, 2, 3, 4, 5, 10, 20, 25, 30,
  40, 50, 100,
];

function nearStandardSplit(r: number): boolean {
  return STANDARD_SPLITS.some((s) => Math.abs(r - s) / s <= 0.03);
}

interface CostRow {
  type: string;
  quantity: number;
  price: number;
  fees: number;
}

/**
 * Average-cost simulation over a set of rows. Never throws — sells are
 * clamped instead of rejected (this is an estimate, not the log writer).
 */
function simulateCost(rows: CostRow[]): {
  quantity: number;
  costBasis: number;
} {
  let q = 0;
  let cb = 0;
  for (const t of rows) {
    if (t.type === "BUY") {
      cb += t.quantity * t.price + t.fees;
      q += t.quantity;
    } else {
      const ratio = q > 0 ? Math.min(t.quantity, q) / q : 0;
      cb -= cb * ratio;
      q -= t.quantity;
    }
  }
  return { quantity: q, costBasis: cb };
}

interface Candidate {
  key: string;
  type: "BUY" | "SELL";
  quantity: number;
  price: number;
  fees: number;
  executedAt: Date;
}

/**
 * Decide whether a set of trades (implied quantity/cost) is a
 * split-distorted view of an IBKR position.
 *
 * Splits scale per-share price and quantity inversely, so TOTAL DOLLARS are
 * invariant: when the dollars agree but the share count doesn't, it's a
 * split — never missing history (missing history would move the dollars
 * too). Returns the adjustment factor r = Q_trades / Q_position, or null
 * when this isn't a split.
 */
function detectSplit(
  qTrades: number,
  bTrades: number,
  pos: IbkrPositionInput,
): number | null {
  if (!(pos.quantity > 0) || !(qTrades > 0)) return null;
  const r = qTrades / pos.quantity;
  if (pos.costBasisPrice != null && pos.costBasisPrice > 0 && bTrades > 0) {
    const ibkrDollars = pos.quantity * pos.costBasisPrice;
    if (Math.abs(bTrades - ibkrDollars) / ibkrDollars <= DOLLAR_TOL) return r;
    return null;
  }
  return nearStandardSplit(r) ? r : null;
}

/**
 * Upsert IBKR trades into the Transaction log and recompute affected
 * holdings. Safe to call on every sync — already-imported trades are
 * skipped via externalId.
 *
 * `positions` (the same report's Open Positions) anchors the import:
 * candidates are reconciled against IBKR's current position, splits are
 * auto-adjusted, and anything unreconcilable is skipped so the IBKR
 * snapshot stays the source of truth for the current position.
 */
export async function importIbkrTrades(
  db: AppDb,
  trades: IbkrTradeInput[],
  positions: IbkrPositionInput[] = [],
): Promise<ImportStats> {
  const stats: ImportStats = {
    imported: 0,
    alreadyImported: 0,
    duplicatesSkipped: 0,
    oversellSkipped: 0,
    unusableSkipped: 0,
    splitAdjusted: 0,
    splitSymbols: [],
    mismatchSkipped: 0,
    repairedSymbols: [],
    symbols: [],
  };

  const posBySymbol = new Map<string, IbkrPositionInput>();
  for (const p of positions) {
    const s = normSymbol(p.symbol ?? "");
    if (s && !posBySymbol.has(s)) posBySymbol.set(s, p);
  }

  const bySymbol = new Map<string, IbkrTradeInput[]>();
  for (const t of trades) {
    const symbol = normSymbol(t.symbol ?? "");
    if (!symbol || t.quantity === 0) continue;
    const arr = bySymbol.get(symbol);
    if (arr) arr.push(t);
    else bySymbol.set(symbol, [t]);
  }

  // Symbols to visit: those with new trades, plus any with an IBKR
  // position (for repairing previously imported bad rows).
  const symbols = new Set<string>(bySymbol.keys());
  for (const s of posBySymbol.keys()) symbols.add(s);

  for (const symbol of symbols) {
    let existing = await db.transaction.findMany({
      where: { symbol },
      orderBy: [{ executedAt: "asc" }, { externalId: "asc" }, { id: "asc" }],
    });
    const pos = posBySymbol.get(symbol);

    // ---- Repair: previously imported rows that disagree with IBKR ----
    // Only auto-repairs when the log has no manual rows — then any
    // disagreement is definitively the import's fault (e.g. an
    // unadjusted stock split), never the user's data.
    if (
      pos &&
      pos.quantity > 0 &&
      existing.length > 0 &&
      existing.every((e) => e.externalId)
    ) {
      const { quantity: qb, costBasis: bb } = simulateCost(existing);
      const qtyMismatch = Math.abs(qb - pos.quantity) / pos.quantity > QTY_TOL;
      if (qtyMismatch && detectSplit(qb, bb, pos) != null) {
        for (const r of existing) {
          await db.transaction.delete({ where: { id: r.id } });
        }
        stats.repairedSymbols.push(symbol);
        existing = [];
      }
    }

    const list = bySymbol.get(symbol) ?? [];
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

    // ---- Reconcile candidates against IBKR's current position ----
    let toConsider = cands;
    if (toConsider.length > 0 && pos && pos.quantity > 0) {
      const { quantity: qExist, costBasis: bExist } = simulateCost(existing);
      const qRes = pos.quantity - qExist;
      if (qRes <= 0) {
        // The log already explains the full position — nothing to add.
        stats.mismatchSkipped += toConsider.length;
        toConsider = [];
      } else {
        const { quantity: qCand, costBasis: bCand } =
          simulateCost(toConsider);
        if (Math.abs(qCand - qRes) / qRes > QTY_TOL) {
          // Re-anchor the comparison on what the candidates alone should
          // explain: the residual quantity and its residual dollars.
          const residualDollars =
            pos.costBasisPrice != null && pos.costBasisPrice > 0
              ? pos.quantity * pos.costBasisPrice - bExist
              : null;
          const split = detectSplit(qCand, bCand, {
            symbol,
            quantity: qRes,
            costBasisPrice:
              residualDollars != null && residualDollars > 0 && qRes > 0
                ? residualDollars / qRes
                : null,
          });
          if (split != null) {
            for (const c of toConsider) {
              c.quantity /= split;
              c.price *= split;
            }
            stats.splitAdjusted += toConsider.length;
            if (!stats.splitSymbols.includes(symbol))
              stats.splitSymbols.push(symbol);
          } else {
            stats.mismatchSkipped += toConsider.length;
            toConsider = [];
          }
        }
      }
    }

    if (toConsider.length === 0) {
      // Nothing new, but a repair may have removed rows — recompute.
      if (stats.repairedSymbols.includes(symbol)) {
        await recomputeHolding(db, symbol);
        if (!stats.symbols.includes(symbol)) stats.symbols.push(symbol);
      }
      continue;
    }

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
      ...toConsider.map((c, i) => ({
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
    if (toInsert.length > 0 || stats.repairedSymbols.includes(symbol)) {
      // Cannot throw: the simulation above validated the same order.
      await recomputeHolding(db, symbol);
      if (!stats.symbols.includes(symbol)) stats.symbols.push(symbol);
    }
  }

  return stats;
}
