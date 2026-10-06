# Futu sync agent for Holdr

Pushes your 富途牛牛 / moomoo stock positions and recent trades into Holdr.

Futu has no cloud API — the only official API talks to **OpenD**, a gateway
that runs on your own computer. So this script runs on **your machine** (not
on Holdr's server): it reads from your local OpenD and POSTs the results to
your Holdr instance.

## One-time setup

### 1. Install and log in to OpenD

1. Download **OpenD** for your OS from the Futu OpenAPI page
   （富途牛牛 / moomoo → OpenAPI).
2. You need a funded Futu/moomoo account with **OpenAPI permission enabled**
   (apply in-app if needed).
3. Launch OpenD and log in (+ phone/2FA). Note the **API port** it listens
   on (default `11111`).
4. Keep OpenD running whenever you want to sync.

### 2. Install this script

```bash
cd tools/futu-sync
pip install -r requirements.txt
cp .env.example .env   # then edit .env
```

### 3. Configure `.env`

| Variable | Required | Notes |
|---|---|---|
| `HOLDR_URL` | yes | Your Holdr instance, e.g. `https://holdr.lol` |
| `HOLDR_SYNC_TOKEN` | yes | Create in Holdr → Stock brokers → Futu → **Sync tokens** → *New token*. Shown once — paste it here. |
| `FUTU_TRADE_PWD_MD5` | for REAL accounts | MD5 of your Futu **trade password**. OpenD needs it to unlock the session before positions can be queried. Compute it without leaving traces in shell history: `printf %s 'yourpassword' \| md5sum` |
| `FUTU_HOST` / `FUTU_PORT` | no | Defaults `127.0.0.1` / `11111` |
| `FUTU_ACC_ID` | no | Sync only this account id (default: all REAL stock accounts) |
| `HISTORY_DAYS` | no | How far back to pull history orders (default `365`) |

> The trade-password MD5 and your sync token stay on **your machine**.
> Only positions and trades are sent to Holdr — never credentials.

### 4. Run it

```bash
python3 sync.py
```

Then open Holdr → Stock brokers → **Futu** tab to see your positions.

### 5. (Optional) Run automatically every hour

On macOS, copy the example launchd job and point it at your paths:

```bash
cp com.holdr.futu-sync.plist.example ~/Library/LaunchAgents/com.holdr.futu-sync.plist
# edit the plist: replace /path/to/holdr/tools/futu-sync and /usr/bin/python3
launchctl load ~/Library/LaunchAgents/com.holdr.futu-sync.plist
```

Logs go to `/tmp/holdr-futu-sync.log`.

## Security notes

- **Read-only.** The script only calls Futu query APIs
  (`position_list_query`, `history_order_list_query`). There is no order
  placement code, and Holdr's ingest endpoint cannot trade either.
- **Your sync token is a bearer secret.** Anyone holding it can push Futu
  data into your Holdr account. Don't share it, don't commit `.env`.
  Revoke it anytime in Holdr → Stock brokers → Futu → Sync tokens.
- Each sync **replaces** the previous snapshot for your account(s), so
  re-running is always safe. Trades shown are the recent window
  (`HISTORY_DAYS`); older history stays in your Futu app.
