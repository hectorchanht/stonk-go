import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchFlexPositions } from "./ibkr";

const okSend = (ref: string) =>
  `<FlexStatementResponse><Status>Success</Status><ReferenceCode>${ref}</ReferenceCode></FlexStatementResponse>`;
const errSend = (code: string, msg: string) =>
  `<FlexStatementResponse><Status>Failure</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>${msg}</ErrorMessage></FlexStatementResponse>`;
const emptyStatement = `<?xml version="1.0"?><FlexQueryResponse><FlexStatements count="0"></FlexStatements></FlexQueryResponse>`;

function mockFetch(handler: (url: string) => string) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, text: async () => handler(url) } as Response;
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchFlexPositions date range", () => {
  it("requests the full history via fd/td overrides on SendRequest", async () => {
    const urls = mockFetch((url) =>
      url.includes("/SendRequest?") ? okSend("REF1") : emptyStatement,
    );
    await fetchFlexPositions("tok", "qid", { pollMs: 1, maxAttempts: 1 });
    const send = urls.find((u) => u.includes("/SendRequest?"))!;
    expect(send).toContain("fd=20100101");
    const today = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const td = `${today.getFullYear()}${p(today.getMonth() + 1)}${p(today.getDate())}`;
    expect(send).toContain(`td=${td}`);
    // GetStatement polling must NOT carry the overrides.
    const get = urls.find((u) => u.includes("/GetStatement?"))!;
    expect(get).not.toContain("fd=");
  });

  it("falls back to the plain request when IBKR rejects the overrides", async () => {
    let calls = 0;
    const urls = mockFetch((url) => {
      if (!url.includes("/SendRequest?")) return emptyStatement;
      calls++;
      // First attempt (with fd/td) fails at the Flex level; retry without.
      return calls === 1 && url.includes("fd=")
        ? errSend("9999", "bad range")
        : okSend("REF2");
    });
    await fetchFlexPositions("tok", "qid", { pollMs: 1, maxAttempts: 1 });
    const sends = urls.filter((u) => u.includes("/SendRequest?"));
    expect(sends).toHaveLength(2);
    expect(sends[0]).toContain("fd=");
    expect(sends[1]).not.toContain("fd=");
  });

  it("does NOT fall back on rate limit (1018) — surfaces immediately", async () => {
    const urls = mockFetch((url) =>
      url.includes("/SendRequest?")
        ? errSend("1018", "Request rate limit exceeded")
        : emptyStatement,
    );
    await expect(
      fetchFlexPositions("tok", "qid", { pollMs: 1, maxAttempts: 1 }),
    ).rejects.toThrow("1018");
    // Exactly one SendRequest: no plain-request retry burning a 2nd call.
    const sends = urls.filter((u) => u.includes("/SendRequest?"));
    expect(sends).toHaveLength(1);
  });
});
