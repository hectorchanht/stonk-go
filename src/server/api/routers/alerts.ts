import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

/**
 * Price alerts. Login is required — the account email is where the alert
 * goes. The actual checking happens in /api/alerts/check (key-authenticated,
 * driven by a scheduled job), which emails owners via Resend and flips hit
 * alerts to inactive.
 */

const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .transform((s) => s.toUpperCase().replace(/\s+/g, ""));

export const alertsRouter = createTRPCRouter({
  /** The caller's alerts, newest first (active and triggered). */
  list: protectedProcedure.query(({ ctx }) =>
    ctx.db.priceAlert.findMany({
      where: { userId: ctx.session.user.id },
      orderBy: [{ createdAt: "desc" }],
    }),
  ),

  create: protectedProcedure
    .input(
      z.object({
        symbol: symbolSchema,
        targetPrice: z.number().positive().max(1_000_000_000),
        direction: z.enum(["above", "below"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const email = ctx.session.user.email;
      if (!email) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Your account has no email address — alerts need somewhere to go.",
        });
      }
      // One active alert per symbol+direction: re-creating just moves the target.
      const existing = await ctx.db.priceAlert.findMany({
        where: { userId: ctx.session.user.id, active: true },
      });
      const dup = existing.find(
        (a) => a.symbol === input.symbol && a.direction === input.direction,
      );
      if (dup) {
        return ctx.db.priceAlert.update({
          where: { id: dup.id },
          data: { targetPrice: input.targetPrice },
        });
      }
      return ctx.db.priceAlert.create({
        data: {
          userId: ctx.session.user.id,
          email,
          symbol: input.symbol,
          targetPrice: input.targetPrice,
          direction: input.direction,
        },
      });
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.priceAlert.findUnique({
        where: { id: input.id },
      });
      if (!row || row.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Alert not found." });
      }
      await ctx.db.priceAlert.delete({ where: { id: input.id } });
      return { ok: true };
    }),
});
