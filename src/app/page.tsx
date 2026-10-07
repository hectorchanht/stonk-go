import { Dashboard } from "~/app/_components/dashboard";
import { HydrateClient } from "~/trpc/server";

// Always render on demand: the dashboard needs live quotes and a live DB,
// neither of which exists at build time (esp. on Cloudflare Workers).
export const dynamic = "force-dynamic";

export default async function Home() {
  // NOTE: no summary prefetch here. The server can't see the browser's
  // broker snapshots (localStorage), so a prefetched empty-positions
  // summary would paint $0 values on first paint. The client fetches after
  // its snapshots merge into the query input; skeletons cover the wait.
  return (
    <HydrateClient>
      <main className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 antialiased">
        <Dashboard />
      </main>
    </HydrateClient>
  );
}
