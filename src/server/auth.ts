import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  getServerSession,
  type DefaultSession,
  type NextAuthOptions,
} from "next-auth";
import DiscordProvider from "next-auth/providers/discord";
import EmailProvider from "next-auth/providers/email";

import { env } from "~/env";
import { getAdapter } from "~/server/d1-adapter";

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

function getResendKey(): string | null {
  let key: unknown;
  try {
    // On Cloudflare Workers, dashboard secrets live on the worker env.
    key = getCloudflareContext().env.RESEND_API_KEY;
  } catch {
    // Not in a worker request scope — local dev falls through to process.env.
  }
  key ??= process.env.RESEND_API_KEY;
  return typeof key === "string" && key.length > 0 ? key : null;
}

function getEmailFrom(): string {
  let from: unknown;
  try {
    from = getCloudflareContext().env.EMAIL_FROM;
  } catch {
    // ignore — fall through to process.env
  }
  from ??= process.env.EMAIL_FROM;
  return typeof from === "string" && from.length > 0
    ? from
    : "Holdr <login@holdr.lol>";
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * Passwordless sign-in email via the Resend HTTP API (Workers have no SMTP).
 * Throws a clear error when RESEND_API_KEY is missing so the UI can show it.
 */
async function sendVerificationRequest(params: {
  identifier: string;
  url: string;
  provider: { from?: string };
}) {
  const apiKey = getResendKey();
  if (!apiKey) {
    throw new Error(
      "Email login is not configured: set the RESEND_API_KEY secret.",
    );
  }
  const from = params.provider.from ?? getEmailFrom();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [params.identifier],
      subject: "Sign in to Holdr",
      text: `Sign in to Holdr:\n\n${params.url}\n\nThis link expires in 24 hours. If you didn't request it, ignore this email.`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2>Sign in to Holdr</h2>
        <p><a href="${esc(params.url)}" style="display:inline-block;padding:12px 24px;background:#059669;color:#fff;text-decoration:none;border-radius:8px">Sign in</a></p>
        <p style="color:#666;font-size:14px">This link expires in 24 hours. If you didn't request it, ignore this email.</p>
        <p style="color:#999;font-size:12px">${esc(params.url)}</p>
      </div>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Never include the API key in the error.
    throw new Error(
      `Could not send the sign-in email (Resend responded ${res.status}). ${body.slice(0, 200)}`,
    );
  }
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * Built per request (not at module scope) so the D1 binding and worker env
 * resolve inside a request on Cloudflare Workers.
 *
 * Sign-in is optional: the portfolio works fully without it. Logging in lets
 * a user save their IBKR credentials to their account (encrypted server-side)
 * instead of re-pasting them in every browser.
 */
export const getAuthOptions = (): NextAuthOptions => {
  const providers: NextAuthOptions["providers"] = [
    EmailProvider({
      from: getEmailFrom(),
      sendVerificationRequest,
    }),
  ];
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    providers.push(
      DiscordProvider({
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
      }),
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

  return {
    // Database sessions: the session callback always receives the DB user,
    // and sign-out actually invalidates server-side.
    session: { strategy: "database" },
    secret: env.NEXTAUTH_SECRET,
    callbacks: {
      session: ({ session, user }) => ({
        ...session,
        user: {
          ...session.user,
          id: user.id,
        },
      }),
    },
    adapter: getAdapter(),
    providers,
    pages: {
      signIn: "/login",
    },
  };
};

/**
 * Wrapper for `getServerSession` so that you don't need to import the `authOptions` in every file.
 */
export const getServerAuthSession = () => getServerSession(getAuthOptions());

/** True when the server can actually send magic-link emails. */
export function isEmailConfigured(): boolean {
  return getResendKey() != null;
}
