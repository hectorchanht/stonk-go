"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { localeShort, useLocale } from "~/app/_components/locale";

type Summary = RouterOutputs["portfolio"]["summary"];

const card = "rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/60 p-4 sm:p-5";
const CACHE_TTL_MS = 24 * 3600 * 1000;

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function loadCache(key: string): { text: string; at: number } | null {
  try {
    const raw = window.localStorage.getItem(`holdr.ai.${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { text: string; at: number };
    if (!parsed.text || Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function timeAgo(at: number): string {
  const mins = Math.max(1, Math.round((Date.now() - at) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function toBullets(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[•\-*]\s*/, ""));
}

type Phase = "idle" | "waiting" | "streaming" | "error";

/**
 * AI portfolio brief, powered by Cloudflare Workers AI.
 * Streams tokens live via /api/ai/insights-stream (SSE) so the response
 * types out as it's generated; the completed text is cached in
 * localStorage for 24h per portfolio snapshot.
 */
export function AiInsights({
  rows,
  totals,
}: {
  rows: Summary["rows"];
  totals: Summary["totals"];
}) {
  const { data: txns } = api.portfolio.transactions.useQuery({ limit: 10 });
  const { aiLocale: globalAiLocale } = useLocale();
  // Per-section locale override — defaults to global AI locale.
  const [localeOverride, setLocaleOverride] = useState<"en" | "zh-Hant" | "zh-Hans" | null>(null);
  const locale = localeOverride ?? globalAiLocale;

  const input = useMemo(() => {
    const mv = totals.marketValue > 0 ? totals.marketValue : 1;
    // Send up to 200 positions by market value (server cap) — the AI
    // sees the whole portfolio, dust included.
    const topPositions = rows
      .filter((r) => (r.marketValue ?? 0) > 0)
      .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
    return {
      // The locale is part of the cache key, so each language keeps its
      // own 24h cache and switching languages regenerates.
      locale,
      positionCount: topPositions.length,
      positions: topPositions.slice(0, 200).map((r) => ({
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
    };
  }, [rows, totals, txns, locale]);

  const key = useMemo(() => hashStr(JSON.stringify(input)), [input]);
  const [cached, setCached] = useState<{ text: string; at: number } | null>(
    null,
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [streamed, setStreamed] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedKeyRef = useRef<string | null>(null);

  const startStream = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStreamed("");
    setErrorMsg(null);
    setPhase("waiting");
    let full = "";
    try {
      const res = await fetch("/api/ai/insights-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error("no-stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let firstToken = true;
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
              const text = full.trim();
              if (!text) throw new Error("ai-error: empty stream");
              const entry = { text, at: Date.now() };
              try {
                window.localStorage.setItem(
                  `holdr.ai.${key}`,
                  JSON.stringify(entry),
                );
              } catch {
                /* ignore */
              }
              setCached(entry);
              setPhase("idle");
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
              full += payload;
              if (firstToken) {
                firstToken = false;
                setPhase("streaming");
              }
              setStreamed(full);
            }
          }
        }
      }
      // Stream ended without [DONE] — accept what we got if non-empty.
      const text = full.trim();
      if (text) {
        const entry = { text, at: Date.now() };
        try {
          window.localStorage.setItem(`holdr.ai.${key}`, JSON.stringify(entry));
        } catch {
          /* ignore */
        }
        setCached(entry);
        setPhase("idle");
      } else {
        throw new Error("ai-error: empty stream");
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setErrorMsg(e instanceof Error ? e.message : "AI_ERROR");
      setPhase("error");
    }
  }, [input, key]);

  // Reset on input change; load cache.
  useEffect(() => {
    abortRef.current?.abort();
    setCached(loadCache(key));
    setStreamed("");
    setErrorMsg(null);
    setPhase("idle");
    startedKeyRef.current = null;
  }, [key]);

  // Auto-start when there's no cache and we have rows.
  useEffect(() => {
    if (cached || rows.length === 0) return;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    void startStream();
  }, [cached, rows.length, key, startStream]);

  // Abort on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const regenerate = useCallback(() => {
    try {
      window.localStorage.removeItem(`holdr.ai.${key}`);
    } catch {
      /* ignore */
    }
    setCached(null);
    startedKeyRef.current = key;
    void startStream();
  }, [key, startStream]);

  const text = cached?.text ?? null;
  const isNoBinding = (errorMsg ?? "").includes("no binding");
  const bullets = toBullets(streamed);

  return (
    <div className={`${card} border-violet-900/40`}>
      {text ? (
        <>
          <ul className="space-y-2.5 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
            {toBullets(text).map((b, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-violet-400">✦</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-zinc-200 dark:border-zinc-800/60 pt-2.5">
            <p className="text-xs text-zinc-500">
              Generated by Cloudflare AI (Qwen3) · {localeShort(locale)}
              {input.positionCount > 200
                ? ` · top 200 of ${input.positionCount} holdings`
                : ""}{" "}
              · {cached ? timeAgo(cached.at) : "just now"}
            </p>
            <div className="flex items-center gap-2">
              <select
                value={locale}
                onChange={(e) => {
                  const v = e.target.value as "en" | "zh-Hant" | "zh-Hans";
                  setLocaleOverride(v === globalAiLocale ? null : v);
                  setCached(null);
                }}
                title="Language for this section"
                className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 focus:border-violet-600 focus:outline-none"
              >
                <option value="en">EN</option>
                <option value="zh-Hant">繁</option>
                <option value="zh-Hans">简</option>
              </select>
              <button
                onClick={regenerate}
                className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:border-zinc-500 hover:text-zinc-900 dark:text-zinc-100"
              >
                <RefreshCw size={13} className="mr-1.5 inline" />Regenerate
              </button>
            </div>
          </div>
        </>
      ) : phase === "waiting" ? (
        <div className="space-y-2.5" aria-label="Generating insights">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
              style={{ width: `${92 - i * 9}%` }}
            />
          ))}
          <p className="pt-1 text-xs text-zinc-500">
            <span className="inline-flex items-center gap-1.5">
              <Sparkles size={13} className="animate-spin text-violet-400" />
              Analyzing {input.positionCount} position
              {input.positionCount === 1 ? "" : "s"}…
            </span>
          </p>
        </div>
      ) : phase === "streaming" ? (
        <>
          <ul className="space-y-2.5 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
            {bullets.map((b, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-violet-400">✦</span>
                <span>
                  {b}
                  {i === bullets.length - 1 && (
                    <span className="animate-pulse text-violet-400"> ▍</span>
                  )}
                </span>
              </li>
            ))}
            {bullets.length === 0 && (
              <li className="flex gap-2">
                <span className="animate-pulse text-violet-400">▍</span>
              </li>
            )}
          </ul>
          <p className="pt-2 text-xs text-zinc-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
              Streaming…
            </span>
          </p>
        </>
      ) : phase === "error" ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-zinc-500">
            {isNoBinding
              ? "AI insights need the Cloudflare AI binding — live in production after the next deploy."
              : "Couldn't generate insights right now."}
          </p>
          <button
            onClick={regenerate}
            className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:border-zinc-500"
          >
            <RefreshCw size={13} className="mr-1.5 inline" />Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Log some transactions or sync IBKR first — the AI needs a portfolio to roast.
        </p>
      ) : null}
    </div>
  );
}
