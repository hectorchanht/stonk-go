"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { ArrowUpDown, Bell, X } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";

/**
 * Price alerts: the user sets a target per symbol; a scheduled job checks
 * /api/alerts/check every 30 minutes and emails them (Resend) when it hits.
 * Alerts are one-shot — a hit deactivates the alert.
 */

type AlertRow = RouterOutputs["alerts"]["list"][number];

type PriceAlertSort = "symbol" | "target";
const PA_SORT_KEY = "holdr.pricealert-sort";

function loadPaSort(): PriceAlertSort {
  try {
    const v = window.localStorage.getItem(PA_SORT_KEY);
    if (v === "target" || v === "symbol") return v;
  } catch {
    /* ignore */
  }
  return "symbol";
}

/** Native-currency prefix for display (HKEX codes are numeric). */
const csym = (s: string) => (/^\d{1,5}$/.test(s.trim()) ? "HK$" : "$");

const inputCls =
  "w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500";

export function PriceAlerts() {
  const { status } = useSession();
  const listQ = api.alerts.list.useQuery(undefined, {
    enabled: status === "authenticated",
    retry: false,
  });
  const [symbol, setSymbol] = useState("");
  const [target, setTarget] = useState("");
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [error, setError] = useState<string | null>(null);
  const [paSort, setPaSort] = useState<PriceAlertSort>(loadPaSort);

  const changePaSort = (m: PriceAlertSort) => {
    setPaSort(m);
    try {
      window.localStorage.setItem(PA_SORT_KEY, m);
    } catch {
      /* ignore */
    }
  };

  const create = api.alerts.create.useMutation({
    onSuccess: () => {
      setSymbol("");
      setTarget("");
      setError(null);
      void listQ.refetch();
    },
    onError: (e) => setError(e.message),
  });
  const remove = api.alerts.remove.useMutation({
    onSuccess: () => void listQ.refetch(),
    onError: (e) => setError(e.message),
  });

  if (status === "loading") {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/60 sm:p-5">
        <p className="text-sm text-zinc-500">Checking sign-in…</p>
      </div>
    );
  }

  if (status !== "authenticated") {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/60 sm:p-5">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          <Bell size={15} className="mr-1.5 inline text-zinc-400" />
          Get an email when a stock crosses your target price.
        </p>
        <a
          href="/login"
          className="mt-3 inline-block rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
        >
          Sign in to set alerts
        </a>
      </div>
    );
  }

  const alerts = listQ.data ?? [];
  // Stable: ties keep server order.
  const sortPa = (list: AlertRow[]) =>
    [...list].sort((a, b) =>
      paSort === "target"
        ? a.targetPrice - b.targetPrice
        : a.symbol.localeCompare(b.symbol),
    );
  const active = sortPa(alerts.filter((a) => a.active));
  const done = sortPa(alerts.filter((a) => !a.active));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const px = Number(target);
    if (!symbol.trim()) {
      setError("Enter a symbol.");
      return;
    }
    if (!Number.isFinite(px) || px <= 0) {
      setError("Enter a target price above zero.");
      return;
    }
    create.mutate({ symbol: symbol.trim(), targetPrice: px, direction });
  };

  const row = (a: AlertRow) => (
    <li
      key={a.id}
      className={`flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5 ${
        a.active ? "" : "opacity-50"
      }`}
    >
      <span className="font-semibold text-zinc-900 dark:text-zinc-100">
        {a.symbol}
      </span>
      <span className="text-zinc-600 dark:text-zinc-400">
        {a.direction === "above" ? "≥" : "≤"}{" "}
        <span className="tabular-nums">
          {csym(a.symbol)}
          {a.targetPrice}
        </span>
      </span>
      {a.lastPrice != null && (
        <span className="text-xs tabular-nums text-zinc-500">
          last {csym(a.symbol)}
          {a.lastPrice}
        </span>
      )}
      {!a.active && (
        <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          triggered
        </span>
      )}
      <button
        onClick={() => remove.mutate({ id: a.id })}
        className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-rose-500 dark:hover:bg-zinc-800 dark:hover:text-rose-400"
        title="Delete alert"
        aria-label={`Delete alert for ${a.symbol}`}
      >
        <X size={14} />
      </button>
    </li>
  );

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white/60 p-0 dark:border-zinc-800 dark:bg-zinc-900/60">
      <form
        onSubmit={submit}
        className="grid grid-cols-2 gap-3 border-b border-zinc-200 p-4 dark:border-zinc-800 sm:p-5"
      >
        <div className="col-span-1">
          <label className="mb-1 block text-xs text-zinc-500">Symbol</label>
          <input
            className={`${inputCls} uppercase`}
            placeholder="AAPL"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          />
        </div>
        <div className="col-span-1">
          <label className="mb-1 block text-xs text-zinc-500">
            Target price
          </label>
          <input
            className={inputCls}
            inputMode="decimal"
            placeholder="300.00"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
        <div className="col-span-1">
          <label className="mb-1 block text-xs text-zinc-500">Alert when</label>
          <div className="flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
            {(["above", "below"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDirection(d)}
                className={`flex-1 py-2 text-sm font-semibold capitalize ${
                  direction === d
                    ? "bg-amber-600 text-white"
                    : "bg-white text-zinc-500 hover:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="col-span-1 flex items-end">
          <button
            type="submit"
            disabled={create.isPending}
            className="w-full rounded-lg bg-amber-600 py-2 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:opacity-50"
          >
            {create.isPending ? "Adding…" : "Add alert"}
          </button>
        </div>
        {error && (
          <p className="col-span-2 text-sm text-rose-500 dark:text-rose-400">
            {error}
          </p>
        )}
      </form>
      {listQ.isLoading ? (
        <p className="px-4 py-4 text-sm text-zinc-500">Loading alerts…</p>
      ) : alerts.length === 0 ? (
        <p className="px-4 py-4 text-sm text-zinc-500">
          No alerts yet — set one above and we&apos;ll email you when it hits.
          Checked every 30 minutes.
        </p>
      ) : (
        <>
          {alerts.length > 1 && (
            <div
              className="flex items-center gap-1 border-b border-zinc-200 px-4 py-1 dark:border-zinc-800 sm:px-5"
              role="group"
              aria-label="Sort price alerts"
            >
              <ArrowUpDown size={13} className="mr-1 shrink-0 text-zinc-500" aria-hidden />
              {(
                [
                  { mode: "symbol", label: "Symbol" },
                  { mode: "target", label: "Target" },
                ] as const
              ).map(({ mode, label }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => changePaSort(mode)}
                  aria-pressed={paSort === mode}
                  className={`min-h-[44px] rounded-lg px-3 text-xs font-semibold ${
                    paSort === mode
                      ? "bg-zinc-700 text-zinc-100"
                      : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <ul className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
            {active.map(row)}
          </ul>
          {done.length > 0 && (
            <>
              <p className="border-t border-zinc-200 px-4 pt-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-800 sm:px-5">
                Triggered
              </p>
              <ul className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
                {done.map(row)}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
