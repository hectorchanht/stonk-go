"use client";

import { useMemo, useState } from "react";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Structural mirror of the server's MonthCell (tRPC-inferred). */
export interface HeatmapCell {
  month: string; // "2026-10"
  year: number;
  monthIndex: number; // 0-11
  startValue: number;
  endValue: number;
  netFlow: number;
  gain: number;
  pct: number | null;
}

/** Cell label: +2.4% (percentages keep one decimal here). */
export function formatCellPct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

function cellColors(pct: number | null): {
  backgroundColor: string;
  color: string;
} {
  if (pct == null || !Number.isFinite(pct)) {
    return { backgroundColor: "rgba(63,63,70,0.35)", color: "#71717a" };
  }
  const intensity = Math.min(Math.abs(pct) / 8, 1);
  const alpha = 0.15 + 0.6 * intensity;
  return pct >= 0
    ? { backgroundColor: `rgba(52,211,153,${alpha.toFixed(2)})`, color: "#a7f3d0" }
    : {
        backgroundColor: `rgba(251,113,133,${alpha.toFixed(2)})`,
        color: "#fecdd3",
      };
}

/**
 * Monthly-returns heatmap: one row per year, Jan–Dec columns. Cell color
 * intensity = monthly % return net of deposits (green/red). Tapping a cell
 * shows the month's detail below.
 */
export function MonthlyHeatmap({
  cells,
  formatMoney,
}: {
  cells: HeatmapCell[];
  /** Formats a USD value (whole units, no decimals). */
  formatMoney: (v: number) => string;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const years = useMemo(() => {
    const byYear = new Map<number, Map<number, HeatmapCell>>();
    for (const c of cells) {
      let m = byYear.get(c.year);
      if (!m) {
        m = new Map();
        byYear.set(c.year, m);
      }
      m.set(c.monthIndex, c);
    }
    return [...byYear.entries()].sort((a, b) => b[0] - a[0]);
  }, [cells]);

  const selectedCell = useMemo(
    () => cells.find((c) => c.month === selected) ?? null,
    [cells, selected],
  );

  if (cells.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500">
        Monthly returns appear once your daily history covers a full month.
      </p>
    );
  }

  const moneyRow = (
    label: string,
    value: number,
    opts?: { sign?: boolean; tone?: "pos" | "neg" | "neutral" },
  ): React.ReactNode => {
    const signed =
      opts?.sign && value !== 0
        ? `${value > 0 ? "+" : "−"}${formatMoney(Math.abs(value))}`
        : formatMoney(value);
    const color =
      opts?.tone === "pos"
        ? "text-emerald-400"
        : opts?.tone === "neg"
          ? "text-rose-400"
          : "text-zinc-200";
    return (
      <div className="flex items-center justify-between py-0.5">
        <span className="text-[11px] text-zinc-400">{label}</span>
        <span className={`text-sm font-semibold tabular-nums ${color}`}>
          {signed}
        </span>
      </div>
    );
  };

  return (
    <div className="w-full">
      {years.map(([year, byMonth]) => (
        <div key={year} className="mb-3">
          <div className="mb-1 text-xs font-semibold text-zinc-400">{year}</div>
          <div className="grid grid-cols-12 gap-1">
            {Array.from({ length: 12 }, (_, mi) => {
              const cell = byMonth.get(mi);
              const key = `${year}-${String(mi + 1).padStart(2, "0")}`;
              const isSel = selected === (cell?.month ?? key);
              const colors = cellColors(cell?.pct ?? null);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => cell && setSelected(isSel ? null : cell.month)}
                  disabled={!cell}
                  title={
                    cell
                      ? `${MONTH_NAMES[mi]} ${year}: ${formatCellPct(cell.pct)}`
                      : `${MONTH_NAMES[mi]} ${year}: no data`
                  }
                  aria-label={
                    cell
                      ? `${MONTH_NAMES[mi]} ${year}, return ${formatCellPct(cell.pct)}`
                      : `${MONTH_NAMES[mi]} ${year}, no data`
                  }
                  className={`flex h-10 items-center justify-center rounded-md text-[9px] font-bold tabular-nums transition-transform ${
                    isSel ? "ring-2 ring-zinc-300" : ""
                  } ${cell ? "active:scale-95" : "cursor-default"}`}
                  style={colors}
                >
                  {cell ? formatCellPct(cell.pct) : ""}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {selectedCell !== null && (
        <div className="mt-2 rounded-xl border border-zinc-700 bg-zinc-800/60 p-3">
          <div className="mb-1 text-sm font-bold text-zinc-100">
            {MONTH_NAMES[selectedCell.monthIndex]} {selectedCell.year}
          </div>
          <div className="flex items-center justify-between py-0.5">
            <span className="text-[11px] text-zinc-400">Value</span>
            <span className="text-sm font-semibold tabular-nums text-zinc-200">
              {formatMoney(selectedCell.startValue)} →{" "}
              {formatMoney(selectedCell.endValue)}
            </span>
          </div>
          {moneyRow("Net deposited", selectedCell.netFlow, {
            sign: true,
            tone: "neutral",
          })}
          {moneyRow("Gain", selectedCell.gain, {
            sign: true,
            tone:
              selectedCell.gain > 0
                ? "pos"
                : selectedCell.gain < 0
                  ? "neg"
                  : "neutral",
          })}
          <div className="flex items-center justify-between py-0.5">
            <span className="text-[11px] text-zinc-400">Return</span>
            <span
              className={`text-sm font-semibold tabular-nums ${
                selectedCell.pct == null
                  ? "text-zinc-400"
                  : selectedCell.pct > 0
                    ? "text-emerald-400"
                    : selectedCell.pct < 0
                      ? "text-rose-400"
                      : "text-zinc-200"
              }`}
            >
              {formatCellPct(selectedCell.pct)}
            </span>
          </div>
        </div>
      )}

      <p className="mt-2 text-right text-[11px] text-zinc-500">
        Monthly return net of deposits · simple, not time-weighted
      </p>
    </div>
  );
}
