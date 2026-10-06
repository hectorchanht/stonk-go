"use client";

import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";

import { api } from "~/trpc/react";

export function BackupButtons() {
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const backupQuery = api.portfolio.exportBackup.useQuery(undefined, {
    enabled: false,
  });
  const importMut = api.portfolio.importBackup.useMutation({
    onSuccess: (r) => {
      setStatus(`Restored ${r.restored} transactions. Reloading…`);
      setTimeout(() => window.location.reload(), 1500);
    },
    onError: (e) => setStatus(`Restore failed: ${e.message}`),
  });

  const doExport = async () => {
    setStatus("Preparing backup…");
    const res = await backupQuery.refetch();
    if (res.data) {
      const blob = new Blob([JSON.stringify(res.data, null, 2)], {
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
        };
        if (data.version !== 1 || !Array.isArray(data.transactions)) {
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
        importMut.mutate({
          version: 1,
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
          holdings: [],
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
      {status && <p className="mt-1.5 text-xs text-zinc-500">{status}</p>}
    </div>
  );
}
