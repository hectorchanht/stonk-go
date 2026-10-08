-- Tombstones for user-deleted transactions, so IBKR auto-sync can't resurrect them.
-- IBKR rows are keyed by externalId; manual rows (externalId NULL) are matched
-- by (symbol, type, quantity, price, date) with import-dedupe tolerances.
CREATE TABLE "DeletedTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "price" REAL NOT NULL,
    "executedAt" DATETIME NOT NULL,
    "externalId" TEXT,
    "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeletedTransaction_externalId_key" UNIQUE ("externalId")
);
CREATE INDEX "DeletedTransaction_symbol_idx" ON "DeletedTransaction"("symbol");
