"use client";

import { useRef, useState } from "react";
import { Download, Upload, RotateCcw } from "lucide-react";

import { api } from "~/trpc/react";

/**
 * Minimal backup: only what a restore actually needs.
 * - Server: transactions + price alerts (portfolio.exportBackup).
 * - Client: UI config below. Everything else is re-synced, re-fetched,
 *   or recomputed after a restore — and credentials are NEVER exported.
 */
const PREF_KEYS = new Set([
  "holdr.currency",
  "holdr.locale",
  "holdr.ai-locale",
  "holdr.theme",
  "holdr.dashboard-layout.v2",
  "holdr.dashboard-layout.v1", // legacy: restored by the v2 migration path
  "holdr.holdings.columns",
  "holdr.pnl.period",
  "holdr.alert-threshold",
  "holdr.alert-sort",
  "holdr.alert-dismissed",
  "holdr.pricealert-sort",
  "holdr.ai-chat-settings",
  "holdr.brokers.selected",
  "holdr.crypto.selected",
  "holdr.fx.usd",
]);
const PREF_PREFIXES = ["holdr.tablesort.", "holdr.tabletools."];

function isBackupPref(key: string): boolean {
  if (PREF_KEYS.has(key)) return true;
  return PREF_PREFIXES.some((p) => key.startsWith(p));
}

export function BackupButtons() {
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const backupQuery = api.portfolio.exportBackup.useQuery(undefined, {
    enabled: false,
  });
  const importMut = api.portfolio.importBackup.useMutation({
    onSuccess: (r) => {
      const alerts =
        r.alertsRestored > 0 ? ` and ${r.alertsRestored} price alerts` : "";
      setStatus(`Restored ${r.restored} transactions${alerts}. Reloading…`);
      setTimeout(() => window.location.reload(), 1500);
    },
    onError: (e) => setStatus(`Restore failed: ${e.message}`),
  });

  const clearSnapMut = api.portfolio.clearSnapshots.useMutation({
    onSuccess: (r) => setStatus(`Cleared ${r.cleared} snapshots.`),
    onError: (e) => setStatus(`Reset failed: ${e.message}`),
  });

  const doResetSnapshots = () => {
    if (
      !window.confirm(
        "Clear all daily snapshots? The performance chart rebuilds from your trade history; snapshots re-accumulate from today.",
      )
    )
      return;
    setStatus("Clearing snapshots…");
    clearSnapMut.mutate();
  };

  const doExport = async () => {
    setStatus("Preparing backup…");
    const res = await backupQuery.refetch();
    if (res.data) {
      // Client-side preferences: allowlisted UI config only.
      // Snapshots, chat history and credentials (holdr.*.creds) are
      // deliberately excluded — they're re-synced or must never leave
      // the device.
      const clientPrefs: Record<string, string> = {};
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && isBackupPref(k)) {
            const v = window.localStorage.getItem(k);
            if (v != null) clientPrefs[k] = v;
          }
        }
      } catch {
        /* storage unavailable */
      }
      const full = { ...res.data, clientPrefs };
      const blob = new Blob([JSON.stringify(full, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `holdr-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("Backup downloaded.");
    }
  };

  const doImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as {
          version?: unknown;
          exportedAt?: unknown;
          transactions?: unknown;
          holdings?: unknown;
          clientPrefs?: unknown;
        };
        if (
          (data.version !== 1 && data.version !== 2 && data.version !== 3) ||
          !Array.isArray(data.transactions)
        ) {
          setStatus("Invalid backup file.");
          return;
        }
        if (
          !window.confirm(
            `Restore backup from ${String(data.exportedAt ?? "unknown date")}? This replaces ALL current data.`,
          )
        )
          return;
        setStatus("Restoring…");
        // Restore client preferences first (independent of server).
        if (
          typeof data.clientPrefs === "object" &&
          data.clientPrefs !== null &&
          !Array.isArray(data.clientPrefs)
        ) {
          try {
            for (const [k, v] of Object.entries(
              data.clientPrefs as Record<string, unknown>,
            )) {
              // Same allowlist as export — old v2 files may contain
              // credentials/snapshots, which we refuse to write back.
              if (isBackupPref(k) && typeof v === "string") {
                window.localStorage.setItem(k, v);
              }
            }
          } catch {
            /* storage unavailable */
          }
        }
        importMut.mutate({
          version: data.version,
          transactions: data.transactions as Array<{
            symbol: string;
            type: string;
            quantity: number;
            price: number;
            fees?: number;
            executedAt: string;
            note?: string | null;
            source?: string;
            externalId?: string | null;
          }>,
          priceAlerts: Array.isArray(
            (data as { priceAlerts?: unknown }).priceAlerts,
          )
            ? (data as { priceAlerts: Array<{
                symbol: string;
                targetPrice: number;
                direction: string;
                active?: boolean;
              }> }).priceAlerts
            : undefined,
        });
      } catch {
        setStatus("Invalid backup file.");
      }
    };
    reader.readAsText(f);
  };

  return (
    <div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={doExport}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-2 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700"
        >
          <Download size={13} /> Export
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-2 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700"
        >
          <Upload size={13} /> Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={doImport}
        />
      </div>
      <button
        type="button"
        onClick={doResetSnapshots}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-2 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700"
      >
        <RotateCcw size={13} /> Reset snapshots
      </button>
      {status && <p className="mt-1.5 text-xs text-zinc-500">{status}</p>}
    </div>
  );
}
