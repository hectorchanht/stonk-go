import {
  normalizeLocale,
  type AiLocale,
  type InsightInput,
} from "~/server/ai";
import { normalizeSkills, SKILLS } from "~/server/ai-skills";
import {
  normalizeLength,
  normalizeTone,
  LENGTHS,
  TONES,
} from "~/server/ai-tones";
import {
  chatWithProvider,
  normalizeProvider,
  type ChatMessage,
  type ProviderId,
} from "~/server/ai-providers";

export interface ChatInput {
  question: string;
  /** Prior conversation turns (user/assistant only). */
  history: { role: "user" | "assistant"; content: string }[];
  portfolio: InsightInput;
  locale: string;
  provider: string;
  /** BYOK key — used transiently, never stored. */
  apiKey?: string | null;
  skills: string[];
  tone: string;
  length: string;
  /** 0 = precise, 1 = creative. */
  temperature: number;
  maxTokens: number;
  model?: string | null;
  /** Allow emojis in replies. */
  emojis: boolean;
  /** End replies with suggested follow-up questions. */
  followUps: boolean;
}

const BASE_PROMPT: Record<AiLocale, string> = {
  en:
    "You answer questions about the user's stock portfolio. " +
    "Use the portfolio snapshot below as ground truth. " +
    "All amounts are in USD unless noted.",
  "zh-Hant":
    "你負責答 user 關於佢股票組合嘅問題。" +
    "下面嗰份組合 snapshot 係事實根據。" +
    "金額全部係 USD，除非另有註明。",
  "zh-Hans":
    "你负责回答用户关于其股票组合的问题。" +
    "下方组合快照为事实依据。" +
    "金额均为 USD，除非另有注明。",
};

/**
 * Explicit reply-language directive. The tone/skill prompts are already
 * written in the target language, but some models (notably Qwen on
 * Workers AI) still default to English for financial analysis without
 * an explicit instruction — this fixes "AI set to 繁 but replies in EN".
 */
const LOCALE_DIRECTIVE: Record<AiLocale, string> = {
  en: "Reply in English.",
  "zh-Hant": "全程用繁體中文（廣東話口語）回答，唔好用英文。",
  "zh-Hans": "全程用简体中文回答，不要用英文。",
};

const EMOJI_PROMPT: Record<AiLocale, string> = {
  en: "Do not use emojis.",
  "zh-Hant": "唔好用 emoji。",
  "zh-Hans": "不要用 emoji。",
};

const FOLLOWUP_PROMPT: Record<AiLocale, string> = {
  en: "End your reply with 2-3 suggested follow-up questions the user might ask next, each on its own line.",
  "zh-Hant":
    "答完之後，用繁體中文（廣東話口語）加 2-3 條 user 可能會想問嘅 follow-up 問題，每條一行，唔好用英文標題。",
  "zh-Hans":
    "答完后，用简体中文加 2-3 条用户可能想问的后续问题，每条一行，不要用英文标题。",
};

function buildPortfolioContext(input: InsightInput): string {
  const pos = input.positions
    .map(
      (p) =>
        `- ${p.symbol}: $${p.marketValue.toFixed(0)} (${p.weightPct.toFixed(1)}%), ` +
        `P/L $${p.totalPL.toFixed(0)}` +
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
    `.\n\nPositions:\n${pos}\n\nRecent trades:\n${trades}`
  );
}

function buildSystemPrompt(input: ChatInput, locale: AiLocale): string {
  const tone = TONES.find((t) => t.id === normalizeTone(input.tone)) ?? TONES[0]!;
  const length = LENGTHS.find((l) => l.id === normalizeLength(input.length)) ?? LENGTHS[0]!;
  const skillIds = normalizeSkills(input.skills);
  const skills = SKILLS.filter((s) => skillIds.includes(s.id));

  const parts = [
    BASE_PROMPT[locale],
    LOCALE_DIRECTIVE[locale],
    tone.prompt[locale],
    length.instruction[locale],
    ...skills.map((s) => s.prompt[locale]),
  ];
  if (!input.emojis) parts.push(EMOJI_PROMPT[locale]);
  if (input.followUps) parts.push(FOLLOWUP_PROMPT[locale]);

  return (
    `${parts.join(" ")}\n\n` +
    `Portfolio snapshot:\n${buildPortfolioContext(input.portfolio)}`
  );
}

/** Build the message array for a chat request (shared by chat + stream). */
export function buildChatMessages(input: ChatInput): ChatMessage[] {
  const locale = normalizeLocale(input.locale);
  const system = buildSystemPrompt(input, locale);
  return [
    { role: "system", content: system },
    ...input.history.slice(-10).map((h) => ({
      role: h.role,
      content: h.content.slice(0, 2000),
    })),
    { role: "user", content: input.question.slice(0, 2000) },
  ];
}

export async function chat(input: ChatInput): Promise<{ text: string }> {
  const provider: ProviderId = normalizeProvider(input.provider);
  const messages = buildChatMessages(input);

  const { text } = await chatWithProvider(
    provider,
    messages,
    input.apiKey?.trim() ?? null,
    {
      model: input.model?.trim() ?? undefined,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    },
  );
  return { text };
}
