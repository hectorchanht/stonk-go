import { isEmailConfigured } from "~/server/auth";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

/** Auth metadata the UI needs before attempting sign-in. */
export const authRouter = createTRPCRouter({
  /** Whether the server can send magic-link emails (RESEND_API_KEY set). */
  emailConfigured: publicProcedure.query(() => ({
    configured: isEmailConfigured(),
  })),
});
