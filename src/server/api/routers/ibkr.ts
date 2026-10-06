import { TRPCError } from "@trpc/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { fetchFlexPositions, FlexError } from "~/server/ibkr";

const SETUP_HINT =
  "IBKR is not connected. In Client Portal: Reports > Flex Queries (create an Activity query with the Open Positions section, note its ID), then Settings > Reporting > Flex Web Service (generate a token). Set IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID as environment variables/secrets.";

function getFlexConfig(): { token: string; queryId: string } | null {
  let token: unknown;
  let queryId: unknown;
  try {
    // On Cloudflare Workers, dashboard env vars/secrets live on the
    // worker env (process.env is not reliable there).
    const cfEnv = getCloudflareContext().env;
    token = cfEnv.IBKR_FLEX_TOKEN;
    queryId = cfEnv.IBKR_FLEX_QUERY_ID;
  } catch {
    // Not in a worker request scope — local dev falls through to process.env.
  }
  token ??= process.env.IBKR_FLEX_TOKEN;
  queryId ??= process.env.IBKR_FLEX_QUERY_ID;
  if (typeof token !== "string" || !token || typeof queryId !== "string" || !queryId) {
    return null;
  }
  return { token, queryId };
}

export const ibkrRouter = createTRPCRouter({
  status: publicProcedure.query(async ({ ctx }) => {
    const cfg = getFlexConfig();
    const rows = await ctx.db.brokerPosition.findMany({
      orderBy: [{ symbol: "asc" }],
    });
    const lastSyncedAt = rows.reduce<Date | null>(
      (max, r) => (max == null || r.syncedAt > max ? r.syncedAt : max),
      null,
    );
    return {
      configured: cfg != null,
      positionCount: rows.length,
      lastSyncedAt,
      positions: rows.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        symbol: r.symbol,
        description: r.description,
        assetCategory: r.assetCategory,
        currency: r.currency,
        quantity: r.quantity,
        markPrice: r.markPrice,
      })),
    };
  }),

  sync: publicProcedure.mutation(async ({ ctx }) => {
    const cfg = getFlexConfig();
    if (!cfg) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: SETUP_HINT });
    }
    let positions;
    try {
      ({ positions } = await fetchFlexPositions(cfg.token, cfg.queryId));
    } catch (e) {
      const message = e instanceof FlexError ? e.message : "IBKR sync failed unexpectedly.";
      throw new TRPCError({ code: "BAD_REQUEST", message });
    }
    // Replace the whole snapshot. Sequential statements: D1 has no
    // interactive transactions, and a position list is small.
    await ctx.db.brokerPosition.deleteMany();
    if (positions.length > 0) {
      await ctx.db.brokerPosition.createMany({
        data: positions.map((p) => ({
          accountId: p.accountId,
          symbol: p.symbol,
          description: p.description,
          assetCategory: p.assetCategory,
          currency: p.currency,
          quantity: p.quantity,
          markPrice: p.markPrice,
        })),
      });
    }
    return { count: positions.length, syncedAt: new Date() };
  }),
});
