"use client";

import { useCallback, useMemo, useState } from "react";
import { signOut, useSession } from "next-auth/react";

import { api, type RouterOutputs } from "~/trpc/react";
import { BrokerCard } from "~/app/_components/broker";
import { CollapsibleSection, InfoTip } from "~/app/_components/ui";
import { AiInsights } from "~/app/_components/insights";
import {
  CurrencyPicker,
  CurrencyProvider,
  useCurrency,
} from "~/app/_components/currency";
import {
  FlairBadge,
  YoloMeter,
  GainLossPorn,
  TendiesCounter,
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

function StatCard({
  label,
  value,
  sub,
  tone,
  info,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg" | "neutral";
  info?: string;
}) {
  const toneClass =
    tone === "pos"
      ? "text-emerald-400"
      : tone === "neg"
        ? "text-rose-400"
        : "text-zinc-100";
  return (
    <div className={`${card} min-w-0 p-3 sm:p-5`}>
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
        {info && <InfoTip text={info} />}
      </div>
      <div
        className={`mt-1 font-bold tabular-nums leading-tight ${toneClass} text-[clamp(1.15rem,5vw,1.875rem)]`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 truncate text-sm text-zinc-500">{sub}</div>}
    </div>
  );
}

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

  if (rows.length === 0) {
    return (
      <div className={card}>
        <p className="text-zinc-500">
          No positions yet. Log your first buy below to get started.
        </p>
      </div>
    );
  }

  return (
    <div className={`${card} overflow-x-auto p-0`}>
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead>
          <tr className="border-y border-zinc-800 text-xs uppercase tracking-wider text-zinc-500">
            <th className="px-4 py-2 sm:px-5">Symbol</th>
            <th className="px-4 py-2 text-right sm:px-5">Qty</th>
            <th className="px-4 py-2 text-right sm:px-5">Avg cost</th>
            <th className="px-4 py-2 text-right sm:px-5">Price</th>
            <th className="px-4 py-2 text-right sm:px-5">Mkt value</th>
            <th className="px-4 py-2 text-right sm:px-5">Day P/L</th>
            <th className="px-4 py-2 text-right sm:px-5">Total P/L</th>
            <th className="px-4 py-2 text-right sm:px-5">Weight</th>
            <th className="px-4 py-2 sm:px-5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className="border-b border-zinc-800/60 last:border-0 hover:bg-zinc-800/30">
              <td className="px-4 py-3 sm:px-5">
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
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-zinc-300 sm:px-5">
                {r.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-zinc-300 sm:px-5">
                {money(r.avgCost)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-zinc-300 sm:px-5">
                {money(r.price)}
              </td>
              <td className="px-4 py-3 text-right font-medium tabular-nums text-zinc-100 sm:px-5">
                {money(r.marketValue)}
              </td>
              <td className={`px-4 py-3 text-right tabular-nums sm:px-5 ${plClass(r.dayPL)}`}>
                <div>{money(r.dayPL, { sign: true })}</div>
                <div className="text-xs">{pct(r.dayChangePct, { sign: true })}</div>
              </td>
              <td className={`px-4 py-3 text-right tabular-nums sm:px-5 ${plClass(r.totalPL)}`}>
                <div>{money(r.totalPL, { sign: true })}</div>
                <div className="text-xs">{pct(r.totalPLPct, { sign: true })}</div>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-zinc-300 sm:px-5">
                {pct(r.weightPct)}
              </td>
              <td className="px-4 py-3 text-right sm:px-5">
                {r.source === "manual" ? (
                  <button
                    onClick={() => {
                      if (
                        confirm(
                          `Delete ${r.symbol} and ALL of its transactions? This cannot be undone.`
                        )
                      ) {
                        del.mutate({ symbol: r.symbol });
                      }
                    }}
                    className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-rose-400"
                    title={`Delete ${r.symbol}`}
                  >
                    ✕
                  </button>
                ) : (
                  <span
                    className="text-xs text-zinc-600"
                    title="Synced from IBKR — read-only"
                  >
                    synced
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

function TransactionList() {
  const money = useMoney();
  const utils = api.useUtils();
  const { data, isLoading } = api.portfolio.transactions.useQuery({ limit: 50 });
  const del = api.portfolio.deleteTransaction.useMutation({
    onSuccess: () => {
      void utils.portfolio.summary.invalidate();
      void utils.portfolio.transactions.invalidate();
      void utils.portfolio.flair.invalidate();
    },
  });

  return (
    <div className={`${card} p-0`}>
      {isLoading ? (
        <p className="px-4 py-4 text-sm text-zinc-500 sm:px-5">Loading…</p>
      ) : !data || data.length === 0 ? (
        <p className="px-4 py-4 text-sm text-zinc-500 sm:px-5">
          Nothing logged yet.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-800/60">
          {data.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5"
            >
              <span
                className={`rounded px-2 py-0.5 text-xs font-bold ${
                  t.type === "BUY"
                    ? "bg-emerald-900/60 text-emerald-400"
                    : "bg-rose-900/60 text-rose-400"
                }`}
              >
                {t.type}
              </span>
              <span className="font-semibold text-zinc-100">{t.symbol}</span>
              <span className="tabular-nums text-zinc-400">
                {t.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })} @{" "}
                {money(t.price)}
              </span>
              {t.note && (
                <span className="hidden truncate text-zinc-500 sm:inline">
                  {t.note}
                </span>
              )}
              <span className="ml-auto shrink-0 text-xs text-zinc-500">
                {new Date(t.executedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <button
                onClick={() => {
                  if (confirm("Delete this transaction? The holding will be recomputed.")) {
                    del.mutate({ id: t.id });
                  }
                }}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-rose-400"
                title="Delete transaction"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
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

export function Dashboard() {
  return (
    <CurrencyProvider>
      <DashboardInner />
    </CurrencyProvider>
  );
}

function DashboardInner() {
  const money = useMoney();
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
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img
            src="/logo.webp"
            alt="Holdr logo"
            width={40}
            height={40}
            className="h-10 w-10 rounded-xl"
          />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
              Holdr
            </h1>
            <p className="hidden text-sm text-zinc-500 min-[380px]:block">
              we are diamond holdrs 💎🙌
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AuthButtons />
          <CurrencyPicker />
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh prices"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
          >
            {isFetching ? "…" : <><span className="sm:hidden">↻</span><span className="hidden sm:inline">↻ Refresh prices</span></>}
          </button>
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
            title="✨ AI Insights"
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
              <TendiesCounter totalPL={t!.totalPL} />
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
            info="Read-only sync from Interactive Brokers via the Flex Web Service. Auto-syncs when you open the app if the data is older than an hour."
          >
            <BrokerCard onPositions={setBrokerPositions} />
          </CollapsibleSection>

          <CollapsibleSection
            id="log-txn"
            title="Log transaction"
            info="Record a buy or sell. Holdings, cost basis and flair are all recomputed from this log."
          >
            <TransactionForm />
          </CollapsibleSection>

          <CollapsibleSection
            id="txns"
            title="Transactions"
            info="Your full trade history, newest first. Deleting one recomputes the holding."
            defaultOpen={false}
          >
            <TransactionList />
          </CollapsibleSection>

          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("holdr:open-section", { detail: "log-txn" }),
              );
              requestAnimationFrame(() => {
                document
                  .getElementById("section-log-txn")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
                window.setTimeout(() => {
                  document
                    .getElementById("txn-symbol")
                    ?.focus({ preventScroll: true });
                }, 450);
              });
            }}
            title="Log a transaction"
            aria-label="Log a transaction"
            className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-2xl font-bold text-white shadow-xl shadow-emerald-950/50 transition hover:bg-emerald-500 active:scale-95"
          >
            ＋
          </button>

          <footer className="pt-2 text-center text-xs text-zinc-600">
            Prices: Finnhub realtime when configured, else Yahoo (~15min
            delayed, Stooq fallback) · cached 60s · not financial advice
          </footer>
        </>
      )}
    </div>
  );
}
