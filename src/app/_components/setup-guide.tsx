"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";

export interface GuideStep {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
  /** Amber callout rendered under the step — for safety-critical notes. */
  warn?: string;
}

/** Inline chip for exact button / menu / field names — never plain prose. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-100">
      {children}
    </code>
  );
}

function storageKey(id: string) {
  return `holdr.setup.${id}`;
}

function loadDone(id: string, n: number): boolean[] {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return Array<boolean>(n).fill(false);
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return Array<boolean>(n).fill(false);
    return Array.from({ length: n }, (_, i) => arr[i] === true);
  } catch {
    return Array<boolean>(n).fill(false);
  }
}

/**
 * Visual step-by-step setup guide: numbered vertical timeline, per-step
 * "mark done" checkboxes persisted in localStorage, amber safety callouts,
 * and a link to the official help article. Icon-driven — no screenshots.
 */
export function SetupGuide({
  id,
  steps,
  guideUrl,
  guideLabel,
}: {
  /** Stable id, e.g. "questrade" — progress is stored per id. */
  id: string;
  steps: GuideStep[];
  guideUrl: string;
  guideLabel: string;
}) {
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState<boolean[]>(() =>
    Array<boolean>(steps.length).fill(false),
  );
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setDone(loadDone(id, steps.length));
    setReady(true);
  }, [id, steps.length]);

  const toggle = (i: number) => {
    setDone((prev) => {
      const next = prev.map((v, j) => (j === i ? !v : v));
      try {
        localStorage.setItem(storageKey(id), JSON.stringify(next));
      } catch {
        /* storage unavailable — in-memory still works */
      }
      return next;
    });
  };

  const doneCount = done.filter(Boolean).length;
  // Collapsed: only the first step shows — friendlier on small screens.
  const first = steps[0];
  if (!first) return null;
  const shown = expanded
    ? steps.map((s, i) => ({ s, i }))
    : [{ s: first, i: 0 }];

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-zinc-200">Setup guide</p>
        {ready && (
          <p className="text-xs tabular-nums text-zinc-500">
            {doneCount} of {steps.length} done
          </p>
        )}
      </div>
      {ready && (
        <div
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-800"
          aria-hidden="true"
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${(doneCount / steps.length) * 100}%` }}
          />
        </div>
      )}

      <ol className="mt-3">
        {shown.map(({ s, i }) => {
          const Icon = s.icon;
          const isDone = ready && done[i];
          const isLast = i === steps.length - 1 || !expanded;
          // NOTE: the whole row is the done-toggle (tap target >= 44px), so
          // the number circle can stay small (30px, indicator only). Keep
          // GuideStep.body phrasing content — no nested buttons/links — since
          // it renders inside this <button>.
          return (
            <li key={i} className="relative pb-4 last:pb-0">
              <button
                type="button"
                onClick={() => toggle(i)}
                aria-pressed={isDone}
                aria-label={`Mark step ${i + 1} ${isDone ? "not done" : "done"}: ${s.title}`}
                title={isDone ? "Mark not done" : "Mark done"}
                className="flex w-full gap-2 rounded-lg py-1 text-left transition-colors hover:bg-zinc-800/40"
              >
                <span className="flex shrink-0 flex-col items-center">
                  <span
                    aria-hidden="true"
                    className={`flex h-[30px] w-[30px] items-center justify-center rounded-full border text-xs font-bold transition-colors ${
                      isDone
                        ? "border-emerald-600 bg-emerald-900/50 text-emerald-300"
                        : "border-zinc-700 bg-zinc-800/60 text-zinc-300"
                    }`}
                  >
                    {isDone ? <Check size={14} /> : i + 1}
                  </span>
                  {!isLast && (
                    <span className="w-px flex-1 bg-zinc-800" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1 pt-[5px]">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
                    <Icon size={15} className="shrink-0 text-zinc-500" />
                    {s.title}
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-zinc-400">
                    {s.body}
                  </span>
                  {s.warn && (
                    <span className="mt-2 flex gap-2 rounded-lg border border-amber-800/60 bg-amber-950/30 p-2.5 text-xs leading-relaxed text-amber-200/90">
                      <AlertTriangle
                        size={14}
                        className="mt-0.5 shrink-0 text-amber-400"
                      />
                      <span>{s.warn}</span>
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {steps.length > 1 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-1 flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-800 text-sm font-semibold text-zinc-300 hover:bg-zinc-800/60"
        >
          <ChevronDown
            size={16}
            className={`transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Show fewer steps" : `Show all ${steps.length} steps`}
        </button>
      )}

      <a
        href={guideUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-[44px] items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300"
      >
        <ExternalLink size={13} />
        {guideLabel}
      </a>
    </div>
  );
}
