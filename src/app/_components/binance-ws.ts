/**
 * Binance WebSocket API client for the browser-side sync.
 *
 * Why WebSocket instead of REST:
 * - Binance's CDN geo/WAF-blocks api.binance.com from Cloudflare Workers
 *   egress IPs, so the server can't call it at all.
 * - Signed REST calls from a browser need the custom `X-MBX-APIKEY` header,
 *   whose CORS preflight (OPTIONS) Binance does not answer — the fetch dies
 *   with a TypeError before any request is sent.
 * - The WebSocket handshake has no CORS preflight, and WS API auth travels
 *   inside JSON params, so this route works where both others fail.
 *
 * Auth note (verified against the official Binance docs,
 * developers.binance.com/docs/binance-spot-api-docs/websocket-api):
 * `session.logon` supports ONLY Ed25519 keys, so the user's
 * system-generated HMAC key CANNOT use it. Instead every signed request
 * carries its own apiKey/timestamp/signature params (per-request signing),
 * which accepts HMAC-SHA256 — the same signing as REST.
 *
 * Timestamp note: phones drift. Before signing, we query Binance's own
 * server time over the same socket (public `time` method) and sign with
 * THAT timestamp, so device clock skew can't produce -1021
 * "Timestamp for this request is outside of the recvWindow" errors. If the
 * time query fails, we fall back to the device clock and still attempt the
 * sync, with a wide recvWindow as belt-and-braces.
 *
 * The API secret is used here only as the HMAC key and never leaves the
 * device except inside the signed messages addressed to Binance itself.
 * No key material is ever logged.
 */

export const BINANCE_WS_URL = "wss://ws-api.binance.com:443/ws-api/v3";

/** Overall timeout for one full sync round-trip. */
export const BINANCE_WS_TIMEOUT_MS = 20_000;

/**
 * How long we wait for the server-time query before falling back to the
 * device clock. The time query is one cheap round-trip; 8s is generous.
 */
export const BINANCE_WS_TIME_TIMEOUT_MS = 8_000;

/**
 * recvWindow for the signed account.status request. The docs recommend a
 * small recvWindow (<=5000) for trading for timing security; this is a
 * read-only balance query, and the wide window is deliberate belt-and-braces
 * against residual skew after syncing to Binance server time.
 * Maximum allowed by Binance: 60000.
 */
export const BINANCE_WS_RECV_WINDOW_MS = 60_000;

/** Request ids — unique per connection; used to correlate responses. */
export const BINANCE_WS_TIME_ID = "binance-ws-time";
export const BINANCE_WS_ACCOUNT_ID = "binance-ws-account-status";
export const BINANCE_WS_TICKERS_ID = "binance-ws-ticker-price";

/**
 * Canonical signature payload: parameters sorted by key, joined as
 * `key=value` pairs with `&` (the signature itself excluded). Matches the
 * official "Request security" construction for HMAC keys, e.g.
 * `apiKey=<key>&recvWindow=60000&timestamp=<ms>`.
 */
export function signedRequestPayload(
  params: Record<string, string | number>,
): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

export interface BinanceWsRequest {
  id: string;
  method: string;
  params: Record<string, string | number>;
}

/**
 * Public `time` request — no auth. Response result: `{ serverTime: <ms> }`.
 */
export function buildTimeRequest(): BinanceWsRequest {
  return { id: BINANCE_WS_TIME_ID, method: "time", params: {} };
}

/** Pull a finite millisecond serverTime out of a `time` response, or null. */
export function extractServerTime(resp: BinanceWsResponse): number | null {
  if (typeof resp.result !== "object" || resp.result === null) return null;
  const t = (resp.result as Record<string, unknown>).serverTime;
  return typeof t === "number" && Number.isFinite(t) ? t : null;
}

/**
 * Signed `account.status` request. Its `result` has the same shape as
 * REST GET /api/v3/account (a `balances` array), so the server-side
 * valuation pipeline is reused unchanged.
 */
export function buildAccountStatusRequest(
  apiKey: string,
  signature: string,
  timestamp: number,
  recvWindow: number = BINANCE_WS_RECV_WINDOW_MS,
): BinanceWsRequest {
  return {
    id: BINANCE_WS_ACCOUNT_ID,
    method: "account.status",
    params: { apiKey, signature, recvWindow, timestamp },
  };
}

/**
 * Public `ticker.price` request — needs no auth. Its `result` is the same
 * [{symbol, price}] array as REST GET /api/v3/ticker/price.
 */
export function buildTickerPriceRequest(): BinanceWsRequest {
  return { id: BINANCE_WS_TICKERS_ID, method: "ticker.price", params: {} };
}

export interface BinanceWsResponse {
  id: string;
  status: number;
  result?: unknown;
  error?: { code: number; msg: string };
}

/** Parse one raw WS frame into a response, or null if it isn't a response. */
export function parseWsResponse(raw: unknown): BinanceWsResponse | null {
  if (typeof raw !== "string") return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.status !== "number") return null;
  const out: BinanceWsResponse = { id: d.id, status: d.status };
  if ("result" in d) out.result = d.result;
  if (typeof d.error === "object" && d.error !== null) {
    const e = d.error as Record<string, unknown>;
    if (typeof e.code === "number" && typeof e.msg === "string") {
      out.error = { code: e.code, msg: e.msg };
    }
  }
  return out;
}

/** User-facing message for a WS error response. */
export function wsErrorMessage(resp: BinanceWsResponse): string {
  const msg = resp.error?.msg?.trim();
  const detail = msg ? msg : `request failed (status ${resp.status})`;
  return `Binance: ${detail.slice(0, 200)}`;
}

export type BinanceWsSyncResult =
  | { ok: true; accountJson: unknown; tickersJson: unknown }
  | { ok: false; error: string };

/**
 * HMAC-SHA256 hex signer for the canonical payload. Kept OUTSIDE this module
 * on purpose: the caller owns the API secret and injects the signing, so key
 * material never enters this file's scope.
 */
export type BinanceWsSignFn = (payload: string) => Promise<string>;

/**
 * One full sync round trip over a single WebSocket: time (public) →
 * account.status (signed, per-request) → ticker.price (public). The account
 * request is signed with Binance's own server time when available, falling
 * back to the device clock. Resolves with the raw `result` payloads — the
 * same shapes the REST flow used to POST — or with a user-facing error
 * string. The socket is always closed on completion or failure. No
 * session.logon is used (it is Ed25519-only), so there is no session to log
 * out of — closing the socket is enough.
 */
export function syncBinanceViaWs(args: {
  apiKey: string;
  sign: BinanceWsSignFn;
  timeoutMs?: number;
  /** @internal — exposed so tests can shorten the time-query fallback. */
  timeTimeoutMs?: number;
}): Promise<BinanceWsSyncResult> {
  const timeoutMs = args.timeoutMs ?? BINANCE_WS_TIMEOUT_MS;
  const timeTimeoutMs = args.timeTimeoutMs ?? BINANCE_WS_TIME_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    let timeResolved = false; // the time step finished (server or fallback)
    let accountJson: unknown;
    let ws: WebSocket;

    const fail = (error: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(timeTimer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error });
    };

    const timer = setTimeout(() => {
      fail("Binance didn't answer within 20 seconds — try again.");
    }, timeoutMs);

    /** Sign with the resolved timestamp and send account.status. Runs once. */
    const proceedWithTimestamp = async (timestamp: number) => {
      if (done || timeResolved) return;
      timeResolved = true;
      clearTimeout(timeTimer);
      const payload = signedRequestPayload({
        apiKey: args.apiKey,
        recvWindow: BINANCE_WS_RECV_WINDOW_MS,
        timestamp,
      });
      let signature: string;
      try {
        signature = await args.sign(payload);
      } catch {
        fail(
          "Couldn't sign the request in this browser (WebCrypto unavailable).",
        );
        return;
      }
      if (done) return;
      ws.send(
        JSON.stringify(
          buildAccountStatusRequest(args.apiKey, signature, timestamp),
        ),
      );
    };

    // If the time query doesn't answer in time, fall back to the device
    // clock and still attempt the sync.
    const timeTimer = setTimeout(() => {
      void proceedWithTimestamp(Date.now());
    }, timeTimeoutMs);

    try {
      ws = new WebSocket(BINANCE_WS_URL);
    } catch {
      fail(
        "Couldn't open a live connection to Binance from this browser. Your network may block it.",
      );
      return;
    }

    ws.onopen = () => {
      ws.send(JSON.stringify(buildTimeRequest()));
    };

    ws.onerror = () => {
      fail(
        "Couldn't open a live connection to Binance from this browser. Your network may block it.",
      );
    };

    ws.onclose = () => {
      // A close before we finished means the handshake or connection died
      // early (network block, rejected origin, geo-block...). Our own
      // close after success is a no-op here because `done` is set.
      fail(
        "Couldn't open a live connection to Binance from this browser. Your network may block it.",
      );
    };

    ws.onmessage = (ev) => {
      const resp = parseWsResponse(ev.data);
      if (!resp) return; // ignore non-response frames
      if (resp.id === BINANCE_WS_TIME_ID) {
        if (resp.status !== 200) {
          // Failed time query — fall back to the device clock immediately
          // instead of waiting for the time timer.
          void proceedWithTimestamp(Date.now());
          return;
        }
        void proceedWithTimestamp(extractServerTime(resp) ?? Date.now());
        return;
      }
      if (resp.id === BINANCE_WS_ACCOUNT_ID) {
        if (resp.status !== 200 || resp.result === undefined) {
          fail(wsErrorMessage(resp));
          return;
        }
        accountJson = resp.result;
        ws.send(JSON.stringify(buildTickerPriceRequest()));
      } else if (resp.id === BINANCE_WS_TICKERS_ID) {
        if (resp.status !== 200 || resp.result === undefined) {
          fail(wsErrorMessage(resp));
          return;
        }
        if (done) return;
        done = true;
        clearTimeout(timer);
        const tickersJson: unknown = resp.result;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve({ ok: true, accountJson, tickersJson });
      }
      // Unknown ids are ignored; the timeout guards a stuck flow.
    };
  });
}
