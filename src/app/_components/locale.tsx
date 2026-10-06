"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * AI insights language. The locale tailors the Workers AI system prompt and
 * the reply language/style (see ~/server/ai.ts). Persisted in localStorage;
 * the insights cache key includes the locale, so switching languages
 * regenerates (and each language keeps its own 24h cache).
 */
export const LOCALES = [
  { code: "en", label: "English", short: "EN" },
  { code: "zh-Hant", label: "繁體中文（廣東話）", short: "繁" },
  { code: "zh-Hans", label: "简体中文", short: "简" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

const LOCALE_KEY = "holdr.locale";

function loadLocale(): LocaleCode {
  try {
    const raw = window.localStorage.getItem(LOCALE_KEY);
    if (
      raw &&
      (LOCALES as readonly { code: string }[]).some((l) => l.code === raw)
    ) {
      return raw as LocaleCode;
    }
  } catch {
    /* ignore */
  }
  return "en";
}

const Ctx = createContext<{
  locale: LocaleCode;
  setLocale: (l: LocaleCode) => void;
  /** Language for AI responses — separate from UI locale. */
  aiLocale: LocaleCode;
  setAiLocale: (l: LocaleCode) => void;
}>({
  locale: "en",
  setLocale: () => undefined,
  aiLocale: "en",
  setAiLocale: () => undefined,
});

const AI_LOCALE_KEY = "holdr.ai-locale";

function loadAiLocale(): LocaleCode {
  try {
    const v = window.localStorage.getItem(AI_LOCALE_KEY);
    if (v === "en" || v === "zh-Hant" || v === "zh-Hans") return v;
  } catch {
    /* ignore */
  }
  return "en";
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  // undefined = not yet loaded (avoids SSR mismatch); falls back to "en".
  const [locale, setLocaleState] = useState<LocaleCode | undefined>(undefined);
  const [aiLocale, setAiLocaleState] = useState<LocaleCode | undefined>(undefined);

  useEffect(() => {
    setLocaleState(loadLocale());
    setAiLocaleState(loadAiLocale());
  }, []);

  const setLocale = useCallback((l: LocaleCode) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(LOCALE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const setAiLocale = useCallback((l: LocaleCode) => {
    setAiLocaleState(l);
    try {
      window.localStorage.setItem(AI_LOCALE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <Ctx.Provider
      value={{
        locale: locale ?? "en",
        setLocale,
        aiLocale: aiLocale ?? "en",
        setAiLocale,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useLocale(): {
  locale: LocaleCode;
  setLocale: (l: LocaleCode) => void;
  aiLocale: LocaleCode;
  setAiLocale: (l: LocaleCode) => void;
} {
  return useContext(Ctx);
}

/** Short display label for a locale code ("EN" / "繁" / "简"). */
export function localeShort(code: string): string {
  return (
    (LOCALES as readonly { code: string; short: string }[]).find(
      (l) => l.code === code,
    )?.short ?? code
  );
}

/** Compact language picker for the dashboard header. */
export function LocalePicker() {
  const { locale, setLocale } = useLocale();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as LocaleCode)}
      aria-label="Interface language"
      title="Interface language"
      className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 px-2 py-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200 hover:border-zinc-500"
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code} title={l.label}>
          {l.short}
        </option>
      ))}
    </select>
  );
}

/** Picker for the AI response language (separate from UI locale). */
export function AiLocalePicker() {
  const { aiLocale, setAiLocale } = useLocale();
  return (
    <select
      value={aiLocale}
      onChange={(e) => setAiLocale(e.target.value as LocaleCode)}
      aria-label="AI response language"
      title="AI response language"
      className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 px-2 py-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200 hover:border-zinc-500"
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code} title={l.label}>
          {l.short}
        </option>
      ))}
    </select>
  );
}
