// Sentry client-side init. DSN via NEXT_PUBLIC_SENTRY_DSN (set in Cloudflare
// dashboard or wrangler vars for the client bundle).
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  // Don't send errors in local dev.
  enabled: process.env.NODE_ENV === "production",
});
