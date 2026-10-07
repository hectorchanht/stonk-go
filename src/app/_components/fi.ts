/**
 * Financial-independence math for the Financial Freedom widget.
 * Pure functions — no React, no DOM — so vitest can import this directly.
 *
 * Convention: every amount passed into these functions must be in the SAME
 * currency unit. The widget converts the portfolio (USD) and the user's
 * inputs (display currency) into one unit before calling them.
 */

export interface FiSettings {
  /** Monthly spending, in display currency. */
  monthlyExpenses: number;
  /** Monthly amount invested, in display currency. */
  monthlyContribution: number;
  /** Expected nominal annual return, percent (e.g. 7 = 7%). */
  annualReturnPct: number;
  currentAge: number;
  retireAge: number;
}

export const DEFAULT_FI_SETTINGS: FiSettings = {
  monthlyExpenses: 4000,
  monthlyContribution: 2000,
  annualReturnPct: 7,
  currentAge: 35,
  retireAge: 60,
};

const SETTINGS_KEY = "holdr.fi-settings.v1";
const GOALS_KEY = "holdr.fi-goals.v1";

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeSettings(raw: unknown): FiSettings {
  const r = (raw ?? {}) as Partial<FiSettings>;
  const currentAge = Math.min(100, Math.max(10, Math.round(num(r.currentAge, DEFAULT_FI_SETTINGS.currentAge))));
  const retireAge = Math.min(100, Math.max(currentAge + 1, Math.round(num(r.retireAge, DEFAULT_FI_SETTINGS.retireAge))));
  return {
    monthlyExpenses: Math.max(0, num(r.monthlyExpenses, DEFAULT_FI_SETTINGS.monthlyExpenses)),
    monthlyContribution: Math.max(0, num(r.monthlyContribution, DEFAULT_FI_SETTINGS.monthlyContribution)),
    annualReturnPct: Math.min(30, Math.max(0, num(r.annualReturnPct, DEFAULT_FI_SETTINGS.annualReturnPct))),
    currentAge,
    retireAge,
  };
}

/** SSR-safe: returns defaults on the server. */
export function loadFiSettings(): FiSettings {
  if (typeof window === "undefined") return { ...DEFAULT_FI_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_FI_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_FI_SETTINGS };
  }
}

export function saveFiSettings(s: FiSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(s)));
  } catch {
    /* storage unavailable — settings stay in memory */
  }
}

export interface FiGoal {
  id: string;
  name: string;
  /** Target amount, in display currency. */
  targetAmount: number;
  /** Target date, YYYY-MM-DD. */
  targetDate: string;
  createdAt: string; // ISO timestamp
}

export function newGoalId(): string {
  return `goal-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function sanitizeGoal(raw: unknown): FiGoal | null {
  const r = (raw ?? {}) as Partial<FiGoal>;
  const targetAmount = num(r.targetAmount, NaN);
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) return null;
  if (typeof r.targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.targetDate)) return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : newGoalId(),
    name: r.name.trim().slice(0, 80),
    targetAmount,
    targetDate: r.targetDate,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
  };
}

/** SSR-safe: returns [] on the server. */
export function loadFiGoals(): FiGoal[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(GOALS_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(sanitizeGoal).filter((g): g is FiGoal => g !== null);
  } catch {
    return [];
  }
}

export function saveFiGoals(goals: FiGoal[]): void {
  try {
    window.localStorage.setItem(
      GOALS_KEY,
      JSON.stringify(goals.map(sanitizeGoal).filter((g): g is FiGoal => g !== null)),
    );
  } catch {
    /* storage unavailable — goals stay in memory */
  }
}

/** FI number under the 4% rule: 25x annual expenses. */
export function fiNumber(annualExpenses: number): number {
  return Math.max(0, annualExpenses) * 25;
}

/**
 * Months needed for a portfolio to grow from `presentValue` to `target`
 * with a fixed `monthlyContribution` and `annualReturnPct` (monthly
 * compounding, contribution at each month-end).
 * Returns 0 when already there, Infinity when unreachable.
 */
export function monthsToTarget(
  presentValue: number,
  monthlyContribution: number,
  annualReturnPct: number,
  target: number,
): number {
  const pv = Math.max(0, presentValue);
  const pmt = Math.max(0, monthlyContribution);
  if (target <= pv) return 0;
  const r = annualReturnPct / 100 / 12;
  if (r <= 0) {
    if (pmt <= 0) return Infinity;
    return (target - pv) / pmt;
  }
  if (pmt <= 0) {
    // Pure growth: pv * (1+r)^n = target
    return Math.log(target / pv) / Math.log(1 + r);
  }
  // FV = pv*(1+r)^n + pmt*(((1+r)^n - 1)/r) = target.
  // Let x = (1+r)^n → x*(pv + pmt/r) = target + pmt/r.
  const x = (target + pmt / r) / (pv + pmt / r);
  if (!(x > 1)) return 0;
  const n = Math.log(x) / Math.log(1 + r);
  return Number.isFinite(n) && n >= 0 ? n : Infinity;
}

/** Human duration: "27y 6m", "8m", "—" when unreachable. */
export function formatDurationMonths(months: number): string {
  if (!Number.isFinite(months)) return "—";
  const m = Math.max(0, Math.round(months));
  const y = Math.floor(m / 12);
  const rem = m % 12;
  if (y <= 0) return `${rem}m`;
  return rem === 0 ? `${y}y` : `${y}y ${rem}m`;
}

/**
 * Coast FI: the lump sum needed TODAY to hit `fiNum` by `retireAge`
 * with no further contributions.
 */
export function coastFiAmount(
  fiNum: number,
  annualReturnPct: number,
  currentAge: number,
  retireAge: number,
): number {
  const years = Math.max(0, retireAge - currentAge);
  const r = annualReturnPct / 100;
  if (years <= 0 || r <= 0) return fiNum;
  return fiNum / Math.pow(1 + r, years);
}

export interface ProjectionPoint {
  year: number;
  /** Projected portfolio value. */
  total: number;
  /** Present value + all contributions so far. */
  contributed: number;
  /** total - contributed (the compounding effect). */
  growth: number;
}

/** Year-by-year projection with monthly compounding. */
export function projectSeries(
  presentValue: number,
  monthlyContribution: number,
  annualReturnPct: number,
  years: number,
): ProjectionPoint[] {
  const r = annualReturnPct / 100 / 12;
  const n = Math.max(0, Math.round(years));
  const pv = Math.max(0, presentValue);
  const pmt = Math.max(0, monthlyContribution);
  const points: ProjectionPoint[] = [{ year: 0, total: pv, contributed: pv, growth: 0 }];
  let total = pv;
  for (let y = 1; y <= n; y++) {
    for (let m = 0; m < 12; m++) {
      total = total * (1 + r) + pmt;
    }
    const contributed = pv + pmt * 12 * y;
    points.push({ year: y, total, contributed, growth: Math.max(0, total - contributed) });
  }
  return points;
}

/** Add `months` to a Date, returning a new Date. */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + Math.round(months));
  return d;
}
