import type { D1Database } from "@cloudflare/workers-types";

declare global {
  interface CloudflareEnv {
    /** D1 database bound in wrangler.jsonc (d1_databases). */
    DB: D1Database;
  }
}

export {};
