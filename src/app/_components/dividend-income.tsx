"use client";

import { useCallback } from "react";

import { useCurrency } from "~/app/_components/currency";

/**
 * Dividend income: monthly bars from the IBKR Flex cash transactions.
 * Amounts arrive in USD (converted server-side); shown in display currency.
 */

interface DividendMonth {
  month: string; // YYYY-MM
  amount: number;
}

function useMoney() {
  const { fmt } = useCurrency();
  return useCallback(
    (v: number | null) =>
      v == null || !Number.isFinite(v) ? "—" : fmt(v),
    [fmt],
  );
}

const fmtMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
  });
};

export function DividendIncome({ months }: { months: DividendMonth[] }) {
  const money = useMoney();
  if (months.length === 0) return null;

  const last12 = months.slice(-12);
  const max = Math.max(...last12.map((m) => m.amount), 0);
  const total = months.reduce((a, m) => a + m.amount, 0);

  return (
    <>
      <h4 className="mt-4 text-xs font-bold uppercase tracking-wide text-zinc-500">
        Dividend income
      </h4>
      <div className="mt-2 space-y-1.5">
        {last12.map((m) => (
          <div key={m.month} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs tabular-nums text-zinc-500">
              {fmtMonth(m.month)}
            </span>
            <div className="h-3.5 min-w-0 flex-1 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800/70">
              <div
                className="h-full rounded bg-emerald-500/70"
                style={{
                  width: `${max > 0 ? (m.amount / max) * 100 : 0}%`,
                }}
              />
            </div>
            <span className="w-24 shrink-0 text-right text-sm tabular-nums text-zinc-900 dark:text-zinc-200">
              {money(m.amount)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {money(total)} total across {months.length} month
        {months.length === 1 ? "" : "s"} · from IBKR cash transactions, in your
        display currency
      </p>
    </>
  );
}
