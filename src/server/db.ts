import type { D1Database } from "@cloudflare/workers-types";
import { PrismaClient } from "@prisma/client";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { env } from "~/env";
import { createD1Db, type AppDb } from "~/server/d1db";

export type { AppDb };

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Real Prisma client, used for local dev (sqlite file) and for NextAuth's
 * PrismaAdapter. Never queried on Cloudflare Workers — Prisma's query
 * engine cannot load there.
 */
function getPrismaClient(): PrismaClient {
  if (env.NODE_ENV === "production") return new PrismaClient();
  globalForPrisma.prisma ??= new PrismaClient();
  return globalForPrisma.prisma;
}

/** Prisma client for NextAuth's adapter. Auth has no providers configured, so this is never queried. */
export function getAuthDb(): PrismaClient {
  return getPrismaClient();
}

/**
 * Get the database for the current request.
 *
 * On Cloudflare Workers this returns a D1-backed client: Prisma's query
 * engine resolves its native binary via fs.readdir at runtime, which the
 * Workers runtime does not implement ("[unenv] fs.readdir is not
 * implemented yet!"). The D1 binding is plain SQL over HTTP, so we talk
 * to it directly (see ~/server/d1db.ts).
 *
 * Everywhere else (local dev, plain Node hosts) this returns Prisma over
 * DATABASE_URL (sqlite file).
 */
export function getDb(): AppDb {
  try {
    const d1 = getCloudflareContext().env.DB as D1Database | undefined;
    if (d1) return createD1Db(d1);
  } catch {
    // Not inside a worker request scope — fall through to Prisma.
  }
  return getPrismaClient();
}
