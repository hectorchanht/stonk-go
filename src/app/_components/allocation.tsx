"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { RouterOutputs } from "~/trpc/react";
import { useCurrency } from "./currency";

type HoldingRow = RouterOutputs["portfolio"]["summary"]["rows"][number];

/** Categorical palette tuned for dark-first UI; "Others" is always zinc. */
const SLICE_COLORS = [
  "#4ade80",
  "#60a5fa",
  "#f472b6",
  "#fbbf24",
  "#a78bfa",
  "#2dd4bf",
  "#fb7185",
  "#f97316",
];
const OTHERS_COLOR = "#52525b";
const TOP_SLICES = 7;
const LEGEND_PREVIEW = 5;

interface Slice {
  symbol: string;
  value: number;
  pct: number;
  color: string;
}

const pct = (v: number) => `${v.toFixed(1)}%`;

/**
 * Allocation as a donut chart with a collapsed legend.
 *
 * Long tail, collapsed: the donut shows the top 7 positions + one "Others"
 * slice; the legend previews the top 5 and expands to the full list on tap.
 * Hover/tap on a slice or legend row spotlights it in the donut center.
 */
export function AllocationDonut({ rows }: { rows: HoldingRow[] }) {
  const { fmt } = useCurrency();
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState<number | null>(null);

  const { slices, total, count, legend } = useMemo(() => {
    const priced = rows
      .filter((r) => r.marketValue != null && r.marketValue > 0)
      .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
    const total = priced.reduce((s, r) => s + (r.marketValue ?? 0), 0);
    if (priced.length === 0 || total <= 0)
      return { slices: [], total: 0, count: 0, legend: [] as { slice: number; symbol: string; value: number; pct: number; color: string }[] };

    const top = priced.slice(0, TOP_SLICES);
    const rest = priced.slice(TOP_SLICES);
    const slices: Slice[] = top.map((r, i) => ({
      symbol: r.symbol,
      value: r.marketValue ?? 0,
      pct: ((r.marketValue ?? 0) / total) * 100,
      color: SLICE_COLORS[i % SLICE_COLORS.length]!,
    }));
    let othersIdx = -1;
    if (rest.length > 0) {
      const rv = rest.reduce((s, r) => s + (r.marketValue ?? 0), 0);
      othersIdx = slices.length;
      slices.push({
        symbol: `Others (${rest.length})`,
        value: rv,
        pct: (rv / total) * 100,
        color: OTHERS_COLOR,
      });
    }
    // Full legend: every holding, mapped back to its donut slice
    // (tail holdings spotlight the "Others" slice).
    const legend = priced.map((r, i) => ({
      slice: i < TOP_SLICES ? i : othersIdx,
      symbol: r.symbol,
      value: r.marketValue ?? 0,
      pct: ((r.marketValue ?? 0) / total) * 100,
      color: i < TOP_SLICES ? SLICE_COLORS[i % SLICE_COLORS.length]! : OTHERS_COLOR,
    }));
    return { slices, total, count: priced.length, legend };
  }, [rows]);

  if (slices.length === 0) return null;

  const R = 75;
  const C = 2 * Math.PI * R;
  const STROKE = 30;
  let acc = 0;
  const arcs = slices.map((s, i) => {
    const len = Math.max((s.pct / 100) * C - 2, 0.5); // 2px gap between slices
    const a = { ...s, dash: len, offset: acc, index: i };
    acc += (s.pct / 100) * C;
    return a;
  });

  const activeSlice = active != null ? slices[active] : null;
  const visibleLegend = expanded ? legend : legend.slice(0, LEGEND_PREVIEW);

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 sm:p-5">
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:gap-6">
        {/* Donut */}
        <div className="relative shrink-0">
          <svg
            width={180}
            height={180}
            viewBox="0 0 180 180"
            role="img"
            aria-label={`Allocation across ${count} positions`}
          >
            {arcs.map((a) => {
              const dim = active != null && active !== a.index;
              return (
                <circle
                  key={a.index}
                  cx={90}
                  cy={90}
                  r={R}
                  fill="none"
                  stroke={a.color}
                  strokeWidth={active === a.index ? STROKE + 6 : STROKE}
                  strokeDasharray={`${a.dash} ${C - a.dash}`}
                  strokeDashoffset={-a.offset}
                  transform="rotate(-90 90 90)"
                  opacity={dim ? 0.3 : 1}
                  className="cursor-pointer transition-all"
                  onMouseEnter={() => setActive(a.index)}
                  onMouseLeave={() => setActive(null)}
                  onClick={() =>
                    setActive((cur) => (cur === a.index ? null : a.index))
                  }
                >
                  <title>{`${a.symbol} · ${pct(a.pct)} · ${fmt(a.value)}`}</title>
                </circle>
              );
            })}
          </svg>
          {/* Center readout */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            {activeSlice ? (
              <>
                <span className="max-w-[110px] truncate text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  {activeSlice.symbol}
                </span>
                <span className="text-xl font-extrabold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {pct(activeSlice.pct)}
                </span>
                <span className="text-xs tabular-nums text-zinc-500">
                  {fmt(activeSlice.value)}
                </span>
              </>
            ) : (
              <>
                <span className="text-xl font-extrabold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {fmt(total)}
                </span>
                <span className="text-xs text-zinc-500">
                  {count} position{count === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Legend — collapsed by default */}
        <div className="w-full min-w-0 flex-1">
          <ul
            className={`space-y-0.5 ${
              expanded ? "max-h-64 overflow-y-auto pr-1" : ""
            }`}
          >
            {visibleLegend.map((l, i) => (
              <li key={`${l.symbol}-${i}`}>
                <button
                  type="button"
                  onClick={() =>
                    setActive((cur) => (cur === l.slice ? null : l.slice))
                  }
                  onMouseEnter={() => setActive(l.slice)}
                  onMouseLeave={() => setActive(null)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                    active === l.slice
                      ? "bg-zinc-100 dark:bg-zinc-800"
                      : "hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: l.color }}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium text-zinc-800 dark:text-zinc-200">
                    {l.symbol}
                  </span>
                  <span className="shrink-0 tabular-nums text-zinc-500">
                    {fmt(l.value)}
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                    {pct(l.pct)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {legend.length > LEGEND_PREVIEW && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="mt-1.5 flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              {expanded
                ? "Show less"
                : `Show all ${legend.length} positions`}
              <ChevronDown
                size={13}
                className={`transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
