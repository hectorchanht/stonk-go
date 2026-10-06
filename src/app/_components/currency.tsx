"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

/**
 * Display-currency switching for Holdr. IBKR/Flex data is always in USD;
 * amounts are converted for display only.
 *
 * FX rates come from the same free public source moneyrate.lol uses
 * (fawazahmed0/currency-api): primary pages.dev mirror + jsdelivr fallback,
 * no API key. Rates are cached in localStorage for 1 hour.
 */

const RATE_URLS = [
  "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
];

export const CURRENCIES = [
  { code: "USD", name: "US Dollar" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "TWD", name: "Taiwan Dollar" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "KRW", name: "South Korean Won" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];

const CUR_KEY = "holdr.currency";
const FX_KEY = "holdr.fx.usd";
const FX_TTL_MS = 3600 * 1000;

type FxCache = {
  rates: Record<string, number>;
  date: string;
  fetchedAt: number;
};

function loadCachedFx(): FxCache | null {
  try {
    const raw = window.localStorage.getItem(FX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FxCache;
    if (!parsed.rates || Date.now() - parsed.fetchedAt > FX_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function fetchFx(): Promise<FxCache> {
  let lastErr: unknown = null;
  for (const url of RATE_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`FX request failed: ${res.status}`);
      const json = (await res.json()) as {
        date: string;
        usd: Record<string, number>;
      };
      const fx: FxCache = {
        rates: json.usd,
        date: json.date,
        fetchedAt: Date.now(),
      };
      try {
        window.localStorage.setItem(FX_KEY, JSON.stringify(fx));
      } catch {
        /* ignore */
      }
      return fx;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new Error("FX fetch failed");
}

/** Format a USD amount in the given display currency. */
export function formatMoney(
  usd: number,
  currency: string,
  rates?: Record<string, number> | null,
  opts?: { sign?: boolean },
): string {
  const rate = rates?.[currency.toLowerCase()] ?? 1;
  const converted = usd * rate;
  const sign = opts?.sign && converted > 0 ? "+" : "";
  try {
    return (
      sign +
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      }).format(converted)
    );
  } catch {
    return `${sign}${currency} ${converted.toFixed(2)}`;
  }
}

type CurrencyCtx = {
  currency: CurrencyCode;
  setCurrency: (c: CurrencyCode) => void;
  rates: Record<string, number> | null;
  rateDate: string | null;
  /** Convert a USD amount to the display currency. */
  convert: (usd: number) => number;
  /** Format a USD amount in the display currency. */
  fmt: (usd: number, opts?: { sign?: boolean }) => string;
};

const Ctx = createContext<CurrencyCtx>({
  currency: "USD",
  setCurrency: () => {
    // Set by CurrencyProvider; never called unmounted.
  },
  rates: null,
  rateDate: null,
  convert: (usd) => usd,
  fmt: (usd, opts) => formatMoney(usd, "USD", null, opts),
});

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [currency, setCurrencyState] = useState<CurrencyCode>(() => {
    if (typeof window === "undefined") return "USD";
    try {
      const saved = window.localStorage.getItem(CUR_KEY);
      if (saved && CURRENCIES.some((c) => c.code === saved))
        return saved as CurrencyCode;
    } catch {
      /* ignore */
    }
    return "USD";
  });
  const [fx, setFx] = useState<FxCache | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = loadCachedFx();
    if (cached) setFx(cached);
    // Refresh in the background even when a fresh cache exists.
    fetchFx()
      .then((fresh) => {
        if (!cancelled) setFx(fresh);
      })
      .catch(() => {
        /* stay on cache / USD fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setCurrency = useCallback((c: CurrencyCode) => {
    setCurrencyState(c);
    try {
      window.localStorage.setItem(CUR_KEY, c);
    } catch {
      /* ignore */
    }
  }, []);

  const convert = useCallback(
    (usd: number) => usd * (fx?.rates[currency.toLowerCase()] ?? 1),
    [fx, currency],
  );
  const fmt = useCallback(
    (usd: number, opts?: { sign?: boolean }) =>
      formatMoney(usd, currency, fx?.rates, opts),
    [fx, currency],
  );

  return (
    <Ctx.Provider
      value={{ currency, setCurrency, rates: fx?.rates ?? null, rateDate: fx?.date ?? null, convert, fmt }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useCurrency(): CurrencyCtx {
  return useContext(Ctx);
}

/** Compact currency picker for the dashboard header. */
export function CurrencyPicker() {
  const { currency, setCurrency, rates, rateDate } = useCurrency();
  const rate =
    currency === "USD" ? null : rates?.[currency.toLowerCase()] ?? null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5"
      title={
        rateDate
          ? `Converted from USD at ${rateDate} rates (moneyrate.lol uses the same source)`
          : "Converted from USD with live FX rates"
      }
    >
      <select
        value={currency}
        onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
        aria-label="Display currency"
        className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm font-semibold text-zinc-200 hover:border-zinc-500"
      >
        {CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code}
          </option>
        ))}
      </select>
      {rate != null && (
        <span className="hidden text-xs text-zinc-500 md:inline">
          1 USD ≈ {rate.toFixed(2)} {currency}
        </span>
      )}
    </span>
  );
}
