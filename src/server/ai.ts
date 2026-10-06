import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Portfolio insights via Cloudflare Workers AI (no API key needed —
 * billed to the Cloudflare account through the AI binding).
 *
 * The binding only exists in production (wrangler.jsonc `ai` binding).
 * Every access is guarded: without it we return { unavailable: true }
 * and the UI degrades gracefully.
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

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
}

const SYSTEM_PROMPT =
  "You are a sharp, plain-spoken portfolio analyst with a dash of WallStreetBets humor. " +
  "You analyze a stock portfolio snapshot (all amounts in USD) and give short, genuinely useful insights. " +
  "Cover: concentration risk, the biggest winners/losers and what likely drove them, today's notable movers, " +
  "and ONE concrete suggestion. Each bullet under 25 words. No disclaimers, no headings, no intro — just the bullets.";

function buildPrompt(input: InsightInput): string {
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
    `Give 4-6 bullets, each on its own line starting with "• ".`
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

  try {
    const res = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(input) },
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
