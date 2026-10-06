import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * AI providers for the chat. Cloudflare Workers AI is built-in (no key).
 * OpenAI / Anthropic are BYOK — the key travels with the request and is
 * never stored server-side.
 */

export const PROVIDERS = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Workers AI — free, no key needed",
    needsKey: false,
    models: [
      { id: "@cf/qwen/qwen3-30b-a3b-fp8", name: "Qwen 3 30B" },
      { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B" },
      { id: "@cf/meta/llama-3.1-8b-instruct", name: "Llama 3.1 8B" },
      { id: "@cf/mistral/mistral-7b-instruct-v0.2", name: "Mistral 7B" },
      { id: "@cf/qwen/qwen2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B" },
      {
        id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        name: "DeepSeek R1 Distill 32B",
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "Needs your API key",
    needsKey: true,
    models: [
      { id: "gpt-4o-mini", name: "GPT-4o mini" },
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "o4-mini", name: "o4 mini" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Needs your API key",
    needsKey: true,
    models: [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
      { id: "claude-3-5-haiku-20241022", name: "Claude Haiku 3.5" },
      { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    ],
  },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

export function normalizeProvider(v: unknown): ProviderId {
  return typeof v === "string" &&
    (PROVIDERS as readonly { id: string }[]).some((p) => p.id === v)
    ? (v as ProviderId)
    : "cloudflare";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResult {
  text: string;
}

export interface ChatOptions {
  model?: string;
  /** 0 = precise/factual, 1 = creative. */
  temperature?: number;
  maxTokens?: number;
}

function clamp(n: number | undefined, min: number, max: number, fallback: number) {
  if (typeof n !== "number" || Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Cloudflare Workers AI via the production binding. */
async function chatCloudflare(
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<ChatResult> {
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
  if (!ai) throw new Error("no-binding");

  const model =
    opts.model ?? "@cf/qwen/qwen3-30b-a3b-fp8";
  const res = (await ai.run(model, {
    messages,
    max_tokens: clamp(opts.maxTokens, 100, 4000, 1000),
    temperature: clamp(opts.temperature, 0, 1, 0.7),
  })) as { response?: unknown };
  const text = typeof res?.response === "string" ? res.response.trim() : "";
  if (!text) throw new Error("ai-error");
  return { text };
}

/**
 * Cloudflare Workers AI streaming via the production binding.
 * Yields raw text tokens as the model produces them (`stream: true`
 * returns an SSE stream of `data: {"response": "<token>"}` events).
 */
async function* streamCloudflare(
  messages: ChatMessage[],
  opts: ChatOptions,
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
  if (!ai) throw new Error("no-binding");

  const model = opts.model ?? "@cf/qwen/qwen3-30b-a3b-fp8";
  const stream = await ai.run(model, {
    messages,
    max_tokens: clamp(opts.maxTokens, 100, 4000, 1000),
    temperature: clamp(opts.temperature, 0, 1, 0.7),
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

/** OpenAI chat completions (BYOK). */
async function chatOpenAI(
  messages: ChatMessage[],
  apiKey: string,
  opts: ChatOptions,
): Promise<ChatResult> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model ?? "gpt-4o-mini",
      messages,
      max_tokens: clamp(opts.maxTokens, 100, 4000, 1000),
      temperature: clamp(opts.temperature, 0, 2, 0.7),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai-${res.status}: ${body.slice(0, 120)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("ai-error");
  return { text };
}

/** Anthropic messages API (BYOK). System prompt goes in `system`. */
async function chatAnthropic(
  messages: ChatMessage[],
  apiKey: string,
  opts: ChatOptions,
): Promise<ChatResult> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-4-20250514",
      max_tokens: clamp(opts.maxTokens, 100, 4000, 1000),
      temperature: clamp(opts.temperature, 0, 1, 0.7),
      system: system || undefined,
      messages: rest,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`anthropic-${res.status}: ${body.slice(0, 120)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text =
    json.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim() ?? "";
  if (!text) throw new Error("ai-error");
  return { text };
}

/** Parse SSE stream and yield content deltas. */
async function* parseSse(
  res: Response,
  extract: (data: string) => string | null,
): AsyncGenerator<string, void, unknown> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") return;
        const chunk = extract(data);
        if (chunk) yield chunk;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** OpenAI streaming via SSE. */
async function* streamOpenAI(
  messages: ChatMessage[],
  apiKey: string,
  opts: ChatOptions,
): AsyncGenerator<string, void, unknown> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model ?? "gpt-4o-mini",
      messages,
      max_tokens: clamp(opts.maxTokens, 100, 4000, 1000),
      temperature: clamp(opts.temperature, 0, 2, 0.7),
      stream: true,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai-${res.status}: ${body.slice(0, 120)}`);
  }
  yield* parseSse(res, (data) => {
    try {
      const j = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      return j.choices?.[0]?.delta?.content ?? null;
    } catch {
      return null;
    }
  });
}

/** Anthropic streaming via SSE. */
async function* streamAnthropic(
  messages: ChatMessage[],
  apiKey: string,
  opts: ChatOptions,
): AsyncGenerator<string, void, unknown> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-4-20250514",
      max_tokens: clamp(opts.maxTokens, 100, 4000, 1000),
      temperature: clamp(opts.temperature, 0, 1, 0.7),
      system: system || undefined,
      messages: rest,
      stream: true,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`anthropic-${res.status}: ${body.slice(0, 120)}`);
  }
  yield* parseSse(res, (data) => {
    try {
      const j = JSON.parse(data) as {
        type?: string;
        delta?: { type?: string; text?: string };
      };
      if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
        return j.delta.text ?? null;
      }
      return null;
    } catch {
      return null;
    }
  });
}

/**
 * Route a chat to the selected provider. The apiKey is used transiently
 * for this call only — never persisted.
 */
export async function chatWithProvider(
  provider: ProviderId,
  messages: ChatMessage[],
  apiKey?: string | null,
  opts?: ChatOptions,
): Promise<ChatResult> {
  const o = opts ?? {};
  if (provider === "openai") {
    if (!apiKey) throw new Error("openai-needs-key");
    return chatOpenAI(messages, apiKey, o);
  }
  if (provider === "anthropic") {
    if (!apiKey) throw new Error("anthropic-needs-key");
    return chatAnthropic(messages, apiKey, o);
  }
  return chatCloudflare(messages, o);
}

/** Streaming variant — yields text chunks as they arrive. */
export async function* chatWithProviderStream(
  provider: ProviderId,
  messages: ChatMessage[],
  apiKey?: string | null,
  opts?: ChatOptions,
): AsyncGenerator<string, void, unknown> {
  const o = opts ?? {};
  if (provider === "openai") {
    if (!apiKey) throw new Error("openai-needs-key");
    yield* streamOpenAI(messages, apiKey, o);
    return;
  }
  if (provider === "anthropic") {
    if (!apiKey) throw new Error("anthropic-needs-key");
    yield* streamAnthropic(messages, apiKey, o);
    return;
  }
  // Cloudflare: true token streaming via Workers AI.
  yield* streamCloudflare(messages, o);
}
