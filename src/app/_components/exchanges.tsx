"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Bitcoin,
  Check,
  ChevronDown,
  Copy,
  Globe,
  ListChecks,
  LogIn,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Tag,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { useCurrency } from "~/app/_components/currency";
import {
  Code,
  SetupGuide,
  type GuideStep,
} from "~/app/_components/setup-guide";

type ExchangeName = "coinbase" | "binance";
type SyncResult = RouterOutputs["exchanges"]["sync"];
type Status = RouterOutputs["exchanges"]["status"]["exchanges"][ExchangeName];

/** Position shape the dashboard merges into its Holdings table. */
export interface ExchangePositionLike {
  symbol: string;
  quantity: number;
  markPrice: number | null;
  costBasisPrice?: number | null;
  label?: string | null;
}

const card = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5";

const EXCHANGE_META: Record<
  ExchangeName,
  { title: string; accent: string; snapshotKey: string }
> = {
  coinbase: {
    title: "Coinbase",
    accent: "text-sky-400",
    snapshotKey: "holdr.exchange.coinbase.snapshot",
  },
  binance: {
    title: "Binance",
    accent: "text-amber-400",
    snapshotKey: "holdr.exchange.binance.snapshot",
  },
};

const AUTO_SYNC_AFTER_MS = 1 * 3600 * 1000;

/** Browser-side Binance credentials (the secret never leaves this device). */
const BINANCE_CREDS_KEY = "holdr.binance.creds";

/** Persisted platform selection for the crypto-exchanges section. */
const SELECTED_KEY = "holdr.crypto.selected";

const EXCHANGE_IDS = Object.keys(EXCHANGE_META) as ExchangeName[];

function loadSelected(): ExchangeName | null {
  try {
    const raw = localStorage.getItem(SELECTED_KEY);
    return raw === "coinbase" || raw === "binance" ? raw : null;
  } catch {
    return null;
  }
}

interface BrowserCreds {
  k: string;
  s: string;
}

function loadBinanceCreds(): BrowserCreds | null {
  try {
    const raw = localStorage.getItem(BINANCE_CREDS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { k?: unknown; s?: unknown };
    if (typeof p.k === "string" && p.k && typeof p.s === "string" && p.s) {
      return { k: p.k, s: p.s };
    }
    return null;
  } catch {
    return null;
  }
}

/* NOTE: copy of the server-side binanceSignature in src/server/exchanges.ts.
 * Duplicated on purpose and NOT imported: the server module must never enter
 * the client bundle, and the browser needs the raw secret for HMAC signing
 * anyway — the whole point of the browser-side flow is that the secret never
 * leaves the user's device. */
async function binanceBrowserSignature(
  apiSecret: string,
  queryString: string,
): Promise<string> {
  const te = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(queryString));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const COINBASE_STEPS: GuideStep[] = [
  {
    icon: LogIn,
    title: "Log in to Coinbase",
    body: (
      <>
        Log in at <Code>coinbase.com</Code>.
      </>
    ),
  },
  {
    icon: Settings,
    title: "Open API settings",
    body: (
      <>
        Click your profile icon → <Code>Settings</Code> → the <Code>API</Code>{" "}
        tab.
      </>
    ),
  },
  {
    icon: Plus,
    title: "Create an API key",
    body: (
      <>
        Click <Code>Create API Key</Code> and complete 2-step verification.
      </>
    ),
  },
  {
    icon: ShieldCheck,
    title: "Read-only permissions",
    body: (
      <>
        Keep only the <Code>View</Code> (read-only) permission. Leave{" "}
        <Code>Trade</Code>, <Code>Transfer</Code> and <Code>Manage</Code> OFF.
      </>
    ),
    warn: "Never enable trading or transfers — Holdr only reads balances and has no trading code at all.",
  },
  {
    icon: Copy,
    title: "Copy key + secret",
    body: <>Copy the API key and secret into the fields below.</>,
    warn: "The secret is shown only once — copy it now or you'll need a new key.",
  },
];

const BINANCE_STEPS: GuideStep[] = [
  {
    icon: LogIn,
    title: "Open API Management",
    body: (
      <>
        In the Binance app, tap your profile / account icon →{" "}
        <Code>API Management</Code> → tap the yellow <Code>Create API</Code>{" "}
        button.
      </>
    ),
    warn: "Do NOT tap Create Tax Report API — that's tax-software-only, one per user, and the wrong key type.",
  },
  {
    icon: ListChecks,
    title: "Choose System generated",
    body: (
      <>
        On <Code>Choose API Key type</Code>, select{" "}
        <Code>System generated</Code> (HMAC symmetric encryption).
      </>
    ),
    warn: "Do NOT choose Self-generated (Ed25519 / RSA) — Holdr only supports the system-generated HMAC key type.",
  },
  {
    icon: Tag,
    title: "Label it and verify",
    body: (
      <>
        Enter a label like <Code>Holdr</Code>, tap <Code>Next</Code>, then
        complete the 2FA / security verification. Binance may ask to opt all
        keys into Default Security Controls — leaving that checked is fine; it
        doesn&apos;t affect read-only use.
      </>
    ),
  },
  {
    icon: ChevronDown,
    title: "Expand the key card",
    body: (
      <>
        On the new key card, tap the <Code>▼</Code> chevron at the bottom of
        the card to expand it — the <Code>API restrictions</Code> section is
        hidden inside and won&apos;t show until you expand.
      </>
    ),
  },
  {
    icon: ShieldCheck,
    title: "Enable Reading only",
    body: (
      <>
        Check only <Code>Enable Reading</Code>. Leave everything else OFF:{" "}
        <Code>Spot &amp; Margin &amp; Stock Trading</Code>,{" "}
        <Code>Margin Loan/Repay/Transfer</Code>, <Code>Futures</Code>,{" "}
        <Code>Universal Transfer</Code>, <Code>Withdrawals</Code>,{" "}
        <Code>Alpha Withdrawals</Code>, <Code>Prediction Trading</Code>,{" "}
        <Code>Symbol Whitelist</Code>.
      </>
    ),
    warn: "Never enable trading or withdrawals — Holdr only reads balances.",
  },
  {
    icon: Globe,
    title: "Leave IP unrestricted",
    body: (
      <>
        Under <Code>IP access restrictions</Code>, leave it{" "}
        <Code>Unrestricted</Code>. Binance warns that an unrestricted IP plus
        any non-reading permission gets the key deleted — that doesn&apos;t
        apply to this reading-only key.
      </>
    ),
    warn: "Do NOT enable “Restrict access to trusted IPs only” — Holdr syncs from Cloudflare Workers whose IPs change, so a whitelist would break syncing.",
  },
  {
    icon: Copy,
    title: "Copy key + secret into Holdr",
    body: (
      <>
        <Code>Copy</Code> the API Key and Secret Key, paste both into
        Holdr&apos;s Binance panel below, then hit{" "}
        <Code>Connect &amp; sync</Code>.
      </>
    ),
    warn: "They're never shown in full again — copy now or you'll need a new key.",
  },
];

/** Gear menu for the connected card (mirrors the IBKR card). */
function GearMenu({
  items,
  label,
}: {
  items: { label: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        title={label}
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-zinc-400 hover:text-zinc-200"
      >
        <Settings size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-60 rounded-xl border border-zinc-700 bg-zinc-800 py-1 shadow-xl">
            {items.map((it, i) => (
              <button
                key={i}
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm hover:bg-zinc-700 disabled:opacity-40 ${
                  it.danger ? "text-rose-400" : "text-zinc-200"
                }`}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function BalancesTable({ data }: { data: SyncResult }) {
  const { fmt } = useCurrency();
  const money = (cents: number | null) =>
    cents == null ? "—" : fmt(cents / 100);
  const rows = [...data.items].sort(
    (a, b) => (b.valueCents ?? -1) - (a.valueCents ?? -1),
  );
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-zinc-400">Exchange total</span>
        <span className="text-xl font-bold tabular-nums">{money(data.totalCents)}</span>
      </div>
      {data.driftCents !== 0 && (
        <p className="mt-1 text-xs text-amber-400/90">
          Rounding drift {money(data.driftCents)} across {data.pricedCount} priced
          assets{data.reconciled ? " (within bound)" : " — exceeds bound, flagged"}.
        </p>
      )}
      {data.unpriced.length > 0 && (
        <p className="mt-1 text-xs text-zinc-500">
          No price for {data.unpriced.join(", ")} — quantities shown, excluded from total.
        </p>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="pb-2 pr-3">Asset</th>
              <th className="pb-2 pr-3 text-right">Qty</th>
              <th className="pb-2 pr-3 text-right">Price</th>
              <th className="pb-2 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.asset} className="border-t border-zinc-800/60 text-zinc-200">
                <td className="py-2 pr-3 font-semibold">{r.asset}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-zinc-300" title="Native quantity (exact)">
                  {r.quantity}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-zinc-400">
                  {r.priceUsd == null ? "—" : money(Math.round(Number(r.priceUsd) * 100))}
                </td>
                <td className="py-2 text-right tabular-nums">{money(r.valueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-zinc-600">
        Quantities are native (e.g. BTC), values in USD at each asset&apos;s spot
        price at sync time.
      </p>
    </div>
  );
}

function loadSnapshot(key: string): { at: string; data: SyncResult } | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { at: string; data: SyncResult }) : null;
  } catch {
    return null;
  }
}

function ExchangeCard({
  exchange,
  onPositions,
  onConnectionChange,
}: {
  exchange: ExchangeName;
  onPositions?: (positions: ExchangePositionLike[]) => void;
  /** Fired when this card's connected state changes (so the section selector's indicators stay fresh). */
  onConnectionChange?: () => void;
}) {
  const meta = EXCHANGE_META[exchange];
  const { data: session } = useSession();

  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{ at: string; data: SyncResult } | null>(null);
  const [browserCreds, setBrowserCreds] = useState<BrowserCreds | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const autoStarted = useRef(false);
  const isBinance = exchange === "binance";

  const statusQ = api.exchanges.status.useQuery(undefined, { retry: false });
  const st: Status | undefined = statusQ.data?.exchanges[exchange];
  const savedQ = api.exchanges.savedCredentials.useQuery(
    { exchange },
    { enabled: !!session?.user, retry: false },
  );

  const balancesQ = api.exchanges.balances.useQuery(
    { exchange },
    { enabled: !!session?.user && !!st?.configured, retry: false },
  );

  const handleSyncSuccess = (data: SyncResult) => {
    setError(null);
    const snap = { at: new Date().toISOString(), data };
    setSnapshot(snap);
    try {
      localStorage.setItem(meta.snapshotKey, JSON.stringify(snap));
    } catch {
      /* ignore */
    }
    void statusQ.refetch();
    void balancesQ.refetch();
    void savedQ.refetch();
  };
  const handleSyncError = (e: { message: string }) => setError(e.message);

  const sync = api.exchanges.sync.useMutation({
    onSuccess: handleSyncSuccess,
    onError: handleSyncError,
  });

  // Browser-side Binance sync result goes through the same snapshot pipeline.
  const directSync = api.exchanges.binanceDirectSync.useMutation();

  const submitBinanceDirect = (
    accountJson: unknown,
    tickersJson: unknown,
    key: string,
    secret: string,
  ) => {
    directSync.mutate(
      { accountJson, tickersJson, label: "browser" },
      {
        onSuccess: (d) => {
          try {
            localStorage.setItem(
              BINANCE_CREDS_KEY,
              JSON.stringify({ k: key, s: secret }),
            );
          } catch {
            /* ignore */
          }
          setBrowserCreds({ k: key, s: secret });
          setApiKey("");
          setApiSecret("");
          handleSyncSuccess(d);
        },
        onError: handleSyncError,
      },
    );
  };

  /**
   * Binance connects from the USER'S BROWSER, not our server: Binance's CDN
   * geo-blocks / WAF-blocks api.binance.com from Cloudflare Workers egress
   * IPs (HTTP 403 before the key is checked), while a residential IP works.
   * The secret is used here for HMAC signing and never leaves this device —
   * only the fetched balances + public tickers are posted to the server for
   * valuation and storage.
   */
  const connectBinanceBrowser = async (
    key: string,
    secret: string,
    opts?: { silent?: boolean },
  ) => {
    const silent = opts?.silent ?? false;
    const fail = (msg: string) => {
      if (!silent) setError(msg);
    };
    setBrowserBusy(true);
    try {
      const timestamp = Date.now().toString();
      const qs = `timestamp=${timestamp}&recvWindow=5000`;
      let signature: string;
      try {
        signature = await binanceBrowserSignature(secret, qs);
      } catch {
        fail("Couldn't sign the request in this browser (WebCrypto unavailable).");
        return;
      }
      let accountRes: Response;
      let tickersRes: Response;
      try {
        [accountRes, tickersRes] = await Promise.all([
          fetch(
            `https://api.binance.com/api/v3/account?${qs}&signature=${signature}`,
            { headers: { "X-MBX-APIKEY": key } },
          ),
          fetch("https://api.binance.com/api/v3/ticker/price"),
        ]);
      } catch (e) {
        fail(
          e instanceof TypeError
            ? "Couldn't reach Binance directly from this browser. Check your connection — some networks block api.binance.com."
            : "Couldn't reach Binance directly from this browser.",
        );
        return;
      }
      if (!accountRes.ok) {
        let msg = `Binance request failed (HTTP ${accountRes.status}).`;
        try {
          const body = (await accountRes.json()) as {
            msg?: unknown;
            code?: unknown;
          };
          if (typeof body?.msg === "string" && body.msg) {
            msg = `Binance: ${body.msg.slice(0, 200)}`;
          }
        } catch {
          /* ignore parse errors */
        }
        fail(msg);
        return;
      }
      let accountJson: unknown;
      let tickersJson: unknown;
      try {
        accountJson = await accountRes.json();
        tickersJson = tickersRes.ok ? await tickersRes.json() : [];
      } catch {
        fail("Couldn't parse Binance's response.");
        return;
      }
      submitBinanceDirect(accountJson, tickersJson, key, secret);
    } finally {
      setBrowserBusy(false);
    }
  };


  const saveCreds = api.exchanges.saveCredentials.useMutation({
    onSuccess: () => {
      setError(null);
      setApiKey("");
      setApiSecret("");
      void statusQ.refetch();
      void savedQ.refetch();
    },
    onError: (e) => setError(e.message),
  });

  const clearCreds = api.exchanges.clearCredentials.useMutation({
    onSuccess: () => {
      setError(null);
      setSnapshot(null);
      try {
        localStorage.removeItem(meta.snapshotKey);
      } catch {
        /* ignore */
      }
      onPositions?.([]);
      void statusQ.refetch();
      void savedQ.refetch();
      void balancesQ.refetch();
    },
    onError: (e) => setError(e.message),
  });
  const disconnectBinance = () => {
    try {
      localStorage.removeItem(BINANCE_CREDS_KEY);
      localStorage.removeItem(meta.snapshotKey);
    } catch {
      /* ignore */
    }
    setBrowserCreds(null);
    setApiKey("");
    setApiSecret("");
    setSnapshot(null);
    setError(null);
    onPositions?.([]);
    // Also wipe server-side persisted balances for this exchange.
    clearCreds.mutate({ exchange });
    void statusQ.refetch();
    void savedQ.refetch();
    void balancesQ.refetch();
  };

  useEffect(() => {
    setSnapshot(loadSnapshot(meta.snapshotKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange]);

  const configured = !!st?.configured;
  const connectedNow = configured || (isBinance && !!browserCreds);
  const onConnRef = useRef(onConnectionChange);
  onConnRef.current = onConnectionChange;
  useEffect(() => {
    onConnRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedNow]);
  // Binance syncs from this browser (see connectBinanceBrowser); Coinbase
  // still syncs server-side.
  const syncData: SyncResult | null = isBinance ? directSync.data ?? null : sync.data ?? null;
  const data: SyncResult | null = syncData ?? snapshot?.data ?? null;
  const busy = isBinance ? browserBusy || directSync.isPending : sync.isPending;

  // Auto-sync once when saved credentials exist and the snapshot is stale.
  // Coinbase: server-side sync with saved server credentials.
  useEffect(() => {
    if (isBinance) return;
    if (!session?.user || !configured || autoStarted.current || sync.isPending || data) return;
    autoStarted.current = true;
    const snap = loadSnapshot(meta.snapshotKey);
    const stale = !snap || Date.now() - new Date(snap.at).getTime() > AUTO_SYNC_AFTER_MS;
    if (stale) sync.mutate({ exchange });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user, configured]);

  // Binance: keys live in this browser — auto-sync silently in the
  // background when browser creds exist and the snapshot is stale.
  useEffect(() => {
    if (!isBinance || autoStarted.current) return;
    autoStarted.current = true;
    const creds = loadBinanceCreds();
    if (!creds) return;
    setBrowserCreds(creds);
    const snap = loadSnapshot(meta.snapshotKey);
    const stale = !snap || Date.now() - new Date(snap.at).getTime() > AUTO_SYNC_AFTER_MS;
    if (stale) void connectBinanceBrowser(creds.k, creds.s, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange]);

  // Report balances upward so the dashboard totals can include them.
  useEffect(() => {
    const items =
      data?.items ??
      balancesQ.data?.items.map((b) => ({
        asset: b.asset,
        quantity: b.quantity,
        priceUsd: b.priceUsd,
        priceSource: b.priceSource,
        priceAt: b.priceAt,
        valueCents: b.valueCents,
      }));
    onPositions?.(
      (items ?? []).map((i) => ({
        symbol: i.asset,
        quantity: Number(i.quantity),
        markPrice: i.priceUsd == null ? null : Number(i.priceUsd),
        label: meta.title.toUpperCase(),
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, balancesQ.data]);

  const lastSyncLabel = (() => {
    const at = syncData ? new Date() : st?.lastSyncedAt ? new Date(st.lastSyncedAt) : snapshot ? new Date(snapshot.at) : null;
    return at
      ? at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : null;
  })();

  const valid = apiKey.trim().length > 0 && apiSecret.trim().length > 0;

  const gearItems: { label: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }[] = isBinance
    ? [
        {
          label: (
            <>
              <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
              {busy ? "Syncing…" : "Sync now"}
            </>
          ),
          onClick: () => {
            const c = loadBinanceCreds();
            if (c) void connectBinanceBrowser(c.k, c.s);
          },
          disabled: busy || !browserCreds,
        },
        {
          label: "Disconnect",
          onClick: disconnectBinance,
          danger: true,
        },
      ]
    : [
        {
          label: (
            <>
              <RefreshCw size={15} className={sync.isPending ? "animate-spin" : ""} />
              {sync.isPending ? "Syncing…" : "Sync now"}
            </>
          ),
          onClick: () => sync.mutate({ exchange }),
          disabled: sync.isPending,
        },
        {
          label: clearCreds.isPending ? "Removing…" : "Remove saved credentials",
          onClick: () => clearCreds.mutate({ exchange }),
          danger: true,
          disabled: clearCreds.isPending,
        },
      ];

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Bitcoin size={20} className={`shrink-0 ${meta.accent}`} />
            <span>{meta.title}</span>
            {data && !busy && (
              <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-700/60 bg-emerald-900/40 px-2.5 py-0.5 align-middle text-[10px] font-extrabold tracking-wider text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                LIVE
              </span>
            )}
            {busy && (
              <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-amber-700/60 bg-amber-900/40 px-2.5 py-0.5 align-middle text-[10px] font-extrabold tracking-wider text-amber-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                SYNCING
              </span>
            )}
          </h2>
          <p className="text-xs text-zinc-500">
            {st?.keyLast4 || browserCreds ? (
              <>
                <Check size={13} className="mr-1 inline text-emerald-400" />
                {browserCreds
                  ? "Connected in this browser — key never leaves your device"
                  : `Key …${st?.keyLast4} saved`}
                {lastSyncLabel ? ` · synced ${lastSyncLabel}` : ""}
              </>
            ) : (
              <>Read-only balances — {meta.title} can never trade from here</>
            )}
          </p>
        </div>
        {(configured || browserCreds) && (
          <GearMenu items={gearItems} label={`${meta.title} settings`} />
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </p>
      )}

      {!(isBinance ? browserCreds : configured) && !data && (
        <>
          <p className="mt-1 text-sm text-zinc-400">
            Connect your {meta.title} account to pull balances (read-only).
          </p>
          <SetupGuide
            id={exchange}
            steps={exchange === "coinbase" ? COINBASE_STEPS : BINANCE_STEPS}
            guideUrl={
              exchange === "coinbase"
                ? "https://help.coinbase.com/en/exchange/managing-my-account/how-to-create-an-api-key"
                : "https://www.binance.com/en-AU/support/faq/detail/360002502072"
            }
            guideLabel={
              exchange === "coinbase"
                ? "Coinbase help: creating an API key"
                : "Binance FAQ: creating API keys"
            }
          />
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-zinc-500">API key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your API key"
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-zinc-500">API secret</span>
              <input
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="Paste your API secret"
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                disabled={!valid || busy}
                onClick={() =>
                  isBinance
                    ? void connectBinanceBrowser(apiKey.trim(), apiSecret.trim())
                    : sync.mutate({ exchange, apiKey: apiKey.trim(), apiSecret: apiSecret.trim() })
                }
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {busy ? "Syncing…" : "Connect & sync"}
              </button>
              {!isBinance && session?.user && data && !saveCreds.isPending && (
                <button
                  onClick={() =>
                    saveCreds.mutate({ exchange, apiKey: apiKey.trim(), apiSecret: apiSecret.trim() })
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-700"
                >
                  <Save size={15} /> Save to my account
                </button>
              )}
            </div>
          </div>
          {isBinance ? (
            <>
              <p className="mt-3 text-xs text-zinc-500">
                Your key + secret stay in this browser — they sign requests
                directly to Binance and <b>never reach our server</b>. Only the
                resulting balances are sent for valuation. Use a{" "}
                <b>read-only</b> key — Holdr has no trading code paths at all.
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Totals are in USD.
              </p>
            </>
          ) : (
            <>
              <p className="mt-3 text-xs text-zinc-500">
                Keys are encrypted on our server (AES-GCM) and only ever used to
                read balances. Use a <b>read-only</b> key — Holdr has no trading
                code paths at all.
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Not signed in? Your keys stay in this browser for this sync only and
                are never saved. Totals are in USD.
              </p>
            </>
          )}
        </>
      )}

      {data && <BalancesTable data={data} />}

      {configured && !data && !sync.isPending && balancesQ.data && balancesQ.data.items.length === 0 && (
        <p className="mt-3 text-sm text-zinc-500">
          No balances found on {meta.title} — or the last sync returned nothing.
        </p>
      )}
    </div>
  );
}

export function ExchangeCards({
  onPositions,
}: {
  onPositions?: (positions: ExchangePositionLike[]) => void;
}) {
  // Positions are kept per exchange so switching platforms never loses data.
  const [positionsByExchange, setPositionsByExchange] = useState<
    Record<ExchangeName, ExchangePositionLike[]>
  >({ coinbase: [], binance: [] });
  // Always start on the first option (avoids SSR hydration mismatch); the
  // persisted / first-connected default is applied in the effect below.
  const [selected, setSelected] = useState<ExchangeName>("coinbase");
  const [initialized, setInitialized] = useState(false);
  const [binanceBrowser, setBinanceBrowser] = useState(false);
  const statusQ = api.exchanges.status.useQuery(undefined, { retry: false });

  const refreshSectionState = () => {
    try {
      setBinanceBrowser(!!localStorage.getItem(BINANCE_CREDS_KEY));
    } catch {
      /* ignore */
    }
    void statusQ.refetch();
  };

  useEffect(() => {
    refreshSectionState();
    window.addEventListener("focus", refreshSectionState);
    window.addEventListener("storage", refreshSectionState);
    return () => {
      window.removeEventListener("focus", refreshSectionState);
      window.removeEventListener("storage", refreshSectionState);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default selection: persisted choice wins; otherwise the first connected
  // exchange; otherwise the first option.
  useEffect(() => {
    if (initialized || !statusQ.data) return;
    const persisted = loadSelected();
    let initial: ExchangeName = persisted ?? "coinbase";
    if (!persisted) {
      const ex = statusQ.data.exchanges;
      const firstConnected = EXCHANGE_IDS.find((e) => ex[e]?.configured);
      initial = firstConnected ?? "coinbase";
      if (!firstConnected) {
        try {
          if (localStorage.getItem(BINANCE_CREDS_KEY)) initial = "binance";
        } catch {
          /* ignore */
        }
      }
    }
    setSelected(initial);
    setInitialized(true);
  }, [statusQ.data, initialized]);

  const choose = (e: ExchangeName) => {
    setSelected(e);
    try {
      localStorage.setItem(SELECTED_KEY, e);
    } catch {
      /* ignore */
    }
  };

  const connected: Record<ExchangeName, boolean> = {
    coinbase: !!statusQ.data?.exchanges.coinbase?.configured,
    binance: !!statusQ.data?.exchanges.binance?.configured || binanceBrowser,
  };

  const setPositionsFor =
    (exchange: ExchangeName) => (p: ExchangePositionLike[]) =>
      setPositionsByExchange((prev) =>
        prev[exchange] === p ? prev : { ...prev, [exchange]: p },
      );

  useEffect(() => {
    onPositions?.([
      ...positionsByExchange.coinbase,
      ...positionsByExchange.binance,
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsByExchange]);

  return (
    <div>
      <label
        htmlFor="crypto-platform-select"
        className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500"
      >
        Platform
      </label>
      <div className="relative">
        <select
          id="crypto-platform-select"
          value={selected}
          onChange={(e) => choose(e.target.value as ExchangeName)}
          aria-label="Select crypto platform"
          className="w-full appearance-none rounded-lg border border-zinc-700 bg-zinc-800 py-3 pl-3 pr-10 text-sm font-semibold text-zinc-100 focus:border-zinc-500 focus:outline-none"
          style={{ minHeight: 44 }}
        >
          {EXCHANGE_IDS.map((e) => (
            <option key={e} value={e}>
              {EXCHANGE_META[e].title}
              {connected[e] ? " \u25cf" : ""}
            </option>
          ))}
        </select>
        <ChevronDown
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400"
        />
      </div>
      <div className="mt-3" key={selected}>
        <ExchangeCard
          exchange={selected}
          onPositions={setPositionsFor(selected)}
          onConnectionChange={refreshSectionState}
        />
      </div>
    </div>
  );
}

/** Collapsible wrapper used by the dashboard (mirrors the IBKR card). */
export function ExchangePositionsToggle({ positions }: { positions: ExchangePositionLike[] }) {
  const [open, setOpen] = useState(false);
  if (positions.length === 0) return null;
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200"
      >
        <ChevronDown size={14} className={`shrink-0 text-zinc-500 transition-transform ${open ? "" : "-rotate-90"}`} />
        <span>
          {positions.length} crypto position{positions.length === 1 ? "" : "s"} — also listed in Holdings above
        </span>
        <span className="text-xs text-zinc-600">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-sm text-zinc-300">
          {positions.map((p) => (
            <li key={`${p.label}-${p.symbol}`} className="flex justify-between tabular-nums">
              <span>
                <span className="font-semibold">{p.symbol}</span>
                <span className="ml-2 text-xs text-zinc-500">{p.label}</span>
              </span>
              <span>
                {p.quantity} {p.markPrice != null ? `@ $${p.markPrice}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
