import { z } from "zod";
import { publicProcedure, createTRPCRouter } from "~/server/api/trpc";

/**
 * Web Push subscriptions. Stores browser push endpoints so the
 * background alert checker can send notifications.
 */
export const pushRouter = createTRPCRouter({
  subscribe: publicProcedure
    .input(
      z.object({
        endpoint: z.string().url(),
        p256dh: z.string(),
        auth: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.pushSubscription.create({ data: input });
      return { ok: true };
    }),

  unsubscribe: publicProcedure
    .input(z.object({ endpoint: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await ctx.db.pushSubscription.delete({
          where: { endpoint: input.endpoint },
        });
      } catch {
        // Already gone — fine.
      }
      return { ok: true };
    }),

  /** VAPID public key for the client to subscribe. */
  vapidKey: publicProcedure.query(() => {
    // Public key is safe to expose — it's used by the client to encrypt.
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!key) throw new Error("VAPID not configured");
    return { publicKey: key };
  }),
});
