import { authRouter } from "~/server/api/routers/auth";
import { ibkrRouter } from "~/server/api/routers/ibkr";
import { portfolioRouter } from "~/server/api/routers/portfolio";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  auth: authRouter,
  ibkr: ibkrRouter,
  portfolio: portfolioRouter,
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
