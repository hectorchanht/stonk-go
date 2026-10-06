"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Check,
  Copy,
  KeyRound,
  Landmark,
  LogIn,
  PlugZap,
  RefreshCw,
  Settings,
  Unplug,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import {
  Code,
  SetupGuide,
  type GuideStep,
} from "~/app/_components/setup-guide";
import {
  DataTable,
  Pagination,
  StatCard,
  TableToolbar,
  usePager,
  useTableSort,
  useTableTools,
  type DataColumn,
} from "~/app/_components/ui";

type SyncResult = RouterOutputs["longbridge"]["sync"];
type LbPosition = SyncResult["positions"][number];
type LbBalance = SyncResult["balances"][number];
type LbTrade = SyncResult["trades"][number];

const card = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5";

function LbBadge() {
  return (
    <span className="ml-2 rounded bg-sky-900/60 px-1.5 py-0.5 align-middle text-[10px] font-extrabold tracking-wider text-sky-300">
      LB
    </span>
  );
}

/** Native-currency badge, e.g. HKD / USD. */
function CurBadge({ currency }: { currency: string | null }) {
  if (!currency) return null;
  return (
    <span className="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 align-middle text-[10px] font-bold text-zinc-400">
      {currency}
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
        aria-label="Longbridge settings"
        title="Longbridge settings"
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

const qtyFmt = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: 4 });

const moneyFmt = (v: number | null) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("en-US", { maximumFractionDigits: 4 });

const fmtYmd = (ymd: string) =>
  /^\d{8}$/.test(ymd)
    ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
    : ymd;

const LONGBRIDGE_STEPS: GuideStep[] = [
  {
    icon: LogIn,
    title: "Get your API credentials",
    body: (
      <>
        Log in at <Code>open.longportapp.com</Code> with your Longbridge
        （長橋證券） account and open the user center.
      </>
    ),
  },
  {
    icon: KeyRound,
    title: "Create an app",
    body: (
      <>
        Create an app and copy the three values: <Code>App Key</Code>,{" "}
        <Code>App Secret</Code> and <Code>Access Token</Code>.
      </>
    ),
  },
  {
    icon: Copy,
    title: "Paste the three values below",
    body: <>Paste them into the connect form and hit Connect &amp; sync.</>,
    warn: "Treat these like passwords — anyone holding them can read your positions.",
  },
  {
    icon: Check,
    title: "Read-only by design",
    body: (
      <>
        Holdr only queries positions, balances and order history. The
        integration has no trading endpoints — it cannot place orders.
      </>
    ),
  },
];

interface LbCreds {
  appKey: string;
  appSecret: string;
  accessToken: string;
}

function ConnectForm({
  onConnect,
  connecting,
}: {
  onConnect: (creds: LbCreds, saveToAccount: boolean) => void;
  connecting: boolean;
}) {
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [saveToAccount, setSaveToAccount] = useState(true);
  const valid =
    appKey.trim().length > 0 &&
    appSecret.trim().length > 0 &&
    accessToken.trim().length > 0;

  const inputCls =
    "mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none";

  return (
    <div className={card}>
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <Landmark size={20} className="shrink-0 text-zinc-400" />
        <span>Longbridge 長橋</span>
        <LbBadge />
      </h2>
      <p className="mt-1 text-sm text-zinc-400">
        Connect your Longbridge account via their official cloud API —
        read-only, no local gateway needed.
      </p>
      <SetupGuide
        id="longbridge"
        steps={LONGBRIDGE_STEPS}
        guideUrl="https://open.longportapp.com/"
        guideLabel="Longbridge OpenAPI docs"
      />
      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-zinc-500">App Key</span>
          <input
            type="password"
            value={appKey}
            onChange={(e) => setAppKey(e.target.value)}
            placeholder="Paste your App Key"
            autoComplete="off"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-zinc-500">App Secret</span>
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
          <span className="text-xs uppercase tracking-wide text-zinc-500">Access Token</span>
          <input
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="Paste your Access Token"
            autoComplete="off"
            className={inputCls}
          />
        </label>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={saveToAccount}
            onChange={(e) => setSaveToAccount(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-emerald-600"
          />
          Save to my account
          <span className="text-xs text-zinc-500">
            (encrypted on the server — uncheck for a one-off sync on this device only)
          </span>
        </label>
        <button
          disabled={!valid || connecting}
          onClick={() =>
            onConnect(
              {
                appKey: appKey.trim(),
                appSecret: appSecret.trim(),
                accessToken: accessToken.trim(),
              },
              saveToAccount,
            )
          }
          className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          <PlugZap size={16} className={connecting ? "animate-pulse" : ""} />
          {connecting ? "Connecting…" : "Connect & sync"}
        </button>
      </div>
    </div>
  );
}

/* ---------------- balances / positions / trades ---------------- */

function BalancesView({ balances }: { balances: LbBalance[] }) {
  if (balances.length === 0) return null;
  const byChannel = new Map<string, LbBalance[]>();
  for (const b of balances) {
    const key = b.accountChannel ?? "?";
    const list = byChannel.get(key) ?? [];
    list.push(b);
    byChannel.set(key, list);
  }
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {[...byChannel.entries()].map(([channel, list]) => (
        <div key={channel} className="rounded-lg bg-zinc-800/50 p-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            {channel} account
          </div>
          {list.map((b) => (
            <div key={b.currency ?? "?"} className="mt-2 flex items-baseline justify-between gap-2">
              <span className="text-sm text-zinc-400">
                <CurBadge currency={b.currency} />
                <span className="ml-1.5 text-xs">cash {moneyFmt(b.totalCash)}</span>
              </span>
              <span className="text-sm font-bold tabular-nums text-zinc-100">
                {moneyFmt(b.netAssets)}
              </span>
            </div>
          ))}
          <div className="mt-1 text-[11px] text-zinc-600">
            net assets per currency
          </div>
        </div>
      ))}
    </div>
  );
}

const positionColumns: DataColumn<LbPosition>[] = [
  {
    key: "symbol",
    header: "Symbol",
    sortValue: (p) => p.symbol,
    sortDescFirst: false,
    searchValue: (p) => p.symbol,
    render: (p) => (
      <span className="font-mono font-semibold text-zinc-100">{p.symbol}</span>
    ),
  },
  {
    key: "qty",
    header: "Qty",
    align: "right",
    sortValue: (p) => p.quantity,
    render: (p) => <span className="tabular-nums text-zinc-300">{qtyFmt(p.quantity)}</span>,
  },
  {
    key: "cost",
    header: "Cost",
    align: "right",
    sortValue: (p) => p.costPrice,
    render: (p) => <span className="tabular-nums text-zinc-400">{moneyFmt(p.costPrice)}</span>,
  },
  {
    key: "ccy",
    header: "Ccy",
    align: "right",
    sortValue: (p) => p.currency ?? "",
    sortDescFirst: false,
    filterValue: (p) => (p.currency ?? "").toUpperCase(),
    filterLabel: "Currency",
    render: (p) => <CurBadge currency={p.currency} />,
  },
];

const tradeColumns: DataColumn<LbTrade>[] = [
  {
    key: "date",
    header: "Date",
    sortValue: (t) => t.tradeDate.replace(/\D/g, ""),
    render: (t) => <span className="whitespace-nowrap tabular-nums text-zinc-400">{fmtYmd(t.tradeDate)}</span>,
  },
  {
    key: "symbol",
    header: "Symbol",
    sortValue: (t) => t.symbol,
    sortDescFirst: false,
    searchValue: (t) => t.symbol,
    render: (t) => <span className="font-mono font-semibold text-zinc-100">{t.symbol}</span>,
  },
  {
    key: "side",
    header: "Side",
    sortValue: (t) => (t.quantity >= 0 ? "BUY" : "SELL"),
    sortDescFirst: false,
    filterValue: (t) => (t.quantity >= 0 ? "BUY" : "SELL"),
    filterLabel: "Side",
    render: (t) => (
      <span className={`font-semibold ${t.quantity >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
        {t.quantity >= 0 ? "BUY" : "SELL"}
      </span>
    ),
  },
  {
    key: "qty",
    header: "Qty",
    align: "right",
    sortValue: (t) => Math.abs(t.quantity),
    render: (t) => <span className="tabular-nums text-zinc-300">{qtyFmt(Math.abs(t.quantity))}</span>,
  },
  {
    key: "price",
    header: "Price",
    align: "right",
    sortValue: (t) => t.tradePrice,
    filterValue: (t) => (t.currency ?? "").toUpperCase(),
    filterLabel: "Currency",
    render: (t) => (
      <span className="tabular-nums text-zinc-300">
        {moneyFmt(t.tradePrice)}
        <CurBadge currency={t.currency} />
      </span>
    ),
  },
];

/* ---------------- main card ---------------- */

export function LongbridgeCard() {
  const { status: sessionStatus } = useSession();
  const [creds, setCreds] = useState<LbCreds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);

  const authenticated = sessionStatus === "authenticated";
  const statusQ = api.longbridge.status.useQuery(undefined, {
    enabled: authenticated,
    refetchOnWindowFocus: false,
  });

  const sync = api.longbridge.sync.useMutation({
    onSuccess: () => setError(null),
    onError: (e) => setError(e.message),
  });
  const saveM = api.longbridge.saveCredentials.useMutation();
  const clearM = api.longbridge.clearCredentials.useMutation({
    onSuccess: () => void statusQ.refetch(),
  });

  const doSync = useCallback(
    (c: LbCreds | null, save: boolean) => {
      setError(null);
      if (save && authenticated && c) {
        // Verify + save encrypted first, then sync off the saved credentials.
        saveM.mutate(c, {
          onSuccess: () => {
            setCreds(null); // no need to keep secrets in memory
            sync.mutate();
          },
          onError: (e) => setError(e.message),
        });
      } else {
        // Transient: pasted credentials, used for this sync only.
        if (c) setCreds(c);
        sync.mutate(c ?? undefined);
      }
    },
    [authenticated, saveM, sync],
  );

  // Auto-sync on page load when the account has saved credentials.
  useEffect(() => {
    if (!authenticated || autoStarted.current) return;
    if (statusQ.data?.configured) {
      autoStarted.current = true;
      sync.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, statusQ.data?.configured]);

  const connecting = sync.isPending || saveM.isPending;

  // Hooks must run unconditionally — before any early return.
  const data = sync.data ?? null;
  const posTools = useTableTools<LbPosition>({ storageKey: "lb-pos-tools" });
  const posSort = useTableSort(positionColumns, {
    defaultKey: "symbol",
    storageKey: "lb-positions",
  });
  const posPager = usePager(
    posSort.applySort(posTools.apply(data?.positions ?? [], positionColumns)),
    10,
  );
  const tradeTools = useTableTools<LbTrade>({ storageKey: "lb-trades-tools" });
  const tradeSort = useTableSort(tradeColumns, {
    defaultKey: "date",
    storageKey: "lb-trades",
  });
  const tradePager = usePager(
    tradeSort.applySort(tradeTools.apply(data?.trades ?? [], tradeColumns)),
    10,
  );
  const handlePosSortChange = (key: string) => {
    posSort.toggleSort(key);
    posPager.reset();
  };
  const handleTradeSortChange = (key: string) => {
    tradeSort.toggleSort(key);
    tradePager.reset();
  };

  if (sessionStatus === "loading") {
    return (
      <div className={card}>
        <p className="text-sm text-zinc-500">Checking sign-in…</p>
      </div>
    );
  }

  const configured = statusQ.data?.configured ?? false;
  const showForm = !configured && !data && !connecting && !creds;

  if (showForm) {
    return (
      <>
        <ConnectForm onConnect={doSync} connecting={connecting} />
        {error && (
          <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
            {error}
          </p>
        )}
      </>
    );
  }

  const disconnect = () => {
    if (authenticated) clearM.mutate();
    setCreds(null);
    setError(null);
    sync.reset();
    autoStarted.current = false;
  };

  const lastSyncLabel = data?.syncedAt
    ? new Date(data.syncedAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Landmark size={20} className="shrink-0 text-zinc-400" />
            <span>Longbridge 長橋</span>
            <LbBadge />
            <SyncPill syncing={sync.isPending} live={!!data && !sync.isPending} />
          </h2>
          <p className="text-xs text-zinc-500">
            {lastSyncLabel ? `Synced ${lastSyncLabel} · ` : ""}
            {data
              ? `${data.positions.length} position${data.positions.length === 1 ? "" : "s"} · ${data.tradeCount} trade${data.tradeCount === 1 ? "" : "s"} (12m)`
              : "your account"}{" "}
            · read-only
            {!data?.persisted && data ? " · one-off sync, nothing saved" : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => sync.mutate(creds ?? undefined)}
            disabled={sync.isPending}
            aria-label="Sync now"
            title="Sync now"
            className="rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
          >
            <RefreshCw size={16} className={sync.isPending ? "animate-spin" : ""} />
          </button>
          <GearMenu
            items={[
              {
                label: (
                  <>
                    <Unplug size={15} />
                    Disconnect
                  </>
                ),
                onClick: disconnect,
                danger: true,
              },
            ]}
          />
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </p>
      )}

      {sync.isPending && !data && (
        <p className="mt-3 text-sm text-zinc-500">Pulling your Longbridge data…</p>
      )}

      {data && (
        <>
          <BalancesView balances={data.balances} />

          {data.positions.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-zinc-500">
                Positions ({data.positions.length})
              </p>
              <div className="overflow-hidden rounded-xl border border-zinc-800">
                <div className="border-b border-zinc-800/60 px-3 py-2">
                  <TableToolbar
                    tools={posTools}
                    columns={positionColumns}
                    rows={data.positions}
                    searchPlaceholder="Search symbol…"
                    onChange={() => posPager.reset()}
                  />
                </div>
                <DataTable
                  columns={positionColumns}
                  rows={posPager.rows}
                  keyOf={(p, i) => `${p.accountChannel}-${p.symbol}-${i}`}
                  sort={posSort.sort}
                  onSortChange={handlePosSortChange}
                  emptyText={
                    posTools.hasActive
                      ? "No positions match the current filters."
                      : undefined
                  }
                  footer={
                    <Pagination page={posPager.page} pageCount={posPager.pageCount} onPage={posPager.setPage} />
                  }
                />
              </div>
            </div>
          )}

          {data.trades.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-zinc-500">
                Recent trades ({data.tradeCount})
              </p>
              <div className="overflow-hidden rounded-xl border border-zinc-800">
                <div className="border-b border-zinc-800/60 px-3 py-2">
                  <TableToolbar
                    tools={tradeTools}
                    columns={tradeColumns}
                    rows={data.trades}
                    searchPlaceholder="Search symbol…"
                    onChange={() => tradePager.reset()}
                  />
                </div>
                <DataTable
                  columns={tradeColumns}
                  rows={tradePager.rows}
                  keyOf={(t, i) => `${t.orderId}-${i}`}
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
            </div>
          )}

          {data.positions.length === 0 && data.trades.length === 0 && (
            <p className="mt-3 text-sm text-zinc-500">
              No positions or trades found in the last 12 months.
            </p>
          )}

          <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
            <StatCard label="Positions" value={String(data.positions.length)} tone="neutral" />
            <StatCard label="Trades (12m)" value={String(data.tradeCount)} tone="neutral" />
            <StatCard
              label="Saved"
              value={data.persisted ? "Yes" : "No"}
              tone={data.persisted ? "pos" : "neutral"}
              info={
                data.persisted
                  ? "Credentials are saved encrypted on your account."
                  : "One-off sync — credentials were kept only in memory and never saved."
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
