#!/usr/bin/env python3
"""
Holdr Futu sync agent.

Pulls stock positions + recent history orders from your Futu account via a
locally-running Futu OpenD gateway, and POSTs them to your Holdr instance.

    python3 sync.py

Configuration (environment variables, or a `.env` file next to this script):

    FUTU_HOST=127.0.0.1          OpenD host (default 127.0.0.1)
    FUTU_PORT=11111               OpenD API port (default 11111)
    FUTU_TRADE_PWD_MD5=...        MD5 of your Futu trade password (required for
                                 REAL accounts — OpenD needs it to unlock the
                                 session before positions can be queried)
    FUTU_ACC_ID=                  Optional: sync only this Futu account id.
                                 Default: all REAL stock accounts.
    HOLDR_URL=https://holdr.lol   Your Holdr instance (required)
    HOLDR_SYNC_TOKEN=...          Sync token from Holdr → Stock brokers →
                                 Futu → "Sync tokens" (required)
    HISTORY_DAYS=365              How far back to pull history orders
                                 (default 365)

Security model — read this once:
  * This script is READ-ONLY by construction. It only calls Futu query APIs
    (position_list_query, history_order_list_query). There is no order
    placement code here, and the Holdr ingest endpoint cannot trade either.
  * Your Futu trade password (MD5) is used ONLY to unlock your LOCAL OpenD
    session. It is never sent to Holdr or anywhere else — only positions
    and trades go over the wire.
  * Your Holdr sync token is a bearer secret: anyone holding it can push
    Futu data into YOUR Holdr account. Store it like a password. You can
    revoke it anytime in Holdr → Stock brokers → Futu → "Sync tokens".
  * Traffic goes to HOLDR_URL over HTTPS. Never point HOLDR_URL at a host
    you don't trust.

Exit codes: 0 ok · 1 config error · 2 OpenD unreachable · 3 Futu API error ·
            4 Holdr rejected the ingest.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import date, timedelta

try:
    from futu import (
        RET_OK,
        OpenSecTradeContext,
        SecurityFirm,
        TrdEnv,
    )
except ImportError:
    print(
        "error: the 'futu-api' package is not installed.\n"
        "Run: pip install -r requirements.txt",
        file=sys.stderr,
    )
    sys.exit(1)


# ---------------------------------------------------------------- config

def load_dotenv() -> None:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip("'").strip('"')
            if k and k not in os.environ:
                os.environ[k] = v


load_dotenv()

FUTU_HOST = os.environ.get("FUTU_HOST", "127.0.0.1")
FUTU_PORT = int(os.environ.get("FUTU_PORT", "11111"))
FUTU_TRADE_PWD_MD5 = os.environ.get("FUTU_TRADE_PWD_MD5", "")
FUTU_ACC_ID = os.environ.get("FUTU_ACC_ID", "").strip()
HOLDR_URL = os.environ.get("HOLDR_URL", "").rstrip("/")
HOLDR_SYNC_TOKEN = os.environ.get("HOLDR_SYNC_TOKEN", "")
HISTORY_DAYS = int(os.environ.get("HISTORY_DAYS", "365"))

INGEST_VERSION = 1


def fail(msg: str, code: int) -> "NoReturn":
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


# ---------------------------------------------------------------- futu helpers

def check_ret(ret: int, data, action: str) -> None:
    """futu-api returns (RET_OK, DataFrame) on success, (err, message) on
    failure — the message never contains credentials."""
    if ret != RET_OK:
        fail(f"{action} failed: {data}", 3)


def norm_symbol(code: str) -> str:
    """'HK.00700' -> '00700', 'US.AAPL' -> 'AAPL'."""
    code = (code or "").strip().upper()
    return code.split(".")[-1] if "." in code else code


def clean(value, default=None):
    """DataFrame NaN -> default; keep everything else."""
    try:
        import pandas as pd  # noqa: F401
        import math

        if value is None:
            return default
        if isinstance(value, float) and math.isnan(value):
            return default
        return value
    except ImportError:
        return value if value is not None else default


def ymd(dt_str: str) -> str:
    """'2026-01-15 10:30:00' -> '20260115'."""
    return (dt_str or "")[:10].replace("-", "")


# ---------------------------------------------------------------- main

def main() -> None:
    if not HOLDR_URL:
        fail("HOLDR_URL is not set (e.g. https://holdr.lol)", 1)
    if not HOLDR_SYNC_TOKEN:
        fail("HOLDR_SYNC_TOKEN is not set — create one in Holdr → "
             "Stock brokers → Futu → Sync tokens", 1)
    if not FUTU_TRADE_PWD_MD5:
        # Warn, don't fail: paper (SIMULATE) accounts don't need unlocking.
        print("warn: FUTU_TRADE_PWD_MD5 not set — REAL accounts need it to "
              "unlock the OpenD session", file=sys.stderr)

    try:
        trd_ctx = OpenSecTradeContext(
            host=FUTU_HOST, port=FUTU_PORT,
            security_firm=SecurityFirm.FUTUSECURITIES,
        )
    except Exception as e:  # noqa: BLE001 — connection errors vary
        fail(f"cannot reach OpenD at {FUTU_HOST}:{FUTU_PORT} — is OpenD "
             f"running and logged in? ({e})", 2)

    try:
        if FUTU_TRADE_PWD_MD5:
            ret, msg = trd_ctx.unlock_trade(FUTU_TRADE_PWD_MD5)
            check_ret(ret, msg, "unlock_trade")

        ret, acc_df = trd_ctx.accinfo_query(trd_env=TrdEnv.REAL)
        check_ret(ret, acc_df, "accinfo_query")
        accounts = []
        for row in acc_df.to_dict("records"):
            acc_id = str(row["acc_id"])
            if FUTU_ACC_ID and acc_id != FUTU_ACC_ID:
                continue
            accounts.append(acc_id)
        if not accounts:
            fail("no REAL Futu accounts found"
                 + (f" matching FUTU_ACC_ID={FUTU_ACC_ID}" if FUTU_ACC_ID else ""),
                 3)
        print(f"accounts: {', '.join(accounts)}")

        end = date.today()
        start = end - timedelta(days=HISTORY_DAYS)
        start_s, end_s = start.isoformat(), end.isoformat()

        payload_accounts = []
        total_positions = 0
        total_trades = 0
        for acc_id in accounts:
            ret, pos_df = trd_ctx.position_list_query(
                trd_env=TrdEnv.REAL, acc_id=int(acc_id))
            check_ret(ret, pos_df, f"position_list_query({acc_id})")

            positions = []
            for row in pos_df.to_dict("records"):
                qty = clean(row.get("qty"), 0)
                if not qty:
                    continue
                cost_valid = bool(clean(row.get("cost_price_valid"), False))
                positions.append({
                    "symbol": norm_symbol(row.get("code")),
                    "name": clean(row.get("stock_name")) or None,
                    "currency": (clean(row.get("currency")) or "HKD").upper(),
                    "quantity": float(qty),
                    "avgCost": float(row["cost_price"]) if cost_valid
                    and clean(row.get("cost_price")) else None,
                    "markPrice": float(row["nominal_price"])
                    if clean(row.get("nominal_price")) else None,
                })

            ret, ord_df = trd_ctx.history_order_list_query(
                start=start_s, end=end_s,
                trd_env=TrdEnv.REAL, acc_id=int(acc_id))
            check_ret(ret, ord_df, f"history_order_list_query({acc_id})")

            trades = []
            for row in ord_df.to_dict("records"):
                dealt = clean(row.get("dealt_qty"), 0)
                if not dealt:
                    continue  # skip cancelled / unfilled orders
                side = (clean(row.get("trd_side")) or "").upper()
                if side not in ("BUY", "SELL"):
                    continue
                trades.append({
                    "symbol": norm_symbol(row.get("code")),
                    "side": side,
                    "quantity": float(dealt),
                    "price": float(row["dealt_avg_price"])
                    if clean(row.get("dealt_avg_price")) else 0,
                    "currency": (clean(row.get("currency")) or "HKD").upper(),
                    "tradeDate": ymd(clean(row.get("create_time")) or ""),
                    "orderId": str(row.get("order_id") or ""),
                })
            # Drop zero-price rows (shouldn't happen, but the schema
            # requires a positive price).
            trades = [t for t in trades if t["price"] > 0]

            total_positions += len(positions)
            total_trades += len(trades)
            payload_accounts.append({
                "accountId": acc_id,
                "positions": positions,
                "trades": trades,
            })
            print(f"  account {acc_id}: {len(positions)} positions, "
                  f"{len(trades)} trades (last {HISTORY_DAYS}d)")

        payload = {"version": INGEST_VERSION, "accounts": payload_accounts}
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{HOLDR_URL}/api/futu/ingest",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {HOLDR_SYNC_TOKEN}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            # Try to surface the server's error JSON for debuggability.
            detail = ""
            if hasattr(e, "read"):
                try:
                    detail = f": {e.read().decode('utf-8')[:300]}"
                except Exception:  # noqa: BLE001
                    pass
            fail(f"Holdr rejected the ingest{detail} ({e})", 4)

        print(f"ingested: {result.get('positions', total_positions)} positions, "
              f"{result.get('trades', total_trades)} trades across "
              f"{result.get('accounts', len(payload_accounts))} account(s)")
    finally:
        trd_ctx.close()


if __name__ == "__main__":
    # Helpful fingerprint: MD5 of the trade password is expected, not the
    # password itself — catch the common mistake early.
    pwd = os.environ.get("FUTU_TRADE_PWD", "")
    if pwd and not FUTU_TRADE_PWD_MD5:
        print("warn: FUTU_TRADE_PWD looks like a plaintext password; "
              "set FUTU_TRADE_PWD_MD5 to its MD5 instead "
              "(printf %s 'pwd' | md5sum)", file=sys.stderr)
    main()
