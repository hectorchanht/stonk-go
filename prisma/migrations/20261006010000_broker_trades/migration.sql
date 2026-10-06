-- Trade executions + cash flows synced from IBKR Flex Web Service
CREATE TABLE "BrokerTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "description" TEXT,
    "assetCategory" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "tradeDate" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "tradePrice" REAL,
    "proceeds" REAL,
    "commission" REAL,
    "realizedPnl" REAL,
    "openClose" TEXT,
    "transactionType" TEXT,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "BrokerTrade_symbol_idx" ON "BrokerTrade"("symbol");
CREATE INDEX "BrokerTrade_tradeDate_idx" ON "BrokerTrade"("tradeDate");

CREATE TABLE "BrokerCashFlow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "symbol" TEXT,
    "description" TEXT,
    "currency" TEXT NOT NULL,
    "dateTime" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "type" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "BrokerCashFlow_type_idx" ON "BrokerCashFlow"("type");
