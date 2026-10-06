"use client";

import { useCallback, useEffect, useState } from "react";

import { api } from "~/trpc/react";
import { useCurrency } from "~/app/_components/currency";
import { StatCard } from "~/app/_components/ui";

/**
 * Performance section: equity curve from daily snapshots + XIRR.
 * Snapshots are recorded client-side (once per day on dashboard load)
 * because broker positions live in the browser's IBKR snapshot.
 */

interface BrokerPositionInput {
  symbol: string;
  quantity: number;
  markPrice: number | null;
  costBasisPrice?: number | null;
}

function useMoney() {
  const { fmt } = useCurrency();
  return useCallback(
    (v: number | null, opts?: { sign?: boolean }) =>
      v == null || !Number.isFinite(v) ? "—" : fmt(v, opts),
    [fmt],
  );
}

const pct = (v: number | null, opts?: { sign?: boolean }) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = opts?.sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
};

function EquityChart({
  points,
}: {
  points: { date: string; marketValue: number }[];
}) {
  const money = useMoney();
  const W = 640;
  const H = 200;
  const PAD = 10;

  if (points.length < 2) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500">
        Not enough history yet — a snapshot is recorded each day you open the
        app.
      </p>
    );
  }

  const vals = points.map((p) => p.marketValue);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);
  const line = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.marketValue).toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`;
  const up =
    points[points.length - 1]!.marketValue >= points[0]!.marketValue;
  const stroke = up ? "#34d399" : "#fb7185";
  const last = points[points.length - 1]!;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Portfolio value over time"
      >
        <path
          d={area}
          fill={up ? "rgba(52,211,153,0.12)" : "rgba(251,113,133,0.12)"}
        />
        <path
          d={line}
          fill="none"
          stroke={stroke}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={x(points.length - 1)}
          cy={y(last.marketValue)}
          r="4"
          fill={stroke}
        />
      </svg>
      <div className="mt-1 flex items-center justify-between text-xs text-zinc-500">
        <span className="tabular-nums">{points[0]!.date}</span>
        <span className="tabular-nums">
          {money(min)} – {money(max)}
        </span>
        <span className="tabular-nums">{last.date}</span>
      </div>
    </div>
  );
}

const RANGES = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "1Y", days: 365 },
  { label: "ALL", days: 0 },
] as const;

export function PerformanceSection({
  brokerPositions,
}: {
  brokerPositions: BrokerPositionInput[];
}) {
  const [range, setRange] = useState<number>(90);
  const { data: history, isLoading } = api.portfolio.history.useQuery({
    days: range,
  });
  const { data: perf } = api.portfolio.xirr.useQuery({ brokerPositions });

  const pts = (history ?? []).map((h) => ({
    date: h.date,
    marketValue: h.marketValue,
  }));
  const first = pts[0];
  const last = pts[pts.length - 1];
  const periodReturn =
    first && last && first.marketValue > 0
      ? ((last.marketValue - first.marketValue) / first.marketValue) * 100
      : null;
  const x = perf?.xirr;
  const xirrTone: "pos" | "neg" | "neutral" =
    x == null ? "neutral" : x > 0 ? "pos" : x < 0 ? "neg" : "neutral";

  return (
    <div className="rounded-xl border border-zinc-200 bg-white/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/60 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => setRange(r.days)}
              className={`px-3 py-1.5 text-xs font-semibold ${
                range === r.days
                  ? "bg-zinc-600 text-white"
                  : "bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? (
        <p className="py-8 text-center text-sm text-zinc-500">Loading…</p>
      ) : (
        <EquityChart points={pts} />
      )}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <StatCard
          label="Annualized return (XIRR)"
          value={x == null ? "—" : `${(x * 100).toFixed(2)}%`}
          tone={xirrTone}
          info="True annualized return from your full trade log: buys count as cash out, sells as cash in, today's value closes it out. Excludes dividends."
        />
        <StatCard
          label="Return this period"
          value={periodReturn == null ? "—" : pct(periodReturn, { sign: true })}
          tone={
            periodReturn == null
              ? "neutral"
              : periodReturn > 0
                ? "pos"
                : periodReturn < 0
                  ? "neg"
                  : "neutral"
          }
          sub={first && last ? `${first.date} → ${last.date}` : undefined}
        />
      </div>
    </div>
  );
}

/**
 * Record today's portfolio snapshot (once per day). Re-records when IBKR
 * positions arrive after the first paint, so the snapshot isn't manual-only.
 */
export function useSnapshotRecorder(
  summaryLoaded: boolean,
  brokerInput: BrokerPositionInput[],
) {
  const recordSnap = api.portfolio.recordSnapshot.useMutation();

  useEffect(() => {
    if (!summaryLoaded) return;
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
    let prev: { date: string; broker: boolean } | null = null;
    try {
      const raw = localStorage.getItem("holdr.snapshot.state");
      prev = raw ? (JSON.parse(raw) as { date: string; broker: boolean }) : null;
    } catch {
      /* ignore */
    }
    const hasBroker = brokerInput.length > 0;
    if (prev?.date === today && (prev.broker || !hasBroker)) return;
    recordSnap.mutate(
      { brokerPositions: brokerInput },
      {
        onSuccess: () => {
          try {
            localStorage.setItem(
              "holdr.snapshot.state",
              JSON.stringify({ date: today, broker: hasBroker }),
            );
          } catch {
            /* ignore */
          }
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryLoaded, brokerInput]);
}
