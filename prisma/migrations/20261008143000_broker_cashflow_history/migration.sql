-- Older-window cash flows collected by the IBKR history backfill.
-- The main sync wipes BrokerCashFlow on every run, so backfilled flows
-- live here instead (delete-then-insert per 365-day window = idempotent).
-- Apply via the wrangler-run workflow (d1 execute stonk-go-db).
CREATE TABLE IF NOT EXISTS "BrokerCashFlowHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "symbol" TEXT,
    "description" TEXT,
    "currency" TEXT NOT NULL,
    "dateTime" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "type" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BrokerCashFlowHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BrokerCashFlowHistory_userId_dateTime_idx" ON "BrokerCashFlowHistory"("userId", "dateTime");
