import { authRouter } from "~/server/api/routers/auth";
import { ibkrRouter } from "~/server/api/routers/ibkr";
import { exchangesRouter } from "~/server/api/routers/exchanges";
import { questradeRouter } from "~/server/api/routers/questrade";
import { portfolioRouter } from "~/server/api/routers/portfolio";
import { aiRouter } from "~/server/api/routers/ai";
import { alertsRouter } from "~/server/api/routers/alerts";
import { pushRouter } from "~/server/api/routers/push";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  auth: authRouter,
  exchanges: exchangesRouter,
  questrade: questradeRouter,
  ibkr: ibkrRouter,
  portfolio: portfolioRouter,
  ai: aiRouter,
  alerts: alertsRouter,
  push: pushRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.portfolio.summary();
 *       ^? Summary
 */
export const createCaller = createCallerFactory(appRouter);
