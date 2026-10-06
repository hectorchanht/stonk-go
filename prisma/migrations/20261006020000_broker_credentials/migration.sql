-- Per-user encrypted IBKR Flex credentials (AES-GCM, see src/server/crypto.ts).
-- Apply manually in the Cloudflare D1 console; deploys do not run migrations.
CREATE TABLE IF NOT EXISTS "BrokerCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "encToken" TEXT NOT NULL,
    "encQueryId" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BrokerCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "BrokerCredential_userId_key" ON "BrokerCredential"("userId");
