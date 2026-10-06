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
  type WhitespaceData,
} from "lightweight-charts";
import {
  chartDayToIso,
  isoToChartDay,
  type ChartDay,
  type EquityPoint,
} from "./equity-chart-data";

const CHART_HEIGHT = 240;
const UP = "#34d399";
const DOWN = "#fb7185";

/** Axis/tooltip label: +40.00%, -20.00% (percentages keep 2 decimals). */
export function formatPct(p: number): string {
  return `${p.toFixed(2)}%`;
}

function timeToIso(t: Time): string {
  if (typeof t === "object" && t !== null && "day" in t) {
    const d: ChartDay = { year: t.year, month: t.month, day: t.day };
    return chartDayToIso(d);
  }
  return String(t);
}

type PctDatum = LineData<Time> | WhitespaceData<Time>;

function splitSeries(points: EquityPoint[]): {
  up: PctDatum[];
  down: PctDatum[];
} {
  const up: PctDatum[] = [];
  const down: PctDatum[] = [];
  for (const p of points) {
    const time = isoToChartDay(p.date);
    if (time === null || !Number.isFinite(p.value)) continue;
    if (p.value >= 0) {
      up.push({ time, value: p.value });
      down.push({ time });
    } else {
      up.push({ time });
      down.push({ time, value: p.value });
    }
  }
  return { up, down };
}

/**
 * Cumulative % return chart (IBKR "Performance" tab style):
 * - green line above zero, red below zero, dashed zero line
 * - % y-axis (+40.00%), crosshair tooltip with date + %
 * - drag to pan, scroll / pinch to zoom, auto-resize
 *
 * `points` must be a cumulative simple % series (see toPercentSeries) —
 * simple return, NOT time-weighted. The parent labels it as such.
 */
export function ReturnChart({ points }: { points: EquityPoint[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipDateRef = useRef<HTMLDivElement | null>(null);
  const tipValueRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{
    chart: IChartApi;
    up: ISeriesApi<"Line">;
    down: ISeriesApi<"Line">;
  } | null>(null);

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
        priceFormatter: (p: number) => formatPct(p),
      },
    });

    const up = chart.addSeries(LineSeries, {
      lineWidth: 2,
      color: UP,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
    });
    const down = chart.addSeries(LineSeries, {
      lineWidth: 2,
      color: DOWN,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
    });
    up.createPriceLine({
      price: 0,
      color: "rgba(161,161,170,0.45)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "",
    });
    apiRef.current = { chart, up, down };

    chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
      const tip = tipRef.current;
      const host = containerRef.current;
      const api = apiRef.current;
      if (tip === null || host === null || api === null) return;
      if (param.point === undefined || param.time === undefined) {
        tip.style.display = "none";
        return;
      }
      const datum = (param.seriesData.get(api.up) ??
        param.seriesData.get(api.down)) as LineData<Time> | undefined;
      if (datum === undefined || !("value" in datum)) {
        tip.style.display = "none";
        return;
      }
      if (tipDateRef.current !== null)
        tipDateRef.current.textContent = timeToIso(param.time);
      if (tipValueRef.current !== null) {
        tipValueRef.current.textContent = formatPct(datum.value);
        tipValueRef.current.style.color =
          datum.value >= 0 ? UP : DOWN;
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
    const { up, down } = splitSeries(points);
    api.up.setData(up);
    api.down.setData(down);
    api.chart.timeScale().fitContent();
  }, [points]);

  if (points.length < 2) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500">
        Not enough points to chart yet.
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
          className="text-sm font-semibold tabular-nums"
        />
      </div>
    </div>
  );
}
