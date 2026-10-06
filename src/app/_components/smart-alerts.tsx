"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  ChevronDown,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";

import type { RouterOutputs } from "~/trpc/react";
import { useLocale } from "~/app/_components/locale";

type Summary = RouterOutputs["portfolio"]["summary"];
type Row = Summary["rows"][number];

interface Alert {
  id: string;
  kind: "spike" | "drop" | "concentration" | "big-loser" | "no-price" | "no-basis";
  severity: "info" | "warn" | "critical";
  symbol: string;
  name: string | null;
  headline: string;
  detail: string;
  /** Pre-filled question for AI Chat. */
  aiQuestion: string;
}

const THRESHOLD_KEY = "holdr.alert-threshold";
const DISMISSED_KEY = "holdr.alert-dismissed";

function loadThreshold(): number {
  try {
    const v = Number(window.localStorage.getItem(THRESHOLD_KEY));
    if (v >= 1 && v <= 50) return v;
  } catch {
    /* ignore */
  }
  return 5;
}

function loadDismissed(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    if (raw) return JSON.parse(raw) as Record<string, number>;
  } catch {
    /* ignore */
  }
  return {};
}

function fmtPct(v: number | null): string {
  if (v == null) return "n/a";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function scan(row: Row, threshold: number): Alert | null {
  const sym = row.symbol;
  const name = row.name;
  // Price spike / drop — the core auto-scan.
  if (row.dayChangePct != null && Math.abs(row.dayChangePct) >= threshold) {
    const up = row.dayChangePct > 0;
    return {
      id: `move-${sym}`,
      kind: up ? "spike" : "drop",
      severity: Math.abs(row.dayChangePct) >= threshold * 2 ? "critical" : "warn",
      symbol: sym,
      name,
      headline: fmtPct(row.dayChangePct),
      detail: up
        ? `Up ${fmtPct(row.dayChangePct)} today (${row.dayPL != null ? `$${row.dayPL.toFixed(0)}` : "n/a"}). Consider taking some profit or trailing a stop.`
        : `Down ${fmtPct(row.dayChangePct)} today (${row.dayPL != null ? `$${row.dayPL.toFixed(0)}` : "n/a"}). Check for news before catching the knife.`,
      aiQuestion: `Why is ${sym} ${up ? "up" : "down"} ${fmtPct(row.dayChangePct)} today? Should I do anything?`,
    };
  }
  // Concentration risk.
  if (row.weightPct != null && row.weightPct >= 25) {
    return {
      id: `conc-${sym}`,
      kind: "concentration",
      severity: "warn",
      symbol: sym,
      name,
      headline: `${row.weightPct.toFixed(0)}% of portfolio`,
      detail: `${sym} is ${row.weightPct.toFixed(1)}% of your portfolio. A single-stock shock hits hard at this size.`,
      aiQuestion: `${sym} is ${row.weightPct.toFixed(1)}% of my portfolio. Is this concentration risky and what should I do?`,
    };
  }
  // Big all-time loser.
  if (row.totalPLPct != null && row.totalPLPct <= -20) {
    return {
      id: `loser-${sym}`,
      kind: "big-loser",
      severity: "warn",
      symbol: sym,
      name,
      headline: fmtPct(row.totalPLPct),
      detail: `Down ${fmtPct(row.totalPLPct)} all-time ($${(row.totalPL ?? 0).toFixed(0)}). Dead money or turnaround play?`,
      aiQuestion: `${sym} is down ${fmtPct(row.totalPLPct)} all-time. Should I cut it, hold, or average down?`,
    };
  }
  // Missing price.
  if (row.price == null && (row.marketValue ?? 0) > 0) {
    return {
      id: `noprice-${sym}`,
      kind: "no-price",
      severity: "info",
      symbol: sym,
      name,
      headline: "No live price",
      detail: `Couldn't fetch a price for ${sym}. Values for this position may be stale.`,
      aiQuestion: `Why might ${sym} have no live price, and how does that affect my portfolio totals?`,
    };
  }
  // Broker position without cost basis.
  if (row.source === "broker" && row.costBasis == null && (row.marketValue ?? 0) > 0) {
    return {
      id: `nobasis-${sym}`,
      kind: "no-basis",
      severity: "info",
      symbol: sym,
      name,
      headline: "No cost basis",
      detail: `IBKR didn't report a cost basis for ${sym}, so its P/L is excluded from totals.`,
      aiQuestion: `My IBKR position ${sym} has no cost basis. How can I fix the P/L calculation?`,
    };
  }
  return null;
}

const KIND_ICON = {
  spike: TrendingUp,
  drop: TrendingDown,
  concentration: AlertTriangle,
  "big-loser": TrendingDown,
  "no-price": AlertTriangle,
  "no-basis": AlertTriangle,
} as const;

const SEVERITY_STYLE = {
  info: "border-zinc-700 bg-zinc-900/60",
  warn: "border-amber-800/60 bg-amber-950/20",
  critical: "border-rose-800/60 bg-rose-950/20",
} as const;

export function SmartAlerts({ rows }: { rows: Row[] }) {
  const { locale } = useLocale();
  const [threshold, setThreshold] = useState(loadThreshold);
  const [dismissed, setDismissed] = useState<Record<string, number>>(loadDismissed);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(THRESHOLD_KEY, String(threshold));
    } catch {
      /* ignore */
    }
  }, [threshold]);

  // Prune dismissals older than 24h so alerts can resurface.
  const alerts = useMemo(() => {
    const now = Date.now();
    const fresh = rows
      .map((r) => scan(r, threshold))
      .filter((a): a is Alert => a != null)
      .filter((a) => {
        const d = dismissed[a.id];
        return !d || now - d > 24 * 3600 * 1000;
      });
    // Critical first, then warn, then info.
    const order = { critical: 0, warn: 1, info: 2 };
    return fresh.sort((a, b) => order[a.severity] - order[b.severity]);
  }, [rows, threshold, dismissed]);

  const dismiss = (id: string) => {
    setDismissed((d) => {
      const next = { ...d, [id]: Date.now() };
      try {
        window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const askAi = (q: string) => {
    // Hand off to the AI Chat section: store the question, open the section.
    try {
      window.localStorage.setItem("holdr.ai-chat-prefill", q);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent("holdr:open-section", { detail: "ai-chat" }));
    window.setTimeout(() => {
      document.getElementById("ai-chat")?.scrollIntoView({ behavior: "smooth" });
    }, 100);
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Bell size={14} />
          {alerts.length === 0 ? (
            <span>All clear — nothing needs your attention</span>
          ) : (
            <span>
              {alerts.length} thing{alerts.length === 1 ? "" : "s"} need
              {alerts.length === 1 ? "s" : ""} your attention
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowSettings((s) => !s)}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          Alert at ±{threshold}%
        </button>
      </div>

      {showSettings && (
        <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <label className="text-xs text-zinc-400">
            Price move alert threshold: <b className="text-zinc-200">±{threshold}%</b>
          </label>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="mt-2 w-full accent-emerald-500"
          />
          <p className="mt-1 text-xs text-zinc-600">
            {locale === "zh-Hant"
              ? "當日升跌超過呢個 % 就出 alert"
              : locale === "zh-Hans"
                ? "当日涨跌超过这个 % 就出 alert"
                : "Alert when a holding moves more than this % in a day"}
          </p>
        </div>
      )}

      {alerts.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-6 text-center">
          <p className="text-2xl">💎🙌</p>
          <p className="mt-2 text-sm text-zinc-500">
            No spikes, no dumps, no concentration risk. Touch grass.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map((a) => {
            const Icon = KIND_ICON[a.kind];
            const isOpen = expanded === a.id;
            return (
              <div
                key={a.id}
                className={`rounded-xl border px-3 py-2.5 ${SEVERITY_STYLE[a.severity]}`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon
                    size={18}
                    className={
                      a.kind === "spike"
                        ? "shrink-0 text-emerald-400"
                        : a.kind === "drop" || a.kind === "big-loser"
                          ? "shrink-0 text-rose-400"
                          : "shrink-0 text-amber-400"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-sm font-bold text-zinc-100">
                        {a.symbol}
                      </span>
                      <span className="text-sm font-semibold text-zinc-300">
                        {a.headline}
                      </span>
                    </div>
                    {a.name && (
                      <p className="truncate text-xs text-zinc-500">{a.name}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : a.id)}
                    aria-label={isOpen ? "Collapse" : "Expand"}
                    className="rounded-lg p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                  >
                    <ChevronDown
                      size={16}
                      className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => dismiss(a.id)}
                    aria-label="Dismiss"
                    className="rounded-lg p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                  >
                    <X size={14} />
                  </button>
                </div>
                {isOpen && (
                  <div className="mt-2 border-t border-zinc-800/60 pt-2">
                    <p className="text-sm text-zinc-400">{a.detail}</p>
                    <button
                      type="button"
                      onClick={() => askAi(a.aiQuestion)}
                      className="mt-2 rounded-lg border border-sky-800 bg-sky-950/40 px-2.5 py-1 text-xs font-medium text-sky-300 hover:bg-sky-900/40"
                    >
                      Ask AI about this
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
