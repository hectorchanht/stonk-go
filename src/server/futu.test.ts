import { describe, it, expect } from "vitest";

import {
  FUTU_INGEST_SCOPE,
  FUTU_PREFIX,
  futuAccountKey,
  futuIngestSchema,
  generateSyncToken,
  ingestFutuPayload,
  sha256Hex,
} from "./futu";
import type { AppDb } from "~/server/d1db";

/* ---------------- token helpers ---------------- */

describe("generateSyncToken", () => {
  it("produces 43-char base64url tokens", () => {
    const t = generateSyncToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("produces unique tokens", () => {
    expect(generateSyncToken()).not.toBe(generateSyncToken());
  });
});

describe("sha256Hex", () => {
  it("hashes deterministically to 64 hex chars", async () => {
    const h1 = await sha256Hex("hello");
    const h2 = await sha256Hex("hello");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // Known vector: sha256("hello").
    expect(h1).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("differs per input", async () => {
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });
});

describe("futuAccountKey", () => {
  it("namespaces per user", () => {
    expect(futuAccountKey("u1", "12345")).toBe("futu:u1:12345");
    expect(futuAccountKey("u2", "12345")).toBe("futu:u2:12345");
  });

  it("neutralizes colons in the opaque account id", () => {
    expect(futuAccountKey("u1", "a:b:c")).toBe("futu:u1:a_b_c");
    expect(futuAccountKey("u1", "a:b:c").startsWith(FUTU_PREFIX)).toBe(true);
  });
});

/* ---------------- ingest schema ---------------- */

const validPayload = {
  version: 1,
  accounts: [
    {
      accountId: "12345678",
      positions: [
        {
          symbol: "00700",
          name: "Tencent",
          currency: "HKD",
          quantity: 100,
          avgCost: 300.5,
          markPrice: 450.25,
        },
      ],
      trades: [
        {
          symbol: "00700",
          side: "BUY",
          quantity: 100,
          price: 300.5,
          currency: "HKD",
          tradeDate: "20260115",
          orderId: "98765",
          commission: 15.2,
        },
      ],
    },
  ],
};

describe("futuIngestSchema", () => {
  it("accepts a valid payload", () => {
    const r = futuIngestSchema.safeParse(validPayload);
    expect(r.success).toBe(true);
  });

  it("normalizes symbols to uppercase trimmed", () => {
    const r = futuIngestSchema.safeParse({
      ...validPayload,
      accounts: [
        {
          accountId: "1",
          positions: [
            { symbol: " aapl ", currency: "USD", quantity: 10 },
          ],
          trades: [],
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.accounts[0]!.positions[0]!.symbol).toBe("AAPL");
    }
  });

  it("rejects wrong version", () => {
    expect(
      futuIngestSchema.safeParse({ ...validPayload, version: 2 }).success,
    ).toBe(false);
  });

  it("rejects non-finite numbers", () => {
    // JSON cannot encode NaN, but 1e999 parses to Infinity — the schema
    // must still reject it.
    const fromJson = JSON.parse(
      JSON.stringify(validPayload).replace("300.5", "1e999"),
    ) as { accounts: { positions: { avgCost: number }[] }[] };
    expect(fromJson.accounts[0]?.positions[0]?.avgCost).toBe(Infinity);
    expect(futuIngestSchema.safeParse(fromJson).success).toBe(false);

    const direct = {
      ...validPayload,
      accounts: [
        {
          accountId: "1",
          positions: [{ symbol: "AAPL", currency: "USD", quantity: NaN }],
          trades: [],
        },
      ],
    };
    expect(futuIngestSchema.safeParse(direct).success).toBe(false);
  });

  it("rejects Infinity prices", () => {
    const direct = {
      version: 1,
      accounts: [
        {
          accountId: "1",
          positions: [],
          trades: [
            {
              symbol: "AAPL",
              side: "BUY",
              quantity: 1,
              price: Infinity,
              currency: "USD",
              tradeDate: "20260115",
            },
          ],
        },
      ],
    };
    expect(futuIngestSchema.safeParse(direct).success).toBe(false);
  });

  it("rejects malformed tradeDate", () => {
    const direct = {
      version: 1,
      accounts: [
        {
          accountId: "1",
          positions: [],
          trades: [
            {
              symbol: "AAPL",
              side: "BUY",
              quantity: 1,
              price: 100,
              currency: "USD",
              tradeDate: "15-01-2026",
            },
          ],
        },
      ],
    };
    expect(futuIngestSchema.safeParse(direct).success).toBe(false);
  });

  it("rejects oversized arrays", () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      symbol: `S${i}`,
      currency: "USD",
      quantity: 1,
    }));
    const direct = {
      version: 1,
      accounts: [{ accountId: "1", positions: many, trades: [] }],
    };
    expect(futuIngestSchema.safeParse(direct).success).toBe(false);
  });

  it("rejects empty accounts and too many accounts", () => {
    expect(
      futuIngestSchema.safeParse({ version: 1, accounts: [] }).success,
    ).toBe(false);
    const manyAccounts = Array.from({ length: 11 }, (_, i) => ({
      accountId: `${i}`,
      positions: [],
      trades: [],
    }));
    expect(
      futuIngestSchema.safeParse({ version: 1, accounts: manyAccounts })
        .success,
    ).toBe(false);
  });

  it("rejects lowercase currency codes", () => {
    const direct = {
      version: 1,
      accounts: [
        {
          accountId: "1",
          positions: [{ symbol: "AAPL", currency: "usd", quantity: 1 }],
          trades: [],
        },
      ],
    };
    expect(futuIngestSchema.safeParse(direct).success).toBe(false);
  });
});

/* ---------------- ingestFutuPayload ---------------- */

function mockDb() {
  const positionRows: Record<string, unknown>[] = [];
  const tradeRows: Record<string, unknown>[] = [];
  const db = {
    brokerPosition: {
      deleteByAccountPrefix: async (prefix: string) => {
        let n = 0;
        for (let i = positionRows.length - 1; i >= 0; i--) {
          if ((positionRows[i]!.accountId as string).startsWith(prefix)) {
            positionRows.splice(i, 1);
            n++;
          }
        }
        return { count: n };
      },
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        positionRows.push(...args.data);
        return { count: args.data.length };
      },
    },
    brokerTrade: {
      deleteByAccountPrefix: async (prefix: string) => {
        let n = 0;
        for (let i = tradeRows.length - 1; i >= 0; i--) {
          if ((tradeRows[i]!.accountId as string).startsWith(prefix)) {
            tradeRows.splice(i, 1);
            n++;
          }
        }
        return { count: n };
      },
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        tradeRows.push(...args.data);
        return { count: args.data.length };
      },
    },
  } as unknown as AppDb;
  return { db, positionRows, tradeRows };
}

describe("ingestFutuPayload", () => {
  it("writes namespaced rows with signed trade quantities", async () => {
    const { db, positionRows, tradeRows } = mockDb();
    const parsed = futuIngestSchema.parse(validPayload);
    const summary = await ingestFutuPayload(db, "user-1", parsed);
    expect(summary).toEqual({
      accounts: 1,
      positions: 1,
      trades: 1,
      accountKeys: ["futu:user-1:12345678"],
    });
    expect(positionRows[0]).toMatchObject({
      accountId: "futu:user-1:12345678",
      symbol: "00700",
      description: "Tencent",
      assetCategory: "STK",
      currency: "HKD",
      quantity: 100,
      markPrice: 450.25,
    });
    // BUY stays positive.
    expect(tradeRows[0]).toMatchObject({
      accountId: "futu:user-1:12345678",
      symbol: "00700",
      currency: "HKD",
      tradeDate: "20260115",
      quantity: 100,
      tradePrice: 300.5,
      commission: 15.2,
    });
  });

  it("signs SELL quantities negative", async () => {
    const { db, tradeRows } = mockDb();
    const parsed = futuIngestSchema.parse({
      version: 1,
      accounts: [
        {
          accountId: "9",
          positions: [],
          trades: [
            {
              symbol: "AAPL",
              side: "SELL",
              quantity: 5,
              price: 200,
              currency: "USD",
              tradeDate: "20260201",
            },
          ],
        },
      ],
    });
    await ingestFutuPayload(db, "user-1", parsed);
    expect(tradeRows[0]).toMatchObject({ quantity: -5, tradePrice: 200 });
  });

  it("replace-all is idempotent and scoped per user", async () => {
    const { db, positionRows } = mockDb();
    const parsed = futuIngestSchema.parse(validPayload);
    await ingestFutuPayload(db, "user-1", parsed);
    await ingestFutuPayload(db, "user-1", parsed);
    expect(positionRows).toHaveLength(1);
    // Another user's rows are untouched.
    await ingestFutuPayload(db, "user-2", parsed);
    expect(positionRows).toHaveLength(2);
    expect(
      positionRows.filter((r) =>
        (r.accountId as string).startsWith("futu:user-1:"),
      ),
    ).toHaveLength(1);
  });

  it("throws a clear error when scoped delete is unavailable", async () => {
    const parsed = futuIngestSchema.parse(validPayload);
    // Local-dev Prisma client: tables exist, but the D1-only scoped
    // delete does not.
    const prismaLike = {
      brokerPosition: {},
      brokerTrade: {},
    } as unknown as AppDb;
    await expect(ingestFutuPayload(prismaLike, "user-1", parsed)).rejects.toThrow(
      /D1 binding/,
    );
  });
});

describe("FUTU_INGEST_SCOPE", () => {
  it("is the documented single-purpose scope", () => {
    expect(FUTU_INGEST_SCOPE).toBe("futu:ingest");
  });
});
