"use client";

import { useEffect, useRef, useState } from "react";

import { api, type RouterOutputs } from "~/trpc/react";

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

const CREDS_KEY = "stonkgo.ibkr.creds";
const SNAPSHOT_KEY = "stonkgo.ibkr.snapshot";
/** Auto-sync on page load when the cached snapshot is older than this. */
const AUTO_SYNC_AFTER_MS = 6 * 3600 * 1000;

const money = (v: number | null) => {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const moneySigned = (v: number | null) => {
  if (v == null || !Number.isFinite(v))
    return <span className="text-zinc-400">—</span>;
  const cls = v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-zinc-400";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return (
    <span className={cls}>
      {sign}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
};

const qtyFmt = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: 4 });

const fmtYmd = (ymd: string) =>
  /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : ymd;

function valueOf(p: PositionLike): number | null {
  return p.markPrice == null ? null : p.quantity * p.markPrice;
}

/* ---------------- shared presentational pieces ---------------- */

function PositionsTable({ positions }: { positions: PositionLike[] }) {
  const total = positions.reduce<number>((a, p) => a + (valueOf(p) ?? 0), 0);
  const priced = positions.filter((p) => p.markPrice != null).length;
  return (
    <>
      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-sm text-zinc-400">Broker market value</span>
        <span className="text-xl font-bold">{money(total)}</span>
      </div>
      {priced < positions.length && (
        <p className="text-xs text-zinc-500">
          {positions.length - priced} position(s) missing a mark price
        </p>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="pb-2 pr-3">Symbol</th>
              <th className="pb-2 pr-3">Qty</th>
              <th className="pb-2 pr-3">Mark</th>
              <th className="pb-2 pr-3 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p, i) => (
              <tr key={p.id ?? `${p.symbol}-${i}`} className="border-t border-zinc-800/60 text-zinc-200">
                <td className="py-2 pr-3">
                  <span className="font-semibold">{p.symbol}</span>
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
                </td>
                <td className="py-2 pr-3 tabular-nums">{qtyFmt(p.quantity)}</td>
                <td className="py-2 pr-3 tabular-nums text-zinc-400">
                  {p.markPrice == null ? "—" : money(p.markPrice)}
                </td>
                <td className="py-2 text-right tabular-nums">{money(valueOf(p))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AnalyticsView({ data }: { data: Analytics }) {
  const t = data.totals;
  const hasTrades = t.trades > 0;
  return (
    <div className="mt-5 border-t border-zinc-800 pt-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-400">
        📊 Trade analysis
      </h3>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg bg-zinc-800/50 p-3">
          <div className="text-xs text-zinc-500">Realized P/L</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{moneySigned(t.realizedPnl)}</div>
        </div>
        <div className="rounded-lg bg-zinc-800/50 p-3">
          <div className="text-xs text-zinc-500">Dividends</div>
          <div className="mt-1 text-lg font-bold tabular-nums text-emerald-400">{money(t.dividends)}</div>
        </div>
        <div className="rounded-lg bg-zinc-800/50 p-3">
          <div className="text-xs text-zinc-500">Commissions paid</div>
          <div className="mt-1 text-lg font-bold tabular-nums text-rose-400">{money(t.commissions)}</div>
        </div>
        <div className="rounded-lg bg-zinc-800/50 p-3">
          <div className="text-xs text-zinc-500">Trades</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{t.trades}</div>
        </div>
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
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                    <th className="pb-2 pr-3">Symbol</th>
                    <th className="pb-2 pr-3">Trades</th>
                    <th className="pb-2 pr-3 text-right">Realized P/L</th>
                    <th className="pb-2 text-right">Fees</th>
                  </tr>
                </thead>
                <tbody>
                  {data.symbols.slice(0, 10).map((s) => (
                    <tr key={s.symbol} className="border-t border-zinc-800/60 text-zinc-200">
                      <td className="py-2 pr-3 font-semibold">{s.symbol}</td>
                      <td className="py-2 pr-3 tabular-nums text-zinc-400">{s.trades}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{moneySigned(s.realizedPnl)}</td>
                      <td className="py-2 text-right tabular-nums text-zinc-400">{money(s.commissions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.recentTrades.length > 0 && (
            <>
              <h4 className="mt-4 text-xs font-bold uppercase tracking-wide text-zinc-500">
                Recent trades
              </h4>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                      <th className="pb-2 pr-3">Date</th>
                      <th className="pb-2 pr-3">Symbol</th>
                      <th className="pb-2 pr-3">Qty</th>
                      <th className="pb-2 pr-3 text-right">Price</th>
                      <th className="pb-2 text-right">P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentTrades.map((tr) => (
                      <tr key={tr.id} className="border-t border-zinc-800/60 text-zinc-200">
                        <td className="py-1.5 pr-3 tabular-nums text-zinc-400">{fmtYmd(tr.tradeDate)}</td>
                        <td className="py-1.5 pr-3 font-semibold">{tr.symbol}</td>
                        <td className="py-1.5 pr-3 tabular-nums">{qtyFmt(tr.quantity)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {tr.tradePrice == null ? "—" : money(tr.tradePrice)}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{moneySigned(tr.realizedPnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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

function ConnectForm({ onConnect }: { onConnect: (c: Creds) => void }) {
  const [token, setToken] = useState("");
  const [queryId, setQueryId] = useState("");
  const valid = token.trim().length > 0 && queryId.trim().length > 0;
  return (
    <div className={card}>
      <h2 className="text-lg font-bold">🏦 Interactive Brokers</h2>
      <p className="mt-1 text-sm text-zinc-400">
        Connect your IBKR account to pull real positions and trade analysis
        (read-only — Flex can&apos;t trade).
      </p>
      <SetupSteps />
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
  const autoStarted = useRef(false);

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
    },
    onError: (e) => setError(e.message),
  });

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

  const data = sync.data ?? snapshot?.data ?? null;

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
    return (
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
    );
  }

  const lastSync = sync.data
    ? new Date()
    : snapshot
      ? new Date(snapshot.at)
      : null;

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

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">🏦 Interactive Brokers</h2>
          <p className="text-xs text-zinc-500">
            {lastSync
              ? `Synced ${lastSync.toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })} · `
              : ""}
            {data ? `${data.positions.length} position${data.positions.length === 1 ? "" : "s"}` : "your account"} ·
            end-of-day data
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => sync.mutate(creds)}
            disabled={sync.isPending}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
          >
            {sync.isPending ? "Syncing…" : "↻ Sync"}
          </button>
          <button
            onClick={disconnect}
            className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300"
          >
            Disconnect
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </p>
      )}

      {sync.isPending && !data && (
        <p className="mt-3 text-sm text-zinc-500">
          Pulling your IBKR records… (IBKR generates the report, takes ~10–30s)
        </p>
      )}

      {data && (
        <>
          <PositionsTable positions={data.positions} />
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
