"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Landmark,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import {
  Code,
  SetupGuide,
  type GuideStep,
} from "~/app/_components/setup-guide";
import {
  DataTable,
  Pagination,
  StatCard,
  usePager,
  type DataColumn,
} from "~/app/_components/ui";

type FutuStatus = RouterOutputs["futu"]["status"];
type FutuAccount = FutuStatus["accounts"][number];
type FutuPosition = FutuAccount["positions"][number];
type FutuTrade = FutuAccount["trades"][number];
type SyncToken = RouterOutputs["futu"]["listTokens"]["tokens"][number];

const card = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5";

function FutuBadge() {
  return (
    <span className="rounded bg-orange-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-orange-400">
      FUTU
    </span>
  );
}

const fmtQty = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const fmtMoney = (n: number | null) =>
  n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const fmtDate = (ymd: string) =>
  ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : ymd;
const fmtDateTime = (d: Date | string) =>
  new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const FUTU_STEPS: GuideStep[] = [
  {
    icon: Download,
    title: "Install & log in to OpenD",
    body: (
      <>
        Futu has no cloud API — its official API talks to <Code>OpenD</Code>,
        a gateway that runs on <em>your own computer</em>. Download OpenD from
        the Futu OpenAPI page （富途牛牛 / moomoo → OpenAPI), log in with your
        Futu account (+ phone 2FA), and keep it running while you sync.
      </>
    ),
    warn: "Your Futu login stays inside OpenD on your machine — Holdr never sees it.",
  },
  {
    icon: KeyRound,
    title: "Enable the OpenAPI permission",
    body: (
      <>
        In the 富途牛牛 / moomoo app, make sure the <Code>OpenAPI</Code>{" "}
        permission is enabled for your account (apply in-app if needed).
      </>
    ),
  },
  {
    icon: ShieldCheck,
    title: "Create a sync token below",
    body: (
      <>
        Generate a token in the <Code>Sync tokens</Code> section. It is shown{" "}
        <em>once</em> — paste it into the sync script&apos;s <Code>.env</Code>.
        Tokens are single-purpose and revocable.
      </>
    ),
    warn: "Treat the token like a password — anyone holding it can push Futu data into your Holdr account.",
  },
  {
    icon: Terminal,
    title: "Run the sync script",
    body: (
      <>
        Download <Code>tools/futu-sync</Code> from the holdr repo,{" "}
        <Code>pip install -r requirements.txt</Code>, fill in{" "}
        <Code>.env</Code>, then <Code>python3 sync.py</Code>. The script is
        read-only: it only queries positions and trades, and your Futu
        password never leaves your computer.
      </>
    ),
  },
];

/* ---------------- sync token manager ---------------- */

function TokenManager() {
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listQ = api.futu.listTokens.useQuery();
  const createM = api.futu.createToken.useMutation({
    onSuccess: (d) => {
      setError(null);
      setFresh({ token: d.token, name: d.name });
      setName("");
      setCopied(false);
      void listQ.refetch();
    },
    onError: (e) => setError(e.message),
  });
  const revokeM = api.futu.revokeToken.useMutation({
    onSuccess: () => void listQ.refetch(),
    onError: (e) => setError(e.message),
  });

  const tokens = listQ.data?.tokens ?? [];

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.token);
      setCopied(true);
    } catch {
      /* clipboard unavailable — the token is still visible to copy manually */
    }
  };

  return (
    <div className="mt-4">
      <h3 className="flex items-center gap-2 text-sm font-bold text-zinc-200">
        <KeyRound size={16} className="text-zinc-400" />
        Sync tokens
      </h3>
      <p className="mt-1 text-xs text-zinc-500">
        Long-lived bearer tokens for the local sync script. Only the hash is
        stored — the plaintext is shown once and never again.
      </p>

      {fresh && (
        <div className="mt-3 rounded-lg border border-emerald-700 bg-emerald-950/40 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-300">
            New token — copy it now
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100">
              {fresh.token}
            </code>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy token"
              title="Copy token"
              className="rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-200 hover:bg-zinc-700"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-300">
            This is the only time you will see it. Paste it into the sync
            script&apos;s <Code>.env</Code> as <Code>HOLDR_SYNC_TOKEN</Code>,
            then dismiss this box.
          </p>
          <button
            type="button"
            onClick={() => setFresh(null)}
            className="mt-2 text-xs font-semibold text-zinc-400 hover:text-zinc-200"
          >
            I&apos;ve saved it — dismiss
          </button>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Token name, e.g. MacBook Pro"
          maxLength={60}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        <button
          type="button"
          disabled={!name.trim() || createM.isPending}
          onClick={() => createM.mutate({ name: name.trim() })}
          className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          <Plus size={16} />
          New token
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

      {listQ.isLoading ? (
        <p className="mt-3 text-xs text-zinc-500">Loading tokens…</p>
      ) : tokens.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {tokens.map((t) => (
            <TokenRow
              key={t.id}
              token={t}
              revoking={revokeM.isPending}
              onRevoke={() => revokeM.mutate({ id: t.id })}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">
          No tokens yet — create one to connect the sync script.
        </p>
      )}
    </div>
  );
}

function TokenRow({
  token,
  revoking,
  onRevoke,
}: {
  token: SyncToken;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const revoked = token.revokedAt != null;
  return (
    <li
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
        revoked ? "border-zinc-800 opacity-60" : "border-zinc-700"
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-zinc-200">
          {token.name}
          {revoked && (
            <span className="ml-2 rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] font-bold text-zinc-400">
              REVOKED
            </span>
          )}
        </p>
        <p className="text-xs text-zinc-500">
          Created {fmtDateTime(token.createdAt)}
          {token.lastUsedAt
            ? ` · last used ${fmtDateTime(token.lastUsedAt)}`
            : " · never used"}
        </p>
      </div>
      {!revoked && (
        <button
          type="button"
          disabled={revoking}
          onClick={onRevoke}
          aria-label={`Revoke token ${token.name}`}
          title="Revoke token"
          className="rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
        >
          <Trash2 size={16} />
        </button>
      )}
    </li>
  );
}

/* ---------------- positions & trades ---------------- */

const positionColumns: DataColumn<FutuPosition>[] = [
  { key: "symbol", header: "Symbol", render: (r) => <span className="font-mono font-semibold">{r.symbol}</span> },
  {
    key: "name",
    header: "Name",
    render: (r) => <span className="text-zinc-400">{r.description ?? "—"}</span>,
  },
  {
    key: "qty",
    header: "Qty",
    align: "right",
    render: (r) => <span className="tabular-nums">{fmtQty(r.quantity)}</span>,
  },
  {
    key: "price",
    header: "Price",
    align: "right",
    render: (r) => (
      <span className="tabular-nums">
        {fmtMoney(r.markPrice)} <span className="text-zinc-500">{r.currency}</span>
      </span>
    ),
  },
];

const tradeColumns: DataColumn<FutuTrade>[] = [
  { key: "date", header: "Date", render: (r) => <span className="tabular-nums">{fmtDate(r.tradeDate)}</span> },
  { key: "symbol", header: "Symbol", render: (r) => <span className="font-mono font-semibold">{r.symbol}</span> },
  {
    key: "side",
    header: "Side",
    render: (r) => (
      <span
        className={`font-semibold ${r.quantity >= 0 ? "text-emerald-400" : "text-rose-400"}`}
      >
        {r.quantity >= 0 ? "BUY" : "SELL"}
      </span>
    ),
  },
  {
    key: "qty",
    header: "Qty",
    align: "right",
    render: (r) => <span className="tabular-nums">{fmtQty(Math.abs(r.quantity))}</span>,
  },
  {
    key: "price",
    header: "Price",
    align: "right",
    render: (r) => (
      <span className="tabular-nums">
        {fmtMoney(r.tradePrice)} <span className="text-zinc-500">{r.currency}</span>
      </span>
    ),
  },
];

function AccountSection({ account }: { account: FutuAccount }) {
  const posPager = usePager(account.positions, 10);
  const tradePager = usePager(account.trades, 10);
  return (
    <div className="mt-4 rounded-lg border border-zinc-800 p-3">
      <p className="font-mono text-sm font-semibold text-zinc-300">
        Account {account.label}
      </p>
      {account.positions.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-zinc-500">
            Positions ({account.positions.length})
          </p>
          <DataTable
            columns={positionColumns}
            rows={posPager.rows}
            keyOf={(r) => r.id}
            footer={
              <Pagination
                page={posPager.page}
                pageCount={posPager.pageCount}
                onPage={posPager.setPage}
              />
            }
          />
        </div>
      )}
      {account.trades.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-zinc-500">
            Recent trades ({account.trades.length})
          </p>
          <DataTable
            columns={tradeColumns}
            rows={tradePager.rows}
            keyOf={(r) => r.id}
            footer={
              <Pagination
                page={tradePager.page}
                pageCount={tradePager.pageCount}
                onPage={tradePager.setPage}
              />
            }
          />
        </div>
      )}
      {account.positions.length === 0 && account.trades.length === 0 && (
        <p className="mt-2 text-xs text-zinc-500">No positions or trades.</p>
      )}
    </div>
  );
}

/* ---------------- main card ---------------- */

export function FutuCard() {
  const { status: sessionStatus } = useSession();
  const statusQ = api.futu.status.useQuery(undefined, {
    enabled: sessionStatus === "authenticated",
    refetchOnWindowFocus: false,
  });

  if (sessionStatus === "loading") {
    return (
      <div className={card}>
        <p className="text-sm text-zinc-500">Checking sign-in…</p>
      </div>
    );
  }

  if (sessionStatus !== "authenticated") {
    return (
      <div className={card}>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Landmark size={20} className="shrink-0 text-zinc-400" />
          <span>Futu 富途牛牛</span>
          <FutuBadge />
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          Sync your 富途牛牛 / moomoo positions via a local sync script —
          read-only, your Futu password never leaves your computer.
        </p>
        <a
          href="/login"
          className="mt-3 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
        >
          Sign in to connect Futu
        </a>
      </div>
    );
  }

  const data = statusQ.data;
  const totalPositions =
    data?.accounts.reduce((n, a) => n + a.positions.length, 0) ?? 0;

  return (
    <div className={card}>
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <Landmark size={20} className="shrink-0 text-zinc-400" />
        <span>Futu 富途牛牛</span>
        <FutuBadge />
      </h2>
      <p className="mt-1 text-sm text-zinc-400">
        Sync your 富途牛牛 / moomoo positions via a local sync script —
        read-only, your Futu password never leaves your computer.
      </p>

      <SetupGuide
        id="futu"
        steps={FUTU_STEPS}
        guideUrl="https://www.futunn.com/en/openapi"
        guideLabel="Futu OpenAPI docs"
      />

      <TokenManager />

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-zinc-200">Synced data</h3>
          <button
            type="button"
            onClick={() => void statusQ.refetch()}
            disabled={statusQ.isFetching}
            aria-label="Refresh"
            title="Refresh"
            className="rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
          >
            <RefreshCw
              size={16}
              className={statusQ.isFetching ? "animate-spin" : ""}
            />
          </button>
        </div>

        {statusQ.isLoading ? (
          <p className="mt-2 text-sm text-zinc-500">Loading…</p>
        ) : statusQ.isError ? (
          <p className="mt-2 text-sm text-rose-400">
            Couldn&apos;t load Futu data: {statusQ.error.message}
          </p>
        ) : !data?.connected ? (
          <p className="mt-2 text-sm text-zinc-500">
            No sync yet — run <Code>python3 sync.py</Code> on your computer
            and your positions will appear here.
          </p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3">
              <StatCard label="Accounts" value={String(data.accounts.length)} tone="neutral" />
              <StatCard label="Positions" value={String(totalPositions)} tone="neutral" />
              <StatCard
                label="Last sync"
                value={
                  data.lastSyncedAt ? fmtDateTime(data.lastSyncedAt) : "—"
                }
                tone="neutral"
              />
            </div>
            {data.accounts.map((a) => (
              <AccountSection key={a.accountId} account={a} />
            ))}
          </>
        )}
      </div>

      <p className="mt-4 text-xs text-zinc-500">
        Trades show the recent window pulled by the script (default 365 days).
        Each sync replaces the previous snapshot, so re-running is always safe.
      </p>
    </div>
  );
}
