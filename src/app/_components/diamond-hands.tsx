"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Flag,
  Flame,
  Gem,
  Mountain,
  PieChart,
  TrendingDown,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { api } from "~/trpc/react";
import { useCurrency } from "~/app/_components/currency";
import {
  DEFAULT_FI_SETTINGS,
  formatDurationMonths,
  loadFiSettings,
  monthsToTarget,
  type FiSettings,
} from "~/app/_components/fi";

/** Broker position shape matching the portfolio router's summaryInput. */
export interface BrokerPositionLike {
  symbol: string;
  quantity: number;
  markPrice: number | null;
  costBasisPrice?: number | null;
  label?: string | null;
  currency?: string;
}

const MILESTONES = [100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000];

function GlanceTile({
  icon: Icon,
  label,
  value,
  sub,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "pos" | "neg" | "warn" | "neutral";
}) {
  const toneClass =
    tone === "pos"
      ? "text-emerald-500"
      : tone === "neg"
        ? "text-rose-500"
        : tone === "warn"
          ? "text-amber-500"
          : "text-zinc-900 dark:text-zinc-100";
  return (
    <div className="min-w-0 rounded-xl border border-zinc-200 bg-white/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex items-center gap-1.5 text-zinc-500">
        <Icon size={13} className="shrink-0" />
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <div className={`mt-1 truncate text-xl font-bold tabular-nums sm:text-2xl ${toneClass}`}>{value}</div>
      {sub != null && sub !== "" && (
        <div className="mt-0.5 truncate text-xs text-zinc-500">{sub}</div>
      )}
    </div>
  );
}

function TileSkeleton() {
  return <div className="h-[92px] animate-pulse rounded-xl bg-zinc-200/60 dark:bg-zinc-800/60" />;
}

export function DiamondHands({
  marketValue,
  brokerPositions,
}: {
  /** Total portfolio market value, USD. */
  marketValue: number;
  brokerPositions: BrokerPositionLike[];
}) {
  const { fmt, fmtCompact, rates, currency } = useCurrency();
  const displayRate = rates?.[currency.toLowerCase()] ?? 1;
  const toUsd = (display: number) => display / displayRate;

  const [fiSettings, setFiSettings] = useState<FiSettings>({ ...DEFAULT_FI_SETTINGS });
  useEffect(() => {
    setFiSettings(loadFiSettings());
  }, []);

  const statsQ = api.portfolio.handsStats.useQuery(
    { brokerPositions },
    { staleTime: 600_000, retry: false },
  );
  const curveQ = api.portfolio.equityCurve.useQuery(
    { days: 0, brokerPositions },
    { staleTime: 900_000, retry: false },
  );
  const analyticsQ = api.ibkr.analytics.useQuery(undefined, {
    staleTime: 300_000,
    retry: false,
  });

  const stats = statsQ.data;
  const positions = useMemo(
    () => [...(stats?.positions ?? [])].sort((a, b) => b.marketValue - a.marketValue),
    [stats],
  );

  /* ---- derived glanceables (all USD) ---- */
  const monthlyExpensesUsd = toUsd(fiSettings.monthlyExpenses * 12) / 12;
  const annualExpensesUsd = toUsd(fiSettings.monthlyExpenses * 12);
  const monthlyPmtUsd = toUsd(fiSettings.monthlyContribution);
  const freedomMonths = monthlyExpensesUsd > 0 ? marketValue / monthlyExpensesUsd : null;

  const divMonths = analyticsQ.data?.dividendsByMonth ?? [];
  const annualDivUsd = useMemo(
    () => divMonths.slice(-12).reduce((a, m) => a + m.amount, 0),
    [divMonths],
  );
  const rentDays = annualExpensesUsd > 0 && annualDivUsd > 0 ? (annualDivUsd / annualExpensesUsd) * 365 : null;

  const ath = useMemo(() => {
    const pts = curveQ.data?.points ?? [];
    let peak = marketValue;
    for (const p of pts) if (p.value > peak) peak = p.value;
    return peak;
  }, [curveQ.data, marketValue]);
  const athPct = ath > 0 ? ((marketValue - ath) / ath) * 100 : 0;

  const nextMilestone = MILESTONES.find((m) => m > marketValue) ?? null;
  const milestoneMonths =
    nextMilestone != null
      ? monthsToTarget(marketValue, monthlyPmtUsd, fiSettings.annualReturnPct, nextMilestone)
      : null;

  const top = positions[0] ?? null;
  const hasPortfolio = marketValue > 0;
  const loading = statsQ.isLoading;

  return (
    <div className="space-y-4">
      {!hasPortfolio && !loading ? (
        <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          <Gem size={20} className="mx-auto mb-2 text-zinc-400" />
          Connect a broker or log holdings — your diamond-hands stats will appear here.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {loading ? (
              <>
                {Array.from({ length: 8 }).map((_, i) => (
                  <TileSkeleton key={i} />
                ))}
              </>
            ) : (
              <>
                <GlanceTile
                  icon={Gem}
                  label="Longest hold"
                  value={stats?.longestHeld?.daysHeld != null ? `${stats.longestHeld.daysHeld}d` : "—"}
                  sub={
                    stats?.longestHeld
                      ? `${stats.longestHeld.symbol} — never folded`
                      : "log buys to track tenure"
                  }
                />
                <GlanceTile
                  icon={TrendingDown}
                  label="Dip survived"
                  value={
                    stats?.deepestDip?.maxDrawdownPct != null
                      ? `-${(stats.deepestDip.maxDrawdownPct * 100).toFixed(0)}%`
                      : "—"
                  }
                  sub={stats?.deepestDip ? `${stats.deepestDip.symbol} — still holding` : "no drawdown data yet"}
                  tone={stats?.deepestDip ? "pos" : "neutral"}
                />
                <GlanceTile
                  icon={Flame}
                  label="Buy streak"
                  value={stats != null ? `${stats.buyStreakMonths} mo` : "—"}
                  sub={stats && stats.buyStreakMonths > 0 ? "keep stacking" : "log a buy to start"}
                  tone={stats && stats.buyStreakMonths >= 6 ? "pos" : "neutral"}
                />
                <GlanceTile
                  icon={CalendarDays}
                  label="Freedom banked"
                  value={freedomMonths != null ? `${Math.floor(freedomMonths)} mo` : "—"}
                  sub="of spending covered"
                />
                <GlanceTile
                  icon={Wallet}
                  label="Rent from dividends"
                  value={rentDays != null ? `${Math.round(rentDays)} days` : "—"}
                  sub={rentDays != null ? "paid by dividends / yr" : "no dividend data yet"}
                  tone={rentDays != null && rentDays >= 30 ? "pos" : "neutral"}
                />
                <GlanceTile
                  icon={Mountain}
                  label="From all-time high"
                  value={`${athPct >= 0 ? "+" : ""}${athPct.toFixed(1)}%`}
                  sub={athPct >= 0 ? "at the top" : `ATH ${fmtCompact(ath)}`}
                  tone={athPct >= 0 ? "pos" : athPct > -10 ? "neutral" : "neg"}
                />
                <GlanceTile
                  icon={Flag}
                  label="Next milestone"
                  value={nextMilestone != null ? fmtCompact(nextMilestone) : "—"}
                  sub={
                    milestoneMonths != null
                      ? `${formatDurationMonths(milestoneMonths)} away`
                      : "beyond $10M — legend"
                  }
                />
                <GlanceTile
                  icon={PieChart}
                  label="Concentration"
                  value={top != null ? `${top.weightPct.toFixed(0)}%` : "—"}
                  sub={top != null ? `${top.symbol} of portfolio` : "no positions"}
                  tone={top != null && top.weightPct > 35 ? "warn" : "neutral"}
                />
              </>
            )}
          </div>

          {/* conviction list */}
          {!loading && positions.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wide text-zinc-500">
                Conviction board
              </h4>
              <div className="mt-2 divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {positions.slice(0, 6).map((p) => (
                  <div key={p.symbol} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {p.symbol}
                        {p.name && (
                          <span className="ml-1.5 truncate font-normal text-zinc-500">{p.name}</span>
                        )}
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-sky-500"
                          style={{ width: `${Math.min(100, Math.max(0, p.weightPct))}%` }}
                        />
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {p.daysHeld != null ? `${p.daysHeld}d held` : "—"}
                      </div>
                      <div
                        className={`text-xs tabular-nums ${p.maxDrawdownPct != null && p.maxDrawdownPct > 0.2 ? "font-semibold text-emerald-500" : "text-zinc-500"}`}
                      >
                        {p.maxDrawdownPct != null
                          ? `survived -${(p.maxDrawdownPct * 100).toFixed(0)}%`
                          : "dip data —"}
                      </div>
                    </div>
                    <div className="w-20 shrink-0 text-right text-sm tabular-nums text-zinc-500">
                      {fmt(p.marketValue)}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                Tenure from your first logged buy; dips from daily closes since then. {fmt(marketValue)} working.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
