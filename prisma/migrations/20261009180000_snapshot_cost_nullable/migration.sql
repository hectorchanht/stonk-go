-- Make PortfolioSnapshot.costBasis nullable. Unknown cost is never treated
-- as $0: when any position lacks a recorded cost basis, the snapshot keeps
-- a NULL cost instead of a $0-filled one.
CREATE TABLE "PortfolioSnapshot_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "marketValue" REAL NOT NULL,
    "costBasis" REAL,
    "totalPL" REAL,
    "dayPL" REAL,
    "holdingsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "PortfolioSnapshot_new" ("id", "date", "marketValue", "costBasis", "totalPL", "dayPL", "holdingsCount", "createdAt")
    SELECT "id", "date", "marketValue", "costBasis", "totalPL", "dayPL", "holdingsCount", "createdAt" FROM "PortfolioSnapshot";
DROP TABLE "PortfolioSnapshot";
ALTER TABLE "PortfolioSnapshot_new" RENAME TO "PortfolioSnapshot";
CREATE UNIQUE INDEX IF NOT EXISTS "PortfolioSnapshot_date_key" ON "PortfolioSnapshot"("date");
