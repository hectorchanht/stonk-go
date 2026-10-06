import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Portfolio insights via Cloudflare Workers AI (no API key needed —
 * billed to the Cloudflare account through the AI binding).
 *
 * The binding only exists in production (wrangler.jsonc `ai` binding).
 * Every access is guarded: without it we return { unavailable: true }
 * and the UI degrades gracefully.
 */

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Locales the AI can reply in. The code is client-chosen (see
 * ~/app/_components/locale.tsx) and allowlist-validated — it only selects
 * among these pre-written prompts, never interpolates user text.
 */
export const SUPPORTED_LOCALES = ["en", "zh-Hant", "zh-Hans"] as const;
export type AiLocale = (typeof SUPPORTED_LOCALES)[number];

export function normalizeLocale(v: unknown): AiLocale {
  return typeof v === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(v)
    ? (v as AiLocale)
    : "en";
}

export interface InsightPosition {
  symbol: string;
  marketValue: number;
  totalPL: number;
  totalPLPct: number | null;
  dayPL: number | null;
  weightPct: number;
}

export interface InsightInput {
  positions: InsightPosition[];
  totals: {
    marketValue: number;
    dayPL: number | null;
    totalPL: number;
    totalPLPct: number | null;
  };
  recentTrades: {
    symbol: string;
    type: string;
    quantity: number;
    price: number;
    date: string;
  }[];
  /** Reply language for the insights. Validated against SUPPORTED_LOCALES. */
  locale: string;
}

const SYSTEM_PROMPTS: Record<AiLocale, string> = {
  en:
    "You are a sharp, plain-spoken portfolio analyst with a dash of WallStreetBets humor. " +
    "You analyze a stock portfolio snapshot (all amounts in USD) and give short, genuinely useful insights. " +
    "Cover: concentration risk, the biggest winners/losers and what likely drove them, today's notable movers, " +
    "and ONE concrete suggestion. Each bullet under 25 words. No disclaimers, no headings, no intro — just the bullets.",
  "zh-Hant":
    "你係一個把炮、講嘢直接嘅港式散戶組合分析師，識啲 WallStreetBets 式幽默。" +
    "你會分析一個股票組合 snapshot（金額全部係 USD），畀簡短但真係有用嘅見解。" +
    "內容覆蓋：集中風險、最大贏家／輸家同埋背後可能嘅原因、今日最搶眼嘅郁動，同埋一個具體建議。" +
    "每點唔超過 30 個中文字。唔要免責聲明、唔要標題、唔要開場白 — 直接畀 bullet points。" +
    "全程用繁體中文（廣東話口語）回答。",
  "zh-Hans":
    "你是一位犀利、说话直接的股票组合分析师，带一点 WallStreetBets 式的幽默。" +
    "你分析股票组合快照（金额均为 USD），给出简短但真正有用的见解。" +
    "覆盖：集中度风险、最大赢家／输家及其可能原因、今日最值得注意的异动，以及一个具体建议。" +
    "每条不超过 30 个汉字。不要免责声明、不要标题、不要开场白——直接给 bullet points。" +
    "全程用简体中文回答。",
};

const BULLET_TAIL: Record<AiLocale, string> = {
  en: `Give 4-6 bullets, each on its own line starting with "• ".`,
  "zh-Hant": "畀 4-6 點，每點一行，開頭用「• 」。",
  "zh-Hans": "给出 4-6 条，每条一行，开头用「• 」。",
};

function buildPrompt(input: InsightInput, locale: AiLocale): string {
  const pos = input.positions
    .map(
      (p) =>
        `- ${p.symbol}: $${p.marketValue.toFixed(0)} (${p.weightPct.toFixed(1)}% of portfolio), ` +
        `all-time P/L $${p.totalPL.toFixed(0)}` +
        (p.totalPLPct != null ? ` (${p.totalPLPct.toFixed(1)}%)` : "") +
        (p.dayPL != null ? `, today $${p.dayPL.toFixed(0)}` : ""),
    )
    .join("\n");
  const t = input.totals;
  const trades =
    input.recentTrades.length > 0
      ? input.recentTrades
          .map(
            (tr) =>
              `- ${tr.date} ${tr.type} ${tr.quantity} ${tr.symbol} @ $${tr.price.toFixed(2)}`,
          )
          .join("\n")
      : "(no recent trades)";
  return (
    `Portfolio: $${t.marketValue.toFixed(0)} total, ` +
    `today ${t.dayPL != null ? `$${t.dayPL.toFixed(0)}` : "n/a"}, ` +
    `all-time P/L $${t.totalPL.toFixed(0)}` +
    (t.totalPLPct != null ? ` (${t.totalPLPct.toFixed(1)}%)` : "") +
    `.\n\nPositions:\n${pos}\n\nRecent trades:\n${trades}\n\n` +
    BULLET_TAIL[locale]
  );
}

export async function generateInsights(
  input: InsightInput,
): Promise<{ text: string } | { unavailable: true; reason: string }> {
  type AiBinding = {
    run: (model: string, params: unknown) => Promise<unknown>;
  };
  let ai: AiBinding | null = null;
  try {
    const env = getCloudflareContext().env as { AI?: unknown };
    if (env.AI && typeof (env.AI as AiBinding).run === "function") {
      ai = env.AI as AiBinding;
    }
  } catch {
    ai = null;
  }
  if (!ai) return { unavailable: true, reason: "no-binding" };

  const locale = normalizeLocale(input.locale);
  try {
    const res = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPTS[locale] },
        { role: "user", content: buildPrompt(input, locale) },
      ],
      max_tokens: 700,
    })) as { response?: unknown };
    const text =
      typeof res?.response === "string" ? res.response.trim() : "";
    if (!text) return { unavailable: true, reason: "ai-error" };
    return { text };
  } catch (err) {
    console.error("[ai] insights generation failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return { unavailable: true, reason: `ai-error: ${msg.slice(0, 160)}` };
  }
}

/**
 * Streaming variant of generateInsights — yields raw text tokens as the
 * model produces them (Workers AI `stream: true` returns an SSE stream of
 * `data: {"response": "<token>"}` events).
 * Throws when the AI binding is missing or the stream yields nothing.
 */
export async function* generateInsightsStream(
  input: InsightInput,
): AsyncGenerator<string, void, unknown> {
  type AiBinding = {
    run: (
      model: string,
      params: unknown,
    ) => Promise<ReadableStream<Uint8Array>>;
  };
  let ai: AiBinding | null = null;
  try {
    const env = getCloudflareContext().env as { AI?: unknown };
    if (env.AI && typeof (env.AI as AiBinding).run === "function") {
      ai = env.AI as AiBinding;
    }
  } catch {
    ai = null;
  }
  if (!ai) throw new Error("AI unavailable (no binding)");

  const locale = normalizeLocale(input.locale);
  const stream = await ai.run(MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPTS[locale] },
      { role: "user", content: buildPrompt(input, locale) },
    ],
    max_tokens: 700,
    stream: true,
  });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let yielded = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Split on event boundaries; the trailing fragment stays buffered
      // so a JSON payload split across TCP chunks reassembles correctly.
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        for (const line of part.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            const json = JSON.parse(data) as { response?: unknown };
            if (typeof json.response === "string" && json.response) {
              yielded = true;
              yield json.response;
            }
          } catch {
            // Not a complete JSON event — skip it.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!yielded) throw new Error("ai-error: empty stream");
}
