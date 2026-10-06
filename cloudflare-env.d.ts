import type { D1Database } from "@cloudflare/workers-types";

declare global {
  interface CloudflareEnv {
    /** D1 database bound in wrangler.jsonc (d1_databases). */
    DB: D1Database;
    /** IBKR Flex Web Service token (optional; set in dashboard Variables). */
    IBKR_FLEX_TOKEN?: string;
    /** IBKR Flex Query ID (optional; set in dashboard Variables). */
    IBKR_FLEX_QUERY_ID?: string;
    /** Finnhub API key for real-time quotes (optional; dashboard Variables). */
    FINNHUB_API_KEY?: string;
    /** Resend API key for magic-link sign-in emails (optional; dashboard Secrets). */
    RESEND_API_KEY?: string;
    /** From: address for magic-link emails (optional; defaults to Holdr <login@hectorchan.com>). */
    EMAIL_FROM?: string;
    /** base64 of 32 bytes; encrypts per-user IBKR credentials at rest (optional; dashboard Secrets). */
    CREDENTIALS_KEY?: string;
  }
}

export {};
