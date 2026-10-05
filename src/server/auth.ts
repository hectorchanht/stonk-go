import { PrismaAdapter } from "@auth/prisma-adapter";
import {
  getServerSession,
  type DefaultSession,
  type NextAuthOptions,
} from "next-auth";
import { type Adapter } from "next-auth/adapters";
import DiscordProvider from "next-auth/providers/discord";

import { env } from "~/env";
import { getDb } from "~/server/db";

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      // ...other properties
      // role: UserRole;
    } & DefaultSession["user"];
  }

  // interface User {
  //   // ...other properties
  //   // role: UserRole;
  // }
}

/**
 * Auth providers are wired up only when credentials are configured.
 * The portfolio itself does not require sign-in for local use —
 * auth stays available for hosted multi-user setups.
 */
const providers: NextAuthOptions["providers"] = [];
if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
  providers.push(
    DiscordProvider({
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
    })
  );
  /**
   * ...add more providers here.
   *
   * Most other providers require a bit more work than the Discord provider. For example, the
   * GitHub provider requires you to add the `refresh_token_expires_in` field to the Account
   * model. Refer to the NextAuth.js docs for the provider you want to use. Example:
   *
   * @see https://next-auth.js.org/providers/github
   */
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * Built per request (not at module scope) so the Prisma client picks up the
 * D1 binding, which only resolves inside a request on Cloudflare Workers.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const getAuthOptions = (): NextAuthOptions => ({
  callbacks: {
    session: ({ session, user }) => ({
      ...session,
      user: {
        ...session.user,
        id: user.id,
      },
    }),
  },
  adapter: PrismaAdapter(getDb()) as Adapter,
  providers,
});

/**
 * Wrapper for `getServerSession` so that you don't need to import the `authOptions` in every file.
 *
 * @see https://next-auth.js.org/configuration/nextjs
 */
export const getServerAuthSession = () => getServerSession(getAuthOptions());
