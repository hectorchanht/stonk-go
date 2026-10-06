-- Read-only crypto exchange integrations (Coinbase + Binance).
-- Per-user encrypted API credentials, exact-decimal balances, and per-sync
-- reconciliation records.
-- Apply manually in the Cloudflare D1 console; deploys do not run migrations.
CREATE TABLE IF NOT EXISTS "ExchangeCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "label" TEXT,
    "encKey" TEXT NOT NULL,
    "encSecret" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExchangeCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ExchangeCredential_userId_exchange_key" ON "ExchangeCredential"("userId", "exchange");
CREATE INDEX IF NOT EXISTS "ExchangeCredential_userId_idx" ON "ExchangeCredential"("userId");

CREATE TABLE IF NOT EXISTS "ExchangeBalance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "priceUsd" TEXT,
    "priceSource" TEXT,
    "priceAt" TEXT,
    "valueCents" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExchangeBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ExchangeBalance_userId_exchange_asset_key" ON "ExchangeBalance"("userId", "exchange", "asset");
CREATE INDEX IF NOT EXISTS "ExchangeBalance_userId_exchange_idx" ON "ExchangeBalance"("userId", "exchange");

CREATE TABLE IF NOT EXISTS "ExchangeSync" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assetCount" INTEGER NOT NULL,
    "pricedCount" INTEGER NOT NULL,
    "totalCents" TEXT NOT NULL,
    "driftCents" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "note" TEXT,
    CONSTRAINT "ExchangeSync_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ExchangeSync_userId_exchange_idx" ON "ExchangeSync"("userId", "exchange");
