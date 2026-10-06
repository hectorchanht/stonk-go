-- Yahoo historical daily bars: price-history cache for the true value curve.
-- Read-through cache: the curve builder reads D1 first, fetches only missing
-- days from Yahoo's chart API, and upserts what comes back. Recent bars are
-- re-fetched every build (Yahoo revises them); older bars are immutable.
-- Prices are TEXT per the codebase's string-decimal convention (no float).
CREATE TABLE IF NOT EXISTS YahooDailyBar (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,                -- YYYY-MM-DD (trading day, UTC)
  close TEXT NOT NULL,               -- exact decimal string
  adjclose TEXT,                     -- exact decimal string; null when Yahoo omits it
  fetchedAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_yahoobar_symbol_date ON YahooDailyBar(symbol, date);
