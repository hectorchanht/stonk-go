-- Binance cost basis from real spot trade history (myTrades).
-- avgCostUsd: exact-decimal USD average cost per asset; NULL = unknowable
-- (no trade history). Never estimated — unknown stays NULL.
-- costTradeCount: how many real fills the basis was computed from.
ALTER TABLE "ExchangeBalance" ADD COLUMN "avgCostUsd" TEXT;
ALTER TABLE "ExchangeBalance" ADD COLUMN "costTradeCount" INTEGER;
