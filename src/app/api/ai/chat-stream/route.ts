import { NextRequest } from "next/server";

import { buildChatMessages } from "~/server/ai-chat";
import {
  chatWithProviderStream,
  normalizeProvider,
} from "~/server/ai-providers";
import { normalizeLocale } from "~/server/ai";
import { chatInputSchema } from "~/server/api/routers/ai";

/**
 * Streaming AI chat via Server-Sent Events.
 * POST JSON body with the same shape as the tRPC ai.chat input
 * (validated by the shared chatInputSchema).
 * Returns text/event-stream with `data: <token>` lines.
 */
export async function POST(req: NextRequest) {
  const parsed = chatInputSchema.safeParse(
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
        const messages = buildChatMessages({
          question: body.question,
          history: body.history ?? [],
          portfolio: body.portfolio,
          locale: normalizeLocale(body.locale),
          provider: body.provider ?? "cloudflare",
          apiKey: body.apiKey ?? null,
          skills: body.skills ?? [],
          tone: body.tone ?? "analyst",
          length: body.length ?? "medium",
          temperature: body.temperature ?? 0.7,
          maxTokens: body.maxTokens ?? 1000,
          model: body.model ?? null,
          emojis: body.emojis ?? true,
          followUps: body.followUps ?? true,
        });
        const gen = chatWithProviderStream(
          normalizeProvider(body.provider),
          messages,
          body.apiKey ?? null,
          {
            temperature: body.temperature,
            maxTokens: body.maxTokens,
            model: body.model ?? undefined,
          },
        );
        for await (const chunk of gen) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
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
