"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle, Send, Settings2, Square } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { useLocale } from "~/app/_components/locale";
import { InfoTip, TypingDots } from "~/app/_components/ui";

type Summary = RouterOutputs["portfolio"]["summary"];
type AiMeta = RouterOutputs["ai"]["meta"];

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

const SETTINGS_KEY = "holdr.ai-chat-settings";
const HISTORY_KEY = "holdr.ai-chat-history";

interface ChatSettings {
  provider: string;
  apiKey: string;
  skills: string[];
  tone: string;
  length: string;
  temperature: number;
  maxTokens: number;
  model: string;
  emojis: boolean;
  followUps: boolean;
  /** Per-section locale override; empty = use global. */
  locale: string;
}

const DEFAULT_SETTINGS: ChatSettings = {
  provider: "cloudflare",
  apiKey: "",
  skills: [],
  tone: "analyst",
  length: "medium",
  temperature: 0.7,
  maxTokens: 1000,
  model: "",
  emojis: true,
  followUps: true,
  locale: "",
};

function loadSettings(defaultSkills: string[]): ChatSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<ChatSettings>;
      return {
        ...DEFAULT_SETTINGS,
        provider: typeof s.provider === "string" ? s.provider : DEFAULT_SETTINGS.provider,
        apiKey: typeof s.apiKey === "string" ? s.apiKey : DEFAULT_SETTINGS.apiKey,
        skills: Array.isArray(s.skills) ? s.skills : defaultSkills,
        tone: typeof s.tone === "string" ? s.tone : DEFAULT_SETTINGS.tone,
        length: typeof s.length === "string" ? s.length : DEFAULT_SETTINGS.length,
        temperature: typeof s.temperature === "number" ? s.temperature : DEFAULT_SETTINGS.temperature,
        maxTokens: typeof s.maxTokens === "number" ? s.maxTokens : DEFAULT_SETTINGS.maxTokens,
        model: typeof s.model === "string" ? s.model : DEFAULT_SETTINGS.model,
        emojis: typeof s.emojis === "boolean" ? s.emojis : DEFAULT_SETTINGS.emojis,
        followUps: typeof s.followUps === "boolean" ? s.followUps : DEFAULT_SETTINGS.followUps,
        locale: typeof s.locale === "string" ? s.locale : DEFAULT_SETTINGS.locale,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS, skills: defaultSkills };
}

function loadHistory(): ChatMsg[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (raw) {
      const h = JSON.parse(raw) as ChatMsg[];
      if (Array.isArray(h)) return h.slice(-20);
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function AiChat({
  rows,
  totals,
  hideTitle = false,
}: {
  rows: Summary["rows"];
  totals: Summary["totals"];
  /** When embedded in a Widget (which renders the title), skip the inner h2. */
  hideTitle?: boolean;
}) {
  const { aiLocale: globalAiLocale } = useLocale();
  const { data: txns } = api.portfolio.transactions.useQuery({ limit: 10 });
  const { data: meta } = api.ai.meta.useQuery();

  const defaultSkills = useMemo(
    () => (meta?.skills ?? []).filter((s) => s.defaultOn).map((s) => s.id),
    [meta],
  );
  const [settings, setSettings] = useState<ChatSettings>(() =>
    loadSettings(defaultSkills),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>(() => loadHistory());
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Per-section locale: settings override, else global AI locale.
  const locale = settings.locale || globalAiLocale;

  // Sync defaults once meta loads.
  useEffect(() => {
    if (meta && defaultSkills.length > 0) {
      setSettings((s) =>
        s.skills.length === 0 ? { ...s, skills: defaultSkills } : s,
      );
    }
  }, [meta, defaultSkills]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  useEffect(() => {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-20)));
    } catch {
      /* ignore */
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const snapshot = useMemo(() => {
    const mv = totals.marketValue > 0 ? totals.marketValue : 1;
    const topPositions = rows
      .filter((r) => (r.marketValue ?? 0) > 0)
      .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
    return {
      positions: topPositions.slice(0, 30).map((r) => ({
        symbol: r.symbol,
        marketValue: r.marketValue ?? 0,
        totalPL: r.totalPL ?? 0,
        totalPLPct: r.totalPLPct ?? null,
        dayPL: r.dayPL ?? null,
        weightPct: ((r.marketValue ?? 0) / mv) * 100,
      })),
      totals: {
        marketValue: totals.marketValue,
        dayPL: totals.dayPL ?? null,
        totalPL: totals.totalPL ?? 0,
        totalPLPct: totals.totalPLPct ?? null,
      },
      recentTrades: (txns ?? []).map((t) => ({
        symbol: t.symbol,
        type: t.type,
        quantity: t.quantity,
        price: t.price,
        date: new Date(t.executedAt).toISOString().slice(0, 10),
      })),
      locale,
    };
  }, [rows, totals, txns, locale]);

  const providerMeta = meta?.providers.find((p) => p.id === settings.provider);
  const needsKey = providerMeta?.needsKey && !settings.apiKey.trim();
  // Guard against a stored model ID from a different provider (stale localStorage).
  const effectiveModel =
    providerMeta?.models.some((m) => m.id === settings.model)
      ? settings.model
      : providerMeta?.models[0]?.id ?? "";

  // Streaming state: tokens append to the last assistant message live.
  // requestIdRef invalidates a superseded stream; abortRef cancels it.
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [streaming, setStreaming] = useState(false);

  /** True while waiting for / streaming a response. */
  const isLoading = streaming;

  /** Map a stream error to the friendly message the UI shows. */
  function friendlyError(msg: string): string {
    return msg.includes("no-binding") || msg.includes("AI_UNAVAILABLE")
      ? "AI is unavailable right now. Try again in a bit."
      : msg.includes("needs-key") || msg.includes("NEEDS_API_KEY")
        ? "This provider needs an API key — open settings and add one."
        : msg.startsWith("openai-") ||
            msg.startsWith("anthropic-") ||
            msg.startsWith("PROVIDER_ERROR")
          ? `Provider error: ${msg.replace("PROVIDER_ERROR: ", "").slice(0, 160)}`
          : "Couldn't get an answer. Try again.";
  }

  const send = useCallback((question?: string) => {
    const q = (question ?? input).trim();
    if (!q || streaming) return;
    setError(null);
    setInput("");
    const history = messages.slice(-10);
    const reqId = ++requestIdRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming(true);
    setMessages((m) => [...m, { role: "user", content: q }]);

    const body = {
      question: q,
      history,
      portfolio: snapshot,
      locale,
      provider: settings.provider,
      apiKey: settings.apiKey || null,
      skills: settings.skills,
      tone: settings.tone,
      length: settings.length,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      model: effectiveModel === providerMeta?.models[0]?.id ? null : effectiveModel || null,
      emojis: settings.emojis,
      followUps: settings.followUps,
    };

    void (async () => {
      let full = "";
      let addedAssistant = false;
      const appendToken = (token: string) => {
        full += token;
        const snap = full;
        if (!addedAssistant) {
          addedAssistant = true;
          setMessages((m) => [...m, { role: "assistant", content: snap }]);
        } else {
          setMessages((m) => {
            const last = m[m.length - 1];
            return last && last.role === "assistant"
              ? [...m.slice(0, -1), { ...last, content: snap }]
              : [...m, { role: "assistant", content: snap }];
          });
        }
      };
      try {
        const res = await fetch("/api/ai/chat-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
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
              if (data === "[DONE]") {
                if (reqId !== requestIdRef.current) return; // stopped
                if (!full.trim()) throw new Error("ai-error: empty stream");
                setStreaming(false);
                return;
              }
              let payload: unknown = null;
              try {
                payload = JSON.parse(data);
              } catch {
                continue;
              }
              if (payload && typeof payload === "object" && "error" in payload) {
                throw new Error(String((payload as { error: unknown }).error));
              }
              if (typeof payload === "string" && payload) {
                if (reqId !== requestIdRef.current) return; // stopped
                appendToken(payload);
              }
            }
          }
        }
        // Stream ended without [DONE].
        if (reqId !== requestIdRef.current) return;
        if (!full.trim()) throw new Error("ai-error: empty stream");
        setStreaming(false);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (reqId !== requestIdRef.current) return; // stopped
        const msg = e instanceof Error ? e.message : String(e);
        setError(friendlyError(msg));
        setStreaming(false);
      }
    })();
  }, [input, streaming, messages, snapshot, locale, settings, effectiveModel, providerMeta]);

  /** Stop button: abort the in-flight stream; a partial reply stays. */
  const stop = useCallback(() => {
    requestIdRef.current++;
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const toggleSkill = (id: string) =>
    setSettings((s) => ({
      ...s,
      skills: s.skills.includes(id)
        ? s.skills.filter((x) => x !== id)
        : [...s.skills, id],
    }));

  // Alerts can hand off a question via localStorage — auto-send it.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const check = () => {
      try {
        const q = window.localStorage.getItem("holdr.ai-chat-prefill");
        if (q) {
          window.localStorage.removeItem("holdr.ai-chat-prefill");
          sendRef.current(q);
        }
      } catch {
        /* ignore */
      }
    };
    check();
    const t = window.setInterval(check, 1000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/60 p-4 sm:p-5">
      <div className="flex items-center justify-between">
        {!hideTitle && (
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            <MessageCircle size={14} className="mr-1.5 inline text-zinc-600 dark:text-zinc-400" />
            AI Chat
            <InfoTip text="Ask anything about your portfolio — the AI sees your holdings, P/L and recent trades. Your API keys stay in this browser and are sent only with your chat requests." />
          </h2>
        )}
        <div className={`flex items-center gap-2 ${hideTitle ? "ml-auto" : ""}`}>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setMessages([])}
              className="text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-300"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-label="Chat settings"
            title="Provider, API key & skills"
            className="rounded-lg p-1.5 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:bg-zinc-800 hover:text-zinc-800 dark:text-zinc-200"
          >
            <Settings2 size={16} />
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="mt-3 space-y-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-950/60 p-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Provider
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(meta?.providers ?? []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    setSettings((s) => ({ ...s, provider: p.id, model: "" }))
                  }
                  title={p.description}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                    settings.provider === p.id
                      ? "border-emerald-600 bg-emerald-950/50 text-emerald-300"
                      : "border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 hover:border-zinc-600"
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
            {(providerMeta?.models?.length ?? 0) > 0 && (
              <div className="mt-3">
                <label
                  htmlFor="ai-chat-model"
                  className="text-xs font-semibold uppercase tracking-wide text-zinc-500"
                >
                  Model
                </label>
                <select
                  id="ai-chat-model"
                  value={effectiveModel}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      model:
                        e.target.value === providerMeta!.models[0]!.id
                          ? ""
                          : e.target.value,
                    }))
                  }
                  className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:border-emerald-600 focus:outline-none"
                >
                  {providerMeta!.models.map((m) => (
                    <option key={m.id} value={m.id} title={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-zinc-600">
                  {providerMeta!.models.length} models available
                  {settings.provider === "cloudflare"
                    ? " — free via Workers AI"
                    : " — billed to your API key"}
                </p>
              </div>
            )}
          </div>
          {providerMeta?.needsKey && (
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {providerMeta.name} API key
              </label>
              <input
                type="password"
                value={settings.apiKey}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, apiKey: e.target.value.trim() }))
                }
                placeholder="sk-…"
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none"
              />
              <p className="mt-1 text-xs text-zinc-600">
                Stored only in this browser. Sent with your chat requests,
                never saved on the server.
              </p>
            </div>
          )}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Language <span className="normal-case text-zinc-600">(per-section)</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {[
                { id: "", name: "Global" },
                { id: "en", name: "EN" },
                { id: "zh-Hant", name: "繁" },
                { id: "zh-Hans", name: "简" },
              ].map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, locale: l.id }))}
                  title={l.id ? `Reply in ${l.name}` : `Use global AI language (${globalAiLocale})`}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                    settings.locale === l.id
                      ? "border-violet-600 bg-violet-950/50 text-violet-300"
                      : "border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-500 hover:border-zinc-600"
                  }`}
                >
                  {l.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Tone
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(meta?.tones ?? []).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, tone: t.id }))}
                  title={t.description}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                    settings.tone === t.id
                      ? "border-violet-600 bg-violet-950/50 text-violet-300"
                      : "border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-500 hover:border-zinc-600"
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Length
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(meta?.lengths ?? []).map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, length: l.id }))}
                  title={l.description}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                    settings.length === l.id
                      ? "border-violet-600 bg-violet-950/50 text-violet-300"
                      : "border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-500 hover:border-zinc-600"
                  }`}
                >
                  {l.name}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-zinc-600 dark:text-zinc-400">
                Creativity: <b className="text-zinc-800 dark:text-zinc-200">{settings.temperature.toFixed(1)}</b>
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={settings.temperature}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, temperature: Number(e.target.value) }))
                }
                className="mt-1 w-full accent-violet-500"
              />
              <p className="text-[11px] text-zinc-600">0 = precise, 1 = creative</p>
            </div>
            <div>
              <label className="text-xs text-zinc-600 dark:text-zinc-400">
                Max length: <b className="text-zinc-800 dark:text-zinc-200">{settings.maxTokens}</b>
              </label>
              <input
                type="range"
                min={300}
                max={2000}
                step={100}
                value={settings.maxTokens}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, maxTokens: Number(e.target.value) }))
                }
                className="mt-1 w-full accent-violet-500"
              />
              <p className="text-[11px] text-zinc-600">tokens per reply</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSettings((s) => ({ ...s, emojis: !s.emojis }))}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                settings.emojis
                  ? "border-violet-600 bg-violet-950/50 text-violet-300"
                  : "border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-500"
              }`}
            >
              {settings.emojis ? "✓ " : ""}Emojis
            </button>
            <button
              type="button"
              onClick={() => setSettings((s) => ({ ...s, followUps: !s.followUps }))}
              title="End replies with suggested follow-up questions"
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                settings.followUps
                  ? "border-violet-600 bg-violet-950/50 text-violet-300"
                  : "border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-500"
              }`}
            >
              {settings.followUps ? "✓ " : ""}Follow-up suggestions
            </button>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Skills
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(meta?.skills ?? []).map((s) => {
                const on = settings.skills.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleSkill(s.id)}
                    title={s.description}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                      on
                        ? "border-sky-600 bg-sky-950/50 text-sky-300"
                        : "border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-500 hover:border-zinc-600"
                    }`}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 max-h-80 space-y-3 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">
            Try: “Why am I down today?” · “My riskiest position?” · “How did
            my NVDA trade do?”
          </p>
        )}
        {messages.map((m, i) => {
          const isLive =
            streaming && i === messages.length - 1 && m.role === "assistant";
          return (
            <div
              key={i}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-emerald-800/60 text-emerald-50"
                    : "bg-zinc-200/80 dark:bg-zinc-800/80 text-zinc-900 dark:text-zinc-100"
                }`}
              >
                {m.content}
                {isLive && (
                  <span className="ml-0.5 inline-block h-4 w-[7px] translate-y-[3px] animate-pulse rounded-[1px] bg-emerald-500" />
                )}
              </div>
            </div>
          );
        })}
        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="rounded-xl bg-zinc-200/80 dark:bg-zinc-800/80 px-4 py-3">
              <TypingDots />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}

      <div className="mt-3 flex items-center gap-2 rounded-2xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 py-2 pl-4 pr-2 transition focus-within:border-emerald-600">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            needsKey
              ? `Add your ${providerMeta?.name} API key in settings first…`
              : "Ask about your portfolio…"
          }
          disabled={isLoading}
          aria-label="Ask about your portfolio"
          className="flex-1 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none disabled:opacity-50"
        />
        {isLoading ? (
          <button
            type="button"
            onClick={stop}
            aria-label="Stop generating"
            title="Stop generating"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-500 text-white transition hover:bg-zinc-400 active:scale-95"
          >
            <Square size={15} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => send()}
            disabled={!input.trim()}
            aria-label="Send"
            title="Send"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white transition hover:bg-emerald-500 active:scale-95 disabled:opacity-30 disabled:hover:bg-emerald-600"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
