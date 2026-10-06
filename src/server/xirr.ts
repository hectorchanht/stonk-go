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

  let r = guess;
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
}
