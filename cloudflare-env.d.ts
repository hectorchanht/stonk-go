import type { D1Database } from "@cloudflare/workers-types";

declare global {
  interface CloudflareEnv {
    /** D1 database bound in wrangler.jsonc (d1_databases). */
    DB: D1Database;
    /** IBKR Flex Web Service token (optional; set in dashboard Variables). */
    IBKR_FLEX_TOKEN?: string;
    /** IBKR Flex Query ID (optional; set in dashboard Variables). */
    IBKR_FLEX_QUERY_ID?: string;
  }
}

export {};
