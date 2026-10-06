import { NextRequest } from "next/server";
import { z } from "zod";

import { generateInsightsStream, normalizeLocale } from "~/server/ai";

/**
 * Streaming portfolio insights via Server-Sent Events.
 * POST JSON body with the same shape as the tRPC portfolio.insights input
 * (plus locale). Returns text/event-stream with `data: <token>` lines
 * (each token is a JSON-encoded string), terminated by `data: [DONE]`.
 * Failures arrive as `data: {"error": "<message>"}`.
 */
const positionSchema = z.object({
  symbol: z.string().max(12),
  marketValue: z.number(),
  totalPL: z.number(),
  totalPLPct: z.number().nullable(),
  dayPL: z.number().nullable(),
  weightPct: z.number(),
});

const insightsStreamSchema = z.object({
  positions: z.array(positionSchema).max(200),
  totals: z.object({
    marketValue: z.number(),
    dayPL: z.number().nullable(),
    totalPL: z.number(),
    totalPLPct: z.number().nullable(),
  }),
  recentTrades: z
    .array(
      z.object({
        symbol: z.string().max(12),
        type: z.string().max(4),
        quantity: z.number(),
        price: z.number(),
        date: z.string().max(10),
      }),
    )
    .max(10)
    .default([]),
  locale: z.string().default("en"),
});

export async function POST(req: NextRequest) {
  const parsed = insightsStreamSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return new Response("Invalid request", { status: 400 });
  }
  const body = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Keep the prompt bounded even if a client sends the max.
        const positions = [...body.positions]
          .sort((a, b) => b.marketValue - a.marketValue)
          .slice(0, 200);
        const gen = generateInsightsStream({
          positions,
          totals: body.totals,
          recentTrades: body.recentTrades,
          locale: normalizeLocale(body.locale),
        });
        for await (const token of gen) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(token)}\n\n`),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "AI_ERROR";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
        );
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
