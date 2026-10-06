import type { D1Database } from "@cloudflare/workers-types";

/**
 * Minimal D1-backed database client implementing exactly the query surface
 * the portfolio router uses.
 *
 * Why this exists: Prisma's query engine cannot load on Cloudflare Workers —
 * it resolves its native binary via fs.readdir at runtime, and the Workers
 * runtime (unenv) does not implement it ("[unenv] fs.readdir is not
 * implemented yet!" on every DB call). The D1 binding itself is plain
 * HTTP-backed SQL, so we talk to it directly here. Local dev keeps using
 * real Prisma (see ~/server/db.ts).
 *
 * Row shapes mirror the Prisma models (timestamps as Dates, like Prisma
 * returns), so callers can't tell which backend served them.
 */

export interface HoldingRow {
  id: string;
  symbol: string;
  name: string | null;
  quantity: number;
  avgCost: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransactionRow {
  id: string;
  symbol: string;
  type: string;
  quantity: number;
  price: number;
  fees: number;
  executedAt: Date;
  note: string | null;
  /** "manual" | "ibkr" — where this row came from. */
  source: string;
  /** Stable IBKR trade key for idempotent imports; null for manual rows. */
  externalId: string | null;
  createdAt: Date;
}

export interface BrokerPositionRow {
  id: string;
  accountId: string;
  symbol: string;
  description: string | null;
  assetCategory: string;
  currency: string;
  quantity: number;
  markPrice: number | null;
  syncedAt: Date;
}

export interface BrokerTradeRow {
  id: string;
  accountId: string;
  symbol: string;
  description: string | null;
  assetCategory: string;
  currency: string;
  tradeDate: string;
  quantity: number;
  tradePrice: number | null;
  proceeds: number | null;
  commission: number | null;
  realizedPnl: number | null;
  openClose: string | null;
  transactionType: string | null;
  syncedAt: Date;
}

export interface BrokerCashFlowRow {
  id: string;
  accountId: string;
  symbol: string | null;
  description: string | null;
  currency: string;
  dateTime: string;
  amount: number;
  type: string;
  syncedAt: Date;
}

export interface BrokerCredentialRow {
  id: string;
  userId: string;
  encToken: string;
  encQueryId: string;
  iv: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExchangeCredentialRow {
  id: string;
  userId: string;
  exchange: string;
  label: string | null;
  encKey: string;
  encSecret: string;
  iv: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExchangeBalanceRow {
  id: string;
  userId: string;
  exchange: string;
  asset: string;
  /** Native quantity, exact decimal string — never a float. */
  quantity: string;
  priceUsd: string | null;
  priceSource: string | null;
  priceAt: string | null;
  /** Integer USD cents as text; null when unpriced. */
  valueCents: string | null;
  currency: string;
  syncedAt: Date;
}

export interface ExchangeSyncRow {
  id: string;
  userId: string;
  exchange: string;
  syncedAt: Date;
  assetCount: number;
  pricedCount: number;
  /** Integer USD cents as text. */
  totalCents: string;
  /** Integer cents as text (signed). */
  driftCents: string;
  ok: boolean;
  note: string | null;
}

export interface PortfolioSnapshotRow {
  id: string;
  date: string; // YYYY-MM-DD (local)
  marketValue: number;
  costBasis: number;
  totalPL: number | null;
  dayPL: number | null;
  holdingsCount: number;
  createdAt: Date;
}

export interface PriceAlertRow {
  id: string;
  userId: string;
  email: string;
  symbol: string;
  targetPrice: number;
  direction: string; // "above" | "below"
  active: boolean;
  triggeredAt: Date | null;
  lastPrice: number | null;
  createdAt: Date;
}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: Date;
}

type SortDir = "asc" | "desc";

interface BulkInsertable<TData> {
  deleteMany(): Promise<{ count: number }>;
  createMany(args: { data: TData[] }): Promise<{ count: number }>;
}

export interface BrokerTradeData {
  accountId: string;
  symbol: string;
  description?: string | null;
  assetCategory: string;
  currency: string;
  tradeDate: string;
  quantity: number;
  tradePrice?: number | null;
  proceeds?: number | null;
  commission?: number | null;
  realizedPnl?: number | null;
  openClose?: string | null;
  transactionType?: string | null;
}

export interface BrokerCashFlowData {
  accountId: string;
  symbol?: string | null;
  description?: string | null;
  currency: string;
  dateTime: string;
  amount: number;
  type: string;
}

export interface AppDb {
  brokerTrade: {
    findMany(args: {
      orderBy: Array<{ tradeDate?: SortDir; symbol?: SortDir }>;
      take?: number;
    }): Promise<BrokerTradeRow[]>;
  } & BulkInsertable<BrokerTradeData>;
  brokerCashFlow: {
    findMany(args: {
      orderBy: Array<{ dateTime?: SortDir; type?: SortDir }>;
      take?: number;
    }): Promise<BrokerCashFlowRow[]>;
  } & BulkInsertable<BrokerCashFlowData>;
  brokerPosition: {
    findMany(args: {
      orderBy: Array<{ symbol?: SortDir; accountId?: SortDir }>;
    }): Promise<BrokerPositionRow[]>;
    deleteMany(): Promise<{ count: number }>;
    createMany(args: {
      data: Array<{
        accountId: string;
        symbol: string;
        description?: string | null;
        assetCategory: string;
        currency: string;
        quantity: number;
        markPrice?: number | null;
      }>;
    }): Promise<{ count: number }>;
  };
  brokerCredential: {
    findUnique(args: {
      where: { userId: string };
    }): Promise<BrokerCredentialRow | null>;
    upsert(args: {
      where: { userId: string };
      update: { encToken: string; encQueryId: string; iv: string };
      create: {
        userId: string;
        encToken: string;
        encQueryId: string;
        iv: string;
      };
    }): Promise<BrokerCredentialRow>;
    delete(args: { where: { userId: string } }): Promise<BrokerCredentialRow>;
  };
  exchangeCredential: {
    findFirst(args: {
      where: { userId: string; exchange: string };
    }): Promise<ExchangeCredentialRow | null>;
    findMany(args: {
      where: { userId: string };
    }): Promise<ExchangeCredentialRow[]>;
    upsert(args: {
      where: { userId_exchange: { userId: string; exchange: string } };
      update: { encKey: string; encSecret: string; iv: string; label?: string | null };
      create: {
        userId: string;
        exchange: string;
        encKey: string;
        encSecret: string;
        iv: string;
        label?: string | null;
      };
    }): Promise<ExchangeCredentialRow>;
    delete(args: {
      where: { userId_exchange: { userId: string; exchange: string } };
    }): Promise<ExchangeCredentialRow>;
  };
  exchangeBalance: {
    findMany(args: {
      where: { userId: string; exchange: string };
      orderBy?: Array<{ asset?: SortDir }>;
    }): Promise<ExchangeBalanceRow[]>;
    deleteMany(args: {
      where: { userId: string; exchange: string };
    }): Promise<{ count: number }>;
    createMany(args: {
      data: Array<{
        userId: string;
        exchange: string;
        asset: string;
        quantity: string;
        priceUsd?: string | null;
        priceSource?: string | null;
        priceAt?: string | null;
        valueCents?: string | null;
        currency?: string;
      }>;
    }): Promise<{ count: number }>;
  };
  exchangeSync: {
    findFirst(args: {
      where: { userId: string; exchange: string };
      orderBy: { syncedAt: SortDir };
    }): Promise<ExchangeSyncRow | null>;
    create(args: {
      data: {
        userId: string;
        exchange: string;
        assetCount: number;
        pricedCount: number;
        totalCents: string;
        driftCents: string;
        ok: boolean;
        note?: string | null;
      };
    }): Promise<ExchangeSyncRow>;
  };
  holding: {
    findMany(args: { orderBy: { symbol: SortDir } }): Promise<HoldingRow[]>;
    upsert(args: {
      where: { symbol: string };
      update: { quantity: number; avgCost: number };
      create: { symbol: string; quantity: number; avgCost: number };
    }): Promise<HoldingRow>;
    deleteMany(args: { where: { symbol: string } }): Promise<{ count: number }>;
    updateMany(args: {
      where: { symbol: string; name: null };
      data: { name: string };
    }): Promise<{ count: number }>;
  };
  transaction: {
    findMany(args: {
      where?: { symbol: string };
      orderBy: Array<{ executedAt?: SortDir; externalId?: SortDir; id?: SortDir }>;
      take?: number;
    }): Promise<TransactionRow[]>;
    findUnique(args: { where: { id: string } }): Promise<TransactionRow | null>;
    create(args: {
      data: {
        symbol: string;
        type: string;
        quantity: number;
        price: number;
        fees?: number;
        executedAt: Date | string;
        note?: string | null;
        source?: string;
        externalId?: string | null;
      };
    }): Promise<TransactionRow>;
    delete(args: { where: { id: string } }): Promise<TransactionRow>;
    deleteMany(args: { where: { symbol: string } }): Promise<{ count: number }>;
  };
  portfolioSnapshot: {
    findMany(args: {
      orderBy: Array<{ date?: SortDir }>;
    }): Promise<PortfolioSnapshotRow[]>;
    upsert(args: {
      where: { date: string };
      create: {
        date: string;
        marketValue: number;
        costBasis: number;
        totalPL?: number | null;
        dayPL?: number | null;
        holdingsCount?: number;
      };
      update: {
        marketValue: number;
        costBasis: number;
        totalPL?: number | null;
        dayPL?: number | null;
        holdingsCount?: number;
      };
    }): Promise<PortfolioSnapshotRow>;
  };
  priceAlert: {
    findMany(args: {
      where?: { userId?: string; active?: boolean };
      orderBy?: Array<{ createdAt?: SortDir }>;
    }): Promise<PriceAlertRow[]>;
    findUnique(args: { where: { id: string } }): Promise<PriceAlertRow | null>;
    create(args: {
      data: {
        userId: string;
        email: string;
        symbol: string;
        targetPrice: number;
        direction: string;
      };
    }): Promise<PriceAlertRow>;
    update(args: {
      where: { id: string };
      data: {
        active?: boolean;
        triggeredAt?: Date | null;
        lastPrice?: number | null;
        targetPrice?: number;
      };
    }): Promise<PriceAlertRow>;
    delete(args: { where: { id: string } }): Promise<PriceAlertRow>;
  };
  pushSubscription: {
    findMany(): Promise<PushSubscriptionRow[]>;
    create(args: {
      data: { endpoint: string; p256dh: string; auth: string };
    }): Promise<PushSubscriptionRow>;
    delete(args: { where: { endpoint: string } }): Promise<PushSubscriptionRow>;
  };
}

type RawRow = Record<string, unknown>;

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function mapBrokerPosition(r: RawRow): BrokerPositionRow {
  return {
    id: r.id as string,
    accountId: r.accountId as string,
    symbol: r.symbol as string,
    description: (r.description as string | null) ?? null,
    assetCategory: r.assetCategory as string,
    currency: r.currency as string,
    quantity: r.quantity as number,
    markPrice: (r.markPrice as number | null) ?? null,
    syncedAt: toDate(r.syncedAt),
  };
}

function mapBrokerTrade(r: RawRow): BrokerTradeRow {
  return {
    id: r.id as string,
    accountId: r.accountId as string,
    symbol: r.symbol as string,
    description: (r.description as string | null) ?? null,
    assetCategory: r.assetCategory as string,
    currency: r.currency as string,
    tradeDate: r.tradeDate as string,
    quantity: r.quantity as number,
    tradePrice: (r.tradePrice as number | null) ?? null,
    proceeds: (r.proceeds as number | null) ?? null,
    commission: (r.commission as number | null) ?? null,
    realizedPnl: (r.realizedPnl as number | null) ?? null,
    openClose: (r.openClose as string | null) ?? null,
    transactionType: (r.transactionType as string | null) ?? null,
    syncedAt: toDate(r.syncedAt),
  };
}

function mapBrokerCashFlow(r: RawRow): BrokerCashFlowRow {
  return {
    id: r.id as string,
    accountId: r.accountId as string,
    symbol: (r.symbol as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    currency: r.currency as string,
    dateTime: r.dateTime as string,
    amount: r.amount as number,
    type: r.type as string,
    syncedAt: toDate(r.syncedAt),
  };
}

function mapBrokerCredential(r: RawRow): BrokerCredentialRow {
  return {
    id: r.id as string,
    userId: r.userId as string,
    encToken: r.encToken as string,
    encQueryId: r.encQueryId as string,
    iv: r.iv as string,
    createdAt: toDate(r.createdAt),
    updatedAt: toDate(r.updatedAt),
  };
}

function mapExchangeCredential(r: RawRow): ExchangeCredentialRow {
  return {
    id: r.id as string,
    userId: r.userId as string,
    exchange: r.exchange as string,
    label: (r.label as string | null) ?? null,
    encKey: r.encKey as string,
    encSecret: r.encSecret as string,
    iv: r.iv as string,
    createdAt: toDate(r.createdAt),
    updatedAt: toDate(r.updatedAt),
  };
}

function mapExchangeBalance(r: RawRow): ExchangeBalanceRow {
  return {
    id: r.id as string,
    userId: r.userId as string,
    exchange: r.exchange as string,
    asset: r.asset as string,
    quantity: r.quantity as string,
    priceUsd: (r.priceUsd as string | null) ?? null,
    priceSource: (r.priceSource as string | null) ?? null,
    priceAt: (r.priceAt as string | null) ?? null,
    valueCents: (r.valueCents as string | null) ?? null,
    currency: (r.currency as string) ?? "USD",
    syncedAt: toDate(r.syncedAt),
  };
}

function mapExchangeSync(r: RawRow): ExchangeSyncRow {
  return {
    id: r.id as string,
    userId: r.userId as string,
    exchange: r.exchange as string,
    syncedAt: toDate(r.syncedAt),
    assetCount: r.assetCount as number,
    pricedCount: r.pricedCount as number,
    totalCents: String(r.totalCents),
    driftCents: String(r.driftCents),
    ok: (r.ok as number | boolean) === true || (r.ok as number) === 1,
    note: (r.note as string | null) ?? null,
  };
}

function mapHolding(r: RawRow): HoldingRow {
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    name: (r.name as string | null) ?? null,
    quantity: r.quantity as number,
    avgCost: r.avgCost as number,
    createdAt: toDate(r.createdAt),
    updatedAt: toDate(r.updatedAt),
  };
}

function mapTransaction(r: RawRow): TransactionRow {
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    type: r.type as string,
    quantity: r.quantity as number,
    price: r.price as number,
    fees: (r.fees as number) ?? 0,
    executedAt: toDate(r.executedAt),
    note: (r.note as string | null) ?? null,
    source: (r.source as string) ?? "manual",
    externalId: (r.externalId as string | null) ?? null,
    createdAt: toDate(r.createdAt),
  };
}

function mapPortfolioSnapshot(r: RawRow): PortfolioSnapshotRow {
  return {
    id: r.id as string,
    date: r.date as string,
    marketValue: r.marketValue as number,
    costBasis: r.costBasis as number,
    totalPL: (r.totalPL as number | null) ?? null,
    dayPL: (r.dayPL as number | null) ?? null,
    holdingsCount: (r.holdingsCount as number) ?? 0,
    createdAt: toDate(r.createdAt),
  };
}

function mapPriceAlert(r: RawRow): PriceAlertRow {
  return {
    id: r.id as string,
    userId: r.userId as string,
    email: r.email as string,
    symbol: r.symbol as string,
    targetPrice: r.targetPrice as number,
    direction: r.direction as string,
    active: (r.active as number) === 1,
    triggeredAt: r.triggeredAt ? toDate(r.triggeredAt) : null,
    lastPrice: (r.lastPrice as number | null) ?? null,
    createdAt: toDate(r.createdAt),
  };
}

function mapPushSubscription(r: RawRow): PushSubscriptionRow {
  return {
    id: r.id as string,
    endpoint: r.endpoint as string,
    p256dh: r.p256dh as string,
    auth: r.auth as string,
    createdAt: toDate(r.createdAt),
  };
}

export function createD1Db(d1: D1Database): AppDb {
  const orderClause = (
    orderBy: Array<Record<string, "asc" | "desc" | undefined>>,
  ): string => {
    const order = orderBy
      .flatMap((o) =>
        Object.entries(o)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `"${k}" ${v === "desc" ? "DESC" : "ASC"}`),
      )
      .join(", ");
    return order ? ` ORDER BY ${order}` : "";
  };

  const brokerTrade: AppDb["brokerTrade"] = {
    findMany: async (args) => {
      let sql = `SELECT * FROM "BrokerTrade"${orderClause(args.orderBy)}`;
      const binds: unknown[] = [];
      if (args.take !== undefined) {
        sql += ` LIMIT ?`;
        binds.push(args.take);
      }
      const { results } = await d1.prepare(sql).bind(...binds).all();
      return (results as unknown as RawRow[]).map(mapBrokerTrade);
    },
    deleteMany: async () => {
      const r = await d1.prepare(`DELETE FROM "BrokerTrade"`).run();
      return { count: r.meta.changes ?? 0 };
    },
    createMany: async (args) => {
      const now = new Date().toISOString();
      let count = 0;
      for (const t of args.data) {
        await d1
          .prepare(
            `INSERT INTO "BrokerTrade"
               ("id", "accountId", "symbol", "description", "assetCategory",
                "currency", "tradeDate", "quantity", "tradePrice", "proceeds",
                "commission", "realizedPnl", "openClose", "transactionType",
                "syncedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            t.accountId,
            t.symbol,
            t.description ?? null,
            t.assetCategory,
            t.currency,
            t.tradeDate,
            t.quantity,
            t.tradePrice ?? null,
            t.proceeds ?? null,
            t.commission ?? null,
            t.realizedPnl ?? null,
            t.openClose ?? null,
            t.transactionType ?? null,
            now,
          )
          .run();
        count++;
      }
      return { count };
    },
  };

  const brokerCashFlow: AppDb["brokerCashFlow"] = {
    findMany: async (args) => {
      let sql = `SELECT * FROM "BrokerCashFlow"${orderClause(args.orderBy)}`;
      const binds: unknown[] = [];
      if (args.take !== undefined) {
        sql += ` LIMIT ?`;
        binds.push(args.take);
      }
      const { results } = await d1.prepare(sql).bind(...binds).all();
      return (results as unknown as RawRow[]).map(mapBrokerCashFlow);
    },
    deleteMany: async () => {
      const r = await d1.prepare(`DELETE FROM "BrokerCashFlow"`).run();
      return { count: r.meta.changes ?? 0 };
    },
    createMany: async (args) => {
      const now = new Date().toISOString();
      let count = 0;
      for (const c of args.data) {
        await d1
          .prepare(
            `INSERT INTO "BrokerCashFlow"
               ("id", "accountId", "symbol", "description", "currency",
                "dateTime", "amount", "type", "syncedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            c.accountId,
            c.symbol ?? null,
            c.description ?? null,
            c.currency,
            c.dateTime,
            c.amount,
            c.type,
            now,
          )
          .run();
        count++;
      }
      return { count };
    },
  };

  const brokerPosition: AppDb["brokerPosition"] = {
    findMany: async (args) => {
      const order = args.orderBy
        .flatMap((o) =>
          Object.entries(o).map(
            ([k, v]) => `"${k}" ${v === "desc" ? "DESC" : "ASC"}`,
          ),
        )
        .join(", ");
      const sql = `SELECT * FROM "BrokerPosition"${order ? ` ORDER BY ${order}` : ""}`;
      const { results } = await d1.prepare(sql).all();
      return (results as unknown as RawRow[]).map(mapBrokerPosition);
    },

    deleteMany: async () => {
      const r = await d1.prepare(`DELETE FROM "BrokerPosition"`).run();
      return { count: r.meta.changes ?? 0 };
    },

    createMany: async (args) => {
      // D1 has no bulk-insert API; sequential prepared statements are fine
      // for position counts (tens of rows).
      const now = new Date().toISOString();
      let count = 0;
      for (const d of args.data) {
        await d1
          .prepare(
            `INSERT INTO "BrokerPosition"
               ("id", "accountId", "symbol", "description", "assetCategory",
                "currency", "quantity", "markPrice", "syncedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            d.accountId,
            d.symbol,
            d.description ?? null,
            d.assetCategory,
            d.currency,
            d.quantity,
            d.markPrice ?? null,
            now,
          )
          .run();
        count++;
      }
      return { count };
    },
  };

  const brokerCredential: AppDb["brokerCredential"] = {
    findUnique: async (args) => {
      const row = await d1
        .prepare(`SELECT * FROM "BrokerCredential" WHERE "userId" = ?`)
        .bind(args.where.userId)
        .first();
      return row ? mapBrokerCredential(row as unknown as RawRow) : null;
    },

    upsert: async (args) => {
      const now = new Date().toISOString();
      await d1
        .prepare(
          `INSERT INTO "BrokerCredential"
             ("id", "userId", "encToken", "encQueryId", "iv", "createdAt", "updatedAt")
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT("userId") DO UPDATE SET
             "encToken" = excluded."encToken",
             "encQueryId" = excluded."encQueryId",
             "iv" = excluded."iv",
             "updatedAt" = excluded."updatedAt"`,
        )
        .bind(
          crypto.randomUUID(),
          args.create.userId,
          args.create.encToken,
          args.create.encQueryId,
          args.create.iv,
          now,
          now,
        )
        .run();
      const row = await d1
        .prepare(`SELECT * FROM "BrokerCredential" WHERE "userId" = ?`)
        .bind(args.where.userId)
        .first();
      if (!row) throw new Error(`upsert failed for broker credential`);
      return mapBrokerCredential(row as unknown as RawRow);
    },

    delete: async (args) => {
      const row = await d1
        .prepare(`SELECT * FROM "BrokerCredential" WHERE "userId" = ?`)
        .bind(args.where.userId)
        .first();
      if (!row) throw new Error(`Broker credential not found`);
      await d1
        .prepare(`DELETE FROM "BrokerCredential" WHERE "userId" = ?`)
        .bind(args.where.userId)
        .run();
      return mapBrokerCredential(row as unknown as RawRow);
    },
  };

  const exchangeCredential: AppDb["exchangeCredential"] = {
    findFirst: async (args) => {
      const row = await d1
        .prepare(`SELECT * FROM "ExchangeCredential" WHERE "userId" = ? AND "exchange" = ?`)
        .bind(args.where.userId, args.where.exchange)
        .first();
      return row ? mapExchangeCredential(row as unknown as RawRow) : null;
    },

    findMany: async (args) => {
      const { results } = await d1
        .prepare(`SELECT * FROM "ExchangeCredential" WHERE "userId" = ? ORDER BY "exchange" ASC`)
        .bind(args.where.userId)
        .all();
      return (results as unknown as RawRow[]).map(mapExchangeCredential);
    },

    upsert: async (args) => {
      const now = new Date().toISOString();
      const { userId, exchange } = args.where.userId_exchange;
      await d1
        .prepare(
          `INSERT INTO "ExchangeCredential"
             ("id", "userId", "exchange", "label", "encKey", "encSecret", "iv", "createdAt", "updatedAt")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT("userId", "exchange") DO UPDATE SET
             "label" = excluded."label",
             "encKey" = excluded."encKey",
             "encSecret" = excluded."encSecret",
             "iv" = excluded."iv",
             "updatedAt" = excluded."updatedAt"`,
        )
        .bind(
          crypto.randomUUID(),
          userId,
          exchange,
          args.create.label ?? null,
          args.create.encKey,
          args.create.encSecret,
          args.create.iv,
          now,
          now,
        )
        .run();
      const row = await d1
        .prepare(`SELECT * FROM "ExchangeCredential" WHERE "userId" = ? AND "exchange" = ?`)
        .bind(userId, exchange)
        .first();
      if (!row) throw new Error(`upsert failed for exchange credential`);
      return mapExchangeCredential(row as unknown as RawRow);
    },

    delete: async (args) => {
      const { userId, exchange } = args.where.userId_exchange;
      const row = await d1
        .prepare(`SELECT * FROM "ExchangeCredential" WHERE "userId" = ? AND "exchange" = ?`)
        .bind(userId, exchange)
        .first();
      if (!row) throw new Error(`Exchange credential not found`);
      await d1
        .prepare(`DELETE FROM "ExchangeCredential" WHERE "userId" = ? AND "exchange" = ?`)
        .bind(userId, exchange)
        .run();
      return mapExchangeCredential(row as unknown as RawRow);
    },
  };

  const exchangeBalance: AppDb["exchangeBalance"] = {
    findMany: async (args) => {
      const { results } = await d1
        .prepare(
          `SELECT * FROM "ExchangeBalance" WHERE "userId" = ? AND "exchange" = ? ORDER BY "asset" ASC`,
        )
        .bind(args.where.userId, args.where.exchange)
        .all();
      return (results as unknown as RawRow[]).map(mapExchangeBalance);
    },

    deleteMany: async (args) => {
      const r = await d1
        .prepare(`DELETE FROM "ExchangeBalance" WHERE "userId" = ? AND "exchange" = ?`)
        .bind(args.where.userId, args.where.exchange)
        .run();
      return { count: r.meta.changes ?? 0 };
    },

    createMany: async (args) => {
      const now = new Date().toISOString();
      let count = 0;
      for (const b of args.data) {
        await d1
          .prepare(
            `INSERT INTO "ExchangeBalance"
               ("id", "userId", "exchange", "asset", "quantity", "priceUsd",
                "priceSource", "priceAt", "valueCents", "currency", "syncedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            b.userId,
            b.exchange,
            b.asset,
            b.quantity,
            b.priceUsd ?? null,
            b.priceSource ?? null,
            b.priceAt ?? null,
            b.valueCents ?? null,
            b.currency ?? "USD",
            now,
          )
          .run();
        count++;
      }
      return { count };
    },
  };

  const exchangeSync: AppDb["exchangeSync"] = {
    findFirst: async (args) => {
      const dir = args.orderBy.syncedAt === "desc" ? "DESC" : "ASC";
      const row = await d1
        .prepare(
          `SELECT * FROM "ExchangeSync" WHERE "userId" = ? AND "exchange" = ? ORDER BY "syncedAt" ${dir} LIMIT 1`,
        )
        .bind(args.where.userId, args.where.exchange)
        .first();
      return row ? mapExchangeSync(row as unknown as RawRow) : null;
    },

    create: async (args) => {
      const d = args.data;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await d1
        .prepare(
          `INSERT INTO "ExchangeSync"
             ("id", "userId", "exchange", "syncedAt", "assetCount", "pricedCount",
              "totalCents", "driftCents", "ok", "note")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          d.userId,
          d.exchange,
          now,
          d.assetCount,
          d.pricedCount,
          d.totalCents,
          d.driftCents,
          d.ok ? 1 : 0,
          d.note ?? null,
        )
        .run();
      const row = await d1
        .prepare(`SELECT * FROM "ExchangeSync" WHERE "id" = ?`)
        .bind(id)
        .first();
      if (!row) throw new Error(`create failed for exchange sync`);
      return mapExchangeSync(row as unknown as RawRow);
    },
  };

  const holding: AppDb["holding"] = {
    findMany: async (args) => {
      const dir = args.orderBy.symbol === "desc" ? "DESC" : "ASC";
      const { results } = await d1
        .prepare(`SELECT * FROM "Holding" ORDER BY "symbol" ${dir}`)
        .all();
      return (results as unknown as RawRow[]).map(mapHolding);
    },

    upsert: async (args) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await d1
        .prepare(
          `INSERT INTO "Holding" ("id", "symbol", "name", "quantity", "avgCost", "createdAt", "updatedAt")
           VALUES (?, ?, NULL, ?, ?, ?, ?)
           ON CONFLICT("symbol") DO UPDATE SET
             "quantity" = excluded."quantity",
             "avgCost" = excluded."avgCost",
             "updatedAt" = excluded."updatedAt"`,
        )
        .bind(
          id,
          args.create.symbol,
          args.create.quantity,
          args.create.avgCost,
          now,
          now,
        )
        .run();
      const row = await d1
        .prepare(`SELECT * FROM "Holding" WHERE "symbol" = ?`)
        .bind(args.where.symbol)
        .first();
      if (!row) throw new Error(`upsert failed for holding ${args.where.symbol}`);
      return mapHolding(row as unknown as RawRow);
    },

    deleteMany: async (args) => {
      const r = await d1
        .prepare(`DELETE FROM "Holding" WHERE "symbol" = ?`)
        .bind(args.where.symbol)
        .run();
      return { count: r.meta.changes ?? 0 };
    },

    updateMany: async (args) => {
      const r = await d1
        .prepare(
          `UPDATE "Holding" SET "name" = ? WHERE "symbol" = ? AND "name" IS NULL`,
        )
        .bind(args.data.name, args.where.symbol)
        .run();
      return { count: r.meta.changes ?? 0 };
    },
  };

  const transaction: AppDb["transaction"] = {
    findMany: async (args) => {
      const binds: unknown[] = [];
      let sql = `SELECT * FROM "Transaction"`;
      if (args.where?.symbol) {
        sql += ` WHERE "symbol" = ?`;
        binds.push(args.where.symbol);
      }
      const order = args.orderBy
        .flatMap((o) =>
          Object.entries(o).map(
            ([k, v]) => `"${k}" ${v === "desc" ? "DESC" : "ASC"}`,
          ),
        )
        .join(", ");
      if (order) sql += ` ORDER BY ${order}`;
      if (args.take !== undefined) {
        sql += ` LIMIT ?`;
        binds.push(args.take);
      }
      const { results } = await d1.prepare(sql).bind(...binds).all();
      return (results as unknown as RawRow[]).map(mapTransaction);
    },

    findUnique: async (args) => {
      const row = await d1
        .prepare(`SELECT * FROM "Transaction" WHERE "id" = ?`)
        .bind(args.where.id)
        .first();
      return row ? mapTransaction(row as unknown as RawRow) : null;
    },

    create: async (args) => {
      const d = args.data;
      const row: TransactionRow = {
        id: crypto.randomUUID(),
        symbol: d.symbol,
        type: d.type,
        quantity: d.quantity,
        price: d.price,
        fees: d.fees ?? 0,
        executedAt: toDate(d.executedAt),
        note: d.note ?? null,
        source: d.source ?? "manual",
        externalId: d.externalId ?? null,
        createdAt: new Date(),
      };
      await d1
        .prepare(
          `INSERT INTO "Transaction"
             ("id", "symbol", "type", "quantity", "price", "fees", "executedAt", "note", "source", "externalId", "createdAt")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.symbol,
          row.type,
          row.quantity,
          row.price,
          row.fees,
          iso(row.executedAt),
          row.note,
          row.source,
          row.externalId,
          iso(row.createdAt),
        )
        .run();
      return row;
    },

    delete: async (args) => {
      const row = await d1
        .prepare(`SELECT * FROM "Transaction" WHERE "id" = ?`)
        .bind(args.where.id)
        .first();
      if (!row) throw new Error(`Transaction ${args.where.id} not found`);
      await d1
        .prepare(`DELETE FROM "Transaction" WHERE "id" = ?`)
        .bind(args.where.id)
        .run();
      return mapTransaction(row as unknown as RawRow);
    },

    deleteMany: async (args) => {
      const r = await d1
        .prepare(`DELETE FROM "Transaction" WHERE "symbol" = ?`)
        .bind(args.where.symbol)
        .run();
      return { count: r.meta.changes ?? 0 };
    },
  };

  const portfolioSnapshot: AppDb["portfolioSnapshot"] = {
    findMany: async (args) => {
      const order = args.orderBy
        .flatMap((o) =>
          Object.entries(o).map(
            ([k, v]) => `"${k}" ${v === "desc" ? "DESC" : "ASC"}`,
          ),
        )
        .join(", ");
      const { results } = await d1
        .prepare(`SELECT * FROM "PortfolioSnapshot" ORDER BY ${order}`)
        .all();
      return (results as unknown as RawRow[]).map(mapPortfolioSnapshot);
    },

    upsert: async (args) => {
      const c = args.create;
      await d1
        .prepare(
          `INSERT INTO "PortfolioSnapshot"
             ("id", "date", "marketValue", "costBasis", "totalPL", "dayPL", "holdingsCount", "createdAt")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT("date") DO UPDATE SET
             "marketValue" = excluded."marketValue",
             "costBasis" = excluded."costBasis",
             "totalPL" = excluded."totalPL",
             "dayPL" = excluded."dayPL",
             "holdingsCount" = excluded."holdingsCount"`,
        )
        .bind(
          crypto.randomUUID(),
          c.date,
          c.marketValue,
          c.costBasis,
          c.totalPL ?? null,
          c.dayPL ?? null,
          c.holdingsCount ?? 0,
          new Date().toISOString(),
        )
        .run();
      const row = await d1
        .prepare(`SELECT * FROM "PortfolioSnapshot" WHERE "date" = ?`)
        .bind(c.date)
        .first();
      if (!row) throw new Error("PortfolioSnapshot upsert failed");
      return mapPortfolioSnapshot(row as unknown as RawRow);
    },
  };

  const priceAlert: AppDb["priceAlert"] = {
    findMany: async (args) => {
      const binds: unknown[] = [];
      const conds: string[] = [];
      if (args.where?.userId !== undefined) {
        conds.push(`"userId" = ?`);
        binds.push(args.where.userId);
      }
      if (args.where?.active !== undefined) {
        conds.push(`"active" = ?`);
        binds.push(args.where.active ? 1 : 0);
      }
      let sql = `SELECT * FROM "PriceAlert"`;
      if (conds.length > 0) sql += ` WHERE ${conds.join(" AND ")}`;
      const order = (args.orderBy ?? [])
        .flatMap((o) =>
          Object.entries(o).map(
            ([k, v]) => `"${k}" ${v === "desc" ? "DESC" : "ASC"}`,
          ),
        )
        .join(", ");
      if (order) sql += ` ORDER BY ${order}`;
      const { results } = await d1.prepare(sql).bind(...binds).all();
      return (results as unknown as RawRow[]).map(mapPriceAlert);
    },

    findUnique: async (args) => {
      const row = await d1
        .prepare(`SELECT * FROM "PriceAlert" WHERE "id" = ?`)
        .bind(args.where.id)
        .first();
      return row ? mapPriceAlert(row as unknown as RawRow) : null;
    },

    create: async (args) => {
      const d = args.data;
      const row: PriceAlertRow = {
        id: crypto.randomUUID(),
        userId: d.userId,
        email: d.email,
        symbol: d.symbol,
        targetPrice: d.targetPrice,
        direction: d.direction,
        active: true,
        triggeredAt: null,
        lastPrice: null,
        createdAt: new Date(),
      };
      await d1
        .prepare(
          `INSERT INTO "PriceAlert"
             ("id", "userId", "email", "symbol", "targetPrice", "direction", "active", "triggeredAt", "lastPrice", "createdAt")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.userId,
          row.email,
          row.symbol,
          row.targetPrice,
          row.direction,
          1,
          null,
          null,
          row.createdAt.toISOString(),
        )
        .run();
      return row;
    },

    update: async (args) => {
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (args.data.active !== undefined) {
        sets.push(`"active" = ?`);
        binds.push(args.data.active ? 1 : 0);
      }
      if (args.data.triggeredAt !== undefined) {
        sets.push(`"triggeredAt" = ?`);
        binds.push(args.data.triggeredAt ? iso(args.data.triggeredAt) : null);
      }
      if (args.data.lastPrice !== undefined) {
        sets.push(`"lastPrice" = ?`);
        binds.push(args.data.lastPrice);
      }
      if (args.data.targetPrice !== undefined) {
        sets.push(`"targetPrice" = ?`);
        binds.push(args.data.targetPrice);
      }
      binds.push(args.where.id);
      await d1
        .prepare(`UPDATE "PriceAlert" SET ${sets.join(", ")} WHERE "id" = ?`)
        .bind(...binds)
        .run();
      const row = await d1
        .prepare(`SELECT * FROM "PriceAlert" WHERE "id" = ?`)
        .bind(args.where.id)
        .first();
      if (!row) throw new Error(`PriceAlert ${args.where.id} not found`);
      return mapPriceAlert(row as unknown as RawRow);
    },

    delete: async (args) => {
      const row = await d1
        .prepare(`SELECT * FROM "PriceAlert" WHERE "id" = ?`)
        .bind(args.where.id)
        .first();
      if (!row) throw new Error(`PriceAlert ${args.where.id} not found`);
      await d1
        .prepare(`DELETE FROM "PriceAlert" WHERE "id" = ?`)
        .bind(args.where.id)
        .run();
      return mapPriceAlert(row as unknown as RawRow);
    },
  };

  const pushSubscription: AppDb["pushSubscription"] = {
    findMany: async () => {
      const { results } = await d1
        .prepare(`SELECT * FROM "PushSubscription" ORDER BY "createdAt" DESC`)
        .all();
      return (results as unknown as RawRow[]).map(mapPushSubscription);
    },
    create: async (args) => {
      const d = args.data;
      // Upsert by endpoint
      const existing = await d1
        .prepare(`SELECT * FROM "PushSubscription" WHERE "endpoint" = ?`)
        .bind(d.endpoint)
        .first();
      if (existing) {
        return mapPushSubscription(existing as unknown as RawRow);
      }
      const row: PushSubscriptionRow = {
        id: crypto.randomUUID(),
        endpoint: d.endpoint,
        p256dh: d.p256dh,
        auth: d.auth,
        createdAt: new Date(),
      };
      await d1
        .prepare(
          `INSERT INTO "PushSubscription" ("id", "endpoint", "p256dh", "auth", "createdAt") VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(row.id, row.endpoint, row.p256dh, row.auth, row.createdAt.toISOString())
        .run();
      return row;
    },
    delete: async (args) => {
      const row = await d1
        .prepare(`SELECT * FROM "PushSubscription" WHERE "endpoint" = ?`)
        .bind(args.where.endpoint)
        .first();
      if (!row) throw new Error("PushSubscription not found");
      await d1
        .prepare(`DELETE FROM "PushSubscription" WHERE "endpoint" = ?`)
        .bind(args.where.endpoint)
        .run();
      return mapPushSubscription(row as unknown as RawRow);
    },
  };

  return {
    brokerTrade,
    brokerCashFlow,
    brokerPosition,
    brokerCredential,
    holding,
    transaction,
    portfolioSnapshot,
    priceAlert,
    pushSubscription,
    exchangeCredential,
    exchangeBalance,
    exchangeSync,
  };
}
