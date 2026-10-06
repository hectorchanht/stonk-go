# 💎 Holdr

A simple, self-hosted **personal investing portfolio** tracker for diamond
hands — log buys and
sells, watch your holdings with live market prices, day P/L, total P/L, and
allocation, all in a dark, mobile-friendly dashboard.

Built on the [T3 stack](https://create.t3.gg/): Next.js + tRPC + Prisma +
Tailwind. No API keys, no paid services, no required sign-in.

## Features

- **Holdings** — symbol, quantity, average cost basis (fees folded in)
- **Transactions** — full buy/sell log; holdings are recomputed from the log,
  so the positions can never drift out of sync (deleting a transaction
  automatically fixes the holding)
- **Dashboard** — total portfolio value, day P/L, total P/L, cost basis,
  holdings table with live prices, allocation bar
- **Live prices** — fetched server-side and cached for 60s, so the client
  never talks to the quote providers directly
- **Dark theme** by default

## Data sources

Quotes are fetched server-side with a 60-second in-memory cache:

1. **Finnhub** (`finnhub.io/api/v1/quote`) — real-time US quotes on the free
   tier (60 calls/min). Used first when `FINNHUB_API_KEY` is set (free signup
   at finnhub.io, then add it as a Worker secret / `.env` var).
2. **Yahoo Finance** chart API (`query1.finance.yahoo.com/v8/finance/chart`)
   — no key required, ~15min delayed. A few daily bars give the latest price
   *and* the previous close, which powers the day P/L column.
3. **Stooq** CSV (`stooq.com/q/l/?s=…&f=sd2t2ohlcv&h&e=csv`) — fallback,
   close price only.

If all fail, the holding shows `—` and is excluded from value totals.
Quotes are not financial advice.

## Getting started

```bash
npm install

# 1. copy env and point at a database (sqlite by default)
cp .env.example .env

# 2. create the database
npm run db:push

# 3. run it
npm run dev
```

Open http://localhost:3000 — log your first buy and the dashboard comes alive.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | `file:./db.sqlite` for local dev; any Prisma-supported URL for hosted |
| `NEXTAUTH_SECRET` | prod only | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | no | only needed if you enable sign-in |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | no | sign-in provider; portfolio works without it |

Sign-in is **optional**: the portfolio is a single-user app and doesn't
require login. NextAuth stays wired so you can add providers later for a
hosted multi-user setup.

## Scripts

```bash
npm run dev          # dev server
npm run build        # production build
npm run start        # serve production build
npm run db:push      # push schema to the database (dev)
npm run db:migrate   # apply migrations (prod)
npm run db:studio    # Prisma Studio data browser
npm run lint         # eslint
```

## Project structure

```
prisma/
  schema.prisma        # Holding, Transaction, + NextAuth models
src/
  app/
    page.tsx           # dashboard entry (server component, prefetches data)
    _components/
      dashboard.tsx    # dashboard UI (client components)
  server/
    api/routers/
      portfolio.ts     # tRPC: summary, quote, transactions, record/delete
    market.ts          # server-side quote fetcher (Yahoo + Stooq, cached)
    db.ts              # Prisma client
    auth.ts            # NextAuth (optional, no forced login)
  trpc/                # tRPC client/server helpers
```

## Going live on Cloudflare Workers

The repo is deploy-ready for Cloudflare Workers via
[@opennextjs/cloudflare](https://opennext.js.org/cloudflare) (the same setup
as `ownerledgr` — no deprecated `next-on-pages`).

On Workers there is no local sqlite file, so the app uses a **D1 database**
when the `DB` binding is present (`src/server/db.ts` switches automatically
via `@prisma/adapter-d1`; locally it keeps using `DATABASE_URL`).

One-time dashboard setup:

1. **Create the D1 database**: Cloudflare dashboard → Workers & Pages →
   D1 SQL → Create → name it `stonk-go-db`.
2. **Point the repo at it**: paste the database ID into `wrangler.jsonc`
   (`d1_databases[0].database_id`, replacing `REPLACE_WITH_D1_DATABASE_ID`).
3. **Connect git integration**: Workers & Pages → Create → connect
   `hectorchanht/holdr`, build command `npm run build:worker`, deploy
   command `npx wrangler deploy`.
4. **Apply the schema**: after the first deploy,
   `npx wrangler d1 execute stonk-go-db --remote --file=prisma/migrations/20261005233129_portfolio/migration.sql`
   (repeat per migration file if more are added later).

Local worker preview: `npm run preview` (builds with opennext and serves via
workerd).

## Interactive Brokers (optional)

The dashboard has an **Interactive Brokers** card that pulls your real
positions and trade analysis (read-only) via IBKR's **Flex Web Service** —
a token-based reporting API, so no IB Gateway or TWS needs to run anywhere.

**Any IB user can connect — no login needed.** If the server has no IBKR
account configured, the card shows a connect form: paste your Flex token +
query ID once and it's remembered in your browser (localStorage). The app
auto-syncs on page load when the cached data is stale ("self update"). Your
token is sent to IBKR only when syncing and is never stored on the server.
If the server *does* have an account configured (env vars below), everyone
sees that shared snapshot instead.

One-time setup in Client Portal (per user):

1. **Performance & Reports → Flex Queries** — create an *Activity* Flex
   Query with the **Open Positions**, **Trades** and **Cash Transactions**
   sections. Note its Query ID.
2. **Settings → Account Settings → Reporting → Flex Web Service** —
   generate a token (lasts up to ~1 year; set a reminder to rotate).
3. Either:
   - paste both into the app's connect form (browser-kept, per user), or
   - set `IBKR_FLEX_TOKEN` and `IBKR_FLEX_QUERY_ID` as Worker secrets /
     `.env` vars for the server-wide account.

The sync pulls positions, trade executions and cash movements; the analysis
view shows realized P/L (IBKR FIFO), dividends, commissions paid, per-symbol
breakdown and recent trades.

Notes:

- Flex data is **end-of-day** (refreshes after market close), not live.
- The token is read-only reporting access, but treat it like a password.
- Synced positions are a snapshot; your manual transaction log stays the
  source of truth for cost basis.
- If nothing is configured, the card shows these setup steps instead.

## Notes & roadmap

- SQLite is the default; for a hosted deploy, switch `DATABASE_URL` to
  Postgres/MySQL and run `npm run db:migrate`.
- Quotes are cached 60s server-side and the dashboard auto-refreshes every
  2 minutes.
- Possible next steps: multi-currency support, dividends/splits, CSV import,
  portfolio history chart, watchlist.
