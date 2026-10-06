-- Daily portfolio snapshots (equity curve) + price alerts
CREATE TABLE IF NOT EXISTS "PortfolioSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "marketValue" REAL NOT NULL,
    "costBasis" REAL NOT NULL,
    "totalPL" REAL,
    "dayPL" REAL,
    "holdingsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "PortfolioSnapshot_date_key" ON "PortfolioSnapshot"("date");

CREATE TABLE IF NOT EXISTS "PriceAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "targetPrice" REAL NOT NULL,
    "direction" TEXT NOT NULL,
    "active" INTEGER NOT NULL DEFAULT 1,
    "triggeredAt" DATETIME,
    "lastPrice" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PriceAlert_userId_idx" ON "PriceAlert"("userId");
CREATE INDEX IF NOT EXISTS "PriceAlert_active_idx" ON "PriceAlert"("active");
