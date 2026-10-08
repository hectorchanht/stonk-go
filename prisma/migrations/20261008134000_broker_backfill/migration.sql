-- IBKR history-backfill cursor: one row per user, tracks how far back the
-- 365-day-window backfill has reached. Deploys do not run migrations;
-- apply via the wrangler-run workflow (d1 execute stonk-go-db).
CREATE TABLE IF NOT EXISTS "BrokerBackfill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "oldestCovered" TEXT NOT NULL,
    "emptyStreak" INTEGER NOT NULL DEFAULT 0,
    "doneAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BrokerBackfill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "BrokerBackfill_userId_key" ON "BrokerBackfill"("userId");
