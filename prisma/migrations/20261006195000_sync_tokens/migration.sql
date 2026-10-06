-- Bearer tokens for local sync agents (Futu OpenD sync script).
-- Only the SHA-256 hash of each token is stored; the plaintext is shown
-- once at creation. Single-purpose scopes ("futu:ingest"), revocable.
-- Apply manually in the Cloudflare D1 console; deploys do not run migrations.
CREATE TABLE IF NOT EXISTS "SyncToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "SyncToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "SyncToken_tokenHash_key" ON "SyncToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "SyncToken_userId_idx" ON "SyncToken"("userId");
