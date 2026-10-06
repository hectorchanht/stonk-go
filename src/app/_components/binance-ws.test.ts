import { describe, expect, it } from "vitest";

import {
  BINANCE_WS_URL,
  buildAccountStatusRequest,
  buildTickerPriceRequest,
  parseWsResponse,
  signedRequestPayload,
  wsErrorMessage,
} from "./binance-ws";

describe("signedRequestPayload", () => {
  it("sorts params by key into a canonical query string", () => {
    expect(
      signedRequestPayload({ timestamp: 1660801839480, apiKey: "ABC" }),
    ).toBe("apiKey=ABC&timestamp=1660801839480");
  });

  it("excludes the signature itself from the payload", () => {
    expect(signedRequestPayload({ apiKey: "k", timestamp: 123 })).toBe(
      "apiKey=k&timestamp=123",
    );
  });
});

describe("buildAccountStatusRequest", () => {
  it("produces the documented account.status message", () => {
    const msg = buildAccountStatusRequest("KEY", "SIG", 1660801839480);
    expect(typeof msg.id).toBe("string");
    expect(msg).toEqual({
      id: msg.id,
      method: "account.status",
      params: { apiKey: "KEY", signature: "SIG", timestamp: 1660801839480 },
    });
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
