"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Landmark,
  LogIn,
  Plus,
  RefreshCw,
  Settings,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { useCurrency } from "~/app/_components/currency";
import {
  Code,
  SetupGuide,
  type GuideStep,
} from "~/app/_components/setup-guide";
import {
  DataTable,
  Pagination,
  StatCard,
  usePager,
  useTableSort,
  type DataColumn,
} from "~/app/_components/ui";

type SyncResult = RouterOutputs["questrade"]["sync"];
type QtPosition = SyncResult["positions"][number];
type QtBalance = SyncResult["balances"][number];
type ReconIssue = SyncResult["reconciliation"][number];

const card = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5";

const TOKEN_KEY = "holdr.qt.refreshToken";
const SNAPSHOT_KEY = "holdr.qt.snapshot";
/** Auto-sync on page load when the cached snapshot is older than this. */
const AUTO_SYNC_AFTER_MS = 1 * 3600 * 1000;

function useMoney() {
  const { fmt } = useCurrency();
  return useCallback(
    (v: number | null, opts?: { sign?: boolean }) =>
      v == null || !Number.isFinite(v) ? "—" : fmt(v, opts),
    [fmt],
  );
}

const qtyFmt = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: 4 });

const fmtYmd = (ymd: string) =>
  /^\d{8}$/.test(ymd)
    ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
    : ymd;

/** Native-currency badge, e.g. CAD / USD. */
function CurBadge({ currency }: { currency: string | null }) {
  if (!currency) return null;
  return (
    <span className="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 align-middle text-[10px] font-bold text-zinc-400">
      {currency}
    </span>
  );
}

/** The source badge that distinguishes these rows from IBKR ones. */
function QtBadge() {
  return (
    <span className="ml-2 rounded bg-emerald-900/60 px-1.5 py-0.5 align-middle text-[10px] font-extrabold tracking-wider text-emerald-300">
      QT
    </span>
  );
}

function SyncPill({ syncing, live }: { syncing: boolean; live: boolean }) {
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

function GearMenu({
  items,
}: {
  items: { label: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Questrade settings"
        title="Questrade settings"
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-zinc-400 hover:text-zinc-200"
      >
        <Settings size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
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

function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
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

const QUESTRADE_STEPS: GuideStep[] = [
  {
    icon: LogIn,
    title: "Log in to Questrade",
    body: (
      <>
        Log in at <Code>questrade.com</Code>, then open the top-right name menu
        and choose <Code>API centre</Code>.
      </>
    ),
  },
  {
    icon: KeyRound,
    title: "Activate the API",
    body: (
      <>
        Click <Code>Activate API</Code> and accept the API access agreement.
      </>
    ),
  },
  {
    icon: Plus,
    title: "Register a personal app",
    body: (
      <>
        Click <Code>Register a personal app</Code>, enter a name and a short
        description, then <Code>Save</Code>.
      </>
    ),
  },
  {
    icon: Copy,
    title: "Generate a manual token",
    body: (
      <>
        In your personal app click <Code>New manual authorization</Code> →{" "}
        <Code>Generate new token</Code>, then <Code>Copy token</Code>.
      </>
    ),
    warn: "The token is shown only once and expires 7 days after generation — paste it into Holdr right away.",
  },
  {
    icon: Check,
    title: "Paste it in Holdr",
    body: (
      <>
        Paste the token below and hit <Code>Connect &amp; sync</Code>. Holdr
        rotates it automatically — you never paste again.
      </>
    ),
    warn: "Treat the token like a password — never share it with anyone.",
  },
];

function ConnectForm({ onConnect }: { onConnect: (token: string) => void }) {
  const [token, setToken] = useState("");
  const valid = token.trim().length > 0;
  return (
    <div className={card}>
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <Landmark size={20} className="shrink-0 text-zinc-400" />
        <span>Questrade</span>
        <QtBadge />
      </h2>
      <p className="mt-1 text-sm text-zinc-400">
        Connect your Questrade account via their official API — read-only,
        positions stay grouped by currency.
      </p>
      <SetupGuide
        id="questrade"
        steps={QUESTRADE_STEPS}
        guideUrl="https://www.questrade.com/api/documentation/getting-started"
        guideLabel="Questrade API docs"
      />
      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            Manual authorization token
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your token"
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
        </label>
        <button
          disabled={!valid}
          onClick={() => onConnect(token.trim())}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          Connect &amp; sync
        </button>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        The token is stored only in this browser and sent to Questrade when you
        sync — never saved on our server. Questrade data is near real-time
        during market hours.
      </p>
    </div>
  );
}

/* ---------------- per-currency display (never summed across currencies) ---------------- */

function BalancesView({ balances }: { balances: QtBalance[] }) {
  const money = useMoney();
  if (balances.length === 0) return null;
  // Group by account, then currency.
  const byAccount = new Map<string, QtBalance[]>();
  for (const b of balances) {
    const list = byAccount.get(b.accountNumber) ?? [];
    list.push(b);
    byAccount.set(b.accountNumber, list);
  }
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {[...byAccount.entries()].map(([acct, list]) => (
        <div key={acct} className="rounded-lg bg-zinc-800/50 p-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            Account ···{acct.slice(-4)}
          </div>
          {list.map((b) => (
            <div key={b.currency} className="mt-2 flex items-baseline justify-between gap-2">
              <span className="text-sm text-zinc-400">
                <CurBadge currency={b.currency} />
                <span className="ml-1.5 text-xs">cash {money(b.cash)}</span>
              </span>
              <span className="text-sm font-bold tabular-nums text-zinc-100">
                {money(b.totalEquity)}
              </span>
            </div>
          ))}
          <div className="mt-1 text-[11px] text-zinc-600">
            total equity = cash + market value, per currency
          </div>
        </div>
      ))}
    </div>
  );
}

function CurrencyGroup({ currency, list }: { currency: string; list: QtPosition[] }) {
  const money = useMoney();
  const subtotal = list.reduce((a, p) => a + p.marketValue, 0);
  const columns: DataColumn<QtPosition>[] = [
    {
      key: "symbol",
      header: "Symbol",
      sortValue: (p) => p.symbol,
      sortDescFirst: false,
      render: (p) => (
        <span className="font-semibold text-zinc-100">
          {p.symbol}
          {p.assetCategory === "OPT" && (
            <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              OPT
            </span>
          )}
        </span>
      ),
    },
    {
      key: "qty",
      header: "Qty",
      align: "right",
      sortValue: (p) => p.quantity,
      render: (p) => <span className="text-zinc-300">{qtyFmt(p.quantity)}</span>,
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      sortValue: (p) => p.currentPrice,
      render: (p) => (
        <span className="text-zinc-400">
          {p.currentPrice == null ? "—" : money(p.currentPrice)}
        </span>
      ),
    },
    {
      key: "value",
      header: "Value",
      align: "right",
      sortValue: (p) => p.marketValue,
      render: (p) => (
        <span className="font-medium text-zinc-100">{money(p.marketValue)}</span>
      ),
    },
  ];
  const posSort = useTableSort(columns, {
    defaultKey: "value",
    storageKey: "qt-positions",
  });
  const pager = usePager(posSort.applySort(list), 10);
  const handlePosSortChange = (key: string) => {
    posSort.toggleSort(key);
    pager.reset();
  };
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-zinc-400">
          Market value <CurBadge currency={currency} />
        </span>
        <span className="text-lg font-bold tabular-nums">{money(subtotal)}</span>
      </div>
      <div className="mt-2 overflow-hidden rounded-xl border border-zinc-800">
        <DataTable
          columns={columns}
          rows={pager.rows}
          keyOf={(p, i) => `${p.accountNumber}-${p.symbol}-${i}`}
          sort={posSort.sort}
          onSortChange={handlePosSortChange}
          footer={<Pagination page={pager.page} pageCount={pager.pageCount} onPage={pager.setPage} />}
        />
      </div>
    </div>
  );
}

function PositionsTable({ positions }: { positions: QtPosition[] }) {
  const priced = positions.filter((p) => p.currentPrice != null).length;

  // Group by currency — subtotals stay in native currency.
  const groups = new Map<string, QtPosition[]>();
  for (const p of positions) {
    const c = p.currency ?? "?";
    const list = groups.get(c) ?? [];
    list.push(p);
    groups.set(c, list);
  }

  return (
    <>
      {[...groups.entries()].map(([currency, list]) => (
        <CurrencyGroup key={currency} currency={currency} list={list} />
      ))}
      {priced < positions.length && (
        <p className="mt-2 text-xs text-zinc-500">
          {positions.length - priced} position(s) missing a price
        </p>
      )}
    </>
  );
}

function CollapsiblePositions({ positions }: { positions: QtPosition[] }) {
  const [open, setOpen] = useState(false);
  const n = positions.length;
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200"
      >
        <ChevronDown
          size={14}
          className={`shrink-0 text-zinc-500 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span>
          {n} position{n === 1 ? "" : "s"}
          <QtBadge />
        </span>
        <span className="text-xs text-zinc-600">{open ? "hide" : "show"}</span>
      </button>
      {open && <PositionsTable positions={positions} />}
    </div>
  );
}

function ReconWarnings({ issues }: { issues: ReconIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-300">
        <AlertTriangle size={15} />
        {issues.length} reconciliation warning{issues.length === 1 ? "" : "s"}
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-amber-200/80">
        {issues.map((r, i) => (
          <li key={i}>{r.message}</li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] text-amber-200/50">
        Our computed totals didn&apos;t match Questrade&apos;s reported numbers
        — shown as-is, nothing was silently adjusted.
      </p>
    </div>
  );
}

/* ---------------- compact trade analysis ---------------- */

function AnalyticsView({ data }: { data: SyncResult["analytics"] }) {
  const money = useMoney();
  const { rates, fmt } = useCurrency();
  const t = data.totals;

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
      const cls = usd > 0 ? "text-emerald-400" : usd < 0 ? "text-rose-400" : "text-zinc-400";
      return <span className={cls}>{fmt(usd, { sign: true })}</span>;
    },
    [toUsd, fmt],
  );
  const toneOf = (v: number | null): "pos" | "neg" | "neutral" =>
    v == null ? "neutral" : v > 0 ? "pos" : v < 0 ? "neg" : "neutral";

  // Server totals are USD-converted per amount (explicit FX) — reuse them.
  const tradeColumns: DataColumn<(typeof data.recentTrades)[number]>[] = [
    {
      key: "date",
      header: "Date",
      sortValue: (tr) => tr.tradeDate.replace(/\D/g, ""),
      render: (tr) => (
        <span className="whitespace-nowrap text-zinc-400">{fmtYmd(tr.tradeDate)}</span>
      ),
    },
    {
      key: "symbol",
      header: "Symbol",
      sortValue: (tr) => tr.symbol,
      sortDescFirst: false,
      render: (tr) => <span className="font-semibold text-zinc-100">{tr.symbol}</span>,
    },
    {
      key: "qty",
      header: "Qty",
      align: "right",
      sortValue: (tr) => tr.quantity,
      render: (tr) => <span className="text-zinc-300">{qtyFmt(tr.quantity)}</span>,
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      sortValue: (tr) => tr.tradePrice,
      render: (tr) => (
        <span className="text-zinc-300">
          {tr.tradePrice == null ? "—" : moneyFx(tr.tradePrice, tr.currency)}
          <CurBadge currency={tr.currency} />
        </span>
      ),
    },
  ];
  const qtTradeSort = useTableSort(tradeColumns, {
    defaultKey: "date",
    storageKey: "qt-trades",
  });
  const tradePager = usePager(qtTradeSort.applySort(data.recentTrades), 10);
  const handleQtTradeSortChange = (key: string) => {
    qtTradeSort.toggleSort(key);
    tradePager.reset();
  };

  return (
    <div className="mt-5 border-t border-zinc-800 pt-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        Trade analysis <QtBadge />
      </h3>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
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
        <StatCard label="Trades" value={String(t.trades)} tone="neutral" />
        <StatCard
          label="Realized P/L"
          value={t.realizedPnl == null ? "—" : moneyFxSigned(t.realizedPnl, "USD")}
          tone={toneOf(t.realizedPnl)}
          info="Questrade activities don't report per-trade realized P/L — shown when available."
        />
      </div>
      {data.recentTrades.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-xl border border-zinc-800">
          <DataTable
            columns={tradeColumns}
            rows={tradePager.rows}
            keyOf={(tr) => tr.id}
            sort={qtTradeSort.sort}
            onSortChange={handleQtTradeSortChange}
            footer={
              <Pagination page={tradePager.page} pageCount={tradePager.pageCount} onPage={tradePager.setPage} />
            }
          />
        </div>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        From your Questrade activities (last 12 months). Amounts converted to
        your display currency with public FX rates — per-currency figures are
        never summed raw.
      </p>
    </div>
  );
}

/* ---------------- main card ---------------- */

export function QuestradeCard() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<{ at: string; data: SyncResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);

  const sync = api.questrade.sync.useMutation({
    onSuccess: (data) => {
      setError(null);
      const snap = { at: new Date().toISOString(), data };
      setSnapshot(snap);
      try {
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
        // The refresh token rotates on EVERY exchange — persist the new one.
        localStorage.setItem(TOKEN_KEY, data.newRefreshToken);
        setToken(data.newRefreshToken);
      } catch {
        /* storage unavailable — in-memory still works */
      }
    },
    onError: (e) => setError(e.message),
  });

  useEffect(() => {
    setToken(loadToken());
    setSnapshot(loadSnapshot());
  }, []);

  // Auto-sync on page load when the cached snapshot is stale.
  useEffect(() => {
    if (token === undefined || token === null || autoStarted.current) return;
    autoStarted.current = true;
    const snap = loadSnapshot();
    const stale = !snap || Date.now() - new Date(snap.at).getTime() > AUTO_SYNC_AFTER_MS;
    if (stale) sync.mutate({ refreshToken: token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const data = sync.data ?? snapshot?.data ?? null;
  const lastSync = sync.data ? new Date() : snapshot ? new Date(snapshot.at) : null;
  const lastSyncLabel = lastSync
    ? lastSync.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  if (token === undefined) {
    return (
      <div className={card}>
        <p className="text-sm text-zinc-500">Checking Questrade connection…</p>
      </div>
    );
  }

  if (!token) {
    return (
      <ConnectForm
        onConnect={(t) => {
          try {
            localStorage.setItem(TOKEN_KEY, t);
          } catch {
            /* ignore */
          }
          setToken(t);
          sync.mutate({ refreshToken: t });
        }}
      />
    );
  }

  const disconnect = () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(SNAPSHOT_KEY);
    } catch {
      /* ignore */
    }
    setToken(null);
    setSnapshot(null);
    setError(null);
  };

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Landmark size={20} className="shrink-0 text-zinc-400" />
            <span>Questrade</span>
            <QtBadge />
            <SyncPill syncing={sync.isPending} live={!!data && !sync.isPending} />
          </h2>
          <p className="text-xs text-zinc-500">
            {lastSyncLabel ? `Synced ${lastSyncLabel} · ` : ""}
            {data ? `${data.positions.length} position${data.positions.length === 1 ? "" : "s"}` : "your account"} ·
            read-only · token auto-rotates
          </p>
        </div>
        <GearMenu
          items={[
            {
              label: (
                <>
                  <RefreshCw size={15} className={sync.isPending ? "animate-spin" : ""} />
                  {sync.isPending ? "Syncing…" : "Sync now"}
                </>
              ),
              onClick: () => sync.mutate({ refreshToken: token }),
              disabled: sync.isPending,
            },
            { label: "Disconnect", onClick: disconnect, danger: true },
          ]}
        />
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </p>
      )}

      {sync.isPending && !data && (
        <p className="mt-3 text-sm text-zinc-500">Pulling your Questrade data…</p>
      )}

      {data && (
        <>
          <ReconWarnings issues={data.reconciliation} />
          <BalancesView balances={data.balances} />
          {data.positions.length > 0 && <CollapsiblePositions positions={data.positions} />}
          <AnalyticsView data={data.analytics} />
        </>
      )}
    </div>
  );
}
