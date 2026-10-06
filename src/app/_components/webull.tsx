"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Landmark,
  LogIn,
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
  TableToolbar,
  usePager,
  useTableSort,
  useTableTools,
  type DataColumn,
} from "~/app/_components/ui";

type SyncResult = RouterOutputs["webull"]["sync"];
type WbPosition = SyncResult["positions"][number];
type WbBalance = SyncResult["balances"][number];
type WbRecentTrade = RouterOutputs["webull"]["analytics"]["recentTrades"][number];

interface WbCredsInput {
  appKey: string;
  appSecret: string;
  accessToken: string;
}

const card = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5";

const SNAPSHOT_KEY = "holdr.wb.snapshot";
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

/** Native-currency badge, e.g. USD / HKD. */
function CurBadge({ currency }: { currency: string | null }) {
  if (!currency) return null;
  return (
    <span className="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 align-middle text-[10px] font-bold text-zinc-400">
      {currency}
    </span>
  );
}

/** The source badge that distinguishes these rows from other brokers. */
function WbBadge() {
  return (
    <span className="ml-2 rounded bg-sky-900/60 px-1.5 py-0.5 align-middle text-[10px] font-extrabold tracking-wider text-sky-300">
      WB
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
        aria-label="Webull settings"
        title="Webull settings"
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

function loadSnapshot(): { at: string; data: SyncResult } | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as { at: string; data: SyncResult }) : null;
  } catch {
    return null;
  }
}

const WEBULL_STEPS: GuideStep[] = [
  {
    icon: LogIn,
    title: "Apply for API access",
    body: (
      <>
        Go to <Code>developer.webull.com</Code> and apply for individual API
        access.
      </>
    ),
  },
  {
    icon: KeyRound,
    title: "Create an app",
    body: (
      <>
        In the developer portal, create an app to get your <Code>App Key</Code>{" "}
        and <Code>App Secret</Code>.
      </>
    ),
  },
  {
    icon: Copy,
    title: "Copy your credentials",
    body: (
      <>
        Copy the <Code>App Key</Code> and <Code>App Secret</Code> from the
        portal.
      </>
    ),
    warn: "The App Secret is shown once — keep it somewhere safe, like a password.",
  },
  {
    icon: Check,
    title: "Paste them in Holdr",
    body: (
      <>
        Paste them below and hit <Code>Connect &amp; sync</Code>.
      </>
    ),
    warn: "These credentials are read-only — Holdr can never place trades with them.",
  },
];

function ConnectForm({
  onConnect,
  canSave,
  saving,
}: {
  onConnect: (creds: WbCredsInput, save: boolean) => void;
  canSave: boolean;
  saving: boolean;
}) {
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [save, setSave] = useState(true);
  const valid = appKey.trim().length > 0 && appSecret.trim().length > 0;
  const inputCls =
    "mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none";
  return (
    <div className={card}>
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <Landmark size={20} className="shrink-0 text-zinc-400" />
        <span>Webull</span>
        <WbBadge />
      </h2>
      <p className="mt-1 text-sm text-zinc-400">
        Connect your Webull account via their official API — read-only, signed
        per request with your App Secret.
      </p>
      <SetupGuide
        id="webull"
        steps={WEBULL_STEPS}
        guideUrl="https://developer.webull.com/apis"
        guideLabel="Webull API docs"
      />
      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            App Key
          </span>
          <input
            value={appKey}
            onChange={(e) => setAppKey(e.target.value)}
            placeholder="Paste your App Key"
            autoComplete="off"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            App Secret
          </span>
          <input
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder="Paste your App Secret"
            autoComplete="off"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            Access Token <span className="normal-case text-zinc-600">(optional)</span>
          </span>
          <input
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="Only if your portal shows token check enabled"
            autoComplete="off"
            className={inputCls}
          />
          <span className="mt-1 block text-[11px] text-zinc-600">
            Only fill this in if your Webull developer portal shows token check
            enabled — most individual apps don&apos;t need it.
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={save && canSave}
            disabled={!canSave}
            onChange={(e) => setSave(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-sky-600"
          />
          <span>
            Save to my account
            {!canSave && (
              <span className="block text-xs text-zinc-500">
                Log in to save credentials — otherwise this sync stays transient
                and nothing is stored.
              </span>
            )}
          </span>
        </label>
        <button
          disabled={!valid || saving}
          onClick={() =>
            onConnect(
              { appKey: appKey.trim(), appSecret: appSecret.trim(), accessToken: accessToken.trim() },
              save && canSave,
            )
          }
          className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
        >
          <LogIn size={16} />
          {saving ? "Connecting…" : "Connect & sync"}
        </button>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Saved credentials are encrypted on our server. Transient syncs keep the
        secret in this tab&apos;s memory only — it never touches storage.
      </p>
    </div>
  );
}

/* ---------------- balances / positions ---------------- */

function BalancesView({ balances }: { balances: WbBalance[] }) {
  const money = useMoney();
  if (balances.length === 0) return null;
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {balances.map((b) => (
        <div key={b.accountNumber} className="rounded-lg bg-zinc-800/50 p-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            Account ···{b.accountNumber.slice(-4)}
            <CurBadge currency={b.currency} />
          </div>
          <div className="mt-2 space-y-1 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-zinc-400">Cash</span>
              <span className="font-medium tabular-nums text-zinc-100">{money(b.cash)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-zinc-400">Market value</span>
              <span className="font-medium tabular-nums text-zinc-100">{money(b.marketValue)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-zinc-400">Net liquidation</span>
              <span className="font-bold tabular-nums text-zinc-100">{money(b.netLiquidation)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CurrencyGroup({ currency, list }: { currency: string; list: WbPosition[] }) {
  const money = useMoney();
  const costBasis = list.reduce(
    (a, p) => a + (p.costPrice != null ? p.quantity * p.costPrice : 0),
    0,
  );
  const hasCost = list.some((p) => p.costPrice != null);
  const columns: DataColumn<WbPosition>[] = [
    {
      key: "symbol",
      header: "Symbol",
      sortValue: (p) => p.symbol,
      sortDescFirst: false,
      searchValue: (p) => p.symbol,
      render: (p) => (
        <span className="font-semibold text-zinc-100">{p.symbol}</span>
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
      key: "cost",
      header: "Avg cost",
      align: "right",
      sortValue: (p) => p.costPrice,
      render: (p) => (
        <span className="text-zinc-400">
          {p.costPrice == null ? "—" : money(p.costPrice)}
        </span>
      ),
    },
  ];
  const posSort = useTableSort(columns, {
    defaultKey: "qty",
    storageKey: "wb-positions",
  });
  const posTools = useTableTools<WbPosition>({ storageKey: "wb-pos-tools" });
  const pager = usePager(
    posSort.applySort(posTools.apply(list, columns)),
    10,
  );
  const handlePosSortChange = (key: string) => {
    posSort.toggleSort(key);
    pager.reset();
  };
  const handlePosToolsChange = () => pager.reset();
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-zinc-400">
          Cost basis <CurBadge currency={currency} />
        </span>
        <span className="text-lg font-bold tabular-nums">
          {hasCost ? money(costBasis) : "—"}
        </span>
      </div>
      <div className="mt-2 overflow-hidden rounded-xl border border-zinc-800">
        <div className="border-b border-zinc-800/60 px-3 py-2">
          <TableToolbar
            tools={posTools}
            columns={columns}
            rows={list}
            searchPlaceholder="Search symbol…"
            onChange={handlePosToolsChange}
          />
        </div>
        <DataTable
          columns={columns}
          rows={pager.rows}
          keyOf={(p, i) => `${p.symbol}-${i}`}
          sort={posSort.sort}
          onSortChange={handlePosSortChange}
          emptyText={
            posTools.hasActive
              ? "No positions match the current search."
              : undefined
          }
          footer={<Pagination page={pager.page} pageCount={pager.pageCount} onPage={pager.setPage} />}
        />
      </div>
    </div>
  );
}

function PositionsTable({ positions }: { positions: WbPosition[] }) {
  const groups = new Map<string, WbPosition[]>();
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
      <p className="mt-2 text-xs text-zinc-500">
        Live prices aren&apos;t fetched — quantities and average cost only.
      </p>
    </>
  );
}

function CollapsiblePositions({ positions }: { positions: WbPosition[] }) {
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
          <WbBadge />
        </span>
        <span className="text-xs text-zinc-600">{open ? "hide" : "show"}</span>
      </button>
      {open && <PositionsTable positions={positions} />}
    </div>
  );
}

/* ---------------- recent trades ---------------- */

function RecentTrades({ trades }: { trades: WbRecentTrade[] }) {
  const money = useMoney();
  const columns: DataColumn<WbRecentTrade>[] = [
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
      searchValue: (tr) => tr.symbol,
      render: (tr) => <span className="font-semibold text-zinc-100">{tr.symbol}</span>,
    },
    {
      key: "qty",
      header: "Qty",
      align: "right",
      sortValue: (tr) => tr.quantity,
      filterValue: (tr) => (tr.quantity >= 0 ? "BUY" : "SELL"),
      filterLabel: "Side",
      render: (tr) => (
        <span className={tr.quantity >= 0 ? "text-emerald-400" : "text-rose-400"}>
          {tr.quantity >= 0 ? "+" : ""}
          {qtyFmt(tr.quantity)}
        </span>
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      sortValue: (tr) => tr.tradePrice,
      filterValue: (tr) => (tr.currency ?? "").toUpperCase(),
      filterLabel: "Currency",
      render: (tr) => (
        <span className="text-zinc-300">
          {tr.tradePrice == null ? "—" : money(tr.tradePrice)}
          <CurBadge currency={tr.currency} />
        </span>
      ),
    },
  ];
  const tradeSort = useTableSort(columns, {
    defaultKey: "date",
    storageKey: "wb-trades",
  });
  const tradeTools = useTableTools<WbRecentTrade>({
    storageKey: "wb-trades-tools",
  });
  const tradePager = usePager(
    tradeSort.applySort(tradeTools.apply(trades, columns)),
    10,
  );
  const handleTradeSortChange = (key: string) => {
    tradeSort.toggleSort(key);
    tradePager.reset();
  };
  const handleTradeToolsChange = () => tradePager.reset();
  return (
    <div className="mt-5 border-t border-zinc-800 pt-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        Recent trades <WbBadge />
      </h3>
      {trades.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">
          No filled trades in the last 12 months.
        </p>
      ) : (
        <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800">
          <div className="border-b border-zinc-800/60 px-3 py-2">
            <TableToolbar
              tools={tradeTools}
              columns={columns}
              rows={trades}
              searchPlaceholder="Search symbol…"
              onChange={handleTradeToolsChange}
            />
          </div>
          <DataTable
            columns={columns}
            rows={tradePager.rows}
            keyOf={(tr) => tr.id}
            sort={tradeSort.sort}
            onSortChange={handleTradeSortChange}
            emptyText={
              tradeTools.hasActive
                ? "No trades match the current filters."
                : undefined
            }
            footer={
              <Pagination page={tradePager.page} pageCount={tradePager.pageCount} onPage={tradePager.setPage} />
            }
          />
        </div>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        Filled orders from the last 12 months. Buy quantities are positive,
        sells negative.
      </p>
    </div>
  );
}

/* ---------------- main card ---------------- */

export function WebullCard() {
  const { status: sessionStatus } = useSession();
  const [transient, setTransient] = useState<{
    appKey: string;
    appSecret: string;
    accessToken?: string;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<{ at: string; data: SyncResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);

  const statusQuery = api.webull.status.useQuery();

  const sync = api.webull.sync.useMutation({
    onSuccess: (data) => {
      setError(null);
      const snap = { at: new Date().toISOString(), data };
      setSnapshot(snap);
      try {
        // Positions snapshot only — credentials are never written to storage.
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
      } catch {
        /* storage unavailable — in-memory still works */
      }
    },
    onError: (e) => setError(e.message),
  });

  const saveCreds = api.webull.saveCredentials.useMutation();
  const clearCreds = api.webull.clearCredentials.useMutation();

  useEffect(() => {
    setSnapshot(loadSnapshot());
  }, []);

  const connected = (statusQuery.data?.configured ?? false) || transient !== null;

  const startSync = useCallback(
    (input: { appKey?: string; appSecret?: string; accessToken?: string }) => {
      autoStarted.current = true;
      setError(null);
      sync.mutate(input);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Auto-sync on page load when the cached snapshot is stale.
  useEffect(() => {
    if (autoStarted.current || !connected || statusQuery.isLoading) return;
    autoStarted.current = true;
    const snap = loadSnapshot();
    const stale = !snap || Date.now() - new Date(snap.at).getTime() > AUTO_SYNC_AFTER_MS;
    if (stale) startSync(transient ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, statusQuery.isLoading]);

  const analyticsQuery = api.webull.analytics.useQuery(undefined, {
    enabled: connected && !sync.isPending,
  });

  const data = sync.data ?? snapshot?.data ?? null;
  const lastSync = sync.data ? new Date() : snapshot ? new Date(snapshot.at) : null;
  const lastSyncLabel = lastSync
    ? lastSync.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  const handleConnect = (creds: WbCredsInput, save: boolean) => {
    setError(null);
    const syncInput = {
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      ...(creds.accessToken ? { accessToken: creds.accessToken } : {}),
    };
    if (save && sessionStatus === "authenticated") {
      saveCreds.mutate(syncInput, {
        onSuccess: () => {
          setTransient(null);
          statusQuery.refetch().catch(() => undefined);
          startSync({});
        },
        onError: (e) => setError(e.message),
      });
    } else {
      // Transient: credentials live in this tab's memory only.
      setTransient(syncInput);
      startSync(syncInput);
    }
  };

  const disconnect = async () => {
    setError(null);
    try {
      if (sessionStatus === "authenticated") {
        await clearCreds.mutateAsync();
      }
    } catch {
      /* still clear local state below */
    }
    try {
      localStorage.removeItem(SNAPSHOT_KEY);
    } catch {
      /* ignore */
    }
    setTransient(null);
    setSnapshot(null);
    autoStarted.current = false;
    statusQuery.refetch().catch(() => undefined);
  };

  if (sessionStatus === "loading" || statusQuery.isLoading) {
    return (
      <div className={card}>
        <p className="text-sm text-zinc-500">Checking Webull connection…</p>
      </div>
    );
  }

  if (!connected) {
    return (
      <ConnectForm
        onConnect={handleConnect}
        canSave={sessionStatus === "authenticated"}
        saving={saveCreds.isPending || sync.isPending}
      />
    );
  }

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Landmark size={20} className="shrink-0 text-zinc-400" />
            <span>Webull</span>
            <WbBadge />
            <SyncPill syncing={sync.isPending} live={!!data && !sync.isPending} />
          </h2>
          <p className="text-xs text-zinc-500">
            {lastSyncLabel ? `Synced ${lastSyncLabel} · ` : ""}
            {data ? `${data.positions.length} position${data.positions.length === 1 ? "" : "s"}` : "your account"} ·
            read-only{transient ? " · transient (not saved)" : ""}
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
              onClick: () => startSync(transient ?? {}),
              disabled: sync.isPending,
            },
            { label: "Disconnect", onClick: () => void disconnect(), danger: true },
          ]}
        />
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </p>
      )}

      {sync.isPending && !data && (
        <p className="mt-3 text-sm text-zinc-500">Pulling your Webull data…</p>
      )}

      {data && (
        <>
          <BalancesView balances={data.balances} />
          {data.positions.length > 0 ? (
            <CollapsiblePositions positions={data.positions} />
          ) : (
            <p className="mt-3 text-sm text-zinc-500">No positions found.</p>
          )}
          <RecentTrades trades={analyticsQuery.data?.recentTrades ?? []} />
        </>
      )}
    </div>
  );
}
