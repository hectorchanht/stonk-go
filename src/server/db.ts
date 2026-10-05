import type { D1Database } from "@cloudflare/workers-types";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";

import { env } from "~/env";
import { envBinding } from "~/lib/cloudflare-env";

const createPrismaClient = () => {
  const log: Prisma.LogLevel[] =
    env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"];

  // On Cloudflare Workers the D1 binding carries the database;
  // everywhere else (local dev, plain Node hosts) DATABASE_URL is used.
  const d1 = envBinding<D1Database>("DB");
  if (d1) {
    return new PrismaClient({
      adapter: new PrismaD1(d1),
      log,
    });
  }

  return new PrismaClient({ log });
};

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") globalForPrisma.prisma = db;
