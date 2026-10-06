import { Dashboard } from "~/app/_components/dashboard";
import { api, HydrateClient } from "~/trpc/server";

// Always render on demand: the dashboard needs live quotes and a live DB,
// neither of which exists at build time (esp. on Cloudflare Workers).
export const dynamic = "force-dynamic";

export default async function Home() {
  // Prefetch without broker positions (the client's IBKR snapshot merges in
  // after hydration via the summary query's brokerPositions input).
  void api.portfolio.summary.prefetch({ brokerPositions: [] });

  return (
    <HydrateClient>
      <main className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <Dashboard />
      </main>
    </HydrateClient>
  );
}
