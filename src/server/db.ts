import type { D1Database } from "@cloudflare/workers-types";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { env } from "~/env";

const createPrismaClient = () => {
  const log: Prisma.LogLevel[] =
    env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"];

  // On Cloudflare Workers the D1 binding carries the database, but it is
  // only visible inside a request: getCloudflareContext() throws at module
  // scope (worker startup). Everywhere else (local dev, plain Node hosts)
  // the client falls back to DATABASE_URL.
  let d1: D1Database | undefined;
  try {
    d1 = getCloudflareContext().env.DB ?? undefined;
  } catch {
    d1 = undefined;
  }

  if (d1) {
    return new PrismaClient({
      adapter: new PrismaD1(d1),
      log,
    });
  }

  return new PrismaClient({ log });
};

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Get a Prisma client for the current request.
 *
 * MUST be called inside a request (route handler, RSC render, tRPC context
 * factory). A client built at module scope would miss the D1 binding and
 * fail every query in production. In dev the client is cached on globalThis
 * across hot reloads.
 */
export function getDb(): PrismaClient {
  if (env.NODE_ENV === "production") return createPrismaClient();
  globalForPrisma.prisma ??= createPrismaClient();
  return globalForPrisma.prisma;
}
