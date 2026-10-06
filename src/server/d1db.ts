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
      orderBy: Array<{ executedAt?: SortDir; id?: SortDir }>;
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
      };
    }): Promise<TransactionRow>;
    delete(args: { where: { id: string } }): Promise<TransactionRow>;
    deleteMany(args: { where: { symbol: string } }): Promise<{ count: number }>;
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
        createdAt: new Date(),
      };
      await d1
        .prepare(
          `INSERT INTO "Transaction"
             ("id", "symbol", "type", "quantity", "price", "fees", "executedAt", "note", "createdAt")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  return { brokerTrade, brokerCashFlow, brokerPosition, holding, transaction };
}
