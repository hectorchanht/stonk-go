"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type AreaData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import {
  chartDayToIso,
  stackLayers,
  type ChartDay,
  type SourceLayer,
  type StackedLayer,
} from "./equity-chart-data";

const CHART_HEIGHT = 240;

function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

function timeToIso(t: Time): string {
  if (typeof t === "object" && t !== null && "day" in t) {
    const d: ChartDay = { year: t.year, month: t.month, day: t.day };
    return chartDayToIso(d);
  }
  return String(t);
}

interface SeriesEntry {
  api: ISeriesApi<"Area">;
  layer: StackedLayer;
}

/**
 * Stacked area chart of the true value curve, one layer per trade source
 * (IBKR, Manual, …). The legend chips below toggle layers on/off; the stack
 * recomputes from the visible layers only. Tooltip shows the date, the
 * total, and each visible layer's own value.
 */
export function SourceStackChart({
  layers,
  formatMoney,
  formatAxisMoney,
}: {
  layers: SourceLayer[];
  /** Formats a USD value (whole units, no decimals). */
  formatMoney: (v: number) => string;
  /** Compact labels for the price axis (HK$1.1M); defaults to formatMoney. */
  formatAxisMoney?: (v: number) => string;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipDateRef = useRef<HTMLDivElement | null>(null);
  const tipRowsRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<SeriesEntry[]>([]);
  const formatRef = useRef(formatMoney);
  const formatAxisRef = useRef(formatAxisMoney ?? formatMoney);

  useEffect(() => {
    formatRef.current = formatMoney;
    formatAxisRef.current = formatAxisMoney ?? formatMoney;
  }, [formatMoney, formatAxisMoney]);

  const visible = useMemo(
    () => layers.filter((l) => !hidden.has(l.key)),
    [layers, hidden],
  );
  const stacked = useMemo(() => stackLayers(visible), [visible]);

  const toggle = (key: string): void => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    const chart = createChart(el, {
      width: Math.max(1, el.clientWidth),
      height: CHART_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#a1a1aa",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(161,161,170,0.14)" },
        horzLines: { color: "rgba(161,161,170,0.14)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(161,161,170,0.5)",
          labelBackgroundColor: "#3f3f46",
        },
        horzLine: {
          color: "rgba(161,161,170,0.5)",
          labelBackgroundColor: "#3f3f46",
        },
      },
      rightPriceScale: { borderColor: "rgba(161,161,170,0.25)" },
      timeScale: {
        borderColor: "rgba(161,161,170,0.25)",
        timeVisible: false,
        secondsVisible: false,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
      localization: {
        priceFormatter: (p: number) => formatAxisRef.current(p),
      },
    });
    chartRef.current = chart;

    chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
      const tip = tipRef.current;
      const host = containerRef.current;
      const entries = seriesRef.current;
      if (tip === null || host === null || entries.length === 0) return;
      if (param.point === undefined || param.time === undefined) {
        tip.style.display = "none";
        return;
      }
      const fmt = formatRef.current;
      // Own value of each visible layer at the hovered time: entries are
      // bottom-to-top, so own[i] = cumulative[i] − cumulative[i−1].
      const cumValues: number[] = [];
      let any = false;
      for (const e of entries) {
        const datum = param.seriesData.get(e.api) as
          | AreaData<Time>
          | undefined;
        if (datum === undefined || !("value" in datum)) {
          cumValues.push(NaN);
          continue;
        }
        any = true;
        cumValues.push(datum.value);
      }
      if (!any) {
        tip.style.display = "none";
        return;
      }
      const rows: Array<{ label: string; value: number; color: string }> = [];
      let total = 0;
      entries.forEach((e, idx) => {
        const cur = cumValues[idx]!;
        if (!Number.isFinite(cur)) return;
        const below = idx > 0 ? cumValues[idx - 1]! : 0;
        const own = Number.isFinite(below) ? cur - below : cur;
        total += own;
        rows.push({ label: e.layer.label, value: own, color: e.layer.color });
      });
      if (tipDateRef.current !== null)
        tipDateRef.current.textContent = timeToIso(param.time);
      if (tipRowsRef.current !== null) {
        tipRowsRef.current.innerHTML = "";
        const totalRow = document.createElement("div");
        totalRow.className = "flex items-center justify-between gap-3";
        const tl = document.createElement("span");
        tl.className = "text-[11px] font-semibold text-zinc-300";
        tl.textContent = "Total";
        const tr = document.createElement("span");
        tr.className = "text-sm font-bold tabular-nums text-zinc-100";
        tr.textContent = fmt(total);
        totalRow.append(tl, tr);
        tipRowsRef.current.append(totalRow);
        for (const r of rows) {
          const row = document.createElement("div");
          row.className = "flex items-center justify-between gap-3";
          const dot = document.createElement("span");
          dot.className = "mr-1 inline-block h-2 w-2 shrink-0 rounded-full";
          dot.style.backgroundColor = r.color;
          const l = document.createElement("span");
          l.className = "flex items-center text-[11px] text-zinc-400";
          l.append(dot, document.createTextNode(r.label));
          const v = document.createElement("span");
          v.className = "text-[13px] font-semibold tabular-nums text-zinc-200";
          v.textContent = fmt(r.value);
          row.append(l, v);
          tipRowsRef.current.append(row);
        }
      }
      tip.style.display = "block";
      const x = param.point.x;
      const y = param.point.y;
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      const hostW = host.clientWidth;
      tip.style.left = `${x + 12 + tipW > hostW ? x - tipW - 12 : x + 12}px`;
      tip.style.top = `${Math.max(0, y - tipH - 12)}px`;
    });

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w === undefined || w <= 0) return;
      chart.applyOptions({ width: Math.floor(w), height: CHART_HEIGHT });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, []);

  // Rebuild the series whenever the visible set changes (bottom-to-top).
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    for (const e of seriesRef.current) {
      try {
        chart.removeSeries(e.api);
      } catch {
        /* already removed */
      }
    }
    const entries: SeriesEntry[] = stacked.map((layer) => {
      const api = chart.addSeries(AreaSeries, {
        lineWidth: 2,
        lineColor: layer.color,
        topColor: withAlpha(layer.color, 0.35),
        bottomColor: withAlpha(layer.color, 0.04),
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      api.setData(layer.cumulative);
      return { api, layer };
    });
    seriesRef.current = entries;
    chart.timeScale().fitContent();
  }, [stacked]);

  if (layers.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500">
        Per-source history needs the true value curve — it appears once your
        trade log prices cover 2+ days.
      </p>
    );
  }

  return (
    <div className="w-full">
      <div ref={containerRef} className="relative h-[240px] w-full">
        <div
          ref={tipRef}
          className="pointer-events-none absolute left-0 top-0 z-10 hidden rounded-lg border border-zinc-700 bg-zinc-900/95 px-2.5 py-1.5 shadow-xl"
        >
          <div ref={tipDateRef} className="text-[11px] text-zinc-400" />
          <div ref={tipRowsRef} className="mt-0.5 space-y-0.5" />
        </div>
      </div>
      {visible.length === 0 && (
        <p className="py-4 text-center text-xs text-zinc-500">
          All sources hidden — tap a chip below to show one.
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {layers.map((l) => {
          const off = hidden.has(l.key);
          const latest = l.points[l.points.length - 1]!.value;
          return (
            <button
              key={l.key}
              type="button"
              onClick={() => toggle(l.key)}
              aria-pressed={!off}
              title={`${off ? "Show" : "Hide"} ${l.label}`}
              className={`flex min-h-[44px] items-center gap-2 rounded-full border px-3.5 text-sm font-semibold transition-opacity ${
                off
                  ? "border-zinc-700 bg-zinc-800/40 text-zinc-500 opacity-50"
                  : "border-zinc-600 bg-zinc-800 text-zinc-200"
              }`}
            >
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: l.color }}
              />
              {l.label}
              <span className="tabular-nums text-zinc-400">
                {(formatAxisMoney ?? formatMoney)(latest)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
