import { type NextRequest } from "next/server";
import NextAuth from "next-auth";

import { getAuthOptions } from "~/server/auth";

// Auth options are built per request so the Prisma client picks up the D1
// binding, which only resolves inside a request on Cloudflare Workers.
async function handler(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string | string[]>> },
) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  return (NextAuth(getAuthOptions()) as (r: NextRequest, c: unknown) => Promise<Response>)(req, ctx);
}

export { handler as GET, handler as POST };
