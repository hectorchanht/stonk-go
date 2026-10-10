import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { chat } from "~/server/ai-chat";
import { PROVIDERS } from "~/server/ai-providers";
import { SKILLS } from "~/server/ai-skills";
import { TONES, LENGTHS } from "~/server/ai-tones";

/**
 * AI chat + provider/skill/tone metadata. Public (no auth) like the rest
 * of the portfolio API — the portfolio snapshot comes from the client,
 * and BYOK keys travel per-request, never stored server-side.
 */

/** Shared input shape for AI chat — also used by /api/ai/chat-stream. */
export const chatInputSchema = z.object({
  question: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(4000),
      }),
    )
    .max(20)
    .default([]),
  portfolio: z.object({
    positions: z
      .array(
        z.object({
          symbol: z.string().max(16),
          marketValue: z.number(),
          totalPL: z.number(),
          totalPLPct: z.number().nullable(),
          dayPL: z.number().nullable(),
          weightPct: z.number(),
        }),
      )
      .max(60),
    totals: z.object({
      marketValue: z.number(),
      dayPL: z.number().nullable(),
      totalPL: z.number().nullable(),
      totalPLPct: z.number().nullable(),
    }),
    recentTrades: z
      .array(
        z.object({
          symbol: z.string().max(16),
          type: z.string().max(8),
          quantity: z.number(),
          price: z.number(),
          date: z.string().max(16),
        }),
      )
      .max(20),
    locale: z.string().max(16),
  }),
  locale: z.string().max(16),
  provider: z.string().max(32),
  apiKey: z.string().max(300).nullable().default(null),
  skills: z.array(z.string().max(32)).max(16).default([]),
  tone: z.string().max(32).default("analyst"),
  length: z.string().max(32).default("medium"),
  temperature: z.number().min(0).max(1).default(0.7),
  maxTokens: z.number().int().min(100).max(4000).default(1000),
  model: z.string().max(120).nullable().default(null),
  emojis: z.boolean().default(true),
  followUps: z.boolean().default(true),
});
export const aiRouter = createTRPCRouter({
  /** Available providers, models, tones, lengths and skills for settings UI. */
  meta: publicProcedure.query(() => ({
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      needsKey: p.needsKey,
      models: p.models.map((m) => ({ id: m.id, name: m.name })),
    })),
    tones: TONES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
    })),
    lengths: LENGTHS.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
    })),
    skills: SKILLS.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      defaultOn: s.defaultOn,
    })),
  })),

  /** Ask a question about the portfolio snapshot. */
  chat: publicProcedure
    .input(chatInputSchema)
    .mutation(async ({ input }) => {
      try {
        const { text } = await chat({
          question: input.question,
          history: input.history,
          portfolio: input.portfolio,
          locale: input.locale,
          provider: input.provider,
          apiKey: input.apiKey,
          skills: input.skills,
          tone: input.tone,
          length: input.length,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          model: input.model,
          emojis: input.emojis,
          followUps: input.followUps,
        });
        return { text };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Map internal errors to short codes the UI can explain.
        if (msg.includes("no-binding"))
          throw new Error("AI_UNAVAILABLE");
        if (msg.includes("needs-key")) throw new Error("NEEDS_API_KEY");
        if (msg.startsWith("openai-") || msg.startsWith("anthropic-"))
          throw new Error(`PROVIDER_ERROR: ${msg.slice(0, 160)}`);
        throw new Error("AI_ERROR");
      }
    }),
});
