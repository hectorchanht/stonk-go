-- Broker cost basis on positions (for honest historical curve anchoring).
-- costBasisPrice: per-share cost basis as reported by the broker (IBKR Flex
-- OpenPositions); NULL when the broker doesn't report it. Never estimated —
-- unknown stays NULL and the position simply gets no opening-balance leg.
ALTER TABLE "BrokerPosition" ADD COLUMN "costBasisPrice" REAL;
