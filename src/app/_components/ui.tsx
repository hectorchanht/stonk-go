"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";

/**
 * Small ⓘ that explains a section. Hover/focus shows it on desktop,
 * tap toggles it on touch screens.
 */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Touch devices fire mouseenter before click on the first tap — without
  // this guard the click would instantly toggle shut what hover just opened,
  // forcing two taps to open.
  const hoverOpened = useRef(false);
  return (
    <span
      className="relative inline-block align-middle"
      onClick={(e) => e.stopPropagation()}
    >      <button
        type="button"
        aria-label="What is this?"
        onClick={() => {
          if (hoverOpened.current) {
            hoverOpened.current = false; // consume: this click is the same tap
            return;
          }
          setOpen((o) => !o);
        }}
        onMouseEnter={() => {
          hoverOpened.current = true;
          setOpen(true);
        }}
        onMouseLeave={() => {
          hoverOpened.current = false;
          setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-600 align-middle text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 hover:text-zinc-800 dark:text-zinc-200"
      >
        <Info size={10} strokeWidth={2.5} />
      </button>
      {open && (
        <span className="absolute left-1/2 top-full z-30 mt-1.5 w-60 -translate-x-1/2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 p-2.5 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-zinc-700 dark:text-zinc-300 shadow-xl">
          {text}
        </span>
      )}
    </span>
  );
}

const collapsedKey = (id: string) => `holdr.ui.collapsed.${id}`;

/**
 * Every dashboard section is collapsible. The open/closed state persists
 * in localStorage. Other components can force a section open by dispatching:
 *   window.dispatchEvent(new CustomEvent("holdr:open-section", { detail: id }))
 */
export function CollapsibleSection({
  id,
  title,
  info,
  badge,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: React.ReactNode;
  info?: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultOpen;
    try {
      const raw = window.localStorage.getItem(collapsedKey(id));
      return raw == null ? defaultOpen : raw !== "1";
    } catch {
      return defaultOpen;
    }
  });

  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) setOpen(true);
    };
    window.addEventListener("holdr:open-section", handler);
    return () => window.removeEventListener("holdr:open-section", handler);
  }, [id]);

  const toggle = () => {
    setOpen((o) => {
      try {
        window.localStorage.setItem(collapsedKey(id), o ? "1" : "0");
      } catch {
        /* ignore */
      }
      return !o;
    });
  };

  return (
    <section id={`section-${id}`} className="scroll-mt-4">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="flex w-full cursor-pointer items-center gap-2 py-1 text-left"
      >
        <span
          className={`shrink-0 text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <ChevronRight size={14} />
        </span>
        <span className="text-sm font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
          {title}
        </span>
        {badge}
        {info && <InfoTip text={info} />}
      </div>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}

/* ---------------- shared stat card ---------------- */

/**
 * Big-number card used by the portfolio overview and the IBKR trade
 * analysis. The value uses a fluid clamp() size so long currency strings
 * (e.g. "+HK$22,197.30") shrink instead of overflowing their card on
 * narrow screens.
 */
export function StatCard({
  label,
  value,
  sub,
  tone,
  info,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "pos" | "neg" | "neutral";
  info?: string;
}) {
  const toneClass =
    tone === "pos"
      ? "text-emerald-400"
      : tone === "neg"
        ? "text-rose-400"
        : "text-zinc-900 dark:text-zinc-100";
  return (
    <div className="min-w-0 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/60 p-3 sm:p-5">
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
        {info && <InfoTip text={info} />}
      </div>
      <div
        className={`mt-1 break-words font-bold tabular-nums leading-tight ${toneClass} text-[clamp(1.15rem,5vw,1.875rem)]`}
      >
        {value}
      </div>
      {sub != null && sub !== "" && (
        <div className="mt-1 truncate text-sm text-zinc-500">{sub}</div>
      )}
    </div>
  );
}

/* ---------------- unified table ---------------- */

export interface DataColumn<T> {
  key: string;
  header: React.ReactNode;
  align?: "left" | "center" | "right";
  render: (row: T) => React.ReactNode;
}

/**
 * The one table style every section uses: uppercase zinc header row,
 * hairline dividers, hover highlight, horizontal scroll on overflow.
 * Pass `minWidth` (e.g. "720px") for wide tables on mobile.
 */
export function DataTable<T>({
  columns,
  rows,
  keyOf,
  minWidth,
  emptyText,
  footer,
}: {
  columns: DataColumn<T>[];
  rows: T[];
  keyOf: (row: T, index: number) => string;
  minWidth?: string;
  emptyText?: string;
  footer?: React.ReactNode;
}) {
  const alignCls = (a?: DataColumn<T>["align"]) =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
  return (
    <div>
      <div className="overflow-x-auto">
        <table
          className="w-full text-sm"
          style={minWidth ? { minWidth } : undefined}
        >
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800 text-xs uppercase tracking-wider text-zinc-500">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`px-3 py-2 font-medium ${alignCls(c.align)}`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={keyOf(r, i)}
                className="border-b border-zinc-200 dark:border-zinc-800/60 last:border-0 hover:bg-zinc-800/30"
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`px-3 py-2.5 align-top ${alignCls(c.align)} ${
                      c.align === "right" ? "tabular-nums" : ""
                    }`}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && emptyText && (
        <p className="px-3 py-4 text-sm text-zinc-500">{emptyText}</p>
      )}
      {footer}
    </div>
  );
}

/* ---------------- pagination ---------------- */

/** Client-side pager state for a list that is already in memory. */
export function usePager<T>(items: T[], pageSize: number) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const go = useCallback(
    (p: number) => setPage(Math.max(0, Math.min(p, pageCount - 1))),
    [pageCount],
  );
  return {
    page: safePage,
    pageCount,
    rows: items.slice(safePage * pageSize, safePage * pageSize + pageSize),
    setPage: go,
    reset: () => setPage(0),
  };
}

/** Compact ‹ Page x of y › pager, rendered as a table footer. */
export function Pagination({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const btn =
    "rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 p-1.5 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-700 disabled:opacity-40";
  return (
    <div className="flex items-center justify-between border-t border-zinc-200 dark:border-zinc-800/60 px-3 py-2">
      <span className="text-xs tabular-nums text-zinc-500">
        Page {page + 1} of {pageCount}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page === 0}
          aria-label="Previous page"
          className={btn}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page === pageCount - 1}
          aria-label="Next page"
          className={btn}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

/* ---------------- csv export ---------------- */

/** Download a CSV file built from header + row arrays (values are quoted as needed). */
export function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number | null | undefined)[][],
) {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- loading skeletons ---------------- */

/** Single pulsing bar. */
export function SkeletonBar({
  width = "100%",
  height = "1rem",
  className = "",
}: {
  width?: string;
  height?: string;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded bg-zinc-200 dark:bg-zinc-800 ${className}`}
      style={{ width, height }}
    />
  );
}

/** Skeleton for the 4 stat cards in Portfolio overview. */
export function StatCardSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/60 p-4"
        >
          <SkeletonBar width="40%" height="0.75rem" className="mb-3" />
          <SkeletonBar width="70%" height="1.5rem" className="mb-2" />
          <SkeletonBar width="55%" height="0.75rem" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton rows for lists/tables. */
export function RowSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonBar
          key={i}
          width={`${94 - i * 7}%`}
          height="1.1rem"
        />
      ))}
    </div>
  );
}

/** Spinning loader with optional label. */
export function Spinner({
  label,
  size = 16,
}: {
  label?: string;
  size?: number;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className="animate-spin"
        aria-hidden
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="3"
          className="opacity-20"
        />
        <path
          d="M22 12a10 10 0 0 0-10-10"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      {label && <span>{label}</span>}
    </span>
  );
}

/** Three bouncing dots for chat/AI "thinking" states. */
export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}
