/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
await import("./src/env.js");

import { withSentryConfig } from "@sentry/nextjs";

/** @type {import("next").NextConfig} */
const config = {};

export default withSentryConfig(config, {
  // Only upload source maps in production builds with SENTRY_AUTH_TOKEN set.
  // Without it, the build still works — error reporting uses the DSN only.
  silent: true,
  widenClientFileUpload: true,
});
