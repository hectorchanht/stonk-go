"use client";

import { SessionProvider } from "next-auth/react";

import { TRPCReactProvider } from "~/trpc/react";
import { ThemeProvider } from "~/app/_components/theme";

/**
 * Client-side providers. SessionProvider is outer so auth state is
 * available everywhere; sign-in is optional — the app works logged out.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <TRPCReactProvider>
        <ThemeProvider>{children}</ThemeProvider>
      </TRPCReactProvider>
    </SessionProvider>
  );
}
