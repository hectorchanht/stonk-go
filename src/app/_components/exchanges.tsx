"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Bitcoin,
  Check,
  ChevronDown,
  RefreshCw,
  Save,
  Settings,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { useCurrency } from "~/app/_components/currency";

type ExchangeName = "coinbase" | "binance";
type SyncResult = RouterOutputs["exchanges"]["sync"];
type Status = RouterOutputs["exchanges"]["status"]["exchanges"][ExchangeName];

/** Position shape the dashboard merges into its Holdings table. */
export interface ExchangePositionLike {
  symbol: string;
  quantity: number;
  markPrice: number | null;
  costBasisPrice?: number | null;
  label?: string | null;
}

const card = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5";

const EXCHANGE_META: Record<
  ExchangeName,
  { title: string; accent: string; snapshotKey: string }
> = {
  coinbase: {
    title: "Coinbase",
    accent: "text-sky-400",
    snapshotKey: "holdr.exchange.coinbase.snapshot",
  },
  binance: {
    title: "Binance",
    accent: "text-amber-400",
    snapshotKey: "holdr.exchange.binance.snapshot",
  },
};

const AUTO_SYNC_AFTER_MS = 1 * 3600 * 1000;

function SetupSteps({ exchange }: { exchange: ExchangeName }) {
  if (exchange === "coinbase") {
    return (
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-zinc-300">
        <li>
          On <b>coinbase.com</b> open your profile menu → <b>API</b> (or
          Settings → API) and create an API key.
        </li>
        <li>
          Enable <b>view/read permissions only</b> — leave trading and
          transfers OFF.
        </li>
        <li>
          Copy the API key + secret (the secret is shown once) and paste them
          below.
        </li>
      </ol>
    );
  }
  return (
    <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-zinc-300">
      <li>
        On <b>binance.com</b> go to Profile → <b>API Management</b> and create
        an API key.
      </li>
      <li>
        Check <b>only &ldquo;Enable Reading&rdquo;</b> — leave spot/margin
        trading and withdrawals OFF. An IP whitelist is recommended.
      </li>
      <li>Paste the API key + secret below.</li>
    </ol>
  );
}

/** Gear menu for the connected card (mirrors the IBKR card). */
function GearMenu({
  items,
  label,
}: {
  items: { label: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        title={label}
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

function BalancesTable({ data }: { data: SyncResult }) {
  const { fmt } = useCurrency();
  const money = (cents: number | null) =>
    cents == null ? "—" : fmt(cents / 100);
  const rows = [...data.items].sort(
    (a, b) => (b.valueCents ?? -1) - (a.valueCents ?? -1),
  );
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-zinc-400">Exchange total</span>
        <span className="text-xl font-bold tabular-nums">{money(data.totalCents)}</span>
      </div>
      {data.driftCents !== 0 && (
        <p className="mt-1 text-xs text-amber-400/90">
          Rounding drift {money(data.driftCents)} across {data.pricedCount} priced
          assets{data.reconciled ? " (within bound)" : " — exceeds bound, flagged"}.
        </p>
      )}
      {data.unpriced.length > 0 && (
        <p className="mt-1 text-xs text-zinc-500">
          No price for {data.unpriced.join(", ")} — quantities shown, excluded from total.
        </p>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="pb-2 pr-3">Asset</th>
              <th className="pb-2 pr-3 text-right">Qty</th>
              <th className="pb-2 pr-3 text-right">Price</th>
              <th className="pb-2 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.asset} className="border-t border-zinc-800/60 text-zinc-200">
                <td className="py-2 pr-3 font-semibold">{r.asset}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-zinc-300" title="Native quantity (exact)">
                  {r.quantity}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-zinc-400">
                  {r.priceUsd == null ? "—" : money(Math.round(Number(r.priceUsd) * 100))}
                </td>
                <td className="py-2 text-right tabular-nums">{money(r.valueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-zinc-600">
        Quantities are native (e.g. BTC), values in USD at each asset&apos;s spot
        price at sync time.
      </p>
    </div>
  );
}

function loadSnapshot(key: string): { at: string; data: SyncResult } | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { at: string; data: SyncResult }) : null;
  } catch {
    return null;
  }
}

function ExchangeCard({
  exchange,
  onPositions,
}: {
  exchange: ExchangeName;
  onPositions?: (positions: ExchangePositionLike[]) => void;
}) {
  const meta = EXCHANGE_META[exchange];
  const { data: session } = useSession();

  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{ at: string; data: SyncResult } | null>(null);
  const autoStarted = useRef(false);

  const statusQ = api.exchanges.status.useQuery(undefined, { retry: false });
  const st: Status | undefined = statusQ.data?.exchanges[exchange];
  const savedQ = api.exchanges.savedCredentials.useQuery(
    { exchange },
    { enabled: !!session?.user, retry: false },
  );

  const balancesQ = api.exchanges.balances.useQuery(
    { exchange },
    { enabled: !!session?.user && !!st?.configured, retry: false },
  );

  const sync = api.exchanges.sync.useMutation({
    onSuccess: (data) => {
      setError(null);
      const snap = { at: new Date().toISOString(), data };
      setSnapshot(snap);
      try {
        localStorage.setItem(meta.snapshotKey, JSON.stringify(snap));
      } catch {
        /* ignore */
      }
      void statusQ.refetch();
      void balancesQ.refetch();
      void savedQ.refetch();
    },
    onError: (e) => setError(e.message),
  });

  const saveCreds = api.exchanges.saveCredentials.useMutation({
    onSuccess: () => {
      setError(null);
      setApiKey("");
      setApiSecret("");
      void statusQ.refetch();
      void savedQ.refetch();
    },
    onError: (e) => setError(e.message),
  });

  const clearCreds = api.exchanges.clearCredentials.useMutation({
    onSuccess: () => {
      setError(null);
      setSnapshot(null);
      try {
        localStorage.removeItem(meta.snapshotKey);
      } catch {
        /* ignore */
      }
      onPositions?.([]);
      void statusQ.refetch();
      void savedQ.refetch();
      void balancesQ.refetch();
    },
    onError: (e) => setError(e.message),
  });

  useEffect(() => {
    setSnapshot(loadSnapshot(meta.snapshotKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange]);

  const configured = !!st?.configured;
  const data: SyncResult | null = sync.data ?? snapshot?.data ?? null;

  // Auto-sync once when saved credentials exist and the snapshot is stale.
  useEffect(() => {
    if (!session?.user || !configured || autoStarted.current || sync.isPending || data) return;
    autoStarted.current = true;
    const snap = loadSnapshot(meta.snapshotKey);
    const stale = !snap || Date.now() - new Date(snap.at).getTime() > AUTO_SYNC_AFTER_MS;
    if (stale) sync.mutate({ exchange });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user, configured]);

  // Report balances upward so the dashboard totals can include them.
  useEffect(() => {
    const items =
      data?.items ??
      balancesQ.data?.items.map((b) => ({
        asset: b.asset,
        quantity: b.quantity,
        priceUsd: b.priceUsd,
        priceSource: b.priceSource,
        priceAt: b.priceAt,
        valueCents: b.valueCents,
      }));
    onPositions?.(
      (items ?? []).map((i) => ({
        symbol: i.asset,
        quantity: Number(i.quantity),
        markPrice: i.priceUsd == null ? null : Number(i.priceUsd),
        label: meta.title.toUpperCase(),
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, balancesQ.data]);

  const lastSyncLabel = (() => {
    const at = sync.data ? new Date() : st?.lastSyncedAt ? new Date(st.lastSyncedAt) : snapshot ? new Date(snapshot.at) : null;
    return at
      ? at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : null;
  })();

  const valid = apiKey.trim().length > 0 && apiSecret.trim().length > 0;

  const gearItems: { label: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }[] = [
    {
      label: (
        <>
          <RefreshCw size={15} className={sync.isPending ? "animate-spin" : ""} />
          {sync.isPending ? "Syncing…" : "Sync now"}
        </>
      ),
      onClick: () => sync.mutate({ exchange }),
      disabled: sync.isPending,
    },
    {
      label: clearCreds.isPending ? "Removing…" : "Remove saved credentials",
      onClick: () => clearCreds.mutate({ exchange }),
      danger: true,
      disabled: clearCreds.isPending,
    },
  ];

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Bitcoin size={20} className={`shrink-0 ${meta.accent}`} />
            <span>{meta.title}</span>
            {data && !sync.isPending && (
              <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-700/60 bg-emerald-900/40 px-2.5 py-0.5 align-middle text-[10px] font-extrabold tracking-wider text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                LIVE
              </span>
            )}
            {sync.isPending && (
              <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-amber-700/60 bg-amber-900/40 px-2.5 py-0.5 align-middle text-[10px] font-extrabold tracking-wider text-amber-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                SYNCING
              </span>
            )}
          </h2>
          <p className="text-xs text-zinc-500">
            {st?.keyLast4 ? (
              <>
                <Check size={13} className="mr-1 inline text-emerald-400" />
                Key …{st.keyLast4} saved{lastSyncLabel ? ` · synced ${lastSyncLabel}` : ""}
              </>
            ) : (
              <>Read-only balances — {meta.title} can never trade from here</>
            )}
          </p>
        </div>
        {configured && <GearMenu items={gearItems} label={`${meta.title} settings`} />}
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </p>
      )}

      {!configured && !data && (
        <>
          <p className="mt-1 text-sm text-zinc-400">
            Connect your {meta.title} account to pull balances (read-only).
          </p>
          <SetupSteps exchange={exchange} />
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-zinc-500">API key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your API key"
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-zinc-500">API secret</span>
              <input
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="Paste your API secret"
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                disabled={!valid || sync.isPending}
                onClick={() => sync.mutate({ exchange, apiKey: apiKey.trim(), apiSecret: apiSecret.trim() })}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {sync.isPending ? "Syncing…" : "Connect & sync"}
              </button>
              {session?.user && data && !saveCreds.isPending && (
                <button
                  onClick={() =>
                    saveCreds.mutate({ exchange, apiKey: apiKey.trim(), apiSecret: apiSecret.trim() })
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-700"
                >
                  <Save size={15} /> Save to my account
                </button>
              )}
            </div>
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            Keys are encrypted on our server (AES-GCM) and only ever used to
            read balances. Use a <b>read-only</b> key — Holdr has no trading
            code paths at all.
          </p>
          <p className="mt-1 text-xs text-zinc-600">
            Not signed in? Your keys stay in this browser for this sync only and
            are never saved. Totals are in USD.
          </p>
        </>
      )}

      {data && <BalancesTable data={data} />}

      {configured && !data && !sync.isPending && balancesQ.data && balancesQ.data.items.length === 0 && (
        <p className="mt-3 text-sm text-zinc-500">
          No balances found on {meta.title} — or the last sync returned nothing.
        </p>
      )}
    </div>
  );
}

export function ExchangeCards({
  onPositions,
}: {
  onPositions?: (positions: ExchangePositionLike[]) => void;
}) {
  const [coinbase, setCoinbase] = useState<ExchangePositionLike[]>([]);
  const [binance, setBinance] = useState<ExchangePositionLike[]>([]);
  useEffect(() => {
    onPositions?.([...coinbase, ...binance]);
  }, [coinbase, binance, onPositions]);
  return (
    <>
      <ExchangeCard exchange="coinbase" onPositions={setCoinbase} />
      <ExchangeCard exchange="binance" onPositions={setBinance} />
    </>
  );
}

/** Collapsible wrapper used by the dashboard (mirrors the IBKR card). */
export function ExchangePositionsToggle({ positions }: { positions: ExchangePositionLike[] }) {
  const [open, setOpen] = useState(false);
  if (positions.length === 0) return null;
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200"
      >
        <ChevronDown size={14} className={`shrink-0 text-zinc-500 transition-transform ${open ? "" : "-rotate-90"}`} />
        <span>
          {positions.length} crypto position{positions.length === 1 ? "" : "s"} — also listed in Holdings above
        </span>
        <span className="text-xs text-zinc-600">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-sm text-zinc-300">
          {positions.map((p) => (
            <li key={`${p.label}-${p.symbol}`} className="flex justify-between tabular-nums">
              <span>
                <span className="font-semibold">{p.symbol}</span>
                <span className="ml-2 text-xs text-zinc-500">{p.label}</span>
              </span>
              <span>
                {p.quantity} {p.markPrice != null ? `@ $${p.markPrice}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
