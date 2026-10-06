"use client";

import { useState } from "react";

import { api, type RouterOutputs } from "~/trpc/react";

type Status = RouterOutputs["ibkr"]["status"];
type Position = Status["positions"][number];

const card = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5";

const money = (v: number | null) => {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const qtyFmt = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: 4 });

function valueOf(p: Position): number | null {
  return p.markPrice == null ? null : p.quantity * p.markPrice;
}

function SetupHelp() {
  return (
    <div className={card}>
      <h2 className="text-lg font-bold">🏦 Interactive Brokers</h2>
      <p className="mt-1 text-sm text-zinc-400">
        Connect your IBKR account to pull real positions (read-only, via the
        Flex Web Service — no trading access).
      </p>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-zinc-300">
        <li>
          In Client Portal go to <b>Reports → Flex Queries</b>, create an{" "}
          <b>Activity</b> query with the <b>Open Positions</b> section, and note
          its Query ID.
        </li>
        <li>
          Go to <b>Settings → Reporting → Flex Web Service</b> and generate a
          token.
        </li>
        <li>
          Set <code className="text-zinc-100">IBKR_FLEX_TOKEN</code> and{" "}
          <code className="text-zinc-100">IBKR_FLEX_QUERY_ID</code> as secrets /
          environment variables on the Worker (dashboard → Settings →
          Variables), or in <code className="text-zinc-100">.env</code> locally.
        </li>
        <li>Reload this page and hit Sync.</li>
      </ol>
      <p className="mt-3 text-xs text-zinc-500">
        Flex data is end-of-day (refreshes after market close). The token is
        read-only reporting access — treat it like a password.
      </p>
    </div>
  );
}

export function BrokerCard() {
  const utils = api.useUtils();
  const status = api.ibkr.status.useQuery();
  const [error, setError] = useState<string | null>(null);
  const sync = api.ibkr.sync.useMutation({
    onSuccess: () => {
      setError(null);
      void utils.ibkr.status.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  if (status.isLoading) {
    return (
      <div className={card}>
        <p className="text-sm text-zinc-500">Checking IBKR connection…</p>
      </div>
    );
  }
  if (status.isError || !status.data) {
    return (
      <div className={card}>
        <p className="text-sm text-rose-400">
          Couldn&apos;t check the IBKR connection.
        </p>
      </div>
    );
  }

  const s = status.data;
  if (!s.configured) return <SetupHelp />;

  const total = s.positions.reduce<number>(
    (acc, p) => acc + (valueOf(p) ?? 0),
    0,
  );
  const priced = s.positions.filter((p) => p.markPrice != null).length;

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">🏦 Interactive Brokers</h2>
          <p className="text-xs text-zinc-500">
            {s.lastSyncedAt
              ? `Synced ${new Date(s.lastSyncedAt).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })} · `
              : "Never synced · "}
            {s.positionCount} position{s.positionCount === 1 ? "" : "s"} ·
            end-of-day data
          </p>
        </div>
        <button
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        >
          {sync.isPending ? "Syncing…" : "↻ Sync from IBKR"}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </p>
      )}

      {s.positions.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">
          No positions yet — hit Sync to pull them from IBKR.
        </p>
      ) : (
        <>
          <div className="mt-3 flex items-baseline justify-between">
            <span className="text-sm text-zinc-400">Broker market value</span>
            <span className="text-xl font-bold">{money(total)}</span>
          </div>
          {priced < s.positionCount && (
            <p className="text-xs text-zinc-500">
              {s.positionCount - priced} position(s) missing a mark price
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
                {s.positions.map((p) => (
                  <tr
                    key={p.id}
                    className="border-t border-zinc-800/60 text-zinc-200"
                  >
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
                    <td className="py-2 pr-3 tabular-nums">
                      {qtyFmt(p.quantity)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-zinc-400">
                      {p.markPrice == null ? "—" : money(p.markPrice)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {money(valueOf(p))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
