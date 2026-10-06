-- Snapshot of positions synced from Interactive Brokers (Flex Web Service)
CREATE TABLE "BrokerPosition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "description" TEXT,
    "assetCategory" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "markPrice" REAL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "BrokerPosition_accountId_idx" ON "BrokerPosition"("accountId");
CREATE INDEX "BrokerPosition_symbol_idx" ON "BrokerPosition"("symbol");
