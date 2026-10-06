/**
 * XIRR — annualized internal rate of return for irregular dated cash flows.
 * Newton–Raphson on NPV(r) = Σ amountᵢ / (1+r)^((dᵢ−d₀)/365.25).
 * Returns null when there is no meaningful solution (fewer than 2 flows,
 * all flows the same sign, or no convergence).
 */

export interface XirrFlow {
  date: Date;
  amount: number; // negative = money in (buy), positive = money out (sell / terminal value)
}

export function xirr(flows: XirrFlow[], guess = 0.1): number | null {
  const fs = flows.filter((f) => Number.isFinite(f.amount) && f.amount !== 0);
  if (fs.length < 2) return null;
  if (!fs.some((f) => f.amount > 0) || !fs.some((f) => f.amount < 0))
    return null;

  const t0 = Math.min(...fs.map((f) => f.date.getTime()));
  const DAY = 86_400_000;
  const yrs = (d: Date) => (d.getTime() - t0) / (365.25 * DAY);
  const npv = (r: number) =>
    fs.reduce((s, f) => s + f.amount / Math.pow(1 + r, yrs(f.date)), 0);
  const dnpv = (r: number) =>
    fs.reduce(
      (s, f) =>
        s - (yrs(f.date) * f.amount) / Math.pow(1 + r, yrs(f.date) + 1),
      0,
    );

  const attempt = (start: number): number | null => {
    let r = start;
    for (let i = 0; i < 100; i++) {
      const f = npv(r);
      const df = dnpv(r);
      if (!Number.isFinite(f) || !Number.isFinite(df) || df === 0) return null;
      const nr = r - f / df;
      if (!Number.isFinite(nr) || nr <= -1) return null;
      if (Math.abs(nr - r) < 1e-9) return nr;
      r = nr;
    }
    return null;
  };

  // Newton–Raphson is guess-sensitive: from the default 0.1 guess the first
  // step shoots past r = -1 for deeply negative returns (a real -80%
  // annualized XIRR exists but the solver bails). Retry from negative
  // guesses before giving up.
  const tried = new Set<number>();
  for (const g of [guess, -0.5, -0.9]) {
    if (tried.has(g)) continue;
    tried.add(g);
    const r = attempt(g);
    if (r != null) return r;
  }
  return null;
}
