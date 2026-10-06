"use client";

import { useCallback, useMemo, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import {
  ArrowDown,
  ArrowUp,
  Download,
  LogIn,
  LogOut,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { BrokerCard } from "~/app/_components/broker";
import {
  CollapsibleSection,
  DataTable,
  InfoTip,
  Pagination,
  StatCard,
  downloadCsv,
  usePager,
  type DataColumn,
} from "~/app/_components/ui";
import { AiInsights } from "~/app/_components/insights";
import {
  CurrencyPicker,
  CurrencyProvider,
  useCurrency,
} from "~/app/_components/currency";
import {
  LocalePicker,
  LocaleProvider,
} from "~/app/_components/locale";
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
  v == null ? "text-zinc-400" : v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-zinc-400";

const card =
  "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5";

const ALLOC_COLORS = [
  "#4ade80",
  "#60a5fa",
  "#f472b6",
  "#fbbf24",
  "#a78bfa",
  "#2dd4bf",
  "#fb7185",
  "#f97316",
  "#94a3b8",
  "#e879f9",
];

function Allocation({ rows }: { rows: HoldingRow[] }) {
  const priced = rows.filter((r) => r.marketValue != null && r.marketValue > 0);
  if (priced.length === 0) return null;
  return (
    <div className={card}>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-800">
        {priced.map((r, i) => (
          <div
            key={r.symbol}
            className="h-full"
            style={{
              width: `${r.weightPct ?? 0}%`,
              backgroundColor: ALLOC_COLORS[i % ALLOC_COLORS.length],
            }}
            title={`${r.symbol} ${pct(r.weightPct)}`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {priced.map((r, i) => (
          <span key={r.symbol} className="flex items-center gap-1.5 text-sm text-zinc-400">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: ALLOC_COLORS[i % ALLOC_COLORS.length] }}
            />
            {r.symbol}
            <span className="text-zinc-500">{pct(r.weightPct)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

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
      className={`inline-flex items-center gap-1 uppercase hover:text-zinc-200 ${
        sortKey === k ? "text-zinc-200" : ""
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
        r.price ?? "",
        r.marketValue ?? "",
        r.dayPL ?? "",
        r.totalPL ?? "",
        r.weightPct ?? "",
      ]),
    );

  if (rows.length === 0) {
    return (
      <div className={card}>
        <p className="text-zinc-500">
          No positions yet. Log your first buy below to get started.
        </p>
      </div>
    );
  }

  const columns: DataColumn<HoldingRow>[] = [
    {
      key: "symbol",
      header: sortHeader("Symbol", "symbol", "left"),
      render: (r) => (
        <>
          <div className="font-semibold text-zinc-100">{r.symbol}</div>
          {r.source === "broker" && (
            <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-400">
              IBKR
            </div>
          )}
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
        <span className="text-zinc-300">
          {r.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })}
        </span>
      ),
    },
    {
      key: "avgCost",
      header: "Avg cost",
      align: "right",
      render: (r) => <span className="text-zinc-300">{money(r.avgCost)}</span>,
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      render: (r) => <span className="text-zinc-300">{money(r.price)}</span>,
    },
    {
      key: "marketValue",
      header: sortHeader("Mkt value", "marketValue"),
      align: "right",
      render: (r) => (
        <span className="font-medium text-zinc-100">{money(r.marketValue)}</span>
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
      render: (r) => <span className="text-zinc-300">{pct(r.weightPct)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) =>
        r.source === "manual" ? (
          <button
            onClick={() => {
              if (
                confirm(
                  `Delete ${r.symbol} and ALL of its transactions? This cannot be undone.`,
                )
              ) {
                del.mutate({ symbol: r.symbol });
              }
            }}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-rose-400"
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

  return (
    <div className={`${card} overflow-hidden p-0`}>
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
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
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 py-1.5 pl-8 pr-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
          />
        </div>
        <button
          type="button"
          onClick={exportCsv}
          title="Export holdings as CSV"
          aria-label="Export holdings as CSV"
          className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-300 hover:bg-zinc-700"
        >
          <Download size={15} />
        </button>
      </div>
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
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500";

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
          <div className="flex overflow-hidden rounded-lg border border-zinc-700">
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
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
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
              onClick={() => quoteQuery.refetch()}
              disabled={!symbol.trim() || quoteQuery.isFetching}
              className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              {quoteQuery.isFetching ? "…" : "⚡"}
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
          <span className="font-semibold text-zinc-100">{t.symbol}</span>
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
        <span className="whitespace-nowrap text-zinc-400">
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
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-rose-400"
            title="Delete transaction"
          >
            <X size={14} />
          </button>
        ) : null,
    },
  ];

  return (
    <div className={`${card} overflow-hidden p-0`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
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
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 py-1.5 pl-8 pr-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
          />
        </div>
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-zinc-700">
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
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
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
          className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-300 hover:bg-zinc-700"
        >
          <Download size={15} />
        </button>
      </div>
      {isLoading ? (
        <p className="px-4 py-4 text-sm text-zinc-500">Loading…</p>
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

function AuthButtons() {
  const { data: session, status } = useSession();
  if (status === "loading") return null;
  if (status === "authenticated") {
    return (
      <div className="flex items-center gap-2">
        <span
          className="hidden max-w-[160px] truncate text-sm text-zinc-400 sm:inline"
          title={session.user?.email ?? ""}
        >
          {session.user?.email}
        </span>
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="whitespace-nowrap rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          Sign out
        </button>
      </div>
    );
  }
  return (
    <a
      href="/login"
      className="whitespace-nowrap rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
    >
      Sign in
    </a>
  );
}

/** Mobile overflow menu: refresh + sign in/out live here on small screens. */
function MobileMenu({
  onRefresh,
  isFetching,
}: {
  onRefresh: () => void;
  isFetching: boolean;
}) {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  if (status === "loading") return null;
  const itemCls =
    "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-zinc-200 hover:bg-zinc-700";
  return (
    <div className="relative sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Menu"
        title="Menu"
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-zinc-300 hover:bg-zinc-700"
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-1 w-60 rounded-xl border border-zinc-700 bg-zinc-800 py-1 shadow-xl">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRefresh();
              }}
              disabled={isFetching}
              className={`${itemCls} disabled:opacity-40`}
            >
              <RefreshCw
                size={15}
                className={isFetching ? "animate-spin" : ""}
              />
              Refresh prices
            </button>
            {session ? (
              <button
                type="button"
                onClick={() => signOut({ callbackUrl: "/" })}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-zinc-700"
              >
                <LogOut size={15} className="shrink-0 text-zinc-300" />
                <span className="min-w-0">
                  <span className="block text-sm text-zinc-200">Sign out</span>
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
        </>
      )}
    </div>
  );
}

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
  // Log-transaction form stays hidden until the floating + button is tapped.
  const [txnOpen, setTxnOpen] = useState(false);
  // IBKR snapshot reported up by the BrokerCard (lives in this browser only).
  const [brokerPositions, setBrokerPositions] = useState<BrokerPositionInput[]>([]);
  const brokerInput = useMemo(
    () =>
      brokerPositions.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        markPrice: p.markPrice,
        costBasisPrice: p.costBasisPrice ?? null,
      })),
    [brokerPositions],
  );

  const { data, isLoading, isError, refetch, isFetching } =
    api.portfolio.summary.useQuery(
      { brokerPositions: brokerInput },
      {
        refetchInterval: 120_000, // refresh quotes every 2 minutes
        staleTime: 60_000,
      },
    );

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

  const t = data?.totals;
  const missingBasisNote =
    t && t.brokerMissingBasis > 0
      ? ` · excl. ${t.brokerMissingBasis} IBKR w/o cost basis`
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
          <span className="hidden sm:inline-flex">
            <AuthButtons />
          </span>
          <CurrencyPicker />
          <LocalePicker />
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh prices"
            aria-label="Refresh prices"
            className="hidden rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 sm:inline-flex"
          >
            <RefreshCw size={16} className={isFetching ? "animate-spin" : ""} />
          </button>
          <MobileMenu onRefresh={() => refetch()} isFetching={isFetching} />
        </div>
      </header>

      {isLoading ? (
        <div className={card}>
          <p className="text-zinc-500">Loading portfolio…</p>
        </div>
      ) : isError || !data ? (
        <div className={card}>
          <p className="text-rose-400">
            Couldn&apos;t load the portfolio. Is the database set up? (see README)
          </p>
        </div>
      ) : (
        <>
          <CollapsibleSection id="overview" title="Portfolio overview">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
                label="Day P/L"
                value={money(t!.dayPL, { sign: true })}
                info="Today's gain or loss versus yesterday's closing prices."
                sub="vs previous close"
                tone={dayTone}
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
          </CollapsibleSection>

          <CollapsibleSection
            id="insights"
            title={<span className="inline-flex items-center gap-1.5"><Sparkles size={14} className="text-violet-400" /> AI Insights</span>}
            info="Cloudflare Workers AI reads your portfolio and writes a plain-English brief: concentration, winners, losers, and one suggestion. Cached for 24h per snapshot."
          >
            <AiInsights rows={data.rows} totals={t!} />
          </CollapsibleSection>

          <CollapsibleSection
            id="allocation"
            title="Allocation"
            info="How your money is split across positions, by market value."
          >
            <Allocation rows={data.rows} />
          </CollapsibleSection>

          <CollapsibleSection
            id="wsb"
            title="🚀 WSB mode"
            info="Degenerate analytics. Hover each ⓘ for the lore."
          >
            <div className="space-y-4">
              <YoloMeter rows={data.rows} />
              <GainLossPorn rows={data.rows} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="holdings"
            title="Holdings"
            info="Every position at live prices. 💎🙌 / 🧻 badges are judged from your trade history — hover a badge for the verdict."
          >
            <HoldingsTable rows={data.rows} flair={flair} />
          </CollapsibleSection>

          <CollapsibleSection
            id="ibkr"
            title="Interactive Brokers"
            info="Read-only sync from Interactive Brokers via the Flex Web Service. Auto-syncs when you open the app if the data is older than an hour. Synced trades merge into your transaction log (marked IBKR) so holdings and cost basis stay in one place — your manual entries are never touched. Stock splits are auto-adjusted against IBKR's positions. IBKR publishes end-of-day reports, so today's trades appear after the next report; there is no live push."
          >
            <BrokerCard onPositions={setBrokerPositions} />
          </CollapsibleSection>

          {txnOpen && (
            <section id="section-log-txn" className="scroll-mt-4">
              <div className="flex items-center justify-between py-1">
                <span className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
                  Log transaction
                  <InfoTip text="Record a buy or sell. Holdings, cost basis and flair are all recomputed from this log." />
                </span>
                <button
                  type="button"
                  onClick={() => setTxnOpen(false)}
                  aria-label="Close log transaction"
                  className="rounded-lg px-2 py-1 text-zinc-500 hover:text-zinc-200"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="mt-2">
                <TransactionForm />
              </div>
            </section>
          )}

          <CollapsibleSection
            id="txns"
            title="Transactions"
            info="Your full trade history, newest first. Deleting one recomputes the holding."
            defaultOpen={false}
          >
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setTxnOpen(true);
                  const t0 = Date.now();
                  const tryScroll = () => {
                    const el = document.getElementById("section-log-txn");
                    if (el) {
                      el.scrollIntoView({ behavior: "smooth", block: "start" });
                      window.setTimeout(() => {
                        document
                          .getElementById("txn-symbol")
                          ?.focus({ preventScroll: true });
                      }, 450);
                    } else if (Date.now() - t0 < 2000) {
                      requestAnimationFrame(tryScroll);
                    }
                  };
                  requestAnimationFrame(tryScroll);
                }}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm font-medium text-zinc-200 transition hover:bg-zinc-700 active:scale-95"
              >
                <Plus size={16} />
                Log transaction
              </button>
            </div>
            <TransactionList />
          </CollapsibleSection>

          <footer className="pt-2 text-center text-xs text-zinc-600">
            Prices: Finnhub realtime when configured, else Yahoo (~15min
            delayed, Stooq fallback) · cached 60s · not financial advice
          </footer>
        </>
      )}
    </div>
  );
}
