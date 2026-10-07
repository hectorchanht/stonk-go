"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Calculator,
  Check,
  Coins,
  Flag,
  Pencil,
  Plus,
  SlidersHorizontal,
  Target,
  Trash2,
  X,
} from "lucide-react";

import { api } from "~/trpc/react";
import { useCurrency } from "~/app/_components/currency";
import { InfoTip, StatCard } from "~/app/_components/ui";
import {
  DEFAULT_FI_SETTINGS,
  addMonths,
  coastFiAmount,
  fiNumber,
  formatDurationMonths,
  loadFiGoals,
  loadFiSettings,
  monthsToTarget,
  newGoalId,
  projectSeries,
  saveFiGoals,
  saveFiSettings,
  type FiGoal,
  type FiSettings,
  type ProjectionPoint,
} from "~/app/_components/fi";

/* ------------------------------------------------------------------ */
/* Small building blocks                                                */
/* ------------------------------------------------------------------ */

function ProgressBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value * 100));
  return (
    <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      <div
        className="h-full rounded-full bg-emerald-500 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 100,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      <div className="relative mt-1">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full rounded-lg border border-zinc-300 bg-white py-2 pl-3 pr-10 text-sm tabular-nums text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
        {suffix && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-zinc-500">
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}

function Slider({
  label,
  value,
  display,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  display: string;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-zinc-500">{label}</span>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
          {display}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-emerald-500"
        aria-label={label}
      />
    </div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: typeof Target; children: React.ReactNode }) {
  return (
    <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
      <Icon size={14} />
      {children}
    </h4>
  );
}

/* ------------------------------------------------------------------ */
/* Growth chart (SVG, no dependencies)                                  */
/* ------------------------------------------------------------------ */

function GrowthChart({
  points,
  fmtCompact,
}: {
  points: ProjectionPoint[];
  fmtCompact: (usd: number) => string;
}) {
  const W = 640;
  const H = 230;
  const PL = 58;
  const PR = 10;
  const PT = 10;
  const PB = 26;
  const maxV = Math.max(...points.map((p) => p.total), 1);
  const n = points.length - 1;
  const x = (i: number) => PL + (n === 0 ? 0 : (i / n) * (W - PL - PR));
  const y = (v: number) => PT + (1 - v / maxV) * (H - PT - PB);

  const contribLine = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.contributed).toFixed(1)}`).join(" ");
  const totalLine = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(" ");
  const contribArea = `${contribLine} L${x(n).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const growthArea =
    `${points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.contributed).toFixed(1)}`).join(" ")} ` +
    points
      .map((p, i) => `L${x(n - i).toFixed(1)},${y(points[n - i]!.total).toFixed(1)}`)
      .join(" ") +
    " Z";

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxV);
  const yearTicks = useMemo(() => {
    if (n <= 0) return [0];
    const step = Math.max(1, Math.ceil(n / 6));
    const out: number[] = [];
    for (let yr = 0; yr <= n; yr += step) out.push(yr);
    if (out[out.length - 1] !== n) out.push(n);
    return out;
  }, [n]);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Projected portfolio growth chart">
        {ticks.map((tv, i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={y(tv)} y2={y(tv)} stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeWidth={1} />
            <text x={PL - 6} y={y(tv) + 4} textAnchor="end" fontSize={11} className="fill-zinc-500">
              {fmtCompact(tv)}
            </text>
          </g>
        ))}
        <path d={contribArea} className="fill-emerald-500/25" />
        <path d={growthArea} className="fill-emerald-400/50" />
        <path d={totalLine} fill="none" className="stroke-emerald-500" strokeWidth={2} />
        {yearTicks.map((yr) => (
          <text key={yr} x={x(yr)} y={H - 8} textAnchor="middle" fontSize={11} className="fill-zinc-500">
            {yr === 0 ? "now" : `+${yr}y`}
          </text>
        ))}
      </svg>
      <div className="mt-1 flex items-center gap-4 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500/40" />
          You put in
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-400/70" />
          Growth
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main widget                                                         */
/* ------------------------------------------------------------------ */

export function FinancialFreedom({
  marketValue,
  costBasis,
}: {
  /** Total portfolio market value, USD. */
  marketValue: number;
  /** Total cost basis, USD. */
  costBasis: number;
}) {
  const { fmt, fmtCompact, rates, currency } = useCurrency();
  const displayRate = rates?.[currency.toLowerCase()] ?? 1;
  const toUsd = (display: number) => display / displayRate;

  // Settings + goals live in localStorage (SSR-safe defaults first, then
  // corrected after mount to avoid hydration mismatch).
  const [settings, setSettings] = useState<FiSettings>({ ...DEFAULT_FI_SETTINGS });
  const [goals, setGoals] = useState<FiGoal[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [addingGoal, setAddingGoal] = useState(false);
  const [goalName, setGoalName] = useState("");
  const [goalAmount, setGoalAmount] = useState("");
  const [goalDate, setGoalDate] = useState("");

  useEffect(() => {
    setSettings(loadFiSettings());
    setGoals(loadFiGoals());
  }, []);

  const updateSettings = (patch: Partial<FiSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveFiSettings(next);
      return next;
    });
  };

  const updateGoals = (next: FiGoal[]) => {
    setGoals(next);
    saveFiGoals(next);
  };

  const analyticsQ = api.ibkr.analytics.useQuery(undefined, {
    staleTime: 300_000,
    retry: false,
  });
  const divMonths = analyticsQ.data?.dividendsByMonth ?? [];
  const annualDivUsd = useMemo(
    () => divMonths.slice(-12).reduce((a, m) => a + m.amount, 0),
    [divMonths],
  );

  /* ---- FI math (all USD) ---- */
  const annualExpensesUsd = toUsd(settings.monthlyExpenses * 12);
  const monthlyPmtUsd = toUsd(settings.monthlyContribution);
  const fiNum = fiNumber(annualExpensesUsd);
  const progress = fiNum > 0 ? Math.min(1, marketValue / fiNum) : 0;
  const monthsFi = monthsToTarget(marketValue, monthlyPmtUsd, settings.annualReturnPct, fiNum);
  const coast = coastFiAmount(fiNum, settings.annualReturnPct, settings.currentAge, settings.retireAge);
  const isCoast = fiNum > 0 && marketValue >= coast;
  const yieldOnCost = costBasis > 0 && annualDivUsd > 0 ? annualDivUsd / costBasis : null;
  const coverage = annualExpensesUsd > 0 && annualDivUsd > 0 ? annualDivUsd / annualExpensesUsd : null;

  /* ---- simulator state (defaults follow settings) ---- */
  const [simPmt, setSimPmt] = useState<number | null>(null);
  const [simReturn, setSimReturn] = useState<number | null>(null);
  const [simYears, setSimYears] = useState(20);
  const effSimPmt = simPmt ?? settings.monthlyContribution;
  const effSimReturn = simReturn ?? settings.annualReturnPct;
  const series = useMemo(
    () => projectSeries(marketValue, toUsd(effSimPmt), effSimReturn, simYears),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [marketValue, effSimPmt, effSimReturn, simYears, displayRate],
  );
  const simEnd = series[series.length - 1]!;

  const hasPortfolio = marketValue > 0;

  return (
    <div className="space-y-5">
      {/* settings toggle */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Your numbers are in <span className="font-semibold text-zinc-700 dark:text-zinc-300">{currency}</span> and stay in this browser.
        </p>
        <button
          type="button"
          onClick={() => setShowSettings((s) => !s)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-semibold text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300"
        >
          {showSettings ? <X size={14} /> : <SlidersHorizontal size={14} />}
          Your numbers
        </button>
      </div>

      {showSettings && (
        <div className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800 sm:grid-cols-3 lg:grid-cols-5">
          <NumField label={`Monthly spending (${currency})`} value={settings.monthlyExpenses} onChange={(v) => updateSettings({ monthlyExpenses: v })} step={100} />
          <NumField label={`Monthly investing (${currency})`} value={settings.monthlyContribution} onChange={(v) => updateSettings({ monthlyContribution: v })} step={100} />
          <NumField label="Expected return" value={settings.annualReturnPct} onChange={(v) => updateSettings({ annualReturnPct: v })} min={0} max={30} step={0.5} suffix="% / yr" />
          <NumField label="Current age" value={settings.currentAge} onChange={(v) => updateSettings({ currentAge: Math.round(v) })} min={10} max={100} step={1} suffix="yrs" />
          <NumField label="Retire age" value={settings.retireAge} onChange={(v) => updateSettings({ retireAge: Math.round(v) })} min={11} max={100} step={1} suffix="yrs" />
        </div>
      )}

      {/* FI headline cards */}
      {!hasPortfolio ? (
        <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          <Target size={20} className="mx-auto mb-2 text-zinc-400" />
          Connect a broker or log holdings to see your FI number — the simulator below works either way.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatCard
            label="FI number"
            value={fmt(fiNum)}
            sub="25× yearly spending"
            info="The 4% rule: with 25× your annual spending invested, a 4% yearly withdrawal covers your expenses indefinitely."
          />
          <StatCard
            label="FI progress"
            value={`${(progress * 100).toFixed(1)}%`}
            sub={`${fmtCompact(marketValue)} of ${fmtCompact(fiNum)}`}
            info="Your current portfolio value divided by your FI number."
            footer={
              <div className="mt-2">
                <ProgressBar value={progress} />
              </div>
            }
          />
          <StatCard
            label="Time to FI"
            value={formatDurationMonths(monthsFi)}
            tone={Number.isFinite(monthsFi) ? "pos" : "neutral"}
            sub={`${settings.annualReturnPct}%/yr + ${fmt(monthlyPmtUsd)}/mo`}
            info="Projected from your current portfolio, monthly investing and expected return (monthly compounding)."
          />
          <StatCard
            label="Coast FI"
            value={fmt(coast)}
            tone={isCoast ? "pos" : "neutral"}
            sub={isCoast ? "You're coasting — growth alone gets you there" : `${fmt(coast - marketValue)} to go`}
            info="The lump sum you'd need TODAY to hit your FI number by retire age with zero further contributions."
          />
        </div>
      )}

      {/* passive income */}
      {annualDivUsd > 0 && (
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800 sm:p-4">
          <SectionTitle icon={Coins}>Passive income</SectionTitle>
          <div className="mt-2 grid grid-cols-3 gap-3">
            <div className="min-w-0">
              <div className="text-[clamp(1rem,4.5vw,1.5rem)] font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
                {fmt(annualDivUsd)}
              </div>
              <div className="truncate text-xs text-zinc-500">
                dividends / yr (last 12m)
                <InfoTip text="Sum of your last 12 months of dividends from IBKR cash transactions." />
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[clamp(1rem,4.5vw,1.5rem)] font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
                {yieldOnCost != null ? `${(yieldOnCost * 100).toFixed(2)}%` : "—"}
              </div>
              <div className="truncate text-xs text-zinc-500">
                yield on cost
                <InfoTip text="Yearly dividends divided by what you paid. Watch this climb as dividends grow." />
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[clamp(1rem,4.5vw,1.5rem)] font-bold tabular-nums text-emerald-500">
                {coverage != null ? `${(coverage * 100).toFixed(1)}%` : "—"}
              </div>
              <div className="truncate text-xs text-zinc-500">
                of spending covered
                <InfoTip text="Yearly dividends divided by your yearly spending. At 100%, your portfolio pays your bills." />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* goals */}
      <div>
        <div className="flex items-center justify-between">
          <SectionTitle icon={Flag}>Goals</SectionTitle>
          <button
            type="button"
            onClick={() => setAddingGoal((a) => !a)}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-2 py-1 text-xs font-semibold text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300"
          >
            {addingGoal ? <X size={13} /> : <Plus size={13} />}
            {addingGoal ? "Cancel" : "Add goal"}
          </button>
        </div>

        {addingGoal && (
          <div className="mt-2 grid grid-cols-2 gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <label className="block min-w-0">
              <span className="text-xs font-medium text-zinc-500">Name</span>
              <input
                type="text"
                value={goalName}
                onChange={(e) => setGoalName(e.target.value)}
                placeholder="e.g. $1M net worth"
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
            <NumField label={`Target (${currency})`} value={Number(goalAmount) || 0} onChange={(v) => setGoalAmount(String(v))} step={1000} />
            <label className="block min-w-0">
              <span className="text-xs font-medium text-zinc-500">Target date</span>
              <input
                type="date"
                value={goalDate}
                onChange={(e) => setGoalDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                disabled={!goalName.trim() || !(Number(goalAmount) > 0) || !goalDate}
                onClick={() => {
                  updateGoals([
                    ...goals,
                    { id: newGoalId(), name: goalName.trim(), targetAmount: Number(goalAmount), targetDate: goalDate, createdAt: new Date().toISOString() },
                  ]);
                  setGoalName("");
                  setGoalAmount("");
                  setGoalDate("");
                  setAddingGoal(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
              >
                <Check size={15} /> Save
              </button>
            </div>
          </div>
        )}

        {goals.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">
            No goals yet. Set one — e.g. your first $100K — and watch the portfolio chase it.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {goals.map((g) => {
              const targetUsd = toUsd(g.targetAmount);
              const gp = targetUsd > 0 ? Math.min(1, marketValue / targetUsd) : 0;
              const mGoal = monthsToTarget(marketValue, monthlyPmtUsd, settings.annualReturnPct, targetUsd);
              const projDate = Number.isFinite(mGoal) ? addMonths(new Date(), mGoal) : null;
              const targetD = new Date(`${g.targetDate}T12:00:00`);
              const onTrack = projDate != null && projDate <= targetD;
              return (
                <div key={g.id} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{g.name}</div>
                      <div className="text-xs text-zinc-500">
                        {fmt(targetUsd)} by {targetD.toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {hasPortfolio && projDate && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                            onTrack ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          }`}
                          title={onTrack ? "Projected to hit before your target date" : "Projected to miss your target date at current pace"}
                        >
                          {onTrack ? "on track" : "behind"} · {projDate.toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => updateGoals(goals.filter((x) => x.id !== g.id))}
                        className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                        title="Delete goal"
                        aria-label={`Delete goal ${g.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="mt-2">
                    <ProgressBar value={gp} />
                  </div>
                  <div className="mt-1 text-xs tabular-nums text-zinc-500">
                    {(gp * 100).toFixed(1)}% · {fmt(marketValue)} of {fmtCompact(targetUsd)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* simulator */}
      <div>
        <SectionTitle icon={Calculator}>What-if simulator</SectionTitle>
        <div className="mt-2 grid gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800 sm:grid-cols-3 sm:p-4">
          <Slider
            label={`Investing / month (${currency})`}
            value={effSimPmt}
            display={fmt(toUsd(effSimPmt))}
            onChange={setSimPmt}
            min={0}
            max={20000}
            step={100}
          />
          <Slider
            label="Return / year"
            value={effSimReturn}
            display={`${effSimReturn.toFixed(1)}%`}
            onChange={setSimReturn}
            min={0}
            max={12}
            step={0.5}
          />
          <Slider label="Years" value={simYears} display={`${simYears}y`} onChange={setSimYears} min={1} max={40} step={1} />
        </div>
        <div className="mt-3">
          <GrowthChart points={series} fmtCompact={fmtCompact} />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-3">
          <div className="min-w-0">
            <div className="truncate text-[clamp(1rem,4.5vw,1.5rem)] font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
              {fmtCompact(simEnd.total)}
            </div>
            <div className="text-xs text-zinc-500">in {simYears}y</div>
          </div>
          <div className="min-w-0">
            <div className="truncate text-[clamp(1rem,4.5vw,1.5rem)] font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
              {fmtCompact(simEnd.contributed)}
            </div>
            <div className="text-xs text-zinc-500">you put in</div>
          </div>
          <div className="min-w-0">
            <div className="truncate text-[clamp(1rem,4.5vw,1.5rem)] font-bold tabular-nums text-emerald-500">
              {fmtCompact(simEnd.growth)}
            </div>
            <div className="text-xs text-zinc-500">growth did</div>
          </div>
        </div>
        <p className="mt-2 flex items-start gap-1 text-xs text-zinc-500">
          <Pencil size={12} className="mt-0.5 shrink-0" />
          Projection only — markets don't compound this neatly. Start {fmt(toUsd(effSimPmt))}/mo at {effSimReturn}% for {simYears}y.
        </p>
      </div>
    </div>
  );
}
