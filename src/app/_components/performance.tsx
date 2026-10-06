"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "~/trpc/react";
import { useCurrency } from "~/app/_components/currency";
import { StatCard } from "~/app/_components/ui";
import { EquityChart } from "~/app/_components/equity-chart";
import { ReturnChart } from "~/app/_components/return-chart";
import { InvestedValueChart } from "~/app/_components/invested-chart";
import { SourceStackChart } from "~/app/_components/source-chart";
import { MonthlyHeatmap } from "~/app/_components/monthly-heatmap";
import { MissingPricesModal } from "~/app/_components/missing-prices-modal";
import {
  toPercentSeries,
  toReturnOnInvested,
  toSourceLayers,
  type InvestedPoint,
} from "~/app/_components/equity-chart-data";

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

const RANGES = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "1Y", days: 365 },
  { label: "ALL", days: 0 },
] as const;

const VIEWS = [
  { key: "value", label: "Value" },
  { key: "pct", label: "% Return" },
  { key: "invested", label: "Invested vs Value" },
  { key: "source", label: "By Source" },
  { key: "monthly", label: "Monthly" },
] as const;

type ViewKey = (typeof VIEWS)[number]["key"];

export function PerformanceSection({
  brokerPositions,
}: {
  brokerPositions: BrokerPositionInput[];
}) {
  const [range, setRange] = useState<number>(90);
  const [view, setView] = useState<ViewKey>("value");
  const [showMissing, setShowMissing] = useState(false);
  const { data: curve, isLoading } = api.portfolio.equityCurve.useQuery({
    days: range,
    brokerPositions,
  });
  const { data: perf } = api.portfolio.xirr.useQuery({ brokerPositions });
  const money = useMoney();
  const { fmtCompact } = useCurrency();

  const pts = curve?.points ?? [];
  const source = curve?.source ?? "none";
  const missingSymbols =
    curve?.source === "true" ? (curve.missingSymbols ?? []) : [];
  const perSource =
    curve?.source === "true" ? (curve.perSource ?? {}) : {};
  const monthlyCells =
    curve?.source === "true" ? (curve.monthly ?? []) : [];
  const layers = useMemo(() => toSourceLayers(perSource), [perSource]);
  const hasInvested =
    curve?.source === "true" &&
    pts.some((p) => (p as InvestedPoint).invested != null);
  // % formulation by source: true curves carry per-day invested, so the
  // honest series is return-on-invested; snapshot curves only support a
  // simple cumulative vs the first visible point.
  const pctPts =
    source === "true"
      ? toReturnOnInvested(pts)
      : source === "snapshots"
        ? toPercentSeries(pts)
        : [];
  const first = pts[0];
  const last = pts[pts.length - 1];
  const periodReturn =
    first && last && first.value > 0
      ? ((last.value - first.value) / first.value) * 100
      : null;
  const x = perf?.xirr;
  const xirrTone: "pos" | "neg" | "neutral" =
    x == null ? "neutral" : x > 0 ? "pos" : x < 0 ? "neg" : "neutral";
  // The countdown only makes sense before 30 days of history exist; past
  // that, a null XIRR means the solver found no stable rate.
  const xirrSub =
    x != null || perf == null
      ? undefined
      : perf.spanDays < 30
        ? `${Math.floor(perf.spanDays)} of 30 days — XIRR unlocks then`
        : "Couldn't find a stable rate in this history";

  return (
    <div className="rounded-xl border border-zinc-200 bg-white/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/60 sm:p-5">
      <div className="mb-3 space-y-2">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {VIEWS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setView(t.key)}
              aria-pressed={view === t.key}
              className={`min-h-[44px] shrink-0 rounded-full border px-4 text-sm font-semibold ${
                view === t.key
                  ? "border-zinc-400 bg-zinc-700 text-white"
                  : "border-zinc-700 bg-transparent text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {view !== "monthly" && (
          <div className="flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
            {RANGES.map((r) => (
              <button
                key={r.label}
                type="button"
                onClick={() => setRange(r.days)}
                className={`min-h-[44px] flex-1 px-3 text-xs font-semibold ${
                  range === r.days
                    ? "bg-zinc-600 text-white"
                    : "bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {isLoading ? (
        <p className="py-8 text-center text-sm text-zinc-500">Loading…</p>
      ) : view === "value" ? (
        <EquityChart
          points={pts}
          formatMoney={(v) => money(v)}
          formatAxisMoney={(v) => fmtCompact(v)}
        />
      ) : view === "pct" ? (
        pctPts.length >= 2 ? (
          <ReturnChart points={pctPts} />
        ) : (
          <p className="py-8 text-center text-sm text-zinc-500">
            The % view needs daily history — once your trade log prices (or
            daily snapshots) cover 2+ days, the return chart appears here.
          </p>
        )
      ) : view === "invested" ? (
        <InvestedValueChart
          points={pts as InvestedPoint[]}
          formatMoney={(v) => money(v)}
          formatAxisMoney={(v) => fmtCompact(v)}
        />
      ) : view === "source" ? (
        <SourceStackChart
          layers={layers}
          formatMoney={(v) => money(v)}
          formatAxisMoney={(v) => fmtCompact(v)}
        />
      ) : (
        <MonthlyHeatmap cells={monthlyCells} formatMoney={(v) => money(v)} />
      )}
      {!isLoading && pts.length >= 2 && view === "value" && (
        <p className="mt-1 text-right text-[11px] text-zinc-500">
          {source === "true" ? (
            <>
              True historical value · holdings excl. cash · last point is
              today&apos;s live value
              {missingSymbols.length > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => setShowMissing(true)}
                    className="min-h-[44px] underline decoration-dotted underline-offset-2 hover:text-zinc-300"
                  >
                    {missingSymbols.length} symbol
                    {missingSymbols.length === 1 ? "" : "s"} lack
                    {missingSymbols.length === 1 ? "s" : ""} price history
                  </button>
                </>
              )}
            </>
          ) : source === "trades" ? (
            "From your trade log · last point is today's live value"
          ) : (
            "Daily snapshots"
          )}
        </p>
      )}
      {!isLoading && view === "pct" && pctPts.length >= 2 && (
        <p className="mt-1 text-right text-[11px] text-zinc-500">
          {source === "true"
            ? "Return on invested capital · holdings excl. cash · simple, not time-weighted"
            : `Cumulative simple return since ${first?.date} · not time-weighted — deposits/withdrawals shift it`}
        </p>
      )}
      {!isLoading && view === "invested" && hasInvested && (
        <p className="mt-1 text-right text-[11px] text-zinc-500">
          Cumulative invested vs true value · holdings excl. cash · the gap is
          your gain/loss
        </p>
      )}
      {!isLoading && view === "source" && layers.length > 0 && (
        <p className="mt-1 text-right text-[11px] text-zinc-500">
          True value by trade source · holdings excl. cash · tap legend chips
          to toggle layers
        </p>
      )}
      {showMissing && (
        <MissingPricesModal
          symbols={missingSymbols}
          onClose={() => setShowMissing(false)}
        />
      )}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <StatCard
          label="Annualized return (XIRR)"
          value={x == null ? "—" : `${(x * 100).toFixed(2)}%`}
          tone={xirrTone}
          info="True annualized return from your full trade log — every flow converted to USD. Appears once you have 30+ days of history; annualizing a shorter span would be noise. Excludes dividends."
          sub={xirrSub}
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
