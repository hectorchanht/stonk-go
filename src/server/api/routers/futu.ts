/**
 * Futu (富途牛牛 / moomoo) tRPC router.
 *
 * Syncs themselves arrive via POST /api/futu/ingest (bearer token auth —
 * the local agent can't do browser sessions). This router covers everything
 * the dashboard UI needs: minting/revoking sync tokens and reading back
 * the synced positions + trades.
 *
 * Reads are always scoped to the caller's own rows
 * (accountId starts with "futu:<userId>:").
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
  FUTU_INGEST_SCOPE,
  FUTU_PREFIX,
  MAX_TOKENS_PER_USER,
  generateSyncToken,
  sha256Hex,
} from "~/server/futu";

const tokenNameSchema = z.string().min(1).max(60);

const futuRows = <T extends { accountId: string }>(rows: T[], userId: string): T[] => {
  const prefix = `${FUTU_PREFIX}${userId}:`;
  return rows.filter((r) => r.accountId.startsWith(prefix));
};

export const futuRouter = createTRPCRouter({
  /**
   * Positions + trades synced from the caller's Futu accounts, grouped per
   * account. Empty when no sync has run yet.
   */
  status: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const [positions, trades] = await Promise.all([
      ctx.db.brokerPosition.findMany({ orderBy: [{ symbol: "asc" }] }),
      ctx.db.brokerTrade.findMany({ orderBy: [{ tradeDate: "desc" }] }),
    ]);
    const mine = {
      positions: futuRows(positions, userId),
      trades: futuRows(trades, userId),
    };
    const accountIds = [
      ...new Set([
        ...mine.positions.map((r) => r.accountId),
        ...mine.trades.map((r) => r.accountId),
      ]),
    ];
    const lastSyncedAt = [...mine.positions, ...mine.trades].reduce<Date | null>(
      (max, r) => (max == null || r.syncedAt > max ? r.syncedAt : max),
      null,
    );
    return {
      connected: accountIds.length > 0,
      lastSyncedAt,
      accounts: accountIds.map((accountId) => ({
        accountId,
        // Display label: the opaque Futu account id without our prefix.
        label: accountId.slice(`${FUTU_PREFIX}${userId}:`.length),
        positions: mine.positions
          .filter((r) => r.accountId === accountId)
          .map((r) => ({
            id: r.id,
            symbol: r.symbol,
            description: r.description,
            currency: r.currency,
            quantity: r.quantity,
            markPrice: r.markPrice,
          })),
        trades: mine.trades
          .filter((r) => r.accountId === accountId)
          .map((r) => ({
            id: r.id,
            symbol: r.symbol,
            currency: r.currency,
            tradeDate: r.tradeDate,
            quantity: r.quantity,
            tradePrice: r.tradePrice,
            commission: r.commission,
          })),
      })),
    };
  }),

  /**
   * Mint a new sync token. The plaintext token is returned ONCE — it is
   * never stored and can never be retrieved again. The user pastes it into
   * the local sync script's config.
   */
  createToken: protectedProcedure
    .input(z.object({ name: tokenNameSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const existing = await ctx.db.syncToken.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      const active = existing.filter(
        (t) => t.scope === FUTU_INGEST_SCOPE && !t.revokedAt,
      );
      if (active.length >= MAX_TOKENS_PER_USER) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Token limit reached (${MAX_TOKENS_PER_USER}). Revoke an old token first.`,
        });
      }
      const token = generateSyncToken();
      const row = await ctx.db.syncToken.create({
        data: {
          userId,
          name: input.name.trim(),
          tokenHash: await sha256Hex(token),
          scope: FUTU_INGEST_SCOPE,
        },
      });
      return {
        id: row.id,
        token,
        name: row.name,
        createdAt: row.createdAt,
      };
    }),

  /** The caller's Futu sync tokens (hashes are never exposed). */
  listTokens: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.syncToken.findMany({
      where: { userId: ctx.session.user.id },
      orderBy: { createdAt: "desc" },
    });
    return {
      tokens: rows
        .filter((t) => t.scope === FUTU_INGEST_SCOPE)
        .map((t) => ({
          id: t.id,
          name: t.name,
          createdAt: t.createdAt,
          lastUsedAt: t.lastUsedAt,
          revokedAt: t.revokedAt,
        })),
    };
  }),

  /** Soft-revoke a token: it stops working immediately, kept for audit. */
  revokeToken: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.syncToken.findMany({
        where: { userId: ctx.session.user.id },
        orderBy: { createdAt: "desc" },
      });
      const row = rows.find(
        (t) => t.id === input.id && t.scope === FUTU_INGEST_SCOPE,
      );
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Token not found." });
      }
      if (!row.revokedAt) {
        await ctx.db.syncToken.update({
          where: { id: row.id },
          data: { revokedAt: new Date() },
        });
      }
      return { revoked: true };
    }),
});
