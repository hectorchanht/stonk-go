import { type AppDb } from "~/server/db";

export type FlairBadge = "diamond" | "paper" | "neutral";

export interface PositionFlair {
  badge: FlairBadge;
  /** Short label rendered next to the symbol, e.g. "💎🙌 DIAMOND HANDS". */
  label: string;
  /** Tooltip explaining the verdict. */
  detail: string;
  holdDays: number;
  buys: number;
  sells: number;
  avgSellHoldDays: number | null;
  /** FIFO realized P/L on sold shares (null when nothing was sold). */
  realizedPnl: number | null;
}

const DAY_MS = 86_400_000;

/** Prisma/D1 may hand dates back as strings — normalize defensively. */
function tsOf(d: Date | string): number {
  return d instanceof Date ? d.getTime() : new Date(d).getTime();
}

function fmtMoney(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * WSB flair per position, judged from the immutable transaction log.
 *
 * 💎🙌 DIAMOND HANDS — never sold (and held a while, or bought the dip),
 *   or banked profits but still holding long-term.
 * 🧻 PAPER HANDS — sold at a loss, or flipped shares in under two weeks.
 * HODLING — everything else (too early to judge).
 */
export async function computeFlair(
  db: AppDb,
  symbols: string[],
): Promise<Record<string, PositionFlair>> {
  const out: Record<string, PositionFlair> = {};
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  if (uniq.length === 0) return out;

  const txns = (
    await Promise.all(
      uniq.map((symbol) =>
        db.transaction.findMany({
          where: { symbol },
          orderBy: [{ executedAt: "asc" }, { id: "asc" }],
        }),
      ),
    )
  ).flat();

  const bySymbol = new Map<string, typeof txns>();
  for (const t of txns) {
    const list = bySymbol.get(t.symbol);
    if (list) list.push(t);
    else bySymbol.set(t.symbol, [t]);
  }

  const now = Date.now();

  for (const [symbol, list] of bySymbol) {
    const buys = list.filter((t) => t.type === "BUY");
    const sells = list.filter((t) => t.type === "SELL");
    if (buys.length === 0) continue;

    const firstBuy = buys[0]!;
    const holdDays = Math.max(
      0,
      Math.floor((now - tsOf(firstBuy.executedAt)) / DAY_MS),
    );

    // FIFO-match sells against buys: realized P/L + how long sold shares were held.
    const queue = buys.map((b) => ({
      qty: b.quantity,
      price: b.price,
      ts: tsOf(b.executedAt),
    }));
    let realized = 0;
    let soldQty = 0;
    let soldHoldDays = 0;
    for (const s of sells) {
      let remaining = s.quantity;
      const sTs = tsOf(s.executedAt);
      while (remaining > 1e-9 && queue.length > 0) {
        const lot = queue[0]!;
        const take = Math.min(remaining, lot.qty);
        realized += take * (s.price - lot.price);
        soldQty += take;
        soldHoldDays += (take * (sTs - lot.ts)) / DAY_MS;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-9) queue.shift();
      }
      // Sell-side fees shave the realized P/L, pro-rated to matched shares.
      const matched = s.quantity > 0 ? (s.quantity - remaining) / s.quantity : 0;
      realized -= s.fees * matched;
    }
    const avgSellHoldDays = soldQty > 0 ? soldHoldDays / soldQty : null;

    // Bought the dip: a later buy at least 5% below the mean of earlier buy prices.
    let boughtDip = false;
    let prevSum = 0;
    let prevQty = 0;
    for (const b of buys) {
      if (prevQty > 0 && b.price < 0.95 * (prevSum / prevQty)) boughtDip = true;
      prevSum += b.price * b.quantity;
      prevQty += b.quantity;
    }

    const realizedPnl = sells.length > 0 ? realized : null;

    let badge: FlairBadge = "neutral";
    let label = "HODLING";
    let detail = `held ${holdDays}d · ${buys.length} buy${buys.length === 1 ? "" : "s"}`;

    if (sells.length > 0) {
      if (realizedPnl != null && realizedPnl < 0) {
        badge = "paper";
        label = "🧻 PAPER HANDS";
        detail = `sold the dip · ${fmtMoney(realizedPnl)} realized`;
      } else if (avgSellHoldDays != null && avgSellHoldDays < 14) {
        badge = "paper";
        label = "🧻 PAPER HANDS";
        detail = `flipped in ~${Math.max(1, Math.round(avgSellHoldDays))}d on average`;
      } else if (holdDays >= 180) {
        badge = "diamond";
        label = "💎🙌 DIAMOND HANDS";
        detail = `held ${holdDays}d · banked ${fmtMoney(realizedPnl ?? 0)} and still holding`;
      } else {
        detail = `held ${holdDays}d · ${sells.length} sell${sells.length === 1 ? "" : "s"} · ${fmtMoney(realizedPnl ?? 0)} realized`;
      }
    } else if (holdDays >= 90 || boughtDip) {
      badge = "diamond";
      label = "💎🙌 DIAMOND HANDS";
      detail = `held ${holdDays}d · ${buys.length} buy${buys.length === 1 ? "" : "s"} · never sold${boughtDip ? " · bought the dip" : ""}`;
    }

    out[symbol] = {
      badge,
      label,
      detail,
      holdDays,
      buys: buys.length,
      sells: sells.length,
      avgSellHoldDays,
      realizedPnl,
    };
  }

  return out;
}
