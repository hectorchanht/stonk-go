import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BINANCE_WS_ACCOUNT_ID,
  BINANCE_WS_RECV_WINDOW_MS,
  BINANCE_WS_TICKERS_ID,
  BINANCE_WS_TIME_ID,
  BINANCE_WS_TIME_TIMEOUT_MS,
  BINANCE_WS_URL,
  buildAccountStatusRequest,
  buildTickerPriceRequest,
  buildTimeRequest,
  extractServerTime,
  parseWsResponse,
  signedRequestPayload,
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
