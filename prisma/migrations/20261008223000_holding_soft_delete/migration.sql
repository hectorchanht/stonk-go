-- Soft delete for holdings: cleared manual holdings are recoverable.
ALTER TABLE "Holding" ADD COLUMN "deletedAt" DATETIME;
