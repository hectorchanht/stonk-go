// Central runtime binding resolution.
//
// String secrets/vars keep working through globalThis.process.env everywhere:
// plain Node (dev/test) and @opennextjs/cloudflare, which populates
// process.env with every string secret at request time.
//
// Object bindings (D1/KV/R2/services) NEVER land in process.env. Under
// @opennextjs/cloudflare they live on the per-request Cloudflare context, so
// bindings must be read from getCloudflareContext().

import { getCloudflareContext } from "@opennextjs/cloudflare";

type UnknownRecord = Record<string, unknown>;

function contextEnv(): UnknownRecord {
  try {
    return (
      (getCloudflareContext().env as unknown as UnknownRecord | undefined) ??
      {}
    );
  } catch {
    // Not in a request scope (build time, SSG, plain Node).
    return {};
  }
}

/**
 * Read an object binding (D1 database, KV namespace, R2 bucket, service).
 * Prefers the @opennextjs/cloudflare request context, then legacy globals.
 */
export function envBinding<T>(key: string): T | undefined {
  const fromCtx = contextEnv()[key] as T | undefined;
  if (fromCtx !== undefined) return fromCtx;
  const g = globalThis as UnknownRecord & {
    process?: { env?: UnknownRecord };
    __env__?: UnknownRecord;
  };
  return (g.process?.env?.[key] ?? g.__env__?.[key] ?? g[key]) as
    | T
    | undefined;
}
