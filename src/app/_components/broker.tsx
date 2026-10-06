"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  ArrowLeft,
  BarChart3,
  Check,
  ChevronDown,
  Copy,
  Download,
  Landmark,
  RefreshCw,
  Save,
  Settings,
  Upload,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { useCurrency } from "~/app/_components/currency";
import {
  DataTable,
  Pagination,
  RowSkeleton,
  Spinner,
  StatCard,
  usePager,
  type DataColumn,
} from "~/app/_components/ui";

type SyncResult = RouterOutputs["ibkr"]["sync"];
type Analytics = RouterOutputs["ibkr"]["analytics"];

interface PositionLike {
  id?: string;
  symbol: string;
  description: string | null;
  assetCategory: string;
  currency: string;
  quantity: number;
  markPrice: number | null;
  costBasisPrice?: number | null;
}

const card = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5";

const CREDS_KEY = "holdr.ibkr.creds";
const SNAPSHOT_KEY = "holdr.ibkr.snapshot";
/** Auto-sync on page load when the cached snapshot is older than this. */
const AUTO_SYNC_AFTER_MS = 1 * 3600 * 1000;

/** One-line summary of an IBKR trade-import result for the status line. */
function importSummary(s: {
  imported: number;
  duplicatesSkipped: number;
  oversellSkipped: number;
  splitAdjusted: number;
  splitSymbols: string[];
  mismatchSkipped: number;
  repairedSymbols: string[];
}): string {
  const parts = [
    `${s.imported} trade${s.imported === 1 ? "" : "s"} merged into your log`,
  ];
  if (s.splitAdjusted > 0)
    parts.push(
      `${s.splitAdjusted} split-adjusted (${s.splitSymbols.join(", ")})`,
    );
  if (s.repairedSymbols.length > 0)
    parts.push(`repaired ${s.repairedSymbols.join(", ")}`);
  if (s.duplicatesSkipped > 0)
    parts.push(`${s.duplicatesSkipped} already logged by hand`);
  if (s.oversellSkipped > 0)
    parts.push(`${s.oversellSkipped} skipped (buy outside report range)`);
  if (s.mismatchSkipped > 0)
    parts.push(`${s.mismatchSkipped} skipped (can't reconcile with IBKR)`);
  return parts.join(" · ");
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

function useMoneySigned() {
  const { fmt } = useCurrency();
  return useCallback(
    (v: number | null) => {
      if (v == null || !Number.isFinite(v))
        return <span className="text-zinc-400">—</span>;
      const cls =
        v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-zinc-400";
      return <span className={cls}>{fmt(v, { sign: true })}</span>;
    },
    [fmt],
  );
}

const qtyFmt = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: 4 });

const fmtYmd = (ymd: string) =>
  /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : ymd;

function valueOf(p: PositionLike): number | null {
  return p.markPrice == null ? null : p.quantity * p.markPrice;
}

/**
 * The broker positions are already merged into the dashboard's Holdings
 * table above (via onPositions), so the full table here is collapsed by
 * default — trade analysis stays visible below it.
 */
function CollapsiblePositions({ positions }: { positions: PositionLike[] }) {
  const [open, setOpen] = useState(false);
  const n = positions.length;
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200"
      >
        <ChevronDown size={14} className={`shrink-0 text-zinc-500 transition-transform ${open ? "" : "-rotate-90"}`} />
        <span>
          {n} position{n === 1 ? "" : "s"} — also listed in Holdings above
        </span>
        <span className="text-xs text-zinc-600">{open ? "hide" : "show"}</span>
      </button>
      {open && <PositionsTable positions={positions} />}
    </div>
  );
}

/* ---------------- shared presentational pieces ---------------- */

function PositionsTable({ positions }: { positions: PositionLike[] }) {
  const money = useMoney();
  const total = positions.reduce<number>((a, p) => a + (valueOf(p) ?? 0), 0);
  const priced = positions.filter((p) => p.markPrice != null).length;
  const pager = usePager(positions, 10);

  const columns: DataColumn<PositionLike>[] = [
    {
      key: "symbol",
      header: "Symbol",
      render: (p) => (
        <>
          <span className="font-semibold text-zinc-100">{p.symbol}</span>
          {p.description && (
            <span className="ml-2 hidden text-xs text-zinc-500 sm:inline">
              {p.description}
            </span>
          )}
          {p.assetCategory && p.assetCategory !== "STK" && (
            <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {p.assetCategory}
            </span>
          )}
        </>
      ),
    },
    {
      key: "qty",
      header: "Qty",
      align: "right",
      render: (p) => <span className="text-zinc-300">{qtyFmt(p.quantity)}</span>,
    },
    {
      key: "mark",
      header: "Mark",
      align: "right",
      render: (p) => (
        <span className="text-zinc-400">
          {p.markPrice == null ? "—" : money(p.markPrice)}
        </span>
      ),
    },
    {
      key: "value",
      header: "Value",
      align: "right",
      render: (p) => (
        <span className="font-medium text-zinc-100">{money(valueOf(p))}</span>
      ),
    },
  ];

  return (
    <>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <span className="shrink-0 text-sm text-zinc-400">
          Broker market value
        </span>
        <span className="break-words text-right font-bold tabular-nums text-zinc-100 text-[clamp(1.1rem,4.5vw,1.25rem)]">
          {money(total)}
        </span>
      </div>
      {priced < positions.length && (
        <p className="text-xs text-zinc-500">
          {positions.length - priced} position(s) missing a mark price
        </p>
      )}
      <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800">
        <DataTable
          columns={columns}
          rows={pager.rows}
          keyOf={(p, i) => p.id ?? `${p.symbol}-${i}`}
          footer={
            <Pagination
              page={pager.page}
              pageCount={pager.pageCount}
              onPage={pager.setPage}
            />
          }
        />
      </div>
    </>
  );
}

type SymbolAnalytics = Analytics["symbols"][number];
type RecentTrade = Analytics["recentTrades"][number];

function AnalyticsView({ data }: { data: Analytics }) {
  const money = useMoney();
  const moneySigned = useMoneySigned();
  const { rates, fmt } = useCurrency();
  const t = data.totals;
  const hasTrades = t.trades > 0;

  /**
   * Convert an amount in its native currency (e.g. HKD for HKEX trades)
   * to USD, so it can be formatted in the user's display currency.
   * Falls back to treating the amount as-is when no FX rate is available.
   */
  const toUsd = useCallback(
    (amount: number | null, currency: string | null | undefined) => {
      if (amount == null) return null;
      const code = (currency ?? "USD").toUpperCase();
      if (code === "USD") return amount;
      const rate = rates?.[code.toLowerCase()];
      return rate ? amount / rate : amount;
    },
    [rates],
  );
  /** Format an amount in its native currency, converted to display currency. */
  const moneyFx = useCallback(
    (v: number | null, currency: string | null | undefined) => {
      const usd = toUsd(v, currency);
      return usd == null || !Number.isFinite(usd) ? "—" : fmt(usd);
    },
    [toUsd, fmt],
  );
  const moneyFxSigned = useCallback(
    (v: number | null, currency: string | null | undefined) => {
      const usd = toUsd(v, currency);
      if (usd == null || !Number.isFinite(usd))
        return <span className="text-zinc-400">—</span>;
      const cls =
        usd > 0 ? "text-emerald-400" : usd < 0 ? "text-rose-400" : "text-zinc-400";
      return <span className={cls}>{fmt(usd, { sign: true })}</span>;
    },
    [toUsd, fmt],
  );
  /** Native currency badge, shown when it isn't USD (e.g. HKD). */
  const curBadge = (currency: string | null | undefined) => {
    const code = (currency ?? "USD").toUpperCase();
    if (code === "USD") return null;
    return (
      <span className="ml-1 rounded bg-zinc-800 px-1 py-0.5 text-[10px] font-semibold text-zinc-400">
        {code}
      </span>
    );
  };
  // Totals converted to USD first — the server sums native amounts, which
  // mixes currencies when the account trades more than one.
  const totalRealizedUsd =
    t.realizedPnl == null
      ? null
      : data.symbols.reduce<number | null>(
          (sum, s) => {
            const usd = toUsd(s.realizedPnl, s.currency);
            return sum == null || usd == null ? null : sum + usd;
          },
          0,
        );

  const symPager = usePager(data.symbols, 10);
  const tradePager = usePager(data.recentTrades, 10);

  const toneOf = (v: number | null): "pos" | "neg" | "neutral" =>
    v == null ? "neutral" : v > 0 ? "pos" : v < 0 ? "neg" : "neutral";

  const symbolColumns: DataColumn<SymbolAnalytics>[] = [
    {
      key: "symbol",
      header: "Symbol",
      render: (s) => (
        <span className="font-semibold text-zinc-100">
          {s.symbol}
          {data.names?.[s.symbol] && (
            <span className="block text-xs font-normal text-zinc-500">
              {data.names[s.symbol]}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "trades",
      header: "Trades",
      align: "right",
      render: (s) => <span className="text-zinc-400">{s.trades}</span>,
    },
    {
      key: "pnl",
      header: "Realized P/L",
      align: "right",
      render: (s) => (
        <span>
          {moneyFxSigned(s.realizedPnl, s.currency)}
          {curBadge(s.currency)}
        </span>
      ),
    },
    {
      key: "fees",
      header: "Fees",
      align: "right",
      render: (s) => (
        <span className="text-zinc-400">{money(s.commissions)}</span>
      ),
    },
  ];

  const tradeColumns: DataColumn<RecentTrade>[] = [
    {
      key: "date",
      header: "Date",
      render: (tr) => (
        <span className="whitespace-nowrap text-zinc-400">
          {fmtYmd(tr.tradeDate)}
        </span>
      ),
    },
    {
      key: "symbol",
      header: "Symbol",
      render: (tr) => (
        <span className="font-semibold text-zinc-100">
          {tr.symbol}
          {data.names?.[tr.symbol] && (
            <span className="block text-xs font-normal text-zinc-500">
              {data.names[tr.symbol]}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "qty",
      header: "Qty",
      align: "right",
      render: (tr) => (
        <span className="text-zinc-300">{qtyFmt(tr.quantity)}</span>
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      render: (tr) => (
        <span className="text-zinc-300">
          {tr.tradePrice == null ? "—" : money(tr.tradePrice)}
        </span>
      ),
    },
    {
      key: "pnl",
      header: "P/L",
      align: "right",
      render: (tr) => (
        <span>
          {moneyFxSigned(tr.realizedPnl, tr.currency)}
          {curBadge(tr.currency)}
        </span>
      ),
    },
  ];

  return (
    <div className="mt-5 border-t border-zinc-800 pt-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        <BarChart3 size={15} className="mr-1.5 inline text-zinc-400" />Trade
        analysis
      </h3>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Realized P/L"
          value={
            totalRealizedUsd == null ? "—" : money(totalRealizedUsd, { sign: true })
          }
          tone={toneOf(totalRealizedUsd)}
        />
        <StatCard
          label="Dividends"
          value={money(t.dividends)}
          tone={t.dividends != null && t.dividends > 0 ? "pos" : "neutral"}
        />
        <StatCard
          label="Commissions paid"
          value={money(t.commissions)}
          tone={t.commissions != null && t.commissions > 0 ? "neg" : "neutral"}
        />
        <StatCard label="Trades" value={String(t.trades)} />
      </div>

      {!hasTrades ? (
        <p className="mt-3 text-sm text-zinc-500">
          No trades in this Flex Query yet — add the <b>Trades</b> and{" "}
          <b>Cash Transactions</b> sections to your query in Client Portal, then
          sync again.
        </p>
      ) : (
        <>
          {data.symbols.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-xl border border-zinc-800">
              <DataTable
                columns={symbolColumns}
                rows={symPager.rows}
                keyOf={(s) => s.symbol}
                footer={
                  <Pagination
                    page={symPager.page}
                    pageCount={symPager.pageCount}
                    onPage={symPager.setPage}
                  />
                }
              />
            </div>
          )}
          {data.recentTrades.length > 0 && (
            <>
              <h4 className="mt-4 text-xs font-bold uppercase tracking-wide text-zinc-500">
                Recent trades
              </h4>
              <div className="mt-2 overflow-hidden rounded-xl border border-zinc-800">
                <DataTable
                  columns={tradeColumns}
                  rows={tradePager.rows}
                  keyOf={(tr) => tr.id}
                  footer={
                    <Pagination
                      page={tradePager.page}
                      pageCount={tradePager.pageCount}
                      onPage={tradePager.setPage}
                    />
                  }
                />
              </div>
            </>
          )}
        </>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        From your IBKR Flex records (end-of-day). Realized P/L uses IBKR&apos;s
        FIFO numbers when the query includes them.
      </p>
    </div>
  );
}

/* ---------------- browser mode (any IB user, no login) ---------------- */

/** Gear menu: hides rarely-needed IBKR actions (sync now, change/remove credentials). */
function GearMenu({
  items,
}: {
  items: {
    label: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
  }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="IBKR settings"
        title="IBKR settings"
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-zinc-400 hover:text-zinc-200"
      >
        <Settings size={16} />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-1 w-60 rounded-xl border border-zinc-700 bg-zinc-800 py-1 shadow-xl">
            {items.map((it, i) => (
              <button
                key={i}
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm hover:bg-zinc-700 disabled:opacity-40 ${
                  it.danger ? "text-rose-400" : "text-zinc-200"
                }`}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SyncPill({
  syncing,
  live,
}: {
  syncing: boolean;
  live: boolean;
}) {
  if (syncing) {
    return (
      <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-amber-700/60 bg-amber-900/40 px-2.5 py-0.5 align-middle text-[10px] font-extrabold tracking-wider text-amber-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        SYNCING
      </span>
    );
  }
  if (live) {
    return (
      <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-700/60 bg-emerald-900/40 px-2.5 py-0.5 align-middle text-[10px] font-extrabold tracking-wider text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        LIVE
      </span>
    );
  }
  return null;
}

interface Creds {
  token: string;
  queryId: string;
}

function loadCreds(): Creds | null {
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Creds>;
    if (typeof p.token === "string" && p.token && typeof p.queryId === "string" && p.queryId)
      return { token: p.token, queryId: p.queryId };
    return null;
  } catch {
    return null;
  }
}

function loadSnapshot(): { at: string; data: SyncResult } | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as { at: string; data: SyncResult }) : null;
  } catch {
    return null;
  }
}

/**
 * Read a holdr-ibkr-credentials.json export (the file "Export saved
 * credentials" downloads) back into a Creds pair. Accepts any JSON object
 * with a non-empty `token` and `queryId` (queryId may be a number).
 */
async function parseExportedCreds(file: File): Promise<Creds> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const token = typeof o.token === "string" ? o.token.trim() : "";
  const q = o.queryId;
  const queryId =
    typeof q === "string" ? q.trim() : typeof q === "number" ? String(q) : "";
  if (!token || !queryId)
    throw new Error(
      "That file doesn't look like a Holdr IBKR export — it needs a token and a query ID.",
    );
  return { token, queryId };
}

function SetupSteps() {
  return (
    <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-zinc-300">
      <li>
        In Client Portal go to <b>Performance &amp; Reports → Flex Queries</b>,
        create an <b>Activity</b> query with the <b>Open Positions</b>,{" "}
        <b>Trades</b> and <b>Cash Transactions</b> sections, and note its Query
        ID.
      </li>
      <li>
        Go to <b>Settings → Reporting → Flex Web Service</b> and generate a
        token.
      </li>
      <li>Paste both below — they stay in your browser, never on our server.</li>
    </ol>
  );
}

/** Fits IBKR's 200-char "Configure Query with AI" prompt box. */
const IBKR_AI_PROMPT =
  "New Activity Flex Query 'holdr': Open Positions (add Cost Basis Price), Trades, Cash Transactions - all columns. Format XML, delivery Flex Web Service, widest date range. Tell me the Query ID.";

function CopyAiPrompt() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(IBKR_AI_PROMPT);
    } catch {
      // Clipboard API unavailable (older browser / non-secure context).
      const ta = document.createElement("textarea");
      ta.value = IBKR_AI_PROMPT;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <p className="text-xs text-zinc-400">
        Shortcut — paste this into IBKR&apos;s{" "}
        <b className="text-zinc-300">Configure Query with AI</b>:
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-300">
        {IBKR_AI_PROMPT}
      </p>
      <button
        type="button"
        onClick={copy}
        className="mt-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700"
      >
        {copied ? (<><Check size={14} className="mr-1.5 inline" />Copied</>) : (<><Copy size={14} className="mr-1.5 inline" />Copy prompt</>)}
      </button>
    </div>
  );
}

function ConnectForm({ onConnect }: { onConnect: (c: Creds) => void }) {
  const [token, setToken] = useState("");
  const [queryId, setQueryId] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const valid = token.trim().length > 0 && queryId.trim().length > 0;

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    // Reset so picking the same file twice still fires onChange.
    e.target.value = "";
    if (!f) return;
    setFileError(null);
    try {
      onConnect(await parseExportedCreds(f));
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Couldn't read that file.");
    }
  };
  return (
    <div className={card}>
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <Landmark size={20} className="shrink-0 text-zinc-400" />
        <span>Interactive Brokers</span>
      </h2>
      <p className="mt-1 text-sm text-zinc-400">
        Connect your IBKR account to pull real positions and trade analysis
        (read-only — Flex can&apos;t trade).
      </p>
      <SetupSteps />
      <CopyAiPrompt />
      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-zinc-500">Flex Web Service token</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your token"
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-zinc-500">Flex Query ID</span>
          <input
            value={queryId}
            onChange={(e) => setQueryId(e.target.value)}
            placeholder="e.g. 123456"
            inputMode="numeric"
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
        </label>
        <button
          disabled={!valid}
          onClick={() => onConnect({ token: token.trim(), queryId: queryId.trim() })}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          Connect &amp; sync
        </button>
        <div>
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200"
          >
            <Upload size={14} />
            Import from exported file
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={onFile}
          />
          {fileError && <p className="mt-1.5 text-xs text-rose-400">{fileError}</p>}
        </div>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Your token is stored only in this browser (localStorage) and sent to
        IBKR when you sync — it&apos;s never saved on the server. Flex data is
        end-of-day.
      </p>
    </div>
  );
}

function BrowserBrokerCard({
  onPositions,
}: {
  onPositions?: (positions: PositionLike[]) => void;
}) {
  // undefined = still loading from localStorage (avoids SSR mismatch)
  const [creds, setCreds] = useState<Creds | null | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<{ at: string; data: SyncResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const utils = api.useUtils();
  const autoStarted = useRef(false);

  const { data: session } = useSession();
  const savedQ = api.ibkr.savedCredentials.useQuery(undefined, {
    enabled: !!session?.user,
    retry: false,
  });

  const sync = api.ibkr.sync.useMutation({
    onSuccess: (data) => {
      setError(null);
      const snap = { at: new Date().toISOString(), data };
      setSnapshot(snap);
      try {
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
      } catch {
        /* storage full or unavailable — in-memory still works */
      }
      // Owner only: merge the synced IBKR trades into the transaction log
      // so holdings and cost basis reflect brokerage activity.
      // Server-mode syncs already merged server-side (data.tradeImport).
      if (data.tradeImport) {
        setImportStatus(importSummary(data.tradeImport));
        void utils.portfolio.summary.invalidate();
        void utils.portfolio.transactions.invalidate();
        void utils.portfolio.flair.invalidate();
      } else if (
        session?.user &&
        !data.persisted &&
        data.trades.length > 0
      ) {
        importMut.mutate({
          trades: data.trades,
          positions: data.positions.map((p) => ({
            symbol: p.symbol,
            quantity: p.quantity,
            costBasisPrice: p.costBasisPrice ?? null,
          })),
        });
      }
    },
    onError: (e) => setError(e.message),
  });

  const importMut = api.portfolio.importIbkrTrades.useMutation({
    onSuccess: (s) => {
      setImportStatus(importSummary(s));
      void utils.portfolio.summary.invalidate();
      void utils.portfolio.transactions.invalidate();
      void utils.portfolio.flair.invalidate();
    },
    onError: (e) => setImportStatus(`Trade import failed: ${e.message}`),
  });

  const saveCreds = api.ibkr.saveCredentials.useMutation({
    onSuccess: () => {
      setError(null);
      void savedQ.refetch();
    },
    onError: (e) => setError(e.message),
  });

  const clearCreds = api.ibkr.clearCredentials.useMutation({
    onSuccess: () => {
      setError(null);
      void savedQ.refetch();
    },
    onError: (e) => setError(e.message),
  });

  const exportQ = api.ibkr.exportCredentials.useQuery(undefined, {
    enabled: false,
    retry: false,
  });

  /** Download the saved IBKR token + query ID as a JSON backup file. */
  const downloadCreds = useCallback(async () => {
    const res = await exportQ.refetch();
    const d = res.data;
    if (!d) {
      setError("Couldn't export credentials — is anything saved?");
      return;
    }
    try {
      const blob = new Blob(
        [
          JSON.stringify(
            {
              token: d.token,
              queryId: d.queryId,
              exportedAt: new Date().toISOString(),
              note: "IBKR Flex Web Service credentials (read-only report token). Keep this file safe.",
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "holdr-ibkr-credentials.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Couldn't create the download file.");
    }
  }, [exportQ]);

  /** Restore credentials from an exported holdr-ibkr-credentials.json file. */
  const importInputRef = useRef<HTMLInputElement>(null);
  const handleImportedFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const f = e.target.files?.[0];
    // Reset so picking the same file twice still fires onChange.
    e.target.value = "";
    if (!f) return;
    let c: Creds;
    try {
      c = await parseExportedCreds(f);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file.");
      return;
    }
    setError(null);
    if (session?.user && !creds) {
      // Logged-in, server-saved path: restore the import to the account, then sync with it.
      try {
        await saveCreds.mutateAsync(c);
        setError(null);
        void savedQ.refetch();
        sync.mutate(undefined);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Couldn't save the imported credentials.",
        );
      }
    } else {
      // Browser-only path: replace the local credentials and re-sync.
      try {
        localStorage.setItem(CREDS_KEY, JSON.stringify(c));
      } catch {
        /* ignore */
      }
      setCreds(c);
      setShowForm(false);
      sync.mutate(c);
    }
  };
  const importFileInput = (
    <input
      ref={importInputRef}
      type="file"
      accept=".json,application/json"
      className="hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={handleImportedFile}
    />
  );

  useEffect(() => {
    setCreds(loadCreds());
    setSnapshot(loadSnapshot());
  }, []);

  // Self update: auto-sync on page load when the cached snapshot is stale.
  useEffect(() => {
    if (creds === undefined || creds === null || autoStarted.current) return;
    autoStarted.current = true;
    const snap = loadSnapshot();
    const stale =
      !snap || Date.now() - new Date(snap.at).getTime() > AUTO_SYNC_AFTER_MS;
    if (stale) sync.mutate(creds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds]);

  // Auto-sync with server-saved credentials right after login, so the IB
  // portfolio appears without an extra tap (the mobile magic-link flow).
  // Respects the same staleness window as the local-creds path so we don't
  // hammer IBKR's report generation on every page load.
  const savedAutoStarted = useRef(false);
  useEffect(() => {
    if (
      creds !== null ||
      !session?.user ||
      !savedQ.data?.saved ||
      showForm ||
      savedAutoStarted.current ||
      sync.isPending ||
      sync.data
    ) {
      return;
    }
    savedAutoStarted.current = true;
    const snap = loadSnapshot();
    const stale =
      !snap || Date.now() - new Date(snap.at).getTime() > AUTO_SYNC_AFTER_MS;
    if (stale) sync.mutate(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds, session?.user, savedQ.data?.saved, showForm]);

  const data = sync.data ?? snapshot?.data ?? null;

  const lastSync = sync.data
    ? new Date()
    : snapshot
      ? new Date(snapshot.at)
      : null;
  const lastSyncLabel = lastSync
    ? lastSync.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  // Report the snapshot upward so the dashboard totals can include it.
  // (Above the early returns — hooks must run unconditionally.)
  useEffect(() => {
    onPositions?.(data?.positions ?? []);
  }, [data, onPositions]);

  if (creds === undefined) {
    return (
      <div className={card}>
        <p className="text-sm text-zinc-500">Checking IBKR connection…</p>
      </div>
    );
  }

  if (!creds) {
    // Logged in with credentials saved to the account (and not choosing to
    // enter different ones): sync via the server-side saved credentials.
    // Sync is automatic after login, so this is a quiet status card —
    // actions live behind the gear menu.
    if (session?.user && savedQ.data?.saved && !showForm) {
      return (
        <div className={card}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <Landmark size={20} className="shrink-0 text-zinc-400" />
                <span>Interactive Brokers</span>
                <SyncPill syncing={sync.isPending} live={!!data && !sync.isPending} />
              </h2>
              <p className="text-xs text-zinc-500">
                <Check size={13} className="mr-1 inline text-emerald-400" />Saved credentials · auto-sync on
                {lastSyncLabel ? ` · synced ${lastSyncLabel}` : ""}
                {" · end-of-day data"}
              </p>
              {importStatus && (
                <p className="mt-1 text-xs text-sky-400/90">{importStatus}</p>
              )}
            </div>
            <GearMenu
              items={[
                {
                  label: (
                    <>
                      <RefreshCw
                        size={15}
                        className={sync.isPending ? "animate-spin" : ""}
                      />
                      {sync.isPending ? "Syncing…" : "Sync now"}
                    </>
                  ),
                  onClick: () => sync.mutate(undefined),
                  disabled: sync.isPending,
                },
                {
                  label: "Use different credentials",
                  onClick: () => setShowForm(true),
                },
                {
                  label: (
                    <>
                      <Download size={15} />
                      Export saved credentials
                    </>
                  ),
                  onClick: () => void downloadCreds(),
                },
                {
                  label: (
                    <>
                      <Upload size={15} />
                      Import from file
                    </>
                  ),
                  onClick: () => importInputRef.current?.click(),
                },
                {
                  label: clearCreds.isPending ? "Removing…" : "Remove saved credentials",
                  onClick: () => clearCreds.mutate(),
                  danger: true,
                  disabled: clearCreds.isPending,
                },
              ]}
            />
            {importFileInput}
          </div>
          {error && (
            <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
              {error}
            </p>
          )}
          {sync.isPending && !data && (
            <div className="mt-3 space-y-3">
              <Spinner label="Pulling your IBKR records… (takes ~10–30s)" />
              <RowSkeleton rows={4} />
            </div>
          )}
          {data && (
            <>
              {data.positions.length > 0 && (
                <CollapsiblePositions positions={data.positions} />
              )}
              <AnalyticsView data={data.analytics} />
            </>
          )}
        </div>
      );
    }
    return (
      <>
        {session?.user && savedQ.data?.saved && (
          <button
            onClick={() => setShowForm(false)}
            className="mb-2 inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200"
          >
            <ArrowLeft size={15} /> Back to saved credentials
          </button>
        )}
        <ConnectForm
          onConnect={(c) => {
            try {
              localStorage.setItem(CREDS_KEY, JSON.stringify(c));
            } catch {
              /* ignore */
            }
            setCreds(c);
          }}
        />
      </>
    );
  }

  const disconnect = () => {
    try {
      localStorage.removeItem(CREDS_KEY);
      localStorage.removeItem(SNAPSHOT_KEY);
    } catch {
      /* ignore */
    }
    setCreds(null);
    setSnapshot(null);
    setError(null);
  };

  const gearItems: {
    label: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
  }[] = [
    {
      label: (
        <>
          <RefreshCw
            size={15}
            className={sync.isPending ? "animate-spin" : ""}
          />
          {sync.isPending ? "Syncing…" : "Sync now"}
        </>
      ),
      onClick: () => sync.mutate(creds),
      disabled: sync.isPending,
    },
  ];
  if (session?.user) {
    if (savedQ.data?.saved) {
      gearItems.push({
        label: (
          <>
            <Download size={15} />
            Export saved credentials
          </>
        ),
        onClick: () => void downloadCreds(),
      });
      gearItems.push({
        label: clearCreds.isPending ? "Removing…" : "Remove saved credentials",
        onClick: () => clearCreds.mutate(),
        danger: true,
        disabled: clearCreds.isPending,
      });
    } else {
      gearItems.push({
        label: (
          <>
            <Save size={15} />
            {saveCreds.isPending ? "Saving…" : "Save to my account"}
          </>
        ),
        onClick: () => saveCreds.mutate(creds),
        disabled: saveCreds.isPending,
      });
    }
  }
  gearItems.push({
    label: (
      <>
        <Upload size={15} />
        Import from file
      </>
    ),
    onClick: () => importInputRef.current?.click(),
  });
  gearItems.push({ label: "Disconnect", onClick: disconnect, danger: true });

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Landmark size={20} className="shrink-0 text-zinc-400" />
            <span>Interactive Brokers</span>
            <SyncPill syncing={sync.isPending} live={!!data && !sync.isPending} />
          </h2>
          <p className="text-xs text-zinc-500">
            {lastSyncLabel ? `Synced ${lastSyncLabel} · ` : ""}
            {data ? `${data.positions.length} position${data.positions.length === 1 ? "" : "s"}` : "your account"} ·
            end-of-day data
            {session?.user && savedQ.data?.saved ? (
              <>
                {" · "}
                <Check size={12} className="inline text-emerald-400" /> saved to account
              </>
            ) : ""}
          </p>
          {importStatus && (
            <p className="mt-1 text-xs text-sky-400/90">{importStatus}</p>
          )}
        </div>
        <GearMenu items={gearItems} />
        {importFileInput}
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </p>
      )}

      {sync.isPending && !data && (
        <div className="mt-3 space-y-3">
          <Spinner label="Pulling your IBKR records… (takes ~10–30s)" />
          <RowSkeleton rows={4} />
        </div>
      )}

      {data && (
        <>
          {data.positions.length > 0 && (
            <CollapsiblePositions positions={data.positions} />
          )}
          <AnalyticsView data={data.analytics} />
        </>
      )}
    </div>
  );
}

/* ---------------- entry ---------------- */

export function BrokerCard({
  onPositions,
}: {
  onPositions?: (positions: PositionLike[]) => void;
}) {
  // Every visitor connects with their own IBKR credentials (kept in their
  // browser only). Server-side env secrets are never exposed to the public UI.
  return <BrowserBrokerCard onPositions={onPositions} />;
}
