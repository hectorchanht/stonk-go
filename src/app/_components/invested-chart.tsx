"use client";

import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import {
  chartDayToIso,
  curveColor,
  toAreaData,
  type ChartDay,
  type EquityPoint,
  type InvestedPoint,
} from "./equity-chart-data";

const CHART_HEIGHT = 240;
const INVESTED_COLOR = "#a1a1aa";

function timeToIso(t: Time): string {
  if (typeof t === "object" && t !== null && "day" in t) {
    const d: ChartDay = { year: t.year, month: t.month, day: t.day };
    return chartDayToIso(d);
  }
  return String(t);
}

/**
 * Invested vs Value: cumulative net invested (gray, dashed) against the true
 * portfolio value (emerald/rose by period). The gap between the lines IS the
 * gain/loss. Tooltip shows date, value, invested, and the signed difference.
 *
 * `points` must carry `invested` (true-curve points do).
 */
export function InvestedValueChart({
  points,
  formatMoney,
  formatAxisMoney,
}: {
  points: InvestedPoint[];
  /** Formats a USD value (whole units, no decimals). */
  formatMoney: (v: number) => string;
  /** Compact labels for the price axis (HK$1.1M); defaults to formatMoney. */
  formatAxisMoney?: (v: number) => string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipDateRef = useRef<HTMLDivElement | null>(null);
  const tipRowsRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{
    chart: IChartApi;
    value: ISeriesApi<"Line">;
    invested: ISeriesApi<"Line">;
  } | null>(null);
  const formatRef = useRef(formatMoney);
  const formatAxisRef = useRef(formatAxisMoney ?? formatMoney);

  useEffect(() => {
    formatRef.current = formatMoney;
    formatAxisRef.current = formatAxisMoney ?? formatMoney;
  }, [formatMoney, formatAxisMoney]);

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

    const invested = chart.addSeries(LineSeries, {
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      color: INVESTED_COLOR,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
    });
    const value = chart.addSeries(LineSeries, {
      lineWidth: 2,
      color: "#34d399",
      priceLineVisible: true,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
    });
    apiRef.current = { chart, value, invested };

    chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
      const tip = tipRef.current;
      const host = containerRef.current;
      const api = apiRef.current;
      if (tip === null || host === null || api === null) return;
      if (param.point === undefined || param.time === undefined) {
        tip.style.display = "none";
        return;
      }
      const vDatum = param.seriesData.get(api.value) as
        | LineData<Time>
        | undefined;
      const iDatum = param.seriesData.get(api.invested) as
        | LineData<Time>
        | undefined;
      if (
        vDatum === undefined ||
        !("value" in vDatum) ||
        iDatum === undefined ||
        !("value" in iDatum)
      ) {
        tip.style.display = "none";
        return;
      }
      const fmt = formatRef.current;
      const diff = vDatum.value - iDatum.value;
      const diffSign = diff > 0 ? "+" : diff < 0 ? "−" : "";
      const diffColor = diff > 0 ? "#34d399" : diff < 0 ? "#fb7185" : "#a1a1aa";
      if (tipDateRef.current !== null)
        tipDateRef.current.textContent = timeToIso(param.time);
      if (tipRowsRef.current !== null) {
        tipRowsRef.current.innerHTML = "";
        const rows: Array<[string, string, string]> = [
          ["Value", fmt(vDatum.value), "#e4e4e7"],
          ["Invested", fmt(iDatum.value), INVESTED_COLOR],
          ["P/L", `${diffSign}${fmt(Math.abs(diff))}`, diffColor],
        ];
        for (const [label, val, color] of rows) {
          const row = document.createElement("div");
          row.className = "flex items-center justify-between gap-3";
          const l = document.createElement("span");
          l.className = "text-[11px] text-zinc-400";
          l.textContent = label;
          const r = document.createElement("span");
          r.className = "text-sm font-semibold tabular-nums";
          r.style.color = color;
          r.textContent = val;
          row.append(l, r);
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
      apiRef.current = null;
    };
  }, []);

  // Push new data (range switch) into the existing chart.
  useEffect(() => {
    const api = apiRef.current;
    if (api === null) return;
    const color = curveColor(points);
    api.value.applyOptions({ color });
    api.value.setData(toAreaData(points));
    api.invested.setData(
      toAreaData(
        points.map((p) => ({
          date: p.date,
          value:
            p.invested != null && Number.isFinite(p.invested)
              ? p.invested
              : NaN,
        })),
      ),
    );
    api.chart.timeScale().fitContent();
  }, [points]);

  const hasInvested = points.some(
    (p) => p.invested != null && Number.isFinite(p.invested),
  );
  if (points.length < 2 || !hasInvested) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500">
        The invested baseline needs the true value curve — it appears once
        your trade log prices cover 2+ days.
      </p>
    );
  }

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center gap-4 text-[11px] text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-[3px] w-5 rounded"
            style={{ backgroundColor: "#34d399" }}
          />
          Value
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-0 w-5 border-t-2 border-dashed"
            style={{ borderColor: INVESTED_COLOR }}
          />
          Invested
        </span>
      </div>
      <div ref={containerRef} className="relative h-[240px] w-full">
        <div
          ref={tipRef}
          className="pointer-events-none absolute left-0 top-0 z-10 hidden rounded-lg border border-zinc-700 bg-zinc-900/95 px-2.5 py-1.5 shadow-xl"
        >
          <div ref={tipDateRef} className="text-[11px] text-zinc-400" />
          <div ref={tipRowsRef} className="mt-0.5 space-y-0.5" />
        </div>
      </div>
    </div>
  );
}
