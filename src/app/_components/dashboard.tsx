"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { signOut, useSession } from "next-auth/react";
import {
  ArrowDown,
  ArrowUp,
  ArrowLeftRight,
  Bell,
  BellRing,
  Briefcase,
  Download,
  GripVertical,
  Landmark,
  LayoutDashboard,
  LogIn,
  LogOut,
  Maximize2,
  MessageCircle,
  MoreHorizontal,
  PieChart,
  Plus,
  Receipt,
  RefreshCw,
  Rocket,
  Search,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { BrokerCard } from "~/app/_components/broker";
import { QuestradeCard } from "~/app/_components/questrade";
import { ExchangeCards, type ExchangePositionLike } from "~/app/_components/exchanges";
import {
  PerformanceSection,
  useSnapshotRecorder,
} from "~/app/_components/performance";
import { PriceAlerts } from "~/app/_components/price-alerts";
import {
  PNL_PERIODS,
  PNL_PERIOD_KEY,
  parsePnlPeriodKey,
  pnlForPeriod,
  pnlPeriodDays,
  shortDate,
  type PnlPeriodKey,
} from "~/app/_components/pnl-period";
import {
  DataTable,
  Pagination,
  RowSkeleton,
  Spinner,
  StatCard,
  StatCardSkeleton,
  downloadCsv,
  usePager,
  type DataColumn,
} from "~/app/_components/ui";
import {
  ResetLayoutButton,
  WidgetGrid,
  WidgetSection,
  useDashboardLayout,
  type WidgetDef,
} from "~/app/_components/widgets";
import {
  HOLDINGS_ALL_COLUMNS,
  HOLDINGS_COLUMNS_KEY,
  HOLDINGS_DEFAULT_COLUMNS,
  parseStoredColumns,
  toggleColumnKey,
  type HoldingColumnKey,
} from "~/app/_components/holdings-columns";
import { AllocationDonut } from "~/app/_components/allocation";
import { AiInsights } from "~/app/_components/insights";
import { AiChat } from "~/app/_components/ai-chat";
import { SmartAlerts } from "~/app/_components/smart-alerts";
import {
  CurrencyPicker,
  CurrencyProvider,
  useCurrency,
} from "~/app/_components/currency";
import {
  AiLocalePicker,
  LocalePicker,
  LocaleProvider,
} from "~/app/_components/locale";
import { BackupButtons } from "~/app/_components/backup";
import { PushToggle } from "~/app/_components/push-toggle";
import {
  FlairBadge,
  YoloMeter,
  GainLossPorn,
} from "~/app/_components/wsb";
import type { PositionFlair } from "~/server/wsb";

type Summary = RouterOutputs["portfolio"]["summary"];
type HoldingRow = Summary["rows"][number];

/** Broker snapshot positions as the summary API expects them. */
interface BrokerPositionInput {
  symbol: string;
  quantity: number;
  markPrice: number | null;
  costBasisPrice?: number | null;
  /** Source label shown on the Holdings badge ("IBKR", "COINBASE", ...). */
  label?: string | null;
}

/** Format a USD amount in the user's selected display currency. */
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

const plClass = (v: number | null) =>
  v == null ? "text-zinc-600 dark:text-zinc-400" : v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-zinc-600 dark:text-zinc-400";

const card =
  "rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/60 p-4 sm:p-5";

type HoldingSortKey = "symbol" | "marketValue" | "dayPL" | "totalPL" | "weightPct";

function HoldingsTable({
  rows,
  flair,
}: {
  rows: HoldingRow[];
  flair?: Record<string, PositionFlair>;
}) {
  const money = useMoney();
  const utils = api.useUtils();
  const del = api.portfolio.deleteHolding.useMutation({
    onSuccess: () => {
      void utils.portfolio.summary.invalidate();
      void utils.portfolio.transactions.invalidate();
      void utils.portfolio.flair.invalidate();
    },
  });

  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<HoldingSortKey>("marketValue");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  // User-pickable table columns (Symbol + actions are always shown).
  const [visibleCols, setVisibleCols] =
    useState<HoldingColumnKey[]>(HOLDINGS_DEFAULT_COLUMNS);
  const [colsHydrated, setColsHydrated] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  useEffect(() => {
    try {
      const stored = parseStoredColumns(
        window.localStorage.getItem(HOLDINGS_COLUMNS_KEY),
      );
      if (stored) setVisibleCols(stored);
    } catch {
      /* ignore */
    }
    setColsHydrated(true);
  }, []);
  useEffect(() => {
    if (!colsHydrated) return;
    try {
      window.localStorage.setItem(
        HOLDINGS_COLUMNS_KEY,
        JSON.stringify(visibleCols),
      );
    } catch {
      /* ignore */
    }
  }, [visibleCols, colsHydrated]);
  useEffect(() => {
    if (!colsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setColsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [colsOpen]);
  const visibleSet = useMemo(() => new Set(visibleCols), [visibleCols]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const f = q
      ? rows.filter(
          (r) =>
            r.symbol.toLowerCase().includes(q) ||
            (r.name ?? "").toLowerCase().includes(q),
        )
      : rows.slice();
    const val = (r: HoldingRow): string | number =>
      sortKey === "symbol"
        ? r.symbol
        : (r[sortKey] ?? Number.NEGATIVE_INFINITY);
    f.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const cmp =
        typeof va === "string"
          ? va.localeCompare(vb as string)
          : va - (vb as number);
      return cmp * sortDir;
    });
    return f;
  }, [rows, query, sortKey, sortDir]);

  const pager = usePager(filtered, 10);

  const toggleSort = (k: HoldingSortKey) => {
    if (sortKey === k) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(k);
      setSortDir(k === "symbol" ? 1 : -1);
    }
    pager.reset();
  };

  const sortHeader = (
    label: string,
    k: HoldingSortKey,
    align: "left" | "right" = "right",
  ) => (
    <button
      type="button"
      onClick={() => toggleSort(k)}
      className={`inline-flex items-center gap-1 uppercase hover:text-zinc-800 dark:text-zinc-200 ${
        sortKey === k ? "text-zinc-800 dark:text-zinc-200" : ""
      } ${align === "right" ? "flex-row-reverse" : ""}`}
    >
      {label}
      {sortKey === k &&
        (sortDir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
    </button>
  );

  const exportCsv = () =>
    downloadCsv(
      "holdr-holdings.csv",
      [
        "symbol",
        "name",
        "source",
        "quantity",
        "avg_cost",
        "cost_basis",
        "price",
        "market_value",
        "day_pl",
        "total_pl",
        "weight_pct",
      ],
      filtered.map((r) => [
        r.symbol,
        r.name ?? "",
        r.source,
        r.quantity,
        r.avgCost ?? "",
        r.costBasis ?? "",
        r.price ?? "",
        r.marketValue ?? "",
        r.dayPL ?? "",
        r.totalPL ?? "",
        r.weightPct ?? "",
      ]),
    );

  const deleteHolding = (r: HoldingRow) => {
    if (
      confirm(`Delete ${r.symbol} and ALL of its transactions? This cannot be undone.`)
    ) {
      del.mutate({ symbol: r.symbol });
    }
  };

  const sourceBadge = (r: HoldingRow) =>
    r.source === "broker" ? (
      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-400">
        {r.brokerLabel ?? "IBKR"}
      </div>
    ) : null;

  if (rows.length === 0) {
    return (
      <div className={card}>
        <p className="text-zinc-500">
          No positions yet. Log your first buy below to get started.
        </p>
      </div>
    );
  }

  const allColumns: DataColumn<HoldingRow>[] = [
    {
      key: "symbol",
      header: sortHeader("Symbol", "symbol", "left"),
      render: (r) => (
        <>
          <div className="font-semibold text-zinc-900 dark:text-zinc-100">{r.symbol}</div>
          {sourceBadge(r)}
          {r.name && (
            <div className="max-w-[180px] truncate text-xs text-zinc-500">
              {r.name}
            </div>
          )}
          <FlairBadge flair={flair?.[r.symbol]} />
        </>
      ),
    },
    {
      key: "qty",
      header: "Qty",
      align: "right",
      render: (r) => (
        <span className="text-zinc-700 dark:text-zinc-300">
          {r.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })}
        </span>
      ),
    },
    {
      key: "avgCost",
      header: "Avg cost",
      align: "right",
      render: (r) => <span className="text-zinc-700 dark:text-zinc-300">{money(r.avgCost)}</span>,
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      render: (r) => (
        <span className="text-zinc-700 dark:text-zinc-300">{money(r.costBasis)}</span>
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      render: (r) => <span className="text-zinc-700 dark:text-zinc-300">{money(r.price)}</span>,
    },
    {
      key: "marketValue",
      header: sortHeader("Mkt value", "marketValue"),
      align: "right",
      render: (r) => (
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{money(r.marketValue)}</span>
      ),
    },
    {
      key: "dayPL",
      header: sortHeader("Day P/L", "dayPL"),
      align: "right",
      render: (r) => (
        <span className={plClass(r.dayPL)}>
          <div>{money(r.dayPL, { sign: true })}</div>
          <div className="text-xs">{pct(r.dayChangePct, { sign: true })}</div>
        </span>
      ),
    },
    {
      key: "totalPL",
      header: sortHeader("Total P/L", "totalPL"),
      align: "right",
      render: (r) => (
        <span className={plClass(r.totalPL)}>
          <div>{money(r.totalPL, { sign: true })}</div>
          <div className="text-xs">{pct(r.totalPLPct, { sign: true })}</div>
        </span>
      ),
    },
    {
      key: "weight",
      header: sortHeader("Weight", "weightPct"),
      align: "right",
      render: (r) => <span className="text-zinc-700 dark:text-zinc-300">{pct(r.weightPct)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) =>
        r.source === "manual" ? (
          <button
            onClick={() => deleteHolding(r)}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 hover:text-rose-400"
            title={`Delete ${r.symbol}`}
          >
            <X size={14} />
          </button>
        ) : (
          <span
            className="text-xs text-zinc-600"
            title="Synced from IBKR — read-only"
          >
            synced
          </span>
        ),
    },
  ];
  const columns: DataColumn<HoldingRow>[] = allColumns.filter(
    (c) =>
      c.key === "symbol" ||
      c.key === "actions" ||
      visibleSet.has(c.key as HoldingColumnKey),
  );

  return (
    <div className={`${card} overflow-hidden p-0`}>
      <div className="flex items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
          />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              pager.reset();
            }}
            placeholder="Filter by symbol or name…"
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 py-1.5 pl-8 pr-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
          />
        </div>
        <button
          type="button"
          onClick={() => setColsOpen((o) => !o)}
          title="Choose columns"
          aria-label="Choose columns"
          aria-expanded={colsOpen}
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 p-2 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-700"
        >
          <SlidersHorizontal size={15} />
        </button>
        <button
          type="button"
          onClick={exportCsv}
          title="Export holdings as CSV"
          aria-label="Export holdings as CSV"
          className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 p-2 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-700"
        >
          <Download size={15} />
        </button>
      </div>

      {/* Column picker: bottom sheet on mobile, centered dialog on desktop */}
      {colsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
          onClick={() => setColsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Choose holdings columns"
            className="w-full max-w-sm rounded-t-2xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-200">
                Columns
              </h3>
              <button
                type="button"
                onClick={() => setColsOpen(false)}
                aria-label="Close column picker"
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800"
              >
                <X size={16} />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {HOLDINGS_ALL_COLUMNS.map((c) => {
                const checked = visibleSet.has(c.key);
                const isLast = checked && visibleCols.length === 1;
                return (
                  <label
                    key={c.key}
                    title={isLast ? "At least one column must stay visible" : undefined}
                    className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-zinc-800/60 ${
                      isLast ? "opacity-60" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isLast}
                      onChange={() =>
                        setVisibleCols((prev) => toggleColumnKey(prev, c.key))
                      }
                      className="h-5 w-5 shrink-0 accent-emerald-500"
                    />
                    <span className="text-sm text-zinc-200">{c.label}</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Symbol is always shown. At least one column must stay visible.
            </p>
          </div>
        </div>
      )}

      {/* Mobile: position cards instead of a wide swipe table */}
      <div className="sm:hidden">
        {pager.rows.map((r) => (
          <div
            key={r.symbol}
            className="border-b border-zinc-200 dark:border-zinc-800/60 px-3 py-3 last:border-0"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                  {r.symbol}
                </div>
                {sourceBadge(r)}
                {r.name && (
                  <div className="truncate text-xs text-zinc-500">{r.name}</div>
                )}
                <FlairBadge flair={flair?.[r.symbol]} />
              </div>
              <div className="shrink-0 text-right">
                <div className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {money(r.marketValue)}
                </div>
                <div className="text-xs tabular-nums text-zinc-500">
                  {pct(r.weightPct)} of portfolio
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-zinc-500">
                Day{" "}
                <span className={`font-medium tabular-nums ${plClass(r.dayPL)}`}>
                  {money(r.dayPL, { sign: true })} ({pct(r.dayChangePct, { sign: true })})
                </span>
              </span>
              <span className="text-zinc-500">
                Total{" "}
                <span className={`font-medium tabular-nums ${plClass(r.totalPL)}`}>
                  {money(r.totalPL, { sign: true })} ({pct(r.totalPLPct, { sign: true })})
                </span>
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs text-zinc-500">
              <span className="tabular-nums">
                {r.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })} @ {money(r.avgCost)}
                {" · "}Cost {money(r.costBasis)}
              </span>
              <span className="tabular-nums">now {money(r.price)}</span>
              {r.source === "manual" ? (
                <button
                  onClick={() => deleteHolding(r)}
                  aria-label={`Delete ${r.symbol}`}
                  className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-rose-400"
                >
                  <X size={15} />
                </button>
              ) : (
                <span title="Synced from IBKR — read-only">synced</span>
              )}
            </div>
          </div>
        ))}
        {pager.rows.length === 0 && (
          <p className="px-3 py-4 text-sm text-zinc-500">
            {query ? "No holdings match that filter." : "No positions yet."}
          </p>
        )}
        <Pagination
          page={pager.page}
          pageCount={pager.pageCount}
          onPage={pager.setPage}
        />
      </div>

      {/* Desktop: full sortable table */}
      <div className="hidden sm:block">
        <DataTable
          columns={columns}
          rows={pager.rows}
          keyOf={(r) => r.symbol}
          minWidth="760px"
          emptyText={query ? "No holdings match that filter." : "No positions yet."}
          footer={
            <Pagination
              page={pager.page}
              pageCount={pager.pageCount}
              onPage={pager.setPage}
            />
          }
        />
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500";

function TransactionForm() {
  const utils = api.useUtils();
  const [symbol, setSymbol] = useState("");
  const [type, setType] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [fees, setFees] = useState("");
  const [executedAt, setExecutedAt] = useState(
    () => new Date().toISOString().slice(0, 16)
  );
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const quoteQuery = api.portfolio.quote.useQuery(
    { symbol },
    { enabled: false, retry: false }
  );

  const record = api.portfolio.recordTransaction.useMutation({
    onSuccess: () => {
      void utils.portfolio.summary.invalidate();
      void utils.portfolio.transactions.invalidate();
      void utils.portfolio.flair.invalidate();
      setQuantity("");
      setPrice("");
      setFees("");
      setNote("");
      setError(null);
    },
    onError: (e) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const qty = Number(quantity);
    const prc = Number(price);
    if (!symbol.trim() || !Number.isFinite(qty) || qty <= 0) {
      setError("Enter a symbol and a quantity above zero.");
      return;
    }
    if (!Number.isFinite(prc) || prc <= 0) {
      setError("Enter a price above zero (or fetch the live price).");
      return;
    }
    record.mutate({
      symbol,
      type,
      quantity: qty,
      price: prc,
      fees: fees ? Number(fees) : 0,
      executedAt: new Date(executedAt),
      note: note || undefined,
    });
  };

  return (
    <div className={card}>
      <form onSubmit={submit} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="col-span-1">
          <label className="mb-1 block text-xs text-zinc-500">Symbol</label>
          <input
            id="txn-symbol"
            className={`${inputCls} uppercase`}
            placeholder="AAPL"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          />
        </div>
        <div className="col-span-1">
          <label className="mb-1 block text-xs text-zinc-500">Type</label>
          <div className="flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
            {(["BUY", "SELL"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`flex-1 py-2 text-sm font-semibold ${
                  type === t
                    ? t === "BUY"
                      ? "bg-emerald-600 text-white"
                      : "bg-rose-600 text-white"
                    : "bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-700"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="col-span-1">
          <label className="mb-1 block text-xs text-zinc-500">Quantity</label>
          <input
            className={inputCls}
            inputMode="decimal"
            placeholder="10"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div className="col-span-1">
          <label className="mb-1 block text-xs text-zinc-500">Price / share</label>
          <div className="flex gap-1.5">
            <input
              className={inputCls}
              inputMode="decimal"
              placeholder="0.00"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <button
              type="button"
              title={quoteQuery.data?.price != null ? `Live: $${quoteQuery.data.price.toFixed(2)}` : "Fetch live price"}
              aria-label="Fetch live price"
              onClick={() => quoteQuery.refetch()}
              disabled={!symbol.trim() || quoteQuery.isFetching}
              className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 px-2.5 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              {quoteQuery.isFetching ? <Spinner size={14} /> : <Zap size={15} />}
            </button>
          </div>
          {quoteQuery.data?.price != null && (
            <button
              type="button"
              onClick={() => setPrice(quoteQuery.data!.price!.toFixed(2))}
              className="mt-1 text-xs text-emerald-400 hover:underline"
            >
              Use live ${quoteQuery.data.price.toFixed(2)}
            </button>
          )}
        </div>
        <div className="col-span-1">
          <label className="mb-1 block text-xs text-zinc-500">Fees (optional)</label>
          <input
            className={inputCls}
            inputMode="decimal"
            placeholder="0.00"
            value={fees}
            onChange={(e) => setFees(e.target.value)}
          />
        </div>
        <div className="col-span-1">
          <label className="mb-1 block text-xs text-zinc-500">Date</label>
          <input
            type="datetime-local"
            className={inputCls}
            value={executedAt}
            onChange={(e) => setExecutedAt(e.target.value)}
          />
        </div>
        <div className="col-span-2">
          <label className="mb-1 block text-xs text-zinc-500">Note (optional)</label>
          <input
            className={inputCls}
            placeholder="why this trade…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="col-span-2 sm:col-span-4">
          <button
            type="submit"
            disabled={record.isPending}
            className={`w-full rounded-lg py-2.5 text-sm font-semibold text-white transition disabled:opacity-50 ${
              type === "BUY"
                ? "bg-emerald-600 hover:bg-emerald-500"
                : "bg-rose-600 hover:bg-rose-500"
            }`}
          >
            {record.isPending ? "Recording…" : `Record ${type.toLowerCase()}`}
          </button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
    </div>
  );
}

type TxnFilter = "ALL" | "BUY" | "SELL";

function TransactionList() {
  const money = useMoney();
  const utils = api.useUtils();
  const { data, isLoading } = api.portfolio.transactions.useQuery({
    limit: 200,
  });
  const del = api.portfolio.deleteTransaction.useMutation({
    onSuccess: () => {
      void utils.portfolio.summary.invalidate();
      void utils.portfolio.transactions.invalidate();
      void utils.portfolio.flair.invalidate();
    },
  });

  const [typeFilter, setTypeFilter] = useState<TxnFilter>("ALL");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? []).filter(
      (t) =>
        (typeFilter === "ALL" || t.type === typeFilter) &&
        (!q ||
          t.symbol.toLowerCase().includes(q) ||
          (t.note ?? "").toLowerCase().includes(q)),
    );
  }, [data, typeFilter, query]);

  const pager = usePager(filtered, 12);

  const exportCsv = () =>
    downloadCsv(
      "holdr-transactions.csv",
      ["date", "type", "symbol", "quantity", "price", "fees", "note", "source"],
      filtered.map((t) => [
        new Date(t.executedAt).toISOString(),
        t.type,
        t.symbol,
        t.quantity,
        t.price,
        t.fees,
        t.note ?? "",
        t.source,
      ]),
    );

  const columns: DataColumn<NonNullable<typeof data>[number]>[] = [
    {
      key: "type",
      header: "Type",
      render: (t) => (
        <span
          className={`rounded px-2 py-0.5 text-xs font-bold ${
            t.type === "BUY"
              ? "bg-emerald-900/60 text-emerald-400"
              : "bg-rose-900/60 text-rose-400"
          }`}
        >
          {t.type}
        </span>
      ),
    },
    {
      key: "symbol",
      header: "Symbol",
      render: (t) => (
        <>
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{t.symbol}</span>
          {t.source === "ibkr" && (
            <span
              className="ml-1.5 rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] font-bold text-sky-400"
              title="Synced from IBKR — managed by the next sync"
            >
              IBKR
            </span>
          )}
          {t.note && (
            <div className="max-w-[220px] truncate text-xs text-zinc-500">
              {t.note}
            </div>
          )}
        </>
      ),
    },
    {
      key: "detail",
      header: "Detail",
      align: "right",
      render: (t) => (
        <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">
          {t.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })} @{" "}
          {money(t.price)}
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      align: "right",
      render: (t) => (
        <span className="whitespace-nowrap text-xs text-zinc-500">
          {new Date(t.executedAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (t) =>
        t.source !== "ibkr" ? (
          <button
            onClick={() => {
              if (
                confirm(
                  "Delete this transaction? The holding will be recomputed.",
                )
              ) {
                del.mutate({ id: t.id });
              }
            }}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 hover:text-rose-400"
            title="Delete transaction"
          >
            <X size={14} />
          </button>
        ) : null,
    },
  ];

  return (
    <div className={`${card} overflow-hidden p-0`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-3 py-2">
        <div className="relative min-w-0 flex-1 basis-40">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
          />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              pager.reset();
            }}
            placeholder="Filter by symbol or note…"
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 py-1.5 pl-8 pr-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
          />
        </div>
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
          {(["ALL", "BUY", "SELL"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTypeFilter(t);
                pager.reset();
              }}
              className={`px-2.5 py-1.5 text-xs font-semibold ${
                typeFilter === t
                  ? "bg-zinc-600 text-white"
                  : "bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={exportCsv}
          title="Export transactions as CSV"
          aria-label="Export transactions as CSV"
          className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 p-2 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-700"
        >
          <Download size={15} />
        </button>
      </div>
      {isLoading ? (
        <div className="px-1 py-2">
          <RowSkeleton rows={6} />
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={pager.rows}
          keyOf={(t) => t.id}
          emptyText={
            query || typeFilter !== "ALL"
              ? "No transactions match that filter."
              : "Nothing logged yet."
          }
          footer={
            <Pagination
              page={pager.page}
              pageCount={pager.pageCount}
              onPage={pager.setPage}
            />
          }
        />
      )}
    </div>
  );
}

/** Mobile overflow menu: global settings live here on all screens. */
function HeaderMenu() {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  if (status === "loading") return null;
  const itemCls =
    "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-zinc-800 dark:text-zinc-200 hover:bg-zinc-700";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings menu"
        title="Settings"
        className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 px-2.5 py-2 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-700"
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-1 w-60 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 py-1 shadow-xl">
            <div className="border-b border-zinc-300 dark:border-zinc-700/60 px-4 py-2.5">
              <div className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Currency</div>
              <CurrencyPicker />
            </div>
            <div className="border-b border-zinc-300 dark:border-zinc-700/60 px-4 py-2.5">
              <div className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Language</div>
              <div className="flex items-center gap-2">
                <LocalePicker />
                <span className="text-xs text-zinc-600">UI</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <AiLocalePicker />
                <span className="text-xs text-zinc-600">AI</span>
              </div>
            </div>
            <div className="border-b border-zinc-300 dark:border-zinc-700/60 px-4 py-2.5">
              <div className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Notifications</div>
              <PushToggle />
            </div>
            <div className="border-b border-zinc-300 dark:border-zinc-700/60 px-4 py-2.5">
              <div className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Backup</div>
              <BackupButtons />
            </div>
            <div>
              {session ? (
                <button
                  type="button"
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-zinc-700"
                >
                  <LogOut size={15} className="shrink-0 text-zinc-700 dark:text-zinc-300" />
                  <span className="min-w-0">
                    <span className="block text-sm text-zinc-800 dark:text-zinc-200">Sign out</span>
                    {session.user?.email && (
                      <span className="block truncate text-xs text-zinc-500">
                        {session.user.email}
                      </span>
                    )}
                  </span>
                </button>
              ) : (
                <a href="/login" className={itemCls}>
                  <LogIn size={15} />
                  Sign in
                </a>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stock brokers: IBKR + Questrade grouped in one widget with tabs.     */
/* Both cards stay mounted (inactive one hidden) so IBKR's auto-sync   */
/* and position reporting keep working whichever tab is showing.       */
/* ------------------------------------------------------------------ */

const BROKER_TAB_KEY = "holdr.brokers.selected";
type BrokerTab = "ibkr" | "questrade";

function StockBrokers({
  onPositions,
}: {
  onPositions: (p: BrokerPositionInput[]) => void;
}) {
  // Start on IBKR (avoids SSR hydration mismatch); persisted choice applied below.
  const [tab, setTab] = useState<BrokerTab>("ibkr");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(BROKER_TAB_KEY) === "questrade") {
        setTab("questrade");
      }
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(BROKER_TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab, hydrated]);

  const tabs: { id: BrokerTab; label: string }[] = [
    { id: "ibkr", label: "Interactive Brokers" },
    { id: "questrade", label: "Questrade" },
  ];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Stock broker"
        className="mb-3 flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 px-3 py-2 text-sm font-semibold transition ${
              tab === t.id
                ? "bg-zinc-600 text-white"
                : "bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className={tab === "ibkr" ? "" : "hidden"}>
        <BrokerCard onPositions={onPositions} />
      </div>
      <div className={tab === "questrade" ? "" : "hidden"}>
        <QuestradeCard />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Widget registry: every dashboard section is a placeable widget.     */
/* ------------------------------------------------------------------ */

const WIDGET_DEFS: WidgetDef[] = [
  { id: "overview", title: "Portfolio overview", icon: LayoutDashboard, defaultSpan: "full" },
  {
    id: "performance",
    title: "Performance",
    icon: TrendingUp,
    defaultSpan: "full",
    info: "Your portfolio's equity curve, built from a snapshot recorded each day you open the app, plus the true annualized return (XIRR) from your full trade log.",
  },
  {
    id: "allocation",
    title: "Allocation",
    icon: PieChart,
    defaultSpan: "half",
    info: "How your money is split across positions, by market value.",
  },
  {
    id: "alerts",
    title: "Smart Alerts",
    icon: Bell,
    defaultSpan: "half",
    info: "Auto-scans your portfolio on every price refresh: big daily movers, concentration risk, deep losers, missing prices or cost basis. Dismissed alerts resurface after 24h.",
  },
  {
    id: "holdings",
    title: "Holdings",
    icon: Briefcase,
    defaultSpan: "full",
    info: "Every position at live prices. 💎🙌 / 🧻 badges are judged from your trade history — hover a badge for the verdict.",
  },
  {
    id: "insights",
    title: "AI Insights",
    icon: Sparkles,
    defaultSpan: "half",
    defaultOpen: false,
    info: "Cloudflare Workers AI reads your portfolio and writes a plain-English brief: concentration, winners, losers, and one suggestion. Cached for 24h per snapshot.",
  },
  {
    id: "ai-chat",
    title: "AI Chat",
    icon: MessageCircle,
    defaultSpan: "half",
    defaultOpen: false,
    info: "Ask anything about your portfolio in plain language. Pick a provider (Cloudflare is free, or bring your own OpenAI/Anthropic key) and toggle skills to shape the AI's personality.",
  },
  {
    id: "wsb",
    title: "WSB mode",
    icon: Rocket,
    defaultSpan: "half",
    info: "Degenerate analytics. Hover each ⓘ for the lore.",
  },
  {
    id: "price-alerts",
    title: "Price alerts",
    icon: BellRing,
    defaultSpan: "half",
    info: "Set a target price per symbol — a scheduled check emails you when it hits. One-shot: a triggered alert deactivates itself. Requires sign-in.",
  },
  {
    id: "brokers",
    title: "Stock brokers",
    icon: Landmark,
    defaultSpan: "full",
    info: "Your stock broker accounts in one place — Interactive Brokers and Questrade. Read-only sync; switch tabs to view each.",
  },
  {
    id: "exchanges",
    title: "Crypto exchanges",
    icon: ArrowLeftRight,
    defaultSpan: "half",
    info: "Read-only balances from Coinbase and Binance. Keys are encrypted on the server and only ever used to read balances — use read-only API keys.",
  },
  {
    id: "log-txn",
    title: "Log transaction",
    icon: Plus,
    defaultSpan: "full",
    defaultOpen: false,
    info: "Record a buy or sell. Holdings, cost basis and flair are all recomputed from this log.",
  },
  {
    id: "txns",
    title: "Transactions",
    icon: Receipt,
    defaultSpan: "full",
    defaultOpen: false,
    info: "Your full trade history, newest first. Deleting one recomputes the holding.",
  },
];

const DEFS_BY_ID = new Map(WIDGET_DEFS.map((d) => [d.id, d]));

export function Dashboard() {
  return (
    <CurrencyProvider>
      <LocaleProvider>
        <DashboardInner />
      </LocaleProvider>
    </CurrencyProvider>
  );
}

function DashboardInner() {
  const money = useMoney();
  // IBKR snapshot reported up by the BrokerCard (lives in this browser only).
  const [brokerPositions, setBrokerPositions] = useState<BrokerPositionInput[]>([]);
  // Exchange balances reported up by the ExchangeCards.
  const [exchangePositions, setExchangePositions] = useState<ExchangePositionLike[]>([]);
  const brokerInput = useMemo(
    () =>
      [...brokerPositions, ...exchangePositions].map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        markPrice: p.markPrice,
        costBasisPrice: p.costBasisPrice ?? null,
        label: p.label ?? null,
      })),
    [brokerPositions, exchangePositions],
  );

  const { data, isLoading, isError, refetch, isFetching } =
    api.portfolio.summary.useQuery(
      { brokerPositions: brokerInput },
      {
        refetchInterval: 120_000, // refresh quotes every 2 minutes
        staleTime: 60_000,
      },
    );

  // Daily equity-curve snapshot (recorded client-side; re-records when IBKR
  // positions arrive after first paint).
  useSnapshotRecorder(!!data && !isLoading && !isError, brokerInput);

  // Selectable P/L comparison period for the overview card (1D/1W/2W/1M).
  // SSR-safe: defaults to 1D, corrected from localStorage after mount.
  const [pnlPeriod, setPnlPeriod] = useState<PnlPeriodKey>("1D");
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PNL_PERIOD_KEY);
      if (raw) setPnlPeriod(parsePnlPeriodKey(raw));
    } catch {
      /* storage unavailable — keep default */
    }
  }, []);
  const selectPnlPeriod = useCallback((key: PnlPeriodKey) => {
    setPnlPeriod(key);
    try {
      window.localStorage.setItem(PNL_PERIOD_KEY, key);
    } catch {
      /* ignore */
    }
  }, []);

  // True historical value series backing the P/L period lookup. 35 days
  // covers the 1M option plus a weekend/holiday buffer. D1-cached server
  // side, so this is cheap after the first build.
  const { data: pnlCurve } = api.portfolio.equityCurve.useQuery(
    { days: 35, brokerPositions: brokerInput },
    { staleTime: 300_000, refetchInterval: 300_000 },
  );

  const periodDays = pnlPeriodDays(pnlPeriod);
  const periodPnl = useMemo(
    () =>
      data?.totals
        ? pnlForPeriod(
            pnlCurve?.points ?? [],
            data.totals.marketValue,
            periodDays,
          )
        : null,
    [pnlCurve, data, periodDays],
  );
  const periodPnlTone: "pos" | "neg" | "neutral" =
    periodPnl == null
      ? "neutral"
      : periodPnl.pnl > 0
        ? "pos"
        : periodPnl.pnl < 0
          ? "neg"
          : "neutral";

  // WSB flair is judged from the trade log — manual holdings only.
  const manualSymbols = useMemo(
    () =>
      (data?.rows ?? [])
        .filter((r) => r.source === "manual")
        .map((r) => r.symbol),
    [data],
  );
  const { data: flair } = api.portfolio.flair.useQuery(
    { symbols: manualSymbols },
    { enabled: manualSymbols.length > 0 },
  );

  const layout = useDashboardLayout(WIDGET_DEFS);

  // Deep-link support: `holdr:open-section` (e.g. SmartAlerts "Ask AI")
  // opens the widget and scrolls it into view.
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id !== "string" || !DEFS_BY_ID.has(id)) return;
      layout.openSection(id);
      const t0 = Date.now();
      const tryScroll = () => {
        const el = document.getElementById(`section-${id}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (Date.now() - t0 < 2000) {
          requestAnimationFrame(tryScroll);
        }
      };
      requestAnimationFrame(tryScroll);
    };
    window.addEventListener("holdr:open-section", handler);
    return () => window.removeEventListener("holdr:open-section", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const t = data?.totals;
  const missingBasisNote =
    t && t.brokerMissingBasis > 0
      ? ` · excl. ${t.brokerMissingBasis} broker position${t.brokerMissingBasis === 1 ? "" : "s"} w/o cost basis`
      : "";
  const dayTone: "pos" | "neg" | "neutral" =
    t?.dayPL == null ? "neutral" : t.dayPL > 0 ? "pos" : t.dayPL < 0 ? "neg" : "neutral";
  const totalTone: "pos" | "neg" | "neutral" =
    t?.totalPL == null
      ? "neutral"
      : t.totalPL > 0
        ? "pos"
        : t.totalPL < 0
          ? "neg"
          : "neutral";

  const openLogTxn = useCallback(() => {
    layout.openSection("log-txn");
    const t0 = Date.now();
    const tryScroll = () => {
      const el = document.getElementById("section-log-txn");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        window.setTimeout(() => {
          document.getElementById("txn-symbol")?.focus({ preventScroll: true });
        }, 450);
      } else if (Date.now() - t0 < 2000) {
        requestAnimationFrame(tryScroll);
      }
    };
    requestAnimationFrame(tryScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderItem = useCallback(
    (id: string): ReactNode => {
      const def = DEFS_BY_ID.get(id);
      if (!def || !data) return null;
      const collapsed = layout.collapsed[id] ?? def.defaultOpen === false;
      const span = layout.spans[id] ?? def.defaultSpan ?? "full";
      let body: ReactNode = null;
      switch (id) {
        case "overview":
          body = (
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <StatCard
                label="Portfolio value"
                value={money(t!.marketValue)}
                info="Total market value of everything you hold, at live prices."
                sub={
                  t!.pricedCount < t!.holdingsCount
                    ? `prices missing for ${t!.holdingsCount - t!.pricedCount}`
                    : `${t!.holdingsCount} position${t!.holdingsCount === 1 ? "" : "s"}`
                }
              />
              <StatCard
                label={periodPnl ? `${pnlPeriod} P/L` : "Day P/L"}
                value={money(periodPnl ? periodPnl.pnl : t!.dayPL, {
                  sign: true,
                })}
                info={
                  periodPnl
                    ? `Gain or loss versus the portfolio value ${periodDays} day${periodDays === 1 ? "" : "s"} ago (${shortDate(periodPnl.compareDate)}).`
                    : "Today's gain or loss versus yesterday's closing prices."
                }
                sub={
                  periodPnl
                    ? `vs ${shortDate(periodPnl.compareDate)}${periodPnl.clamped ? " · earliest" : ""}`
                    : "vs previous close"
                }
                tone={periodPnl ? periodPnlTone : dayTone}
                footer={
                  <div
                    className="mt-2 flex gap-1"
                    role="group"
                    aria-label="P/L comparison period"
                  >
                    {PNL_PERIODS.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => selectPnlPeriod(p.key)}
                        aria-pressed={pnlPeriod === p.key}
                        title={`Compare vs ${p.days} day${p.days === 1 ? "" : "s"} ago`}
                        className={`flex-1 rounded-md px-1 py-1 text-[11px] font-semibold leading-none transition-colors ${
                          pnlPeriod === p.key
                            ? "bg-zinc-700 text-white dark:bg-zinc-200 dark:text-zinc-900"
                            : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                        }`}
                      >
                        {p.key}
                      </button>
                    ))}
                  </div>
                }
              />
              <StatCard
                label="Total P/L"
                value={money(t!.totalPL, { sign: true })}
                info="All-time profit or loss: current value minus your total cost basis."
                sub={`${pct(t!.totalPLPct, { sign: true })}${missingBasisNote}`}
                tone={totalTone}
              />
              <StatCard
                label="Cost basis"
                value={money(t!.costBasis)}
                info="Everything you've put in (buys + fees). Sells reduce it proportionally."
                sub={`capital invested${missingBasisNote}`}
              />
            </div>
          );
          break;
        case "performance":
          body = <PerformanceSection brokerPositions={brokerInput} />;
          break;
        case "allocation":
          body = <AllocationDonut rows={data.rows} />;
          break;
        case "alerts":
          body = <SmartAlerts rows={data.rows} />;
          break;
        case "holdings":
          body = <HoldingsTable rows={data.rows} flair={flair} />;
          break;
        case "insights":
          body = <AiInsights rows={data.rows} totals={t!} />;
          break;
        case "ai-chat":
          body = <AiChat rows={data.rows} totals={t!} hideTitle />;
          break;
        case "wsb":
          body = (
            <div className="space-y-4">
              <YoloMeter rows={data.rows} />
              <GainLossPorn rows={data.rows} />
            </div>
          );
          break;
        case "price-alerts":
          body = <PriceAlerts />;
          break;
        case "brokers":
          body = <StockBrokers onPositions={setBrokerPositions} />;
          break;
        case "exchanges":
          body = <ExchangeCards onPositions={setExchangePositions} />;
          break;
        case "log-txn":
          body = <TransactionForm />;
          break;
        case "txns":
          body = <TransactionList />;
          break;
      }
      return (
        <WidgetSection
          id={id}
          def={def}
          span={span}
          collapsed={collapsed}
          layout={layout}
        >
          {body}
        </WidgetSection>
      );
    },
    [
      data,
      t,
      flair,
      brokerInput,
      layout,
      money,
      dayTone,
      totalTone,
      missingBasisNote,
      pnlPeriod,
      periodDays,
      periodPnl,
      periodPnlTone,
      selectPnlPeriod,
    ],
  );

  const headerBtn =
    "rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 p-2 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-700";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <img
            src="/logo.webp"
            alt="Holdr logo"
            width={36}
            height={36}
            className="h-9 w-9 shrink-0 rounded-xl sm:h-10 sm:w-10"
          />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-extrabold tracking-tight sm:text-3xl">
              Holdr
            </h1>
            <p className="hidden whitespace-nowrap text-sm text-zinc-500 min-[380px]:block">
              we are diamond holdrs 💎🙌
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh prices"
            title="Refresh prices"
            className={`${headerBtn} disabled:opacity-40`}
          >
            <RefreshCw size={18} className={isFetching ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            onClick={() => layout.setEditMode((m) => !m)}
            aria-label={layout.editMode ? "Done customizing" : "Customize layout"}
            title={layout.editMode ? "Done customizing" : "Customize layout"}
            className={`${headerBtn} ${
              layout.editMode
                ? "border-emerald-600 text-emerald-400"
                : ""
            }`}
          >
            <SlidersHorizontal size={18} />
          </button>
          <HeaderMenu />
        </div>
      </header>

      {layout.editMode && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 px-3 py-2">
          <span className="flex items-center gap-1.5 text-sm text-zinc-500">
            <GripVertical size={15} />
            Drag to rearrange
          </span>
          <span className="flex items-center gap-1.5 text-sm text-zinc-500">
            <Maximize2 size={15} />
            Toggle full / half width
          </span>
          <div className="flex-1" />
          <ResetLayoutButton layout={layout} />
          <button
            type="button"
            onClick={() => layout.setEditMode(false)}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500"
          >
            Done
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-4">
          <StatCardSkeleton />
          <div className={card}>
            <RowSkeleton rows={5} />
          </div>
        </div>
      ) : isError || !data ? (
        <div className={card}>
          <p className="text-rose-400">
            Couldn&apos;t load the portfolio. Is the database set up? (see README)
          </p>
        </div>
      ) : (
        <>
          <WidgetGrid
            order={layout.order}
            spans={layout.spans}
            layout={layout}
            renderItem={renderItem}
            labelOf={(id) => DEFS_BY_ID.get(id)?.title ?? id}
          />
          <footer className="pt-2 text-center text-xs text-zinc-600">
            Prices: Finnhub realtime when configured, else Yahoo (~15min
            delayed, Stooq fallback) · cached 60s · not financial advice
          </footer>
        </>
      )}

      {/* Floating action: log a transaction */}
      {!isLoading && !isError && data && (
        <button
          type="button"
          onClick={openLogTxn}
          aria-label="Log transaction"
          title="Log transaction"
          className="fixed bottom-5 right-5 z-40 rounded-full bg-emerald-600 p-4 text-white shadow-2xl transition hover:bg-emerald-500 active:scale-95"
        >
          <Plus size={22} />
        </button>
      )}
    </div>
  );
}
