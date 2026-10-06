import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BINANCE_WS_ACCOUNT_ID,
  BINANCE_WS_MYTRADES_LIMIT,
  BINANCE_WS_RECV_WINDOW_MS,
  BINANCE_WS_TICKERS_ID,
  BINANCE_WS_TIME_ID,
  BINANCE_WS_TIME_TIMEOUT_MS,
  BINANCE_WS_URL,
  buildAccountStatusRequest,
  buildMyTradesRequest,
  buildTickerPriceRequest,
  buildTimeRequest,
  binanceTradePairs,
  extractServerTime,
  lastTradeId,
  myTradesPayload,
  parseWsResponse,
  signedRequestPayload,
  syncBinanceMyTrades,
  syncBinanceViaWs,
  wsErrorMessage,
} from "./binance-ws";

describe("signedRequestPayload", () => {
  it("sorts params by key into a canonical query string", () => {
    expect(
      signedRequestPayload({ timestamp: 1660801839480, apiKey: "ABC" }),
    ).toBe("apiKey=ABC&timestamp=1660801839480");
  });

  it("includes recvWindow in alphabetical order", () => {
    expect(
      signedRequestPayload({
        timestamp: 1660801839480,
        recvWindow: 60000,
        apiKey: "ABC",
      }),
    ).toBe("apiKey=ABC&recvWindow=60000&timestamp=1660801839480");
  });

  it("excludes the signature itself from the payload", () => {
    expect(signedRequestPayload({ apiKey: "k", timestamp: 123 })).toBe(
      "apiKey=k&timestamp=123",
    );
  });
});

describe("buildTimeRequest", () => {
  it("is the public time method with no params", () => {
    expect(buildTimeRequest()).toEqual({
      id: BINANCE_WS_TIME_ID,
      method: "time",
      params: {},
    });
  });

  it("uses a different id than the other requests", () => {
    const ids = new Set([
      buildTimeRequest().id,
      buildAccountStatusRequest("k", "s", 1).id,
      buildTickerPriceRequest().id,
    ]);
    expect(ids.size).toBe(3);
  });
});

describe("extractServerTime", () => {
  it("pulls serverTime from a time response", () => {
    expect(
      extractServerTime({
        id: "x",
        status: 200,
        result: { serverTime: 1700000000000 },
      }),
    ).toBe(1700000000000);
  });

  it("returns null when serverTime is missing or not a number", () => {
    expect(extractServerTime({ id: "x", status: 200, result: {} })).toBeNull();
    expect(
      extractServerTime({
        id: "x",
        status: 200,
        result: { serverTime: "1700000000000" },
      }),
    ).toBeNull();
    expect(
      extractServerTime({
        id: "x",
        status: 200,
        result: { serverTime: Number.NaN },
      }),
    ).toBeNull();
    expect(extractServerTime({ id: "x", status: 200 })).toBeNull();
  });
});

describe("buildAccountStatusRequest", () => {
  it("produces the documented account.status message with recvWindow", () => {
    const msg = buildAccountStatusRequest("KEY", "SIG", 1660801839480);
    expect(typeof msg.id).toBe("string");
    expect(msg).toEqual({
      id: msg.id,
      method: "account.status",
      params: {
        apiKey: "KEY",
        signature: "SIG",
        recvWindow: BINANCE_WS_RECV_WINDOW_MS,
        timestamp: 1660801839480,
      },
    });
  });

  it("accepts a custom recvWindow", () => {
    const msg = buildAccountStatusRequest("KEY", "SIG", 1, 5000);
    expect(msg.params.recvWindow).toBe(5000);
  });

  it("uses a different id than the ticker request", () => {
    expect(buildAccountStatusRequest("k", "s", 1).id).not.toBe(
      buildTickerPriceRequest().id,
    );
  });
});

describe("buildTickerPriceRequest", () => {
  it("is an unsigned public request", () => {
    const req = buildTickerPriceRequest();
    expect(typeof req.id).toBe("string");
    expect(req).toEqual({
      id: req.id,
      method: "ticker.price",
      params: {},
    });
  });
});

describe("parseWsResponse", () => {
  it("parses a success response", () => {
    const r = parseWsResponse(
      JSON.stringify({ id: "x", status: 200, result: { balances: [] } }),
    );
    expect(r).toEqual({ id: "x", status: 200, result: { balances: [] } });
  });

  it("parses an error response", () => {
    const r = parseWsResponse(
      JSON.stringify({
        id: "x",
        status: 400,
        error: {
          code: -1021,
          msg: "Timestamp for this request is outside of the recvWindow.",
        },
      }),
    );
    expect(r?.error).toEqual({
      code: -1021,
      msg: "Timestamp for this request is outside of the recvWindow.",
    });
  });

  it("rejects garbage", () => {
    expect(parseWsResponse("not json")).toBeNull();
    expect(parseWsResponse(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(parseWsResponse(42)).toBeNull();
    expect(parseWsResponse(null)).toBeNull();
  });
});

describe("wsErrorMessage", () => {
  it("surfaces Binance's message", () => {
    expect(
      wsErrorMessage({
        id: "x",
        status: 400,
        error: {
          code: -2015,
          msg: "Invalid API-key, IP, or permissions for action.",
        },
      }),
    ).toBe("Binance: Invalid API-key, IP, or permissions for action.");
  });

  it("falls back when there is no message", () => {
    expect(wsErrorMessage({ id: "x", status: 500 })).toBe(
      "Binance: request failed (status 500)",
    );
  });

  it("caps long messages", () => {
    const long = "x".repeat(500);
    const msg = wsErrorMessage({
      id: "x",
      status: 400,
      error: { code: -1, msg: long },
    });
    expect(msg.length).toBeLessThanOrEqual("Binance: ".length + 200);
  });
});

describe("BINANCE_WS_URL", () => {
  it("uses the secure WS API host", () => {
    expect(BINANCE_WS_URL).toBe("wss://ws-api.binance.com:443/ws-api/v3");
  });
});

describe("time-sync constants", () => {
  it("uses a wide recvWindow and an 8s time fallback", () => {
    expect(BINANCE_WS_RECV_WINDOW_MS).toBe(60_000);
    expect(BINANCE_WS_TIME_TIMEOUT_MS).toBe(8_000);
  });
});

describe("syncBinanceViaWs time sync", () => {
  class FakeSocket {
    static instances: FakeSocket[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    sent: string[] = [];
    closed = false;
    constructor(public url: string) {
      FakeSocket.instances.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.closed = true;
    }
  }

  const realWebSocket = (globalThis as unknown as { WebSocket: unknown })
    .WebSocket;

  beforeEach(() => {
    FakeSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket =
      FakeSocket as unknown;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket =
      realWebSocket;
  });

  const answer = (ws: FakeSocket, id: string, result: unknown) => {
    ws.onmessage?.({ data: JSON.stringify({ id, status: 200, result }) });
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const firstSocket = (): FakeSocket => {
    const ws: FakeSocket | undefined = FakeSocket.instances[0];
    if (!ws) throw new Error("expected a WebSocket instance");
    return ws;
  };
  const sentAt = (ws: FakeSocket, i: number): string => {
    const s = ws.sent[i];
    if (s === undefined) throw new Error(`expected sent[${i}]`);
    return s;
  };

  it("sends the public time query first on open", async () => {
    const p = syncBinanceViaWs({
      apiKey: "K",
      sign: async () => "SIG",
      timeTimeoutMs: 5000,
    });
    const ws = firstSocket();
    ws.onopen?.();
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(sentAt(ws, 0))).toEqual({
      id: BINANCE_WS_TIME_ID,
      method: "time",
      params: {},
    });
    // Complete the flow so the promise resolves.
    answer(ws, BINANCE_WS_TIME_ID, { serverTime: 1700000000000 });
    await sleep(20);
    answer(ws, BINANCE_WS_ACCOUNT_ID, { balances: [] });
    answer(ws, BINANCE_WS_TICKERS_ID, []);
    await p;
  });

  it("signs the account request with Binance server time", async () => {
    const seen: string[] = [];
    const p = syncBinanceViaWs({
      apiKey: "KEY",
      sign: async (payload) => {
        seen.push(payload);
        return "SIG";
      },
      timeTimeoutMs: 5000,
    });
    const ws = firstSocket();
    ws.onopen?.();
    answer(ws, BINANCE_WS_TIME_ID, { serverTime: 1700000000000 });
    await sleep(20);
    expect(seen).toEqual([
      "apiKey=KEY&recvWindow=60000&timestamp=1700000000000",
    ]);
    const acct = JSON.parse(sentAt(ws, 1)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(acct.method).toBe("account.status");
    expect(acct.params).toMatchObject({
      apiKey: "KEY",
      signature: "SIG",
      recvWindow: 60000,
      timestamp: 1700000000000,
    });
    answer(ws, BINANCE_WS_ACCOUNT_ID, { balances: [] });
    answer(ws, BINANCE_WS_TICKERS_ID, [{ symbol: "BTCUSDT", price: "1" }]);
    const res = await p;
    expect(res).toEqual({
      ok: true,
      accountJson: { balances: [] },
      tickersJson: [{ symbol: "BTCUSDT", price: "1" }],
    });
    expect(ws.closed).toBe(true);
  });

  it("falls back to the device clock when the time query times out", async () => {
    const seen: string[] = [];
    const before = Date.now();
    const p = syncBinanceViaWs({
      apiKey: "K",
      sign: async (payload) => {
        seen.push(payload);
        return "S";
      },
      timeTimeoutMs: 30,
    });
    const ws = firstSocket();
    ws.onopen?.();
    await sleep(120); // let the 30ms time timer fire
    expect(seen).toHaveLength(1);
    const first = seen[0];
    if (first === undefined) throw new Error("expected a signed payload");
    const ts = Number(/timestamp=(\d+)/.exec(first)?.[1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
    answer(ws, BINANCE_WS_ACCOUNT_ID, { balances: [] });
    answer(ws, BINANCE_WS_TICKERS_ID, []);
    const res = await p;
    expect(res.ok).toBe(true);
  });

  it("ignores a late time response after the fallback fired", async () => {
    const p = syncBinanceViaWs({
      apiKey: "K",
      sign: async () => "S",
      timeTimeoutMs: 30,
    });
    const ws = firstSocket();
    ws.onopen?.();
    await sleep(120);
    const sentAfterFallback = ws.sent.length; // time + account
    answer(ws, BINANCE_WS_TIME_ID, { serverTime: 1700000000000 }); // late!
    await sleep(30);
    expect(ws.sent.length).toBe(sentAfterFallback);
    answer(ws, BINANCE_WS_ACCOUNT_ID, { balances: [] });
    answer(ws, BINANCE_WS_TICKERS_ID, []);
    await p;
  });

  it("falls back immediately when the time query errors", async () => {
    const seen: string[] = [];
    const p = syncBinanceViaWs({
      apiKey: "K",
      sign: async (payload) => {
        seen.push(payload);
        return "S";
      },
      timeTimeoutMs: 5000,
    });
    const ws = firstSocket();
    ws.onopen?.();
    ws.onmessage?.({
      data: JSON.stringify({
        id: BINANCE_WS_TIME_ID,
        status: 400,
        error: { code: -1, msg: "bad" },
      }),
    });
    await sleep(30);
    expect(seen).toHaveLength(1);
    // The pending time timer must not fire a second account request later.
    await sleep(80);
    expect(seen).toHaveLength(1);
    answer(ws, BINANCE_WS_ACCOUNT_ID, { balances: [] });
    answer(ws, BINANCE_WS_TICKERS_ID, []);
    await p;
  });

  it("reports a signing failure cleanly", async () => {
    const p = syncBinanceViaWs({
      apiKey: "K",
      sign: async () => {
        throw new Error("nope");
      },
      timeTimeoutMs: 5000,
    });
    const ws = firstSocket();
    ws.onopen?.();
    answer(ws, BINANCE_WS_TIME_ID, { serverTime: 1700000000000 });
    const res = await p;
    expect(res).toEqual({
      ok: false,
      error: "Couldn't sign the request in this browser (WebCrypto unavailable).",
    });
    expect(ws.closed).toBe(true);
  });
});

describe("buildMyTradesRequest", () => {
  it("builds a signed myTrades request with a unique id per page", () => {
    const r1 = buildMyTradesRequest("k", "sig", 123, "BTCUSDT", null);
    expect(r1.method).toBe("myTrades");
    expect(r1.id).toBe("binance-ws-mytrades:BTCUSDT:start");
    expect(r1.params).toMatchObject({
      apiKey: "k",
      signature: "sig",
      timestamp: 123,
      symbol: "BTCUSDT",
      limit: BINANCE_WS_MYTRADES_LIMIT,
    });
    expect(r1.params).not.toHaveProperty("fromId");

    const r2 = buildMyTradesRequest("k", "sig", 123, "BTCUSDT", 5001);
    expect(r2.id).toBe("binance-ws-mytrades:BTCUSDT:5001");
    expect(r2.params.fromId).toBe(5001);
    expect(r2.id).not.toBe(r1.id);
  });
});

describe("myTradesPayload", () => {
  it("covers every param (sorted) except the signature", () => {
    expect(myTradesPayload("k", 123, "BTCUSDT", null)).toBe(
      "apiKey=k&limit=1000&recvWindow=60000&symbol=BTCUSDT&timestamp=123",
    );
    expect(myTradesPayload("k", 123, "BTCUSDT", 42)).toBe(
      "apiKey=k&fromId=42&limit=1000&recvWindow=60000&symbol=BTCUSDT&timestamp=123",
    );
  });
});

describe("lastTradeId", () => {
  it("returns the largest numeric id", () => {
    expect(lastTradeId([{ id: 3 }, { id: 10 }, { id: 7 }])).toBe(10);
    expect(lastTradeId([])).toBeNull();
    expect(lastTradeId([{ noid: 1 }, { id: "x" }])).toBeNull();
  });
});

describe("syncBinanceMyTrades (mocked socket)", () => {
  const realWs = (globalThis as Record<string, unknown>).WebSocket;

  /** Minimal fake WebSocket: scripted incoming frames, records sent. */
  function mockSocket(frames: Array<Record<string, unknown>>) {
    const sent: string[] = [];
    let closed = false;
    let onopen: (() => void) | null = null;
    let onmessage: ((ev: { data: string }) => void) | null = null;
    const sock = {
      sent,
      close: () => {
        closed = true;
      },
      set onopen(f: () => void) {
        onopen = f;
      },
      set onmessage(f: (ev: { data: string }) => void) {
        onmessage = f;
      },
      send: (s: string) => {
        sent.push(s);
        // After each send, deliver the next scripted frame.
        const next = frames.shift();
        if (next && onmessage) {
          queueMicrotask(() =>
            onmessage!({ data: JSON.stringify(next) }),
          );
        }
      },
    };
    void closed;
    (globalThis as Record<string, unknown>).WebSocket = function (
      this: unknown,
      _url: string,
    ) {
      void this;
      void _url;
      queueMicrotask(() => onopen && onopen());
      return sock;
    } as unknown as typeof WebSocket;
    return sock;
  }

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = realWs;
  });

  it("fetches one page per symbol and resolves the raw rows", async () => {
    const t1 = { id: 1, symbol: "BTCUSDT", price: "60000", qty: "0.1", quoteQty: "6000", commission: "0", commissionAsset: "USDT", time: 1, isBuyer: true };
    const t2 = { id: 2, symbol: "ETHUSDT", price: "3000", qty: "1", quoteQty: "3000", commission: "0", commissionAsset: "USDT", time: 2, isBuyer: true };
    mockSocket([
      { id: BINANCE_WS_TIME_ID, status: 200, result: { serverTime: 1700000000000 } },
      { id: "binance-ws-mytrades:BTCUSDT:start", status: 200, result: [t1] },
      { id: "binance-ws-mytrades:ETHUSDT:start", status: 200, result: [t2] },
    ]);
    const res = await syncBinanceMyTrades({
      apiKey: "k",
      sign: async () => "sig",
      symbols: ["BTCUSDT", "ETHUSDT"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pairs).toHaveLength(2);
    expect(res.pairs[0]!.symbol).toBe("BTCUSDT");
    expect(res.pairs[0]!.trades).toEqual([t1]);
    expect(res.pairs[1]!.trades).toEqual([t2]);
  });

  it("paginates with fromId until a short page", async () => {
    const page1 = Array.from({ length: BINANCE_WS_MYTRADES_LIMIT }, (_, i) => ({ id: i + 1 }));
    const page2 = [{ id: BINANCE_WS_MYTRADES_LIMIT + 1 }];
    mockSocket([
      { id: BINANCE_WS_TIME_ID, status: 200, result: { serverTime: 1700000000000 } },
      { id: "binance-ws-mytrades:BTCUSDT:start", status: 200, result: page1 },
      { id: `binance-ws-mytrades:BTCUSDT:${BINANCE_WS_MYTRADES_LIMIT + 1}`, status: 200, result: page2 },
    ]);
    const res = await syncBinanceMyTrades({
      apiKey: "k",
      sign: async () => "sig",
      symbols: ["BTCUSDT"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pairs[0]!.trades).toHaveLength(BINANCE_WS_MYTRADES_LIMIT + 1);
  });

  it("skips a failed pair but keeps the others", async () => {
    mockSocket([
      { id: BINANCE_WS_TIME_ID, status: 200, result: { serverTime: 1700000000000 } },
      { id: "binance-ws-mytrades:BADUSDT:start", status: 400, error: { code: -1121, msg: "Invalid symbol." } },
      { id: "binance-ws-mytrades:BTCUSDT:start", status: 200, result: [{ id: 1 }] },
    ]);
    const res = await syncBinanceMyTrades({
      apiKey: "k",
      sign: async () => "sig",
      symbols: ["BADUSDT", "BTCUSDT"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pairs).toHaveLength(2);
    expect(res.pairs[0]!.error).toMatch(/Invalid symbol/);
    expect(res.pairs[0]!.trades).toEqual([]);
    expect(res.pairs[1]!.trades).toEqual([{ id: 1 }]);
  });

  it("aborts everything on a fatal (bad key) error", async () => {
    mockSocket([
      { id: BINANCE_WS_TIME_ID, status: 200, result: { serverTime: 1700000000000 } },
      { id: "binance-ws-mytrades:BTCUSDT:start", status: 400, error: { code: -2015, msg: "Invalid API-key." } },
    ]);
    const res = await syncBinanceMyTrades({
      apiKey: "k",
      sign: async () => "sig",
      symbols: ["BTCUSDT"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
  });

  it("resolves empty without opening work for no symbols", async () => {
    const res = await syncBinanceMyTrades({ apiKey: "k", sign: async () => "sig", symbols: [] });
    expect(res).toEqual({ ok: true, pairs: [] });
  });
});

describe("binanceTradePairs", () => {
  const account = {
    balances: [
      { asset: "BTC", free: "0.5", locked: "0" },
      { asset: "ETH", free: "10", locked: "0" },
      { asset: "USDT", free: "1500", locked: "0" },
      { asset: "SLP", free: "8109", locked: "0" }, // delisted: no USDT pair
      { asset: "ZERO", free: "0", locked: "0" }, // zero balance
    ],
  };
  const tickers = [{ symbol: "BTCUSDT" }, { symbol: "ETHUSDT" }, { symbol: "BNBUSDT" }];

  it("picks USDT pairs for non-zero, non-stable balances only", () => {
    expect(binanceTradePairs(account, tickers)).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("returns [] for garbage input", () => {
    expect(binanceTradePairs(null, tickers)).toEqual([]);
    expect(binanceTradePairs(account, null)).toEqual([]);
    expect(binanceTradePairs({}, [])).toEqual([]);
  });
});
