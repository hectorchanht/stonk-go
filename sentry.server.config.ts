// Sentry server-side init (Next.js SSR running in the Cloudflare Worker).
// DSN via SENTRY_DSN secret (wrangler secret put SENTRY_DSN).
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  // Don't send errors in local dev.
  enabled: process.env.NODE_ENV === "production",
});
