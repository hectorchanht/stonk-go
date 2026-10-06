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

type SortDir = "asc" | "desc";

export interface AppDb {
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

  return { holding, transaction };
}
