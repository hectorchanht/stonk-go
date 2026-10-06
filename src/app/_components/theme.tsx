"use client";

import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";

export type Theme = "dark" | "light";

const Ctx = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
}>({ theme: "dark", setTheme: () => undefined });

/**
 * Holdr is dark-only: broker.tsx / questrade.tsx / exchanges.tsx were built
 * with dark-only classes (light mode renders dark slabs on a white page),
 * and dark is the de-facto design target. The provider pins the `dark`
 * class and `setTheme` is a no-op kept for API compatibility.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    try {
      window.localStorage.removeItem("holdr.theme");
    } catch {
      /* ignore */
    }
  }, []);

  const setTheme = useCallback((_t: Theme) => undefined, []);

  return <Ctx.Provider value={{ theme: "dark", setTheme }}>{children}</Ctx.Provider>;
}

export function useTheme() {
  return useContext(Ctx);
}
