"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle, Send, Settings2, X } from "lucide-react";

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
}

function loadSettings(defaultSkills: string[]): ChatSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<ChatSettings>;
      return {
        provider: typeof s.provider === "string" ? s.provider : "cloudflare",
        apiKey: typeof s.apiKey === "string" ? s.apiKey : "",
        skills: Array.isArray(s.skills) ? s.skills : defaultSkills,
      };
    }
  } catch {
    /* ignore */
  }
  return { provider: "cloudflare", apiKey: "", skills: defaultSkills };
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
}: {
  rows: Summary["rows"];
  totals: Summary["totals"];
}) {
  const { locale } = useLocale();
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

  // Alerts can hand off a pre-filled question via localStorage + section open.
  useEffect(() => {
    const check = () => {
      try {
        const q = window.localStorage.getItem("holdr.ai-chat-prefill");
        if (q) {
          window.localStorage.removeItem("holdr.ai-chat-prefill");
          setInput(q);
        }
      } catch {
        /* ignore */
      }
    };
    check();
    const t = window.setInterval(check, 1000);
    return () => window.clearInterval(t);
  }, []);

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

  const chatMut = api.ai.chat.useMutation({
    onSuccess: (res) => {
      setMessages((m) => [...m, { role: "assistant", content: res.text }]);
    },
    onError: (e) => {
      const msg = e.message.includes("NEEDS_API_KEY")
        ? "This provider needs an API key — open settings and add one."
        : e.message.includes("AI_UNAVAILABLE")
          ? "AI is unavailable right now. Try again in a bit."
          : e.message.includes("PROVIDER_ERROR")
            ? `Provider error: ${e.message.replace("PROVIDER_ERROR: ", "")}`
            : "Couldn't get an answer. Try again.";
      setError(msg);
    },
  });

  const send = useCallback(() => {
    const q = input.trim();
    if (!q || chatMut.isPending) return;
    setError(null);
    setInput("");
    const history = messages.slice(-10);
    setMessages((m) => [...m, { role: "user", content: q }]);
    chatMut.mutate({
      question: q,
      history,
      portfolio: snapshot,
      locale,
      provider: settings.provider,
      apiKey: settings.apiKey || null,
      skills: settings.skills,
    });
  }, [input, chatMut, messages, snapshot, locale, settings]);

  const toggleSkill = (id: string) =>
    setSettings((s) => ({
      ...s,
      skills: s.skills.includes(id)
        ? s.skills.filter((x) => x !== id)
        : [...s.skills, id],
    }));

  const providerMeta = meta?.providers.find((p) => p.id === settings.provider);
  const needsKey = providerMeta?.needsKey && !settings.apiKey.trim();

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          <MessageCircle size={14} className="mr-1.5 inline text-zinc-400" />
          AI Chat
          <InfoTip text="Ask anything about your portfolio — the AI sees your holdings, P/L and recent trades. Your API keys stay in this browser and are sent only with your chat requests." />
        </h2>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setMessages([])}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-label="Chat settings"
            title="Provider, API key & skills"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <Settings2 size={16} />
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Provider
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(meta?.providers ?? []).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSettings((s) => ({ ...s, provider: p.id }))}
                title={p.description}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                  settings.provider === p.id
                    ? "border-emerald-600 bg-emerald-950/50 text-emerald-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
          {providerMeta?.needsKey && (
            <div className="mt-3">
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
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none"
              />
              <p className="mt-1 text-xs text-zinc-600">
                Stored only in this browser. Sent with your chat requests,
                never saved on the server.
              </p>
            </div>
          )}
          <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
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
                      : "border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-600"
                  }`}
                >
                  {s.name}
                </button>
              );
            })}
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
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-emerald-800/60 text-emerald-50"
                  : "bg-zinc-800/80 text-zinc-100"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {chatMut.isPending && (
          <div className="flex justify-start">
            <div className="rounded-xl bg-zinc-800/80 px-4 py-3">
              <TypingDots />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}

      <div className="mt-3 flex gap-2">
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
          disabled={chatMut.isPending}
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={send}
          disabled={chatMut.isPending || !input.trim()}
          aria-label="Send"
          className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-600 text-white transition hover:bg-emerald-500 active:scale-95 disabled:opacity-40"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
