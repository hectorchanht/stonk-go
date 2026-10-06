"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Maximize2,
  Minimize2,
  RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { InfoTip } from "./ui";

/* ------------------------------------------------------------------ */
/* Layout model                                                        */
/* ------------------------------------------------------------------ */

/** How many grid columns a widget spans on desktop (mobile is 1 col). */
export type WidgetSpan = "full" | "half";

export interface WidgetDef {
  id: string;
  title: ReactNode;
  icon: LucideIcon;
  info?: string;
  defaultOpen?: boolean;
  defaultSpan?: WidgetSpan;
}

interface LayoutState {
  order: string[];
  spans: Record<string, WidgetSpan>;
  collapsed: Record<string, boolean>;
}

const STORAGE_KEY = "holdr.dashboard-layout.v1";

function defaultLayout(defs: WidgetDef[]): LayoutState {
  return {
    order: defs.map((d) => d.id),
    spans: Object.fromEntries(
      defs.map((d) => [d.id, d.defaultSpan ?? "full"]),
    ) as Record<string, WidgetSpan>,
    collapsed: Object.fromEntries(
      defs.map((d) => [d.id, d.defaultOpen === false]),
    ) as Record<string, boolean>,
  };
}

function loadLayout(defs: WidgetDef[]): LayoutState {
  const d = defaultLayout(defs);
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return d;
    const saved = JSON.parse(raw) as Partial<LayoutState>;
    const defIds = new Set(defs.map((x) => x.id));
    // Keep saved order for known widgets; append new ones at the end.
    const order = (saved.order ?? []).filter((id) => defIds.has(id));
    for (const def of defs) if (!order.includes(def.id)) order.push(def.id);
    const spans: Record<string, WidgetSpan> = { ...d.spans };
    for (const [k, v] of Object.entries(saved.spans ?? {})) {
      if (defIds.has(k) && (v === "full" || v === "half")) spans[k] = v;
    }
    const collapsed: Record<string, boolean> = { ...d.collapsed };
    for (const [k, v] of Object.entries(saved.collapsed ?? {})) {
      if (defIds.has(k)) collapsed[k] = !!v;
    }
    return { order, spans, collapsed };
  } catch {
    return d;
  }
}

export function useDashboardLayout(defs: WidgetDef[]) {
  const [state, setState] = useState<LayoutState>(() => defaultLayout(defs));
  const [editMode, setEditMode] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Load the saved layout after first paint (avoids SSR/hydration mismatch).
  useEffect(() => {
    setState(loadLayout(defs));
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on every change once hydrated.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, hydrated]);

  const move = useCallback((id: string, toIndex: number) => {
    setState((s) => {
      const order = s.order.filter((x) => x !== id);
      const idx = Math.max(0, Math.min(toIndex, order.length));
      order.splice(idx, 0, id);
      return { ...s, order };
    });
  }, []);

  const nudge = useCallback(
    (id: string, dir: 1 | -1) => {
      setState((s) => {
        const i = s.order.indexOf(id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= s.order.length) return s;
        const order = s.order.slice();
        const a = order[i];
        const b = order[j];
        if (a === undefined || b === undefined) return s;
        order[i] = b;
        order[j] = a;
        return { ...s, order };
      });
    },
    [],
  );

  const toggleSpan = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      spans: { ...s.spans, [id]: s.spans[id] === "full" ? "half" : "full" },
    }));
  }, []);

  const toggleCollapsed = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      collapsed: { ...s.collapsed, [id]: !s.collapsed[id] },
    }));
  }, []);

  /** Ensure a widget is expanded (used by deep-links, not a toggle). */
  const openSection = useCallback((id: string) => {
    setState((s) =>
      s.collapsed[id]
        ? { ...s, collapsed: { ...s.collapsed, [id]: false } }
        : s,
    );
  }, []);

  const reset = useCallback(() => setState(defaultLayout(defs)), [defs]);

  return {
    order: state.order,
    spans: state.spans,
    collapsed: state.collapsed,
    editMode,
    setEditMode,
    move,
    nudge,
    toggleSpan,
    toggleCollapsed,
    openSection,
    reset,
  };
}

export type DashboardLayout = ReturnType<typeof useDashboardLayout>;

/* ------------------------------------------------------------------ */
/* Drag plumbing: WidgetGrid owns the pointer drag, WidgetSection      */
/* renders the chrome and reports its handle events upward.            */
/* ------------------------------------------------------------------ */

interface DragApi {
  editMode: boolean;
  dragId: string | null;
  onHandlePointerDown: (id: string, e: React.PointerEvent) => void;
}

const DragCtx = createContext<DragApi>({
  editMode: false,
  dragId: null,
  onHandlePointerDown: () => undefined,
});

interface DragState {
  id: string;
  /** pointer position (client coords) */
  x: number;
  y: number;
  /** grabbed element size, for the placeholder + ghost */
  w: number;
  h: number;
  /** offset of the pointer inside the grabbed element */
  ox: number;
  oy: number;
  /** insertion index in the order-without-dragged list */
  over: number;
}

/**
 * Responsive widget grid with pointer-based drag-to-reorder.
 * `renderItem(id)` must return a <WidgetSection id={id} .../> element.
 */
export function WidgetGrid({
  order,
  spans,
  layout,
  renderItem,
  labelOf,
}: {
  order: string[];
  spans: Record<string, WidgetSpan>;
  layout: DashboardLayout;
  renderItem: (id: string) => ReactNode;
  /** Short text label for the drag ghost (defaults to the id). */
  labelOf: (id: string) => ReactNode;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const measureSlots = useCallback(() => {
    const map = new Map<string, DOMRect>();
    gridRef.current
      ?.querySelectorAll<HTMLElement>("[data-slot]")
      .forEach((el) => {
        const id = el.dataset.slot;
        if (id) map.set(id, el.getBoundingClientRect());
      });
    return map;
  }, []);

  /** Insertion index for a pointer position, in reading order. */
  const indexForPoint = useCallback(
    (x: number, y: number, dragId: string) => {
      const slots = Array.from(
        gridRef.current?.querySelectorAll<HTMLElement>("[data-slot]") ?? [],
      );
      let idx = 0;
      for (const el of slots) {
        const id = el.dataset.slot;
        if (!id || id === dragId) continue;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const sameRow = y >= r.top - 4 && y <= r.bottom + 4;
        if (cy < y - 4 || (sameRow && cx < x)) idx += 1;
        else break;
      }
      return idx;
    },
    [],
  );

  const onHandlePointerDown = useCallback(
    (id: string, e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      const slots = measureSlots();
      const r = slots.get(id);
      if (!r) return;
      // Pointer capture on the handle keeps move/up events flowing to it.
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      setDrag({
        id,
        x: e.clientX,
        y: e.clientY,
        w: r.width,
        h: r.height,
        ox: e.clientX - r.left,
        oy: e.clientY - r.top,
        // Start the placeholder where the widget already is.
        over: order.indexOf(id),
      });
    },
    [measureSlots, order],
  );

  const onHandlePointerMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // Non-passive listener (see DragEvents) so touch-drag doesn't scroll.
      e.preventDefault();
      const over = indexForPoint(e.clientX, e.clientY, d.id);
      setDrag({ ...d, x: e.clientX, y: e.clientY, over });
      // Edge auto-scroll while dragging.
      if (e.clientY < 96) window.scrollBy({ top: -16 });
      else if (e.clientY > window.innerHeight - 96)
        window.scrollBy({ top: 16 });
    },
    [indexForPoint],
  );

  const endDrag = useCallback(
    (commit: boolean) => {
      const d = dragRef.current;
      setDrag(null);
      if (d && commit) layout.move(d.id, d.over);
    },
    [layout],
  );

  // Visual order while dragging: dragged item out, placeholder at `over`.
  const visual = useMemo(() => {
    if (!drag) return order.map((id) => ({ id, placeholder: false }));
    const rest = order.filter((id) => id !== drag.id);
    const out: { id: string; placeholder: boolean }[] = [];
    rest.forEach((id, i) => {
      if (i === drag.over) out.push({ id: drag.id, placeholder: true });
      out.push({ id, placeholder: false });
    });
    if (drag.over >= rest.length)
      out.push({ id: drag.id, placeholder: true });
    return out;
  }, [order, drag]);

  const api = useMemo<DragApi>(
    () => ({
      editMode: layout.editMode,
      dragId: drag?.id ?? null,
      onHandlePointerDown,
    }),
    [layout.editMode, drag?.id, onHandlePointerDown],
  );

  return (
    <DragCtx.Provider value={api}>
      <div
        ref={gridRef}
        className={`grid grid-cols-1 gap-4 md:grid-cols-2 ${
          drag ? "select-none" : ""
        }`}
      >
        {visual.map(({ id, placeholder }) =>
          placeholder && drag ? (
            <div
              key={`ph-${id}`}
              aria-hidden
              style={{ height: drag.h }}
              className={`rounded-2xl border-2 border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-100/50 dark:bg-zinc-800/30 ${
                spans[id] === "full" ? "md:col-span-2" : ""
              }`}
            />
          ) : (
            <div
              key={id}
              data-slot={id}
              className={`min-w-0 ${
                spans[id] === "full" ? "md:col-span-2" : ""
              }`}
            >
              {renderItem(id)}
            </div>
          ),
        )}
      </div>

      {/* Floating ghost that follows the pointer while dragging. */}
      {drag && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-xl border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-medium shadow-2xl"
          style={{
            left: drag.x - drag.ox,
            top: drag.y - drag.oy,
            width: Math.min(drag.w, window.innerWidth - 32),
            opacity: 0.96,
          }}
        >
          <GripVertical size={16} className="shrink-0 text-zinc-400" />
          <span className="truncate">{labelOf(drag.id)}</span>
        </div>
      )}

      {/* The handle reports move/up here via capture; rendered once. */}
      <DragEvents
        active={drag != null}
        onMove={onHandlePointerMove}
        onUp={() => endDrag(true)}
        onCancel={() => endDrag(false)}
      />
    </DragCtx.Provider>
  );
}

/**
 * Global move/up listeners while a drag is active. The handle uses pointer
 * capture so events target it, but a document-level fallback keeps the drag
 * alive if capture is lost (e.g. the handle unmounts mid-drag).
 */
function DragEvents({
  active,
  onMove,
  onUp,
  onCancel,
}: {
  active: boolean;
  onMove: (e: PointerEvent) => void;
  onUp: () => void;
  onCancel: () => void;
}) {
  const ref = useRef({ onMove, onUp, onCancel });
  ref.current = { onMove, onUp, onCancel };
  useEffect(() => {
    if (!active) return;
    const mv = (e: PointerEvent) => ref.current.onMove(e);
    const up = () => ref.current.onUp();
    const cancel = () => ref.current.onCancel();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current.onCancel();
    };
    document.addEventListener("pointermove", mv, { passive: false });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointermove", mv);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key);
    };
  }, [active ]);
  return null;
}

/* ------------------------------------------------------------------ */
/* WidgetSection: the one chrome every dashboard section shares.       */
/* ------------------------------------------------------------------ */

export function WidgetSection({
  id,
  def,
  span,
  collapsed,
  layout,
  children,
}: {
  id: string;
  def: WidgetDef;
  span: WidgetSpan;
  collapsed: boolean;
  layout: DashboardLayout;
  children: ReactNode;
}) {
  const { editMode, dragId, onHandlePointerDown } = useContext(DragCtx);
  const Icon = def.icon;
  const beingDragged = dragId === id;

  const chromeBtn =
    "rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-zinc-800 dark:hover:text-zinc-200";

  return (
    <section
      id={`section-${id}`}
      aria-label={typeof def.title === "string" ? def.title : undefined}
      className="min-w-0 scroll-mt-4"
    >
      <div className="flex items-center gap-1.5 py-1">
        {editMode && (
          <button
            type="button"
            aria-label="Drag to reorder"
            title="Drag to reorder"
            onPointerDown={(e) => onHandlePointerDown(id, e)}
            className={`${chromeBtn} cursor-grab touch-none active:cursor-grabbing ${
              beingDragged ? "bg-zinc-200 dark:bg-zinc-700" : ""
            }`}
          >
            <GripVertical size={16} />
          </button>
        )}
        <span className="shrink-0 text-zinc-500">
          <Icon size={15} />
        </span>
        <button
          type="button"
          onClick={() => layout.toggleCollapsed(id)}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse"}
          className="flex min-w-0 items-center gap-1.5 text-left text-sm font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          <span className="truncate">{def.title}</span>
          <ChevronDown
            size={14}
            className={`shrink-0 transition-transform ${
              collapsed ? "-rotate-90" : ""
            }`}
          />
        </button>
        {def.info && <InfoTip text={def.info} />}
        <div className="flex-1" />
        {editMode && (
          <>
            <button
              type="button"
              onClick={() => layout.nudge(id, -1)}
              aria-label="Move up"
              title="Move up"
              className={chromeBtn}
            >
              <ChevronUp size={15} />
            </button>
            <button
              type="button"
              onClick={() => layout.nudge(id, 1)}
              aria-label="Move down"
              title="Move down"
              className={chromeBtn}
            >
              <ChevronDown size={15} />
            </button>
            <button
              type="button"
              onClick={() => layout.toggleSpan(id)}
              aria-label={span === "full" ? "Half width" : "Full width"}
              title={span === "full" ? "Half width" : "Full width"}
              className={chromeBtn}
            >
              {span === "full" ? (
                <Minimize2 size={15} />
              ) : (
                <Maximize2 size={15} />
              )}
            </button>
          </>
        )}
      </div>
      {!collapsed && <div className="mt-1.5">{children}</div>}
    </section>
  );
}

/** Small "reset layout" button for the customize bar. */
export function ResetLayoutButton({ layout }: { layout: DashboardLayout }) {
  return (
    <button
      type="button"
      onClick={() => {
        if (window.confirm("Reset the dashboard layout to defaults?")) {
          layout.reset();
        }
      }}
      className="flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-200/60 dark:bg-zinc-800/60 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-700"
    >
      <RotateCcw size={14} />
      Reset layout
    </button>
  );
}
