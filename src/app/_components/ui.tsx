"use client";

import { useEffect, useState } from "react";

/**
 * Small ⓘ that explains a section. Hover/focus shows it on desktop,
 * tap toggles it on touch screens.
 */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-block align-middle"
      onClick={(e) => e.stopPropagation()}
    >      <button
        type="button"
        aria-label="What is this?"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-600 align-middle text-[10px] font-bold leading-none text-zinc-400 hover:border-zinc-300 hover:text-zinc-200"
      >
        i
      </button>
      {open && (
        <span className="absolute left-1/2 top-full z-30 mt-1.5 w-60 -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-800 p-2.5 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-zinc-300 shadow-xl">
          {text}
        </span>
      )}
    </span>
  );
}

const collapsedKey = (id: string) => `holdr.ui.collapsed.${id}`;

/**
 * Every dashboard section is collapsible. The open/closed state persists
 * in localStorage. Other components can force a section open by dispatching:
 *   window.dispatchEvent(new CustomEvent("holdr:open-section", { detail: id }))
 */
export function CollapsibleSection({
  id,
  title,
  info,
  badge,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: React.ReactNode;
  info?: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultOpen;
    try {
      const raw = window.localStorage.getItem(collapsedKey(id));
      return raw == null ? defaultOpen : raw !== "1";
    } catch {
      return defaultOpen;
    }
  });

  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) setOpen(true);
    };
    window.addEventListener("holdr:open-section", handler);
    return () => window.removeEventListener("holdr:open-section", handler);
  }, [id]);

  const toggle = () => {
    setOpen((o) => {
      try {
        window.localStorage.setItem(collapsedKey(id), o ? "1" : "0");
      } catch {
        /* ignore */
      }
      return !o;
    });
  };

  return (
    <section id={`section-${id}`} className="scroll-mt-4">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="flex w-full cursor-pointer items-center gap-2 py-1 text-left"
      >
        <span
          className={`shrink-0 text-xs text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        <span className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
          {title}
        </span>
        {badge}
        {info && <InfoTip text={info} />}
      </div>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}
