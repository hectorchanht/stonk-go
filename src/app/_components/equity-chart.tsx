"use client";

import { useEffect, useRef } from "react";
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
  curveColor,
  toAreaData,
  type ChartDay,
  type EquityPoint,
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

/**
 * Interactive equity chart (TradingView lightweight-charts):
 * - crosshair with tooltip (date + value)
 * - drag to pan, scroll / pinch to zoom
 * - auto-resizes with its container
 *
 * The upstream `portfolio.equityCurve` returns a single series, so there is
 * one area series. (When the source is the trade log, the points already
 * represent net-invested with the last point replaced by today's live value.)
 */
export function EquityChart({
  points,
  formatMoney,
}: {
  points: EquityPoint[];
  /** Formats a USD value for the tooltip and price axis. */
  formatMoney: (v: number) => string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipDateRef = useRef<HTMLDivElement | null>(null);
  const tipValueRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{ chart: IChartApi; series: ISeriesApi<"Area"> } | null>(
    null,
  );
  const formatRef = useRef(formatMoney);

  useEffect(() => {
    formatRef.current = formatMoney;
  }, [formatMoney]);

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
      // Touch: horizontal drag pans the chart; vertical drag still scrolls
      // the page. Pinch zooms.
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
        priceFormatter: (p: number) => formatRef.current(p),
      },
    });

    const series = chart.addSeries(AreaSeries, {
      lineWidth: 2,
      lineColor: "#34d399",
      topColor: withAlpha("#34d399", 0.35),
      bottomColor: withAlpha("#34d399", 0.02),
      priceLineVisible: true,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
    });
    apiRef.current = { chart, series };

    chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
      const tip = tipRef.current;
      const host = containerRef.current;
      const api = apiRef.current;
      if (tip === null || host === null || api === null) return;
      if (param.point === undefined || param.time === undefined) {
        tip.style.display = "none";
        return;
      }
      const datum = param.seriesData.get(api.series) as
        | AreaData<Time>
        | undefined;
      if (datum === undefined) {
        tip.style.display = "none";
        return;
      }
      if (tipDateRef.current !== null)
        tipDateRef.current.textContent = timeToIso(param.time);
      if (tipValueRef.current !== null)
        tipValueRef.current.textContent = formatRef.current(datum.value);
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
    api.series.applyOptions({
      lineColor: color,
      topColor: withAlpha(color, 0.35),
      bottomColor: withAlpha(color, 0.02),
    });
    api.series.setData(toAreaData(points));
    api.chart.timeScale().fitContent();
  }, [points]);

  if (points.length < 2) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500">
        Log your first trade and your performance curve starts here — daily
        snapshots refine it each time you open the app.
      </p>
    );
  }

  return (
    <div ref={containerRef} className="relative h-[240px] w-full">
      <div
        ref={tipRef}
        className="pointer-events-none absolute left-0 top-0 z-10 hidden rounded-lg border border-zinc-700 bg-zinc-900/95 px-2.5 py-1.5 shadow-xl"
      >
        <div ref={tipDateRef} className="text-[11px] text-zinc-400" />
        <div
          ref={tipValueRef}
          className="text-sm font-semibold tabular-nums text-zinc-100"
        />
      </div>
    </div>
  );
}
