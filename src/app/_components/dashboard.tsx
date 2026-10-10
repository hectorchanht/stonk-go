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
  ChevronDown,
  Download,
  Gem,
  GripVertical,
  Landmark,
  Layers,
  LayoutDashboard,
  LogIn,
  LogOut,
  Maximize2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  PieChart,
  PiggyBank,
  Plus,
  Receipt,
  RefreshCw,
  Rocket,
  Search,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { BrokerCard } from "~/app/_components/broker";
import { QuestradeCard } from "~/app/_components/questrade";
import { FutuCard } from "~/app/_components/futu";
import { LongbridgeCard } from "~/app/_components/longbridge";
import { WebullCard } from "~/app/_components/webull";
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
  useTableSort,
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
import { canonicalSymbol } from "~/server/currency";
import {
  AiLocalePicker,
  LocalePicker,
  LocaleProvider,
} from "~/app/_components/locale";
import { BackupButtons } from "~/app/_components/backup";
import { PushToggle } from "~/app/_components/push-toggle";
import { FinancialFreedom } from "~/app/_components/financial-freedom";
import { DiamondHands } from "~/app/_components/diamond-hands";
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
  /** Native position currency from the broker (IBKR Flex); absent → inferred. */
  currency?: string | null;
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

type TxnRow = RouterOutputs["portfolio"]["transactions"][number];

/** One trade row in the holdings inspector. */
function InspectorTradeRow({
  t,
  money,
  onEdit,
  onDelete,
}: {
  t: TxnRow;
  money: (v: number | null) => string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-zinc-200/60 dark:bg-zinc-800/60 px-2 py-1.5 text-xs">
      <span
        className={"rounded px-1.5 py-0.5 text-[10px] font-bold " + (t.type === "BUY"
            ? "bg-emerald-900/60 text-emerald-400"
            : "bg-rose-900/60 text-rose-400")}
      >
        {t.type}
      </span>
      <span className="whitespace-nowrap text-zinc-500">
        {new Date(t.executedAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </span>
      <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
        {t.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })} @{" "}
        {money(t.price)}
      </span>
      {t.note ? (
        <span className="min-w-0 flex-1 truncate text-zinc-500">{t.note}</span>
      ) : (
        <span className="flex-1" />
      )}
      {t.source !== "ibkr" && (
        <button
          type="button"
          onClick={onEdit}
          title="Edit trade"
          aria-label={"Edit trade " + t.id}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-300 dark:hover:bg-zinc-700 hover:text-zinc-200"
        >
          <Pencil size={13} />
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        title="Delete trade (stays deleted — IBKR sync won't bring it back)"
        aria-label={"Delete trade " + t.id}
        className="rounded p-1 text-zinc-500 hover:bg-zinc-300 dark:hover:bg-zinc-700 hover:text-rose-400"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** One platform section inside the holdings inspector. */
function InspectorSection({
  label,
  rows,
  money,
  setEditingTxn,
  delTxn,
}: {
  label: string;
  rows: TxnRow[];
  money: (v: number | null) => string;
  setEditingTxn: (t: TxnRow | null) => void;
  delTxn: { mutate: (input: { id: string }) => void };
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      <div className="space-y-1">
        {rows.map((t) => (
          <InspectorTradeRow
            key={t.id}
            t={t}
            money={money}
            onEdit={() => setEditingTxn(t)}
            onDelete={() => delTxn.mutate({ id: t.id })}
          />
        ))}
      </div>
    </div>
  );
}

function HoldingsTable({
  rows,
  flair,
  brokerSymbols,
}: {
  rows: HoldingRow[];
  flair?: Record<string, PositionFlair>;
  /** Raw broker/exchange symbols (pre-dedup) for overlap flags. */
  brokerSymbols: string[];
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
  const [sourceFilter, setSourceFilter] = useState<"all" | "manual" | "broker">(
    "all",
  );
  // Company names under each symbol (HK names are long) — toggleable for all regions.
  const [showNames, setShowNames] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("holdr.holdings.showNames") === "0") {
        setShowNames(false);
      }
    } catch {
      /* ignore */
    }
  }, []);
  const toggleShowNames = useCallback((v: boolean) => {
    setShowNames(v);
    try {
      window.localStorage.setItem("holdr.holdings.showNames", v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);
  const [inspectSymbol, setInspectSymbol] = useState<string | null>(null);
  const [editingTxn, setEditingTxn] = useState<TxnRow | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearScope, setClearScope] = useState<"manual" | "all">("manual");
  const [clearAck, setClearAck] = useState(false);
  const clearManual = api.portfolio.clearManualData.useMutation({
    onSuccess: () => {
      setClearOpen(false);
      setClearAck(false);
      setClearScope("manual");
      setSourceFilter("all");
      setInspectSymbol(null);
      void utils.portfolio.summary.invalidate();
      void utils.portfolio.transactions.invalidate();
      void utils.portfolio.flair.invalidate();
      void utils.portfolio.equityCurve.invalidate();
      void utils.portfolio.xirr.invalidate();
      void utils.portfolio.insights.invalidate();
    },
  });
  const txnsQuery = api.portfolio.transactions.useQuery(
    { limit: 200 },
    { staleTime: 60_000 },
  );
  const delTxn = api.portfolio.deleteTransaction.useMutation({
    onSuccess: () => {
      void utils.portfolio.summary.invalidate();
      void utils.portfolio.transactions.invalidate();
      void utils.portfolio.flair.invalidate();
    },
  });

  /** canonical symbol → raw broker symbol, for manual/broker overlap flags. */
  const brokerCanon = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of brokerSymbols) {
      const c = canonicalSymbol(b);
      if (!m.has(c)) m.set(c, b);
    }
    return m;
  }, [brokerSymbols]);

  const overlapFor = (r: HoldingRow): string | undefined =>
    r.source === "manual" ? brokerCanon.get(canonicalSymbol(r.symbol)) : undefined;

  /** Manual-holdings review summary (the "$100K hunt" bar). */
  const manualStats = useMemo(() => {
    const ms = rows.filter((r) => r.source === "manual");
    return {
      n: ms.length,
      cost: ms.reduce((a, r) => a + (r.costBasis ?? 0), 0),
      value: ms.reduce((a, r) => a + (r.marketValue ?? 0), 0),
      noPrice: ms.filter((r) => r.marketValue == null).length,
    };
  }, [rows]);

  const inspectTxns = useMemo(
    () =>
      (txnsQuery.data ?? [])
        .filter((t) => t.symbol === inspectSymbol)
        .slice()
        .sort(
          (a, b) =>
            new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime(),
        ),
    [txnsQuery.data, inspectSymbol],
  );
  // Platforms stay separated in the inspector too: manual trades and IBKR
  // trades render under their own section headers, never interleaved.
  const inspectManual = useMemo(
    () => inspectTxns.filter((t) => t.source !== "ibkr"),
    [inspectTxns],
  );
  const inspectIbkr = useMemo(
    () => inspectTxns.filter((t) => t.source === "ibkr"),
    [inspectTxns],
  );
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
    const f = rows.filter(
      (r) =>
        (sourceFilter === "all" || r.source === sourceFilter) &&
        (!q ||
          r.symbol.toLowerCase().includes(q) ||
          (r.name ?? "").toLowerCase().includes(q)),
    );
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
  }, [rows, query, sortKey, sortDir, sourceFilter]);

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
      render: (r) => {
        const overlap = overlapFor(r);
        return (
          <>
            <div className="font-semibold text-zinc-900 dark:text-zinc-100">{r.symbol}</div>
            {sourceBadge(r)}
            {r.source === "manual" && r.marketValue == null && (
              <div
                className="mt-0.5 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-400"
                title="No live price — this row adds its full cost to Cost Basis but $0 to portfolio value"
              >
                No price
              </div>
            )}
            {overlap != null && (
              <div
                className="mt-0.5 text-[10px] font-medium text-sky-400"
                title={`Overlaps broker position ${overlap} — the broker copy is hidden by the manual-wins dedup`}
              >
                ⇄ {overlap}
              </div>
            )}
            {showNames && r.name && (
              <div className="max-w-[180px] truncate text-xs text-zinc-500">
                {r.name}
              </div>
            )}
            <FlairBadge flair={flair?.[r.symbol]} />
          </>
        );
      },
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
          <span className="inline-flex items-center gap-1">
            <button
              onClick={() =>
                setInspectSymbol(inspectSymbol === r.symbol ? null : r.symbol)
              }
              className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 hover:text-zinc-200"
              title={`Review ${r.symbol} trades`}
              aria-label={`Review ${r.symbol} trades`}
              aria-expanded={inspectSymbol === r.symbol}
            >
              <ChevronDown
                size={14}
                className={inspectSymbol === r.symbol ? "rotate-180" : ""}
              />
            </button>
            <button
              onClick={() => deleteHolding(r)}
              className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 hover:text-rose-400"
              title={`Delete ${r.symbol}`}
            >
              <X size={14} />
            </button>
          </span>
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
      <div className="flex flex-col gap-2 border-b border-zinc-200 dark:border-zinc-800 px-3 py-2">
        <div className="flex items-center gap-2">
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
              placeholder="Filter by symbol or name\u2026"
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
        <div
          className="grid grid-cols-3 overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700"
          role="group"
          aria-label="Filter by source"
        >
          {(["all", "manual", "broker"] as const).map((sf) => (
            <button
              key={sf}
              type="button"
              onClick={() => {
                setSourceFilter(sf);
                pager.reset();
              }}
              aria-pressed={sourceFilter === sf}
              className={"px-2.5 py-2 text-center text-xs font-semibold uppercase " + (sourceFilter === sf
                  ? "bg-zinc-600 text-white"
                  : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800")}
            >
              {sf}
            </button>
          ))}
        </div>
      </div>

            {/* Manual-holdings review summary */}
      {sourceFilter === "manual" && (
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800 px-3 py-2 text-xs text-zinc-500">
          <div>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">
            {manualStats.n} manual {manualStats.n === 1 ? "holding" : "holdings"}
          </span>
          {" · "}Cost{" "}
          <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
            {money(manualStats.cost)}
          </span>
          {" · "}Value{" "}
          <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
            {money(manualStats.value)}
          </span>
          {manualStats.noPrice > 0 && (
            <span className="font-semibold text-amber-400">
              {" · "}
              {manualStats.noPrice} without price
            </span>
          )}
          </div>
          {manualStats.n > 0 && (
            <button
              type="button"
              onClick={() => {
                setClearScope("manual");
                setClearAck(false);
                setClearOpen(true);
              }}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-red-500/40 px-2 py-1.5 font-semibold text-red-400 hover:bg-red-500/10"
            >
              <Trash2 size={13} />
              Clear
            </button>
          )}
        </div>
      )}

      {/* Trade inspector for the expanded manual row */}
      {inspectSymbol && (
        <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900/40 px-3 py-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {inspectSymbol}{" "}
              <span className="font-normal text-zinc-500">
                {"·"} {inspectTxns.length} {inspectTxns.length === 1 ? "trade" : "trades"}
                {txnsQuery.isLoading ? " (loading…)" : ""}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setInspectSymbol(null)}
              aria-label="Close trade inspector"
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            >
              <X size={14} />
            </button>
          </div>
          {inspectTxns.length === 0 && !txnsQuery.isLoading && (
            <p className="text-xs text-zinc-500">
              No trades found for this symbol.
            </p>
          )}
          <div className="space-y-3">
            <InspectorSection
              label="Manual"
              rows={inspectManual}
              money={money}
              setEditingTxn={setEditingTxn}
              delTxn={delTxn}
            />
            <InspectorSection
              label="IBKR"
              rows={inspectIbkr}
              money={money}
              setEditingTxn={setEditingTxn}
              delTxn={delTxn}
            />
          </div>
        </div>
      )}

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
            <label className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-zinc-800/60">
              <input
                type="checkbox"
                checked={showNames}
                onChange={() => toggleShowNames(!showNames)}
                className="h-5 w-5 shrink-0 accent-emerald-500"
              />
              <span className="text-sm text-zinc-200">Company names</span>
            </label>
            <div className="my-1 border-t border-zinc-800" />
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
            key={r.id}
            className="border-b border-zinc-200 dark:border-zinc-800/60 px-3 py-3 last:border-0"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                  {r.symbol}
                </div>
                {sourceBadge(r)}
                {r.source === "manual" && r.marketValue == null && (
                  <div className="mt-0.5 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-400">
                    No price
                  </div>
                )}
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
                <span className="inline-flex items-center">
                  <button
                    onClick={() =>
                      setInspectSymbol(inspectSymbol === r.symbol ? null : r.symbol)
                    }
                    aria-label={`Review ${r.symbol} trades`}
                    className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                  >
                    <ChevronDown
                      size={15}
                      className={inspectSymbol === r.symbol ? "rotate-180" : ""}
                    />
                  </button>
                  <button
                    onClick={() => deleteHolding(r)}
                    aria-label={`Delete ${r.symbol}`}
                    className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-rose-400"
                  >
                    <X size={15} />
                  </button>
                </span>
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
          keyOf={(r) => r.id}
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
    {editingTxn && (
      <EditTransactionModal
        key={editingTxn.id}
        txn={editingTxn}
        onClose={() => setEditingTxn(null)}
      />
    )}
    {clearOpen && (
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
        onClick={() => setClearOpen(false)}
        role="dialog"
        aria-modal="true"
        aria-label="Clear manual data"
      >
        <div
          className="w-full max-w-md rounded-t-2xl sm:rounded-2xl border border-zinc-700 bg-zinc-900 p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">
              Clear manual data
            </div>
            <button
              type="button"
              onClick={() => setClearOpen(false)}
              aria-label="Close"
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800"
            >
              <X size={14} />
            </button>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-zinc-400">
            Delete all {manualStats.n} manual holdings and their trades from the
            transaction log. Broker snapshots are untouched &mdash; re-sync IBKR
            afterwards to rebuild from full history.
          </p>
          <div className="mb-3 grid gap-2">
            {(["manual", "all"] as const).map((sc) => (
              <button
                key={sc}
                type="button"
                onClick={() => setClearScope(sc)}
                aria-pressed={clearScope === sc}
                className={"rounded-lg border p-2.5 text-left text-xs " + (clearScope === sc
                  ? "border-red-500/60 bg-red-500/10 text-zinc-100"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500")}
              >
                <div className="font-semibold">
                  {sc === "manual" ? "Hand-entered trades only" : "Full reset"}
                </div>
                <div className="mt-0.5 text-zinc-500">
                  {sc === "manual"
                    ? "Removes trades you entered by hand. Holdings derived from IBKR syncs stay and are recomputed."
                    : "Also removes IBKR-imported trades. Everything in the log goes."}
                </div>
              </button>
            ))}
          </div>
          <label className="mb-3 flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={clearAck}
              onChange={(e) => setClearAck(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-red-500"
            />
            I understand this cannot be undone. Export a backup first if unsure.
          </label>
          {clearManual.error && (
            <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
              {clearManual.error.message}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setClearOpen(false)}
              className="flex-1 rounded-lg border border-zinc-700 py-2 text-sm font-semibold text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!clearAck || clearManual.isPending}
              onClick={() =>
                clearManual.mutate({ includeIbkr: clearScope === "all" })
              }
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-red-600 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-40"
            >
              <Trash2 size={14} />
              {clearManual.isPending ? "Clearing…" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    )}
    </div>
  );
}

/**
 * Edit one manual transaction in place — the holding is recomputed from
 * the full log on save. IBKR-synced rows never reach this modal.
 */
function EditTransactionModal({
  txn,
  onClose,
}: {
  txn: TxnRow;
  onClose: () => void;
}) {
  const utils = api.useUtils();
  const [type, setType] = useState<"BUY" | "SELL">(
    txn.type === "SELL" ? "SELL" : "BUY",
  );
  const [quantity, setQuantity] = useState(String(txn.quantity));
  const [price, setPrice] = useState(String(txn.price));
  const [fees, setFees] = useState(txn.fees ? String(txn.fees) : "");
  const [executedAt, setExecutedAt] = useState(() =>
    new Date(txn.executedAt).toISOString().slice(0, 16),
  );
  const [note, setNote] = useState(txn.note ?? "");
  const [error, setError] = useState<string | null>(null);

  const update = api.portfolio.updateTransaction.useMutation({
    onSuccess: () => {
      void utils.portfolio.summary.invalidate();
      void utils.portfolio.transactions.invalidate();
      void utils.portfolio.flair.invalidate();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const qty = Number(quantity);
    const prc = Number(price);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Quantity must be above zero.");
      return;
    }
    if (!Number.isFinite(prc) || prc <= 0) {
      setError("Price must be above zero.");
      return;
    }
    const dt = new Date(executedAt);
    if (Number.isNaN(dt.getTime())) {
      setError("Enter a valid date.");
      return;
    }
    update.mutate({
      id: txn.id,
      type,
      quantity: qty,
      price: prc,
      fees: fees ? Number(fees) : 0,
      executedAt: dt,
      note: note.trim(),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={"Edit trade " + txn.symbol}
    >
      <div
        className="w-full max-w-md rounded-t-2xl sm:rounded-2xl border border-zinc-700 bg-zinc-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-zinc-100">
            Edit trade · {txn.symbol}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800"
          >
            <X size={14} />
          </button>
        </div>
        <form onSubmit={save} className="grid grid-cols-2 gap-3">
          <div className="col-span-1">
            <label className="mb-1 block text-xs text-zinc-500">Type</label>
            <div className="flex overflow-hidden rounded-lg border border-zinc-700">
              {(["BUY", "SELL"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={"flex-1 py-2 text-sm font-semibold " + (type === t
                    ? t === "BUY"
                      ? "bg-emerald-600 text-white"
                      : "bg-rose-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700")}
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
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="col-span-1">
            <label className="mb-1 block text-xs text-zinc-500">Price / share</label>
            <input
              className={inputCls}
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div className="col-span-1">
            <label className="mb-1 block text-xs text-zinc-500">Fees</label>
            <input
              className={inputCls}
              inputMode="decimal"
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
          <div className="col-span-1">
            <label className="mb-1 block text-xs text-zinc-500">Note</label>
            <input
              className={inputCls}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error && (
            <p className="col-span-2 text-xs text-rose-400">{error}</p>
          )}
          <div className="col-span-2 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-zinc-700 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={update.isPending}
              className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {update.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
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
  // Platforms are separated: each source gets its own tab, never mixed.
  const [tab, setTab] = useState<"manual" | "ibkr">("manual");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    let manual = 0;
    let ibkr = 0;
    for (const t of data ?? []) {
      if (t.source === "ibkr") ibkr++;
      else manual++;
    }
    return { manual, ibkr };
  }, [data]);

  // If the current tab is empty but the other isn't (e.g. first IBKR sync),
  // switch to the tab that has rows.
  useEffect(() => {
    if (tab === "manual" && counts.manual === 0 && counts.ibkr > 0) {
      setTab("ibkr");
    }
  }, [tab, counts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? []).filter(
      (t) =>
        (tab === "ibkr" ? t.source === "ibkr" : t.source !== "ibkr") &&
        (typeFilter === "ALL" || t.type === typeFilter) &&
        (!q ||
          t.symbol.toLowerCase().includes(q) ||
          (t.note ?? "").toLowerCase().includes(q)),
    );
  }, [data, tab, typeFilter, query]);

  const exportCsv = () =>
    downloadCsv(
      `holdr-transactions-${tab}.csv`,
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
      sortValue: (t) => t.type,
      sortDescFirst: false,
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
      sortValue: (t) => t.symbol,
      sortDescFirst: false,
      render: (t) => (
        <>
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{t.symbol}</span>
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
      sortValue: (t) => t.quantity,
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
      sortValue: (t) => new Date(t.executedAt).getTime(),
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
      render: (t) => (
        <button
          onClick={() => del.mutate({ id: t.id })}
          className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 hover:text-rose-400"
          title="Delete transaction (stays deleted — IBKR sync won't bring it back)"
        >
          <X size={14} />
        </button>
      ),
    },
  ];

  const txnSort = useTableSort(columns, {
    defaultKey: "date",
    storageKey: "txn",
  });
  // applySort is cheap (≤200 rows); recompute each render keeps deps simple.
  const pager = usePager(txnSort.applySort(filtered), 12);
  const handleTxnSortChange = (key: string) => {
    txnSort.toggleSort(key);
    pager.reset();
  };

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
        <div
          className="flex shrink-0 overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700"
          role="tablist"
          aria-label="Transaction source"
        >
          {(
            [
              { key: "manual", label: "Manual" },
              { key: "ibkr", label: "IBKR" },
            ] as const
          ).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              role="tab"
              onClick={() => {
                setTab(key);
                pager.reset();
              }}
              aria-selected={tab === key}
              className={`px-2.5 py-1.5 text-xs font-semibold uppercase ${
                tab === key
                  ? "bg-zinc-600 text-white"
                  : "bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              {label} · {key === "ibkr" ? counts.ibkr : counts.manual}
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
          sort={txnSort.sort}
          onSortChange={handleTxnSortChange}
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
/* Stock brokers: IBKR + Questrade + Futu + Longbridge + Webull in one   */
/* widget with tabs. Cards stay mounted (inactive hidden) so auto-sync  */
/* and position reporting keep working whichever tab is showing.       */
/* ------------------------------------------------------------------ */

const BROKER_TAB_KEY = "holdr.brokers.selected";
type BrokerTab = "ibkr" | "questrade" | "futu" | "longbridge" | "webull";

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
      const saved = window.localStorage.getItem(BROKER_TAB_KEY);
      if (
        saved === "questrade" ||
        saved === "futu" ||
        saved === "longbridge" ||
        saved === "webull"
      ) {
        setTab(saved as BrokerTab);
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
    { id: "futu", label: "Futu 富途" },
    { id: "longbridge", label: "Longbridge 長橋" },
    { id: "webull", label: "Webull" },
  ];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Stock broker"
        className="mb-3 flex overflow-x-auto rounded-lg border border-zinc-300 [scrollbar-width:none] dark:border-zinc-700 [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm font-semibold transition sm:flex-1 ${
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
      <div className={tab === "futu" ? "" : "hidden"}>
        <FutuCard />
      </div>
      <div className={tab === "longbridge" ? "" : "hidden"}>
        <LongbridgeCard />
      </div>
      <div className={tab === "webull" ? "" : "hidden"}>
        <WebullCard />
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
    id: "holdings",
    title: "Holdings",
    icon: Briefcase,
    defaultSpan: "full",
    info: "Every position at live prices. 💎🙌 / 🧻 badges are judged from your trade history — hover a badge for the verdict.",
  },
  {
    id: "txns",
    title: "Transactions",
    icon: Receipt,
    defaultSpan: "full",
    info: "Your trade history, newest first — Manual and IBKR on separate tabs. Deleting one recomputes the holding.",
  },
  {
    id: "brokers",
    title: "Stock brokers",
    icon: Landmark,
    defaultSpan: "full",
    info: "Your stock broker accounts in one place — Interactive Brokers, Questrade and Futu. Read-only sync; switch tabs to view each.",
  },
  {
    id: "exchanges",
    title: "Crypto exchanges",
    icon: ArrowLeftRight,
    defaultSpan: "half",
    info: "Read-only balances from Coinbase and Binance. Keys are encrypted on the server and only ever used to read balances — use read-only API keys.",
  },
  {
    id: "platforms",
    title: "Platforms",
    icon: Layers,
    defaultSpan: "full",
    info: "Value and P/L broken down by platform — your manual log plus each connected broker and exchange.",
  },
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
    id: "price-alerts",
    title: "Price alerts",
    icon: BellRing,
    defaultSpan: "half",
    info: "Set a target price per symbol — a scheduled check emails you when it hits. One-shot: a triggered alert deactivates itself. Requires sign-in.",
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
    id: "diamond-hands",
    title: "Diamond Hands",
    icon: Gem,
    defaultSpan: "full",
    info: "Your conviction at a glance: how long you've held, the dips you survived, and what the money means.",
  },
  {
    id: "financial-freedom",
    title: "Financial Freedom",
    icon: PiggyBank,
    defaultSpan: "full",
    info: "Your FI number (4% rule), progress to financial independence, passive income coverage, goals, and a what-if simulator.",
  },
  {
    id: "wsb",
    title: "WSB mode",
    icon: Rocket,
    defaultSpan: "half",
    info: "Degenerate analytics. Hover each ⓘ for the lore.",
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
        // Empty/missing → undefined so the server falls back to inferCurrency.
        currency: p.currency ? p.currency : undefined,
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
  const [missingOpen, setMissingOpen] = useState(false);

  // The broker / exchange cards report their snapshots asynchronously
  // after mount, and the server can't see them — so a summary fetched
  // with empty positions would flash $0 values. Treat that window as
  // loading so skeletons show instead of false zeros.
  const [snapshotGrace, setSnapshotGrace] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setSnapshotGrace(false), 2500);
    return () => clearTimeout(t);
  }, []);

  // True historical value series backing the P/L period lookup. 35 days
  // covers the 1M option plus a weekend/holiday buffer. D1-cached server
  // side, so this is cheap after the first build.
  //
  // onlySources = platforms present in the live summary. A disconnected
  // platform's history is excluded from the curve so performance is always
  // computed on the connected portfolio — every number stays consistent
  // with what's displayed.
  const liveSources = useMemo(() => {
    const s = new Set<string>();
    for (const r of data?.rows ?? []) {
      s.add(
        r.source === "manual" ? "manual" : (r.brokerLabel ?? "IBKR").toLowerCase(),
      );
    }
    return [...s];
  }, [data]);
  const { data: pnlCurve } = api.portfolio.equityCurve.useQuery(
    { days: 35, brokerPositions: brokerInput, onlySources: liveSources },
    { staleTime: 300_000, refetchInterval: 300_000 },
  );

  // The P/L universe = live sources that actually have curve history
  // (exchanges like Binance keep balances only, no trade log). The live
  // comparison value must cover the same universe, otherwise the pill
  // compares apples (live) to oranges (history).
  const pnlUniverse = useMemo(() => {
    const legSources = new Set(pnlCurve?.legSources ?? []);
    return liveSources.filter((s) => legSources.has(s));
  }, [liveSources, pnlCurve]);
  const liveUniverseValue = useMemo(
    () =>
      (data?.rows ?? [])
        .filter((r) =>
          pnlUniverse.includes(
            r.source === "manual" ? "manual" : (r.brokerLabel ?? "IBKR").toLowerCase(),
          ),
        )
        .reduce((sum, r) => sum + (r.marketValue ?? 0), 0),
    [data, pnlUniverse],
  );
  // Refuse to print a period P/L that represents less than half the
  // displayed portfolio — fall back to the honest 1-day number instead of
  // a fabricated multi-day one.
  const pnlCoverage =
    data?.totals && data.totals.marketValue > 0
      ? liveUniverseValue / data.totals.marketValue
      : 0;
  const hasPnlCoverage = pnlCoverage >= 0.5;

  // 1W/2W/1M need real history — with fewer than 2 equity-curve points
  // they'd silently show the 1D number, so pin to 1D and disable those
  // pills until history exists.
  const hasPnlHistory = (pnlCurve?.points?.length ?? 0) >= 2;
  const activePnlPeriod = hasPnlHistory ? pnlPeriod : "1D";
  const periodDays = pnlPeriodDays(activePnlPeriod);
  const periodPnl = useMemo(
    () =>
      data?.totals && hasPnlCoverage
        ? pnlForPeriod(
            pnlCurve?.points ?? [],
            liveUniverseValue,
            periodDays,
          )
        : null,
    [pnlCurve, data, periodDays, hasPnlCoverage, liveUniverseValue],
  );
  // Coverage failed but history exists: the connected portfolio has no
  // usable multi-day history (e.g. IBKR disconnected, exchange-only).
  // Say so plainly instead of silently showing the 1-day fallback.
  const pnlCoverageBlocked = hasPnlHistory && !hasPnlCoverage;
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
  const noCostNote =
    t && t.brokerMissingBasis > 0
      ? ` ${t.brokerMissingBasis} position${t.brokerMissingBasis === 1 ? "" : "s"} without a recorded cost — Cost and Total P/L stay hidden until every position has one. Sync the platform's trade history to fill it in.`
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
                label="Value"
                value={money(t!.marketValue)}
                info="Total market value of everything you hold, at live prices."
                sub={
                  t!.pricedCount < t!.holdingsCount ? (
                    <button
                      type="button"
                      onClick={() => setMissingOpen(true)}
                      className="inline-flex items-center gap-1 font-semibold text-amber-400 hover:text-amber-300"
                    >
                      <TriangleAlert size={12} />
                      {t!.holdingsCount - t!.pricedCount} no price
                    </button>
                  ) : (
                    `${t!.holdingsCount} position${t!.holdingsCount === 1 ? "" : "s"}`
                  )
                }
              />
              <StatCard
                label={periodPnl ? `${activePnlPeriod} P/L` : "Day P/L"}
                value={money(periodPnl ? periodPnl.pnl : t!.dayPL, {
                  sign: true,
                })}
                info={
                  periodPnl
                    ? `Gain or loss versus the portfolio value ${periodDays} day${periodDays === 1 ? "" : "s"} ago (${shortDate(periodPnl.compareDate)}).`
                    : pnlCoverageBlocked
                      ? "Multi-day performance needs history for your connected platforms — only today's move is available right now."
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
                    {PNL_PERIODS.map((p) => {
                      const disabled = p.key !== "1D" && !hasPnlHistory;
                      return (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => selectPnlPeriod(p.key)}
                          disabled={disabled}
                          aria-pressed={activePnlPeriod === p.key}
                          title={
                            disabled
                              ? "Not enough history yet — check back tomorrow"
                              : `Compare vs ${p.days} day${p.days === 1 ? "" : "s"} ago`
                          }
                          className={`flex-1 rounded-md px-1 py-1 text-[11px] font-semibold leading-none transition-colors ${
                            activePnlPeriod === p.key
                              ? "bg-zinc-700 text-white dark:bg-zinc-200 dark:text-zinc-900"
                              : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                          }${disabled ? " cursor-not-allowed opacity-40" : ""}`}
                        >
                          {p.key}
                        </button>
                      );
                    })}
                  </div>
                }
              />
              <StatCard
                label="Total P/L"
                value={money(t!.totalPL, { sign: true })}
                info={`Current value minus total cost.${noCostNote}`}
                sub={pct(t!.totalPLPct, { sign: true })}
                tone={totalTone}
              />
              <StatCard
                label="Cost"
                value={money(t!.costBasis)}
                info={`Everything you've put in (buys + fees). Sells reduce it proportionally.${noCostNote}`}
                sub="invested"
              />
            </div>
          );
          break;
        case "performance":
          body = <PerformanceSection brokerPositions={brokerInput} onlySources={liveSources} />;
          break;
        case "diamond-hands":
          body = (
            <DiamondHands marketValue={t!.marketValue} brokerPositions={brokerInput} />
          );
          break;
        case "financial-freedom":
          body = <FinancialFreedom marketValue={t!.marketValue} costBasis={t!.costBasis} />;
          break;
        case "platforms": {
          const plats = data?.totals.byPlatform ?? [];
          body =
            plats.length === 0 ? (
              <p className="text-sm text-zinc-500">No positions yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                      <th className="py-2 pr-3 font-medium">Platform</th>
                      <th className="py-2 pr-3 text-right font-medium">Value</th>
                      <th className="py-2 pr-3 text-right font-medium">Day P/L</th>
                      <th className="py-2 text-right font-medium">Total P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plats.map((p) => (
                      <tr
                        key={p.platform}
                        className="border-t border-zinc-200 dark:border-zinc-800"
                      >
                        <td className="py-2 pr-3">
                          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                            {p.platform}
                          </span>{" "}
                          <span className="text-xs text-zinc-500">
                            {p.count}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                          {money(p.marketValue)}
                        </td>
                        <td
                          className={`py-2 pr-3 text-right tabular-nums ${plClass(p.dayPL)}`}
                        >
                          {money(p.dayPL, { sign: true })}
                        </td>
                        <td
                          className={`py-2 text-right tabular-nums ${plClass(p.totalPL)}`}
                        >
                          {money(p.totalPL, { sign: true })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          break;
        }
        case "allocation":
          body = <AllocationDonut rows={data.rows} />;
          break;
        case "alerts":
          body = <SmartAlerts rows={data.rows} />;
          break;
        case "holdings":
          body = (
            <HoldingsTable
              rows={data.rows}
              flair={flair}
              brokerSymbols={brokerInput.map((b) => b.symbol)}
            />
          );
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
      noCostNote,
      hasPnlHistory,
      activePnlPeriod,
      periodDays,
      periodPnl,
      periodPnlTone,
      selectPnlPeriod,
      liveSources,
      pnlCoverageBlocked,
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

      {isLoading ||
      (snapshotGrace &&
        data != null &&
        data.totals.holdingsCount === 0 &&
        brokerInput.length === 0) ? (
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
      {missingOpen && data && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
          onClick={() => setMissingOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Positions without a price"
        >
          <div
            className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-zinc-700 bg-zinc-900 p-4 sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between">
              <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-100">
                <TriangleAlert size={14} className="text-amber-400" />
                No price ·{" "}
                {data.rows.filter((r) => r.marketValue == null).length}
              </div>
              <button
                type="button"
                onClick={() => setMissingOpen(false)}
                aria-label="Close"
                className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800"
              >
                <X size={14} />
              </button>
            </div>
            <p className="mb-3 text-xs text-zinc-500">
              No live price — value not counted in the total.
            </p>
            <div className="grid gap-1.5">
              {data.rows
                .filter((r) => r.marketValue == null)
                .map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2"
                  >
                    <span className="text-sm font-semibold text-zinc-100">
                      {r.symbol}
                    </span>
                    <span className="text-xs uppercase text-zinc-500">
                      {r.brokerLabel ?? "manual"}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
