/**
 * NextAuth v4 database adapter.
 *
 * On Cloudflare Workers this talks to D1 with raw SQL (Prisma's native
 * engine can't load on Workers — see src/server/db.ts). Anywhere else
 * (local dev) it falls back to the standard PrismaAdapter.
 *
 * Notes:
 * - next-auth core sha256-hashes verification tokens before calling the
 *   adapter, so tokens are stored/compared exactly as passed.
 * - Email identifiers are normalized (lowercase/trim) by core before they
 *   reach the adapter; no extra normalization is done here.
 * - Dates are stored as ISO-8601 strings (D1 DATETIME affinity).
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from "next-auth/adapters";

import { getAuthDb } from "~/server/db";

function getD1(): D1Database | null {
  try {
    const db = getCloudflareContext().env.DB as D1Database | undefined;
    return db ?? null;
  } catch {
    // Not inside a worker request scope.
    return null;
  }
}

const newId = () => crypto.randomUUID();
const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const toDate = (v: unknown): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(v as string);

type RawRow = Record<string, unknown>;

function mapUser(r: RawRow): AdapterUser {
  return {
    id: r.id as string,
    name: (r.name as string | null) ?? null,
    email: r.email as string,
    emailVerified: toDate(r.emailVerified),
    image: (r.image as string | null) ?? null,
  };
}

function mapSession(r: RawRow): AdapterSession {
  return {
    sessionToken: r.sessionToken as string,
    userId: r.userId as string,
    expires: toDate(r.expires)!,
  };
}

export function createD1Adapter(d1: D1Database): Adapter {
  const q = (sql: string, ...params: unknown[]) => d1.prepare(sql).bind(...params);
  return {
    async createUser(user: Omit<AdapterUser, "id">) {
      const id = newId();
      await q(
        `INSERT INTO "User" ("id", "name", "email", "emailVerified", "image") VALUES (?, ?, ?, ?, ?)`,
        id,
        user.name ?? null,
        user.email,
        user.emailVerified ? iso(user.emailVerified) : null,
        user.image ?? null,
      ).run();
      return mapUser({ id, ...user });
    },

    async getUser(id) {
      const r = await q(`SELECT * FROM "User" WHERE "id" = ?`, id).first<RawRow>();
      return r ? mapUser(r) : null;
    },

    async getUserByEmail(email) {
      const r = await q(`SELECT * FROM "User" WHERE "email" = ?`, email).first<RawRow>();
      return r ? mapUser(r) : null;
    },

    async getUserByAccount({ provider, providerAccountId }) {
      const r = await q(
        `SELECT u.* FROM "User" u JOIN "Account" a ON a."userId" = u."id"
         WHERE a."provider" = ? AND a."providerAccountId" = ?`,
        provider,
        providerAccountId,
      ).first<RawRow>();
      return r ? mapUser(r) : null;
    },

    async updateUser(user) {
      const existing = await q(`SELECT * FROM "User" WHERE "id" = ?`, user.id).first<RawRow>();
      if (!existing) throw new Error(`User ${user.id} not found`);
      const merged = {
        name: user.name ?? (existing.name as string | null),
        email: user.email ?? (existing.email as string),
        emailVerified:
          user.emailVerified ?? (existing.emailVerified as string | null),
        image: user.image ?? (existing.image as string | null),
      };
      await q(
        `UPDATE "User" SET "name" = ?, "email" = ?, "emailVerified" = ?, "image" = ? WHERE "id" = ?`,
        merged.name ?? null,
        merged.email,
        merged.emailVerified ? iso(merged.emailVerified as Date) : null,
        merged.image ?? null,
        user.id,
      ).run();
      return mapUser({ id: user.id, ...merged });
    },

    async linkAccount(account: AdapterAccount) {
      const id = newId();
      await q(
        `INSERT INTO "Account"
         ("id", "userId", "type", "provider", "providerAccountId",
          "refresh_token", "access_token", "expires_at", "token_type",
          "scope", "id_token", "session_state", "refresh_token_expires_in")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        account.userId,
        account.type,
        account.provider,
        account.providerAccountId,
        account.refresh_token ?? null,
        account.access_token ?? null,
        account.expires_at ?? null,
        account.token_type ?? null,
        account.scope ?? null,
        account.id_token ?? null,
        account.session_state ?? null,
        (account as { refresh_token_expires_in?: number | null })
          .refresh_token_expires_in ?? null,
      ).run();
    },

    async createSession({ sessionToken, userId, expires }) {
      const id = newId();
      await q(
        `INSERT INTO "Session" ("id", "sessionToken", "userId", "expires") VALUES (?, ?, ?, ?)`,
        id,
        sessionToken,
        userId,
        iso(expires),
      ).run();
      return { sessionToken, userId, expires };
    },

    async getSessionAndUser(sessionToken) {
      const r = await q(
        `SELECT s."sessionToken" AS "sessionToken", s."userId" AS "userId", s."expires" AS "expires",
                u."id" AS "uid", u."name" AS "uname", u."email" AS "uemail",
                u."emailVerified" AS "uemailVerified", u."image" AS "uimage"
         FROM "Session" s JOIN "User" u ON u."id" = s."userId"
         WHERE s."sessionToken" = ?`,
        sessionToken,
      ).first<RawRow>();
      if (!r) return null;
      return {
        session: mapSession(r),
        user: mapUser({
          id: r.uid,
          name: r.uname,
          email: r.uemail,
          emailVerified: r.uemailVerified,
          image: r.uimage,
        }),
      };
    },

    async updateSession(session) {
      const existing = await q(
        `SELECT * FROM "Session" WHERE "sessionToken" = ?`,
        session.sessionToken,
      ).first<RawRow>();
      if (!existing) return null;
      const merged = {
        userId: session.userId ?? (existing.userId as string),
        expires: session.expires ? iso(session.expires) : (existing.expires as string),
      };
      await q(
        `UPDATE "Session" SET "userId" = ?, "expires" = ? WHERE "sessionToken" = ?`,
        merged.userId,
        merged.expires,
        session.sessionToken,
      ).run();
      return {
        sessionToken: session.sessionToken,
        userId: merged.userId,
        expires: new Date(merged.expires),
      };
    },

    async deleteSession(sessionToken) {
      await q(`DELETE FROM "Session" WHERE "sessionToken" = ?`, sessionToken).run();
    },

    async createVerificationToken(token) {
      await q(
        `INSERT INTO "VerificationToken" ("identifier", "token", "expires") VALUES (?, ?, ?)`,
        token.identifier,
        token.token,
        iso(token.expires),
      ).run();
      return token;
    },

    async useVerificationToken({ identifier, token }) {
      const r = await q(
        `SELECT * FROM "VerificationToken" WHERE "identifier" = ? AND "token" = ?`,
        identifier,
        token,
      ).first<RawRow>();
      if (!r) return null;
      await q(
        `DELETE FROM "VerificationToken" WHERE "identifier" = ? AND "token" = ?`,
        identifier,
        token,
      ).run();
      const vt: VerificationToken = {
        identifier: r.identifier as string,
        token: r.token as string,
        expires: toDate(r.expires)!,
      };
      return vt;
    },
  };
}

/**
 * Adapter for the current request: D1 on Workers, PrismaAdapter locally.
 * Must be called inside a request (getCloudflareContext only resolves there).
 */
export function getAdapter(): Adapter {
  const d1 = getD1();
  if (d1) return createD1Adapter(d1);
  return PrismaAdapter(getAuthDb()) as Adapter;
}
