/**
 * Futu sync ingest endpoint.
 *
 *   POST /api/futu/ingest
 *   Authorization: Bearer <sync-token>
 *   Content-Type: application/json
 *
 * Called by the local sync agent (tools/futu-sync/) running on the user's
 * own machine — it is the only client that can reach the user's OpenD
 * gateway. Browser sessions can't authenticate here (the agent has no
 * cookies), so auth is bearer-token only.
 *
 * Security:
 * - Only the token's SHA-256 hash is compared; revoked or wrong-scope
 *   tokens are rejected with 401 (no detail leaked).
 * - The body is parsed defensively: hard size cap + strict zod schema
 *   (finite numbers, length caps, array caps) before any DB write.
 * - Writes are namespaced to the token owner's userId — a token can only
 *   ever write its own owner's rows.
 */

import { getDb } from "~/server/db";
import {
  FUTU_INGEST_SCOPE,
  futuIngestSchema,
  ingestFutuPayload,
  sha256Hex,
} from "~/server/futu";

/** Reject bodies larger than this before parsing (a sync is small JSON). */
const MAX_BODY_BYTES = 2_000_000;

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function POST(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return unauthorized();

  const db = getDb();
  let tokenRow;
  try {
    tokenRow = await db.syncToken.findFirst({
      where: { tokenHash: await sha256Hex(token) },
    });
  } catch (e) {
    // The SyncToken table may not exist yet (migration not applied).
    console.error("[futu/ingest] token lookup failed:", e);
    return Response.json({ error: "ingest unavailable" }, { status: 503 });
  }
  if (!tokenRow || tokenRow.revokedAt || tokenRow.scope !== FUTU_INGEST_SCOPE) {
    return unauthorized();
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return Response.json({ error: "could not read body" }, { status: 400 });
  }
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = futuIngestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return Response.json(
      {
        error: "invalid payload",
        detail: first
          ? `${first.path.join(".")}: ${first.message}`
          : "schema validation failed",
      },
      { status: 400 },
    );
  }

  let summary;
  try {
    summary = await ingestFutuPayload(db, tokenRow.userId, parsed.data);
  } catch (e) {
    console.error("[futu/ingest] ingest failed:", e);
    return Response.json({ error: "ingest failed" }, { status: 500 });
  }

  // Record usage (best-effort — a failure here must not fail the sync).
  try {
    await db.syncToken.update({
      where: { id: tokenRow.id },
      data: { lastUsedAt: new Date() },
    });
  } catch (e) {
    console.error("[futu/ingest] lastUsedAt update failed:", e);
  }

  return Response.json({
    ok: true,
    accounts: summary.accounts,
    positions: summary.positions,
    trades: summary.trades,
  });
}
