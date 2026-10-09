import { TRPCError } from "@trpc/server";

import type { AppDb } from "~/server/db";
import { isForexSymbol } from "~/server/currency";

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

  // User-deleted trades stay deleted: the tombstone table records every
  // deleteTransaction/deleteHolding, so the next auto-sync can't resurrect
  // the rows (the classic "my trashed tx keeps coming back" bug).
  const tombstones = await db.deletedTransaction.findMany();
  const tombstonedKeys = new Set(
    tombstones.map((t) => t.externalId).filter((k): k is string => !!k),
  );

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
      // The user deleted this exact trade before — keep it deleted.
      if (tombstonedKeys.has(key)) {
        stats.duplicatesSkipped++;
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
      // The user deleted this trade by hand before (as a manual row) —
      // same tolerant match as the manual-dedupe above, so it can't come
      // back as an ibkr row on the next sync.
      const wasTrashed = tombstones.some(
        (s) =>
          s.externalId == null &&
          s.symbol === symbol &&
          s.type === type &&
          Math.abs(s.quantity - quantity) <= EPS &&
          s.price > 0 &&
          Math.abs(s.price - t.tradePrice!) / s.price < 0.005 &&
          ymd(s.executedAt) === t.tradeDate,
      );
      if (wasTrashed) {
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

/* ---------------- Performance-curve legs ---------------- */

/**
 * A trade leg shaped for the performance curve (performance.ts TradeLeg).
 * Built from three real data sources — never invented:
 *
 * 1. The Transaction log (source of truth where it exists — split-adjusted
 *    and reconciled by mergeIbkrTrades).
 * 2. Raw Flex BrokerTrade rows, for symbols the log doesn't cover whose
 *    trades fully explain the current position.
 * 3. Window-start opening balances: for positions the trades can't fully
 *    explain (bought before the Flex query's date range, or a stock split
 *    the raw trades don't reflect), one BUY leg at the Flex window's first
 *    date for the unexplained quantity at the broker's own costBasisPrice.
 *    No buy date is invented — the leg is explicitly anchored at the start
 *    of our data, and stats.openingBalances counts them for honest UI.
 *
 * Honesty rules:
 * - Symbols WITH Transaction rows use the log ONLY (mixing raw Flex rows
 *   would double-count across stock splits).
 * - Forex conversions ("USD.HKD" etc.) are currency moves, not holdings —
 *   excluded from BOTH the Transaction legs and the raw Flex rows.
 * - Rows without a usable price or date are skipped (counted).
 * - Opening quantities can never go negative: when (position − flexNet)
 *   isn't a sane positive number (e.g. a split makes flexNet dwarf the
 *   position), the whole position is anchored at cost instead.
 */
export interface CurveLeg {
  symbol: string;
  type: string;
  quantity: number;
  price: number;
  fees: number | null;
  executedAt: Date;
  source: string;
}

export interface CurveLegStats {
  /** Legs from the Transaction log. */
  fromTransactions: number;
  /** Legs contributed from raw Flex BrokerTrade rows. */
  fromBrokerTrades: number;
  /** Opening-balance legs anchored at the Flex window start. */
  openingBalances: number;
  /** Symbols whose history comes from the Transaction log. */
  symbolsCoveredByLog: number;
  /** Positions skipped: no usable broker cost basis. */
  noCostBasis: number;
  /** BrokerTrade rows skipped: no price, bad date, or zero quantity. */
  unusableSkipped: number;
}

interface BrokerTradeLike {
  symbol: string;
  tradeDate: string;
  quantity: number;
  tradePrice: number | null;
  commission: number | null;
}

export interface BrokerPositionLike {
  symbol: string;
  quantity: number;
  costBasisPrice: number | null;
}

/** Pure merge — testable without a database. */
export function mergeCurveLegs(
  txns: Array<{
    symbol: string;
    type: string;
    quantity: number;
    price: number;
    fees: number | null;
    executedAt: Date | string;
    source: string;
  }>,
  brokerTrades: BrokerTradeLike[],
  brokerPositions: BrokerPositionLike[] = [],
): { legs: CurveLeg[]; stats: CurveLegStats } {
  const stats: CurveLegStats = {
    fromTransactions: 0,
    fromBrokerTrades: 0,
    openingBalances: 0,
    symbolsCoveredByLog: 0,
    noCostBasis: 0,
    unusableSkipped: 0,
  };
  // Forex conversions (e.g. "USD.HKD") are currency moves, not holdings —
  // valued as positions they'd print hundreds of thousands of dollars of
  // phantom value (2026-10-09: USD.HKD legs inflated the true curve by
  // US$432k → a −HK$3.2M 1D P/L on a HK$766k portfolio).
  const curveTxns = txns.filter((t) => !isForexSymbol(t.symbol));
  const legs: CurveLeg[] = curveTxns.map((t) => ({
    symbol: t.symbol,
    type: t.type,
    quantity: t.quantity,
    price: t.price,
    fees: t.fees,
    executedAt: new Date(t.executedAt),
    source: t.source,
  }));
  stats.fromTransactions = legs.length;

  const logSymbols = new Set(curveTxns.map((t) => normSymbol(t.symbol)));
  stats.symbolsCoveredByLog = logSymbols.size;

  // Validate + group Flex trades (log symbols excluded — see above).
  const bySymbol = new Map<string, BrokerTradeLike[]>();
  for (const b of brokerTrades) {
    const sym = normSymbol(b.symbol);
    if (!sym || isForexSymbol(sym)) continue;
    if (logSymbols.has(sym)) continue;
    const executedAt = parseTradeDate(b.tradeDate);
    if (
      !executedAt ||
      b.tradePrice == null ||
      !(b.tradePrice > 0) ||
      !Number.isFinite(b.quantity) ||
      b.quantity === 0
    ) {
      stats.unusableSkipped++;
      continue;
    }
    const arr = bySymbol.get(sym);
    if (arr) arr.push(b);
    else bySymbol.set(sym, [b]);
  }

  const toLeg = (sym: string, r: BrokerTradeLike): CurveLeg => ({
    symbol: sym,
    type: r.quantity > 0 ? "BUY" : "SELL",
    quantity: Math.abs(r.quantity),
    price: r.tradePrice!,
    fees: r.commission == null ? null : Math.abs(r.commission),
    executedAt: parseTradeDate(r.tradeDate)!,
    source: "ibkr",
  });

  // Anchor date for opening balances: the Flex window's first trade date.
  // We only know a position was held from here on — never invent earlier.
  let anchorDate: Date | null = null;
  for (const rows of bySymbol.values()) {
    for (const r of rows) {
      const d = parseTradeDate(r.tradeDate)!;
      if (!anchorDate || d < anchorDate) anchorDate = d;
    }
  }
  if (!anchorDate) {
    for (const l of legs) {
      if (!anchorDate || l.executedAt < anchorDate) anchorDate = l.executedAt;
    }
  }
  const anchor = anchorDate ?? new Date();

  const posBySymbol = new Map<string, BrokerPositionLike>();
  for (const p of brokerPositions) {
    const sym = normSymbol(p.symbol);
    if (sym) posBySymbol.set(sym, p);
  }

  const handledFlex = new Set<string>();
  for (const [sym, p] of posBySymbol) {
    if (logSymbols.has(sym)) continue;
    if (!Number.isFinite(p.quantity) || p.quantity === 0) continue;
    const rows = bySymbol.get(sym) ?? [];
    const net = rows.reduce((s, r) => s + r.quantity, 0);
    const qty = p.quantity;

    if (
      rows.length > 0 &&
      Math.abs(net - qty) / Math.max(Math.abs(qty), 1e-9) <= 0.01
    ) {
      // Flex trades fully explain the position — real history.
      for (const r of rows) legs.push(toLeg(sym, r));
      stats.fromBrokerTrades += rows.length;
      handledFlex.add(sym);
      continue;
    }
    if (!(p.costBasisPrice != null && p.costBasisPrice > 0)) {
      stats.noCostBasis++;
      handledFlex.add(sym);
      continue;
    }
    const openingQty = qty - net;
    if (
      rows.length > 0 &&
      openingQty > 0 &&
      openingQty <= 3 * Math.abs(qty)
    ) {
      // Pre-window holding + in-window trades: anchor the unexplained
      // remainder at broker cost, then the real trades on top.
      legs.push({
        symbol: sym,
        type: "BUY",
        quantity: openingQty,
        price: p.costBasisPrice,
        fees: null,
        executedAt: anchor,
        source: "ibkr",
      });
      stats.openingBalances++;
      for (const r of rows) legs.push(toLeg(sym, r));
      stats.fromBrokerTrades += rows.length;
    } else {
      // No usable trade split (no trades, or a split scrambles the
      // quantities): anchor the whole position at broker cost.
      legs.push({
        symbol: sym,
        type: "BUY",
        quantity: Math.abs(qty),
        price: p.costBasisPrice,
        fees: null,
        executedAt: anchor,
        source: "ibkr",
      });
      stats.openingBalances++;
    }
    handledFlex.add(sym);
  }

  // Flex symbols with no current position: completed round trips.
  for (const [sym, rows] of bySymbol) {
    if (handledFlex.has(sym)) continue;
    for (const r of rows) legs.push(toLeg(sym, r));
    stats.fromBrokerTrades += rows.length;
  }

  legs.sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());
  return { legs, stats };
}

/**
 * Full curve legs: Transaction log + Flex trades + opening balances.
 *
 * `onlySources` (e.g. `["manual", "ibkr"]`) restricts the legs to those
 * sources — used to keep performance numbers consistent with the platforms
 * currently connected. A disconnected platform's history is excluded so the
 * curve never compares against a live portfolio that doesn't contain it.
 * Empty/omitted = no filtering.
 */
export async function curveTradeLegs(
  db: AppDb,
  onlySources?: string[],
): Promise<{ legs: CurveLeg[]; stats: CurveLegStats }> {
  const [txns, brokerTrades, brokerPositions] = await Promise.all([
    db.transaction.findMany({ orderBy: [{ executedAt: "asc" }] }),
    db.brokerTrade.findMany({ orderBy: [{ tradeDate: "asc" }] }),
    db.brokerPosition.findMany({ orderBy: [{ symbol: "asc" }] }),
  ]);
  const merged = mergeCurveLegs(txns, brokerTrades, brokerPositions);
  if (!onlySources || onlySources.length === 0) return merged;
  const allow = new Set(onlySources.map((s) => s.trim().toLowerCase()));
  return {
    legs: merged.legs.filter((l) => allow.has(l.source.trim().toLowerCase())),
    stats: merged.stats,
  };
}
