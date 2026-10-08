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

describe("fetchFlexPositions request shape", () => {
  it("sends a plain SendRequest with no fd/td overrides (IBKR caps overrides at 365 days; a wider range gets 1018)", async () => {
    const urls = mockFetch((url) =>
      url.includes("/SendRequest?") ? okSend("REF1") : emptyStatement,
    );
    await fetchFlexPositions("tok", "qid", { pollMs: 1, maxAttempts: 1 });
    const sends = urls.filter((u) => u.includes("/SendRequest?"));
    expect(sends).toHaveLength(1);
    expect(sends[0]).not.toContain("fd=");
    expect(sends[0]).not.toContain("td=");
  });

  it("a 1018 rate limit surfaces immediately with exactly one SendRequest", async () => {
    const urls = mockFetch((url) =>
      url.includes("/SendRequest?")
        ? errSend("1018", "Request rate limit exceeded")
        : emptyStatement,
    );
    await expect(
      fetchFlexPositions("tok", "qid", { pollMs: 1, maxAttempts: 1 }),
    ).rejects.toThrow("1018");
    // Exactly one SendRequest: no retry burning a 2nd call.
    const sends = urls.filter((u) => u.includes("/SendRequest?"));
    expect(sends).toHaveLength(1);
  });
});
