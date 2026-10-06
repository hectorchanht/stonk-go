-- Merge IBKR-synced trades into the manual transaction log.
-- source/externalId let ibkr.sync upsert broker trades idempotently so
-- holdings and cost basis are computed from one unified log.
ALTER TABLE "Transaction" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "Transaction" ADD COLUMN "externalId" TEXT;
CREATE UNIQUE INDEX "Transaction_externalId_key" ON "Transaction"("externalId");
