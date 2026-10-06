"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

export interface MissingSymbol {
  symbol: string;
  name: string | null;
}

/**
 * Bottom-sheet modal listing the symbols Yahoo has no price history for.
 * Opened by tapping the "prices missing for N" caption in the Performance
 * section. Backdrop tap and Escape both dismiss it.
 */
export function MissingPricesModal({
  symbols,
  onClose,
}: {
  symbols: MissingSymbol[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label="Symbols without price history"
    >
      {/* Backdrop — tap outside to dismiss */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/60"
      />
      {/* Sheet */}
      <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-zinc-700 bg-zinc-900 p-4 pb-8 sm:mx-auto sm:max-w-md sm:rounded-2xl sm:border">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-base font-bold text-zinc-100">
            Symbols without price history
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={20} aria-hidden />
          </button>
        </div>
        {symbols.length === 0 ? (
          <p className="py-4 text-center text-sm text-zinc-500">
            Every holding has price history.
          </p>
        ) : (
          <ul className="space-y-2">
            {symbols.map((s) => (
              <li
                key={s.symbol}
                className="rounded-lg bg-zinc-800/60 px-3 py-2.5"
              >
                <div className="text-sm font-bold tabular-nums text-zinc-100">
                  {s.symbol}
                </div>
                <div className="text-xs text-zinc-400">
                  {s.name ?? "Company name unavailable"}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs leading-relaxed text-zinc-400">
          These holdings are excluded from the true value curve on days
          without price data — the totals shown cover holdings with price
          data only.
        </p>
      </div>
    </div>
  );
}
